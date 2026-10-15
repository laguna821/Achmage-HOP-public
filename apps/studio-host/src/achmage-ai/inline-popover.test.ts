import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installInlineEditor } from './inline';
import { PANEL_EDIT_EVENT, publishPanelStatus, type PanelEditRequest } from './panel-events';
import type { AiDocument } from './document';
import type { PanelDeps } from './panel';

const VOID = new Set(['input', 'br', 'img']);
// Small nested DOM double: the popover's real markup, handlers and state changes run unchanged.
class El extends EventTarget {
  children: El[] = []; parent: El | null = null; tagName: string; className = ''; textContent = ''; value = ''; placeholder = ''; checked = false; disabled = false; hidden = false; type = '';
  dataset: Record<string, string> = {}; attrs = new Map<string, string>(); style: Record<string, string> = {};
  classList = { add: (c: string) => this.setClasses([...this.classes(), c]), remove: (c: string) => this.setClasses(this.classes().filter(x => x !== c)), contains: (c: string) => this.classes().includes(c), toggle: (c: string, on: boolean) => { on ? this.classList.add(c) : this.classList.remove(c); return on; } };
  constructor(tag = 'div') { super(); this.tagName = tag.toUpperCase(); }
  private classes() { return this.className.split(/\s+/).filter(Boolean); }
  private setClasses(list: string[]) { this.className = [...new Set(list)].join(' '); }
  set innerHTML(markup: string) {
    this.children = []; const stack: El[] = [this];
    for (const m of markup.matchAll(/<(\/?)(\w+)([^>]*)>/g)) {
      if (m[1]) { stack.pop(); continue; }
      const el = new El(m[2]);
      for (const a of m[3].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) { const [k, v = ''] = [a[1], a[2]]; el.setAttribute(k, v); if (k === 'class') el.className = v; if (k === 'hidden') el.hidden = true; if (k === 'type') el.type = v; if (k.startsWith('data-')) el.dataset[k.slice(5)] = v; }
      stack.at(-1)!.append(el); if (!VOID.has(m[2])) stack.push(el);
    }
  }
  append(...els: El[]) { for (const el of els) { el.parent = this; this.children.push(el); } }
  replaceChildren() { this.children = []; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); }
  setAttribute(k: string, v: string) { this.attrs.set(k, v); }
  all(): El[] { return this.children.flatMap(c => [c, ...c.all()]); }
  matches(s: string) { if (s.startsWith('.')) return this.classes().includes(s.slice(1)); const a = s.match(/^\[([\w-]+)\]$/); if (a) return this.attrs.has(a[1]); return this.tagName === s.toUpperCase(); }
  querySelector<T>(s: string) { return (this.all().find(e => e.matches(s)) ?? null) as T; }
  contains(node: unknown) { return node === this || this.all().includes(node as El); }
  getBoundingClientRect() { return { left: 100, top: 100, bottom: 120, right: 300, width: 200, height: 20 }; }
  focus() {}
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
}
class Doc extends EventTarget {
  body = new El('body'); area = new El('div');
  getElementById(id: string) { return id === 'editor-area' ? this.area : null; }
  createElement(tag: string) { return new El(tag); }
  querySelectorAll() { return []; }
  querySelector() { return null; }
}

let dom: Doc, stop: () => void, edits: PanelEditRequest[], onEdit: (detail: PanelEditRequest) => void;
const popover = () => dom.body.children.find(e => e.className.includes('achmage-inline-popover'))!;
const trigger = () => dom.body.children.find(e => e.className.includes('achmage-inline-trigger'))!;
const q = (s: string) => popover().querySelector<El>(s)!;
const chip = (label: string) => q('.inline-chips').children.find(c => c.textContent === label)!;
const capture = { before: '선택한 문장입니다', command: {}, selection: 'fixed' };
const captureSelection = vi.fn(() => capture);
function start() {
  const doc = { captureSelection, isCurrent: () => true, selectionShape: () => ({ partial: false, paragraphs: 1 }) } as unknown as AiDocument;
  const deps = { input: { focus: () => {}, getSelection: () => null, getCursorPosition: () => ({ sectionIndex: 0, paragraphIndex: 0 }) }, wasm: {} } as unknown as PanelDeps;
  stop = installInlineEditor(deps, doc);
  trigger().click();
}

