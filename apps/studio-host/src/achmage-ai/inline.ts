import { AiDocument, type Capture } from './document';
import { PANEL_STATUS_EVENT, requestPanelAsk, requestPanelEdit, requestPanelTocRefresh, requestPanelWholeEdit, type PanelStatus } from './panel-events';
import { hasContentsHeading } from './toc-pages';
import type { PanelDeps } from './panel';
import { registerInlineMenuProvider, type InlineMenuEntry } from './inline-context-menu';
import { aiMenuEntryFor, classifySelection, translationInstruction } from './selection-context';
import { calculatorChoices } from './calculators';
import { looksLikeDraft, parseOutline } from './outline-ast';
import { tidySelectedDraft } from './draft-tidy';
import type { WasmBridge } from '@/upstream/core';
import type { InputHandler } from '@/upstream/editor';
import './inline.css';

export class InlineRequest {
  private capture: Capture | null = null;
  constructor(private doc: Pick<AiDocument, 'captureSelection' | 'isCurrent'> & Partial<Pick<AiDocument, 'apply'>>, private dispatch = requestPanelEdit) {}
  /** wholeParagraphs widens the request to the selected paragraphs; the visible selection stays as it is. */
  open(wholeParagraphs = false): string { this.capture = this.doc.captureSelection({ wholeParagraphs }); return this.capture.before; }
  preparedText():string {if(!this.capture||!this.doc.isCurrent(this.capture))throw Error('문서나 선택이 바뀌었습니다. 다시 선택하세요.');return this.capture.before;}
  cancel(): void { this.capture = null; }
  /** False after a request was handed over; a retry from the same popover captures the selection again. */
  ready(): boolean { return this.capture !== null; }
  /** A locally computed replacement (calculator) applied to the captured selection: no model call, one Ctrl+Z. */
  async applyLocal(replacement: string): Promise<void> {
    const capture = this.capture;
    if (!capture || !this.doc.isCurrent(capture)) throw new Error('문서나 선택이 바뀌었습니다. 다시 선택하세요.');
    if (!this.doc.apply) throw new Error('이 문서에는 바로 넣을 수 없습니다.');
    this.capture = null; await this.doc.apply(capture, replacement);
  }
  submit(instruction: string, composing = false): void {
    const capture = this.capture, prompt = instruction.trim();
    if (composing) throw new Error('한글 입력을 마친 뒤 요청하세요.');
    if (!capture || !this.doc.isCurrent(capture)) throw new Error('문서나 선택이 바뀌었습니다. 다시 선택하세요.');
    if (!prompt) throw new Error('요청을 입력하세요.');
    this.dispatch(capture, prompt); this.capture = null;
  }
}

type Selection = NonNullable<ReturnType<InputHandler['getSelection']>>;
/** Ctrl+A on a single-section document: from the first body position to the end of the last body paragraph. */
export function selectsWholeDocument(wasm: Pick<WasmBridge,'getSectionCount'|'getParagraphCount'|'getParagraphLength'>, s: Selection | null): boolean {
  if (!s) return false;
  try {
    if (wasm.getSectionCount() !== 1) return false;
    const last = wasm.getParagraphCount(0) - 1, body = (p: Selection['start']) => p.sectionIndex === 0 && p.parentParaIndex === undefined && p.cellIndex === undefined && !p.isTextBox && !p.cellPath?.length;
    const [a, b] = s.start.paragraphIndex < s.end.paragraphIndex || s.start.paragraphIndex === s.end.paragraphIndex && s.start.charOffset <= s.end.charOffset ? [s.start, s.end] : [s.end, s.start];
    return body(a) && body(b) && a.paragraphIndex === 0 && a.charOffset === 0 && b.paragraphIndex === last && b.charOffset === wasm.getParagraphLength(0, last) && last > 0;
  } catch { return false; }
}