beforeEach(() => {
  vi.useFakeTimers(); dom = new Doc(); edits = []; onEdit = () => {}; captureSelection.mockClear();
  vi.stubGlobal('document', dom); vi.stubGlobal('innerWidth', 1200); vi.stubGlobal('innerHeight', 800);
  dom.addEventListener(PANEL_EDIT_EVENT, e => { const detail = (e as CustomEvent<PanelEditRequest>).detail; edits.push(detail); onEdit(detail); });
});
afterEach(() => { stop?.(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('inline popover reports every outcome in place (T03)', () => {
  it('shows quiet progress after a chip, then closes when the panel finishes', () => {
    start(); expect(popover().hidden).toBe(false);
    chip('교정').click();
    expect(edits).toHaveLength(1); expect(edits[0].instruction).toContain('맞춤법');
    expect(popover().hidden).toBe(false); expect(popover().classList.contains('is-waiting')).toBe(true);
    expect(q('.inline-status').textContent).toBe('처리 중입니다…'); expect(q('textarea').disabled).toBe(true);
    publishPanelStatus({ working: true }); expect(popover().hidden).toBe(false);
    publishPanelStatus({ working: false }); expect(popover().hidden).toBe(true);
  });

  it('shows a refusal the panel gives while handling the request, and keeps the popover usable', () => {
    onEdit = () => publishPanelStatus({ working: false, message: { text: '표가 든 선택은 이 방식으로 고칠 수 없습니다.', tone: 'error' } });
    start(); chip('교정').click();
    expect(popover().hidden).toBe(false); expect(popover().classList.contains('is-waiting')).toBe(false);
    expect(q('.inline-status').textContent).toBe('표가 든 선택은 이 방식으로 고칠 수 없습니다.'); expect(q('.inline-status').dataset.tone).toBe('error');
    expect(q('textarea').disabled).toBe(false); expect(q('.inline-send').disabled).toBe(false);
  });

  it('shows a later failure with its reason, then a retry captures the selection again', () => {
    start(); chip('요약').click(); publishPanelStatus({ working: true });
    publishPanelStatus({ working: true, message: { text: '개인정보 표시를 가렸습니다.', tone: 'info' } });
    expect(q('.inline-status').textContent).toBe('개인정보 표시를 가렸습니다.'); expect(popover().classList.contains('is-waiting')).toBe(true);
    publishPanelStatus({ working: false, message: { text: '응답을 완료하지 못했습니다. 연결 또는 모델 사용 권한을 확인하세요.', tone: 'error' } });
    expect(popover().hidden).toBe(false); expect(q('.inline-status').textContent).toContain('응답을 완료하지 못했습니다');
    expect(captureSelection).toHaveBeenCalledTimes(1);
    q('textarea').value = '더 짧게'; q('form').dispatchEvent(new Event('submit'));
    expect(captureSelection).toHaveBeenCalledTimes(2); expect(edits).toHaveLength(2); expect(edits[1].instruction).toBe('더 짧게');
  });

  it('never stays silent: with no panel signal at all it points to the panel', () => {
    start(); chip('교정').click();
    vi.advanceTimersByTime(8000);
    expect(popover().hidden).toBe(false); expect(popover().classList.contains('is-waiting')).toBe(false);
    expect(q('.inline-status').textContent).toBe('사이드 패널에서 진행 상황을 확인하세요.');
  });

  it('a local validation error stays in the popover and nothing is sent', () => {
    start(); q('textarea').value = '   '; q('form').dispatchEvent(new Event('submit'));
    expect(edits).toHaveLength(0); expect(q('.inline-status').textContent).toBe('요청을 입력하세요.');
    expect(popover().classList.contains('is-waiting')).toBe(false);
  });

  it('ignores panel status that belongs to no inline request', () => {
    start(); publishPanelStatus({ working: false, message: { text: '다른 요청 실패', tone: 'error' } });
    expect(q('.inline-status').textContent).toBe(''); expect(popover().hidden).toBe(false);
  });
});