const POPOVER = '<form><header><strong class="inline-title">AI로 선택 영역 편집</strong><span class="inline-scope"></span><button type="button" class="inline-close" data-cancel aria-label="닫기">×</button></header>'
  + '<p class="inline-original"></p><label class="inline-expand" hidden><input type="checkbox"> 문단 전체로 넓히기 <span class="inline-expand-hint"></span></label><div class="inline-calc" role="group" aria-label="바로 계산" hidden></div><div class="inline-chips" role="group" aria-label="빠른 요청"></div><div class="inline-row"><textarea rows="2" maxlength="8000" placeholder="어떻게 바꿀까요? 예: 더 간결하게, 공문 어투로"></textarea>'
  + '<button type="submit" class="inline-send" aria-label="AI에 요청">↑</button></div><p class="inline-status" role="status"></p>'
  + '<small>Enter 보내기 · Shift+Enter 줄바꿈 · Esc 닫기 · 적용 후 Ctrl+Z로 되돌리기</small></form>';

/** Inline AI editor that opens next to the selection; transport and atomic apply stay in the common panel. */
export function installInlineEditor(deps: PanelDeps, doc: AiDocument, workflow = true): () => void {
  const area = document.getElementById('editor-area');
  if (!area) return () => {};
  const trigger = document.createElement('button'); trigger.className = 'achmage-inline-trigger';
  trigger.type = 'button'; trigger.textContent = 'AI로 선택 영역 편집'; trigger.hidden = true;
  trigger.setAttribute('aria-label', 'AI로 선택 영역 편집, Ctrl 또는 Command Shift K');
  const popover = document.createElement('div'); popover.className = 'achmage-inline-popover'; popover.hidden = true;
  popover.setAttribute('role', 'dialog'); popover.setAttribute('aria-label', 'AI로 선택 영역 편집'); popover.innerHTML = POPOVER;
  document.body.append(trigger, popover);
  const q = <T extends HTMLElement>(s: string) => popover.querySelector<T>(s)!;
  const prompt = q<HTMLTextAreaElement>('textarea'), status = q('.inline-status'), send = q<HTMLButtonElement>('.inline-send');
  const request = new InlineRequest(doc); let composing = false, mode: 'selection' | 'whole' | 'caret' | 'blocked' = 'blocked';
  // After a request is handed to the panel the popover stays open, shows quiet progress, and reports the outcome:
  // a failure or refusal appears here with its reason; a finished request closes the popover.
  let waiting: { sawWork: boolean; timer: ReturnType<typeof setTimeout> } | null = null;
  const say = (text: string, tone: 'error' | 'info' = 'error') => { status.textContent = text; status.dataset.tone = tone; };
  const stopWaiting = () => { if (!waiting) return; clearTimeout(waiting.timer); waiting = null; popover.classList.remove('is-waiting'); send.disabled = mode === 'blocked'; prompt.disabled = mode === 'blocked'; };
  const close = () => { if (popover.hidden) return; stopWaiting(); popover.hidden = true; request.cancel(); composing = false; deps.input.focus(); };
  const startWaiting = () => {
    stopWaiting(); say('처리 중입니다…', 'info'); popover.classList.add('is-waiting'); send.disabled = true; prompt.disabled = true;
    // Nothing observed at all: point to the panel instead of leaving the popover silent.
    waiting = { sawWork: false, timer: setTimeout(() => { if (waiting && !waiting.sawWork) { stopWaiting(); say('사이드 패널에서 진행 상황을 확인하세요.', 'info'); } }, 8000) };
  };
  const onPanelStatus = (event: Event) => {
    const detail = (event as CustomEvent<PanelStatus>).detail;
    if (!waiting || !detail) return;
    if (detail.message?.text) {
      if (detail.message.tone === 'error' || detail.final) { stopWaiting(); say(detail.message.text, detail.message.tone === 'error' ? 'error' : 'info'); prompt.focus(); return; }
      say(detail.message.text, 'info');
    }
    if (detail.working) waiting.sawWork = true;
    else if (waiting.sawWork) close();
  };
  // Below the highlighted selection (above it near the bottom edge), so the popover never covers the text being edited.
  const place = (anchor: { x: number; y: number }) => {
    const width = Math.min(440, innerWidth - 32), height = popover.getBoundingClientRect().height || 180;
    const marks = Array.from(document.querySelectorAll<HTMLElement>('.selection-highlight')).map(e => e.getBoundingClientRect()).filter(r => r.width > 0 && r.height > 0);
    const box = marks.length ? { left: Math.min(...marks.map(r => r.left)), top: Math.min(...marks.map(r => r.top)), bottom: Math.max(...marks.map(r => r.bottom)) } : { left: anchor.x, top: anchor.y, bottom: anchor.y };
    const below = box.bottom + 10, above = box.top - height - 10;
    popover.style.left = `${Math.max(16, Math.min(box.left, innerWidth - width - 16))}px`;
    popover.style.top = `${below + height <= innerHeight - 16 ? below : above >= 16 ? above : Math.max(16, innerHeight - height - 16)}px`;
  };
  const expand = q<HTMLLabelElement>('.inline-expand'), expandBox = expand.querySelector('input')!;
  // One tap sends a common request at once; the result applies directly and Ctrl+Z undoes it.
  const chips = q<HTMLDivElement>('.inline-chips');
  const setChips = (items: readonly { label: string; instruction: () => string }[]) => {
    chips.replaceChildren();
    for (const item of items) {
      const chip = document.createElement('button'); chip.type = 'button'; chip.textContent = item.label;
      chip.addEventListener('click', () => { prompt.value = item.instruction(); submit(); });
      chips.append(chip);
    }
    chips.hidden = items.length === 0;
  };
  const SELECTION_CHIPS = [
    { label: '교정', instruction: () => '맞춤법·띄어쓰기·문법만 고쳐줘. 내용과 어투는 바꾸지 마.' },
    { label: '요약', instruction: () => '핵심만 남겨 더 짧게 요약해줘.' },
    { label: '번역', instruction: () => translationInstruction(q('.inline-original').textContent ?? '') },
    { label: '다시 쓰기', instruction: () => '같은 뜻으로 더 자연스럽고 매끄럽게 다시 써줘.' },
  ];
  const EDIT_PLACEHOLDER = '어떻게 바꿀까요? 예: 더 간결하게, 공문 어투로', CARET_PLACEHOLDER = '무엇을 쓸까요? 예: 회의 안건 3개, 이 문단 다듬기';
  // Calculations on the selected amount/date/numbers apply at once, computed locally (no AI).
  const calc = q<HTMLDivElement>('.inline-calc');
  const setCalculators = (before: string) => {
    calc.replaceChildren();
    for (const choice of calculatorChoices(before)) {
      const chip = document.createElement('button'); chip.type = 'button'; chip.textContent = choice.label; chip.title = choice.result;
      chip.addEventListener('click', () => { void request.applyLocal(choice.result).then(() => close()).catch(error => { say(error instanceof Error ? error.message : '계산 결과를 넣지 못했습니다.'); }); });
      calc.append(chip);
    }
    // A rough draft (□ ○ -, numbering, "라벨: 내용", pipe/tab tables) is tidied locally: headings, items and real tables.
    if (looksLikeDraft(parseOutline(before))) {
      const chip = document.createElement('button'); chip.type = 'button'; chip.textContent = '서식 정리 (AI 없이)';
      chip.title = '항목 기호·번호·표를 문서 서식으로 정리합니다. Ctrl+Z로 되돌릴 수 있습니다.';
      chip.addEventListener('click', () => { void tidyDraft().then(close).catch(error => { say(error instanceof Error ? error.message : '초안을 정리하지 못했습니다.'); }); });
      calc.append(chip);
    }
    calc.hidden = calc.children.length === 0;
  };
  const tidyDraft = async () => { await tidySelectedDraft(doc); };
  const showSelection = (whole: boolean) => {
    const before = request.open(whole), paragraphs = before.split('\n').length;
    q('.inline-scope').textContent = `${paragraphs}문단 · ${Array.from(before).length}자`; q('.inline-original').textContent = before;
    setCalculators(before);
  };
  expandBox.addEventListener('change', () => {
    try { showSelection(expandBox.checked); status.textContent = ''; } catch (error) { say(error instanceof Error ? error.message : '선택 범위를 다시 확인하세요.'); }
    prompt.focus();
  });
  const open = (anchor: { x: number; y: number }) => {
    stopWaiting(); trigger.hidden = true; status.textContent = ''; prompt.value = ''; expand.hidden = true;
    try {
      // A selection that starts or ends inside a paragraph is offered as whole paragraphs; across paragraphs that is the default.
      const shape = doc.selectionShape();
      expandBox.checked = false; expand.hidden = !shape?.partial;
      q<HTMLElement>('.inline-expand-hint').textContent = shape?.partial ? '(선택이 문단 중간에서 끝납니다)' : '';
      mode = 'selection'; q('.inline-title').textContent = 'AI로 선택 영역 편집'; prompt.placeholder = EDIT_PLACEHOLDER;
      showSelection(expandBox.checked); setChips(SELECTION_CHIPS);
    } catch (error) {
      request.cancel();
      if(workflow){
        mode='caret';q('.inline-title').textContent='AI로 문서 작업';q('.inline-scope').textContent='기존 서식 유지';setChips([]);calc.hidden=true;prompt.placeholder=EDIT_PLACEHOLDER;
        q('.inline-original').textContent='요청한 항목을 문서에서 찾아 수정합니다. 범위가 불분명하면 먼저 확인합니다.';
      } else if (selectsWholeDocument(deps.wasm, deps.input.getSelection())) {
        // Tables and the cover cannot be edited as plain text, so the whole document is rewritten through the template engine.
        mode = 'whole'; q('.inline-title').textContent = 'AI로 문서 전체 편집'; q('.inline-scope').textContent = '표지·목차·표 포함'; setChips([]); calc.hidden = true; prompt.placeholder = EDIT_PLACEHOLDER;
        q('.inline-original').textContent = '선택한 문서 서식으로 문서 전체를 다시 구성해 이 창에 바로 반영합니다.';
      } else {
        mode = 'blocked'; q('.inline-title').textContent = 'AI로 선택 영역 편집'; q('.inline-scope').textContent = ''; setChips([]); calc.hidden = true;
        q('.inline-original').textContent = '';
        say(`${error instanceof Error ? error.message : '선택 영역을 확인하세요.'} 표를 뺀 문단만 선택하거나, 문서 전체(Ctrl+A)를 선택해 요청하세요.`);
      }
    }
    send.disabled = mode === 'blocked'; prompt.disabled = mode === 'blocked';
    popover.hidden = false; place(anchor); if (mode !== 'blocked') prompt.focus();
  };
  /** At the caret the request goes to the panel's router: it decides between writing here and polishing this paragraph. */
  const openCaret = (anchor: { x: number; y: number }) => {
    stopWaiting(); trigger.hidden = true; status.textContent = ''; prompt.value = ''; expand.hidden = true; request.cancel();
    mode = 'caret'; q('.inline-title').textContent = 'AI로 여기에 쓰기'; q('.inline-scope').textContent = '커서 위치'; prompt.placeholder = CARET_PLACEHOLDER; calc.hidden = true;
    let preview = '';
    try { const c = deps.input.getCursorPosition(), length = deps.wasm.getParagraphLength(c.sectionIndex, c.paragraphIndex); preview = length ? deps.wasm.getTextRange(c.sectionIndex, c.paragraphIndex, 0, length) : ''; } catch { /* no caret paragraph text */ }
    q('.inline-original').textContent = preview ? '이 문단: ' + (Array.from(preview).length > 160 ? Array.from(preview).slice(0, 160).join('') + '…' : preview) : '';
    setChips([{ label: '이어서 쓰기', instruction: () => '앞 내용에 자연스럽게 이어지는 문단을 이어서 써줘.' }, ...(preview ? [{ label: '이 문단 다듬기', instruction: () => '커서가 있는 문단을 더 매끄럽게 다듬어줘.' }] : [])]);
    send.disabled = false; prompt.disabled = false;
    popover.hidden = false; place(anchor); prompt.focus();
  };
  /** The right-click / shortcut entry for the current context (cheap: no document capture). */
  const openFor = (anchor: { x: number; y: number }) => {
    const entry = aiMenuEntryFor(classifySelection(deps.wasm, deps.input));
    if (entry?.mode === 'caret' && !entry.disabledReason) openCaret(anchor); else open(anchor);
  };
  const submit = () => {
    if (waiting || mode === 'blocked') return;
    // Waiting starts before the hand-over: the panel may refuse synchronously while handling the event.
    startWaiting();
    try {
      if (mode === 'selection') { if (!request.ready()) showSelection(expandBox.checked); request.submit(prompt.value, composing); }
      else if (mode === 'caret') {
        const text = prompt.value.trim();
        if (composing) throw Error('한글 입력을 마친 뒤 요청하세요.');
        if (!text) throw Error('요청을 입력하세요.');
        requestPanelAsk(text);
      }
      else if (mode === 'whole') {
        const text = prompt.value.trim();
        if (composing) throw Error('한글 입력을 마친 뒤 요청하세요.');
        if (!text) throw Error('요청을 입력하세요.');
        requestPanelWholeEdit(text);
      }
    } catch (error) { stopWaiting(); say(error instanceof Error ? error.message : '요청을 준비하지 못했습니다.'); }
  };
  const update = (event: MouseEvent | KeyboardEvent) => {
    if (!popover.hidden || (event.target instanceof HTMLElement && event.target.closest('.achmage-ai,.achmage-inline-popover'))) return;
    if(document.querySelector('.context-menu')||event instanceof MouseEvent&&event.button===2){trigger.hidden=true;return;}
    const selection = deps.input.getSelection();
    trigger.hidden = !selection || (selection.start.charOffset === selection.end.charOffset && selection.start.paragraphIndex === selection.end.paragraphIndex);
    if (!trigger.hidden) {
      const rect = area.getBoundingClientRect();
      const x = event instanceof MouseEvent ? event.clientX : rect.left + 80, y = event instanceof MouseEvent ? event.clientY : rect.top + 40;
      trigger.style.left = `${Math.max(8, Math.min(x, innerWidth - 240))}px`;
      trigger.style.top = `${Math.max(8, Math.min(y + 12, innerHeight - 60))}px`;
      trigger.textContent = 'AI로 선택 영역 편집';
    }
  };
  const triggerAnchor = () => { const r = trigger.getBoundingClientRect(); return { x: r.left, y: r.top }; };
  const key = (e: KeyboardEvent) => {
    if (!popover.hidden && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'k' && !e.isComposing && area.contains(document.activeElement)) {
      e.preventDefault(); e.stopPropagation(); const r = area.getBoundingClientRect(); openFor({ x: r.left + 80, y: r.top + 60 });
    }
  };
  const outside = (e: MouseEvent) => { if (!popover.hidden && e.target instanceof Node && !popover.contains(e.target)) close(); };
  // Opening the menu stays instant: only cheap position checks here; the exact capture (document hash, runs) runs on click.
  const unregisterMenu=registerInlineMenuProvider(()=>{
    trigger.hidden=true;
    const entry=aiMenuEntryFor(classifySelection(deps.wasm,deps.input)),entries:InlineMenuEntry[]=[];
    if(entry)entries.push(entry.disabledReason&&!workflow?{label:entry.label,disabledReason:entry.disabledReason,choose:()=>{}}:{label:entry.label,choose:anchor=>entry.mode==='caret'?openCaret(anchor):open(anchor)});
    // A document with a contents page offers the page-number refresh directly (no AI, one Ctrl+Z).
    if(hasContentsHeading(deps.wasm))entries.push({label:'목차 쪽 번호 새로 고침 (AI 없이)',choose:()=>requestPanelTocRefresh()});
    return entries;
  });
  trigger.addEventListener('mousedown', e => e.preventDefault()); trigger.addEventListener('click', () => open(triggerAnchor()));
  q('[data-cancel]').addEventListener('click', close);
  prompt.addEventListener('compositionstart', () => { composing = true; }); prompt.addEventListener('compositionend', () => { composing = false; });
  prompt.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !composing) { e.preventDefault(); submit(); } });
  q('form').addEventListener('submit', e => { e.preventDefault(); submit(); });
  area.addEventListener('mouseup', update); area.addEventListener('keyup', update);
  document.addEventListener('keydown', key, true); document.addEventListener('mousedown', outside, true); document.addEventListener(PANEL_STATUS_EVENT, onPanelStatus);
  return () => { stopWaiting(); document.removeEventListener(PANEL_STATUS_EVENT, onPanelStatus); unregisterMenu(); request.cancel(); trigger.remove(); popover.remove(); area.removeEventListener('mouseup', update); area.removeEventListener('keyup', update); document.removeEventListener('keydown', key, true); document.removeEventListener('mousedown', outside, true); };
}
