import {runWorkflow} from './workflow/runtime';
import {WorkflowDraft} from './workflow/draft';
import {WorkflowModelClient} from './workflow/provider-bridge';
import { tidySelectedDraft } from './draft-tidy';
import { describeTextFormat, type TextFormat } from './text-format';
import { AiConnection, authSession, sameAuthSession, nativeTransport, shouldPoll, usageLabel, type AiAction, type AiTransport, type ProviderId } from './bridge';
import { AiDocument, type Capture } from './document';
import { prepareStructuredEdit, decodeStructuredResponse, mentionsWholeDocument, resolveDocumentTemplate } from './document-intent';
import { classifyRequest, describeRoute, needsStructure, type Route, type RouteInput } from './request-route';
import { buildDocumentStateCard, type DocumentStateCard } from './document-state-card';
import { hasPersonalToken, maskNotice, maskPersonal, restorePersonal, type MaskedText } from './outbound-gate';
import { decodeRouterReply, describeOperation, looksLikeRouterAction, mentionsTemplate, offerOperations, routeForOperation, routerPrompt, WHOLE_DOCUMENT_SCOPE, type OperationId, type TemplateOffer } from './intent-router';
import {captureWholeDocumentContext} from './whole-document-context';
import { documentManuscript, documentManuscriptNotices, documentMarkdown, maskedDocumentBlocks, type DocumentManuscript } from './document-manuscript';
import { applyBlockPatch, blockPatchSummary, parseBlockPatch } from './block-patch';
import { normalizeMultiReplacement } from './multi-range';
import { calculatorChoices, fixWeekdays } from './calculators';
import { fillProfile, loadProfile, profilePromptLine, saveProfile, PROFILE_FIELDS, type UserProfile } from './user-profile';
import { structuredParagraphs, StructureUnsupportedError, type StructuredCapture, type ParagraphRange } from './structured-edit';
import { templateLayout, templateGroup, COVER_TOC_PRESETS, BUILTIN_DOCUMENT_TEMPLATES, type DocumentTemplate } from './document-templates';
import type { RhwpDocumentStateV1 } from '@/upstream/document-agent';
import {kordocAuthoringPrompt,createKordocDocument,prepareKordocAuthoring,openRecoveredDocumentWindow} from './kordoc-authoring';
import { installDocumentTemplates } from './template-picker';
import { AS_WRITTEN_REQUEST, LOCAL_MANUSCRIPT_CHARS, MODEL_DOCUMENT_CHARS, REWRITE_REQUEST, asksOnlyForLook, manuscriptMarkdown, splitManuscript } from './manuscript';
import { ensureDesktopFontsAvailable, detectDesktopFontEntries, resolveDesktopFont } from '../core/desktop-local-fonts';
import { PANEL_MARKUP, AI_BADGE } from './panel-view';
import { installInlineEditor } from './inline';
import { installRuntimeTools } from './runtime-tools';
import { installTelegramSettings } from './telegram-settings';
import { requestTemplateImport, PANEL_ASK_EVENT, PANEL_EDIT_EVENT, PANEL_RESTYLE_EVENT, PANEL_TOC_EVENT, PANEL_WHOLE_EDIT_EVENT, publishPanelStatus, registerPanelAction, watchPanelActions, type PanelEditRequest, type PanelAction } from './panel-events';
import { installResearchExtension } from '../achmage-research';
import { conversationContext, addHistory, loadHistory, saveHistory, panelWidth, acceptsCompletion, unwrapQuotedReply, loadProvider, saveProvider, PANEL_WIDTH_KEY, CHAT_STORAGE_KEY, type ChatEntry } from './panel-state';
import type { WasmBridge, EventBus } from '@/upstream/core';
import type { InputHandler } from '@/upstream/editor';
import type { CanvasView } from '@/upstream/view';

const LAYOUT_LABELS: Record<string, string> = { pgnp: '쪽 번호 위치', pghd: '쪽 감추기', nwno: '새 쪽 번호' };
/** Discloses the open document's layout that the selected template replaced (restorable with Ctrl+Z). */
function replacedLayoutNotices(removed: string[]): string[] {
  const notices: string[] = [], hf = [removed.includes('head') && '머리말', removed.includes('foot') && '꼬리말'].filter(Boolean);
  // Header/footer content (text, logos) is not part of the body sent to the AI, so say plainly that it was replaced.
  if (hf.length) notices.push(`기존 ${hf.join('·')}은 글·그림을 포함해 새 서식으로 바뀌었습니다. 필요하면 Ctrl+Z로 되돌리세요.`);
  const labels = [...new Set(removed.map(id => LAYOUT_LABELS[id]).filter(Boolean))];
  if (labels.length) notices.push(`기존 ${labels.join('·')} 설정은 새 서식 기준으로 바뀌었습니다.`);
  return notices;
}
/** Engine authoring hints addressed to the writer (summary-box syntax, preview caveats) are not shown to the user. */
function userFacingEngineNotice(notice: string): boolean {
  // Renderer notes about its own preview geometry ("분할 지오메트리 … region") are not about the document.
  return !/^미리보기는 Kordoc 조판 결과입니다|요약박스가 없습니다|지오메트리|region/u.test(notice);
}
/** The chat keeps what a block patch changed, not its JSON. */
function blockPatchHistory(reply: string, count: number): string {
  try { return 'AI가 ' + blockPatchSummary(parseBlockPatch(reply, count), count); } catch { return '문서 변경 응답을 읽지 못했습니다.'; }
}
function documentDraftSummary(markdown: string): string {
  const title = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim(), sections = (markdown.match(/^##\s+/gm) ?? []).length, tables = (markdown.match(/^\|\s*-{3,}/gm) ?? []).length;
  return `문서 초안을 작성했습니다${title ? `: ${title}` : ''} (소제목 ${sections}개 · 표 ${tables}개). 내용은 문서 창에서 확인하세요.`;
}
export interface PanelDeps { wasm: WasmBridge; input: InputHandler; eventBus: EventBus; view: CanvasView; dirty(): boolean; undo(): void }
/** router: free-form chat messages are interpreted by the model (default); false keeps the local rules only. */
export interface PanelOptions { workflow?:boolean; router?: boolean; /** At launch, reselect the last provider and pick up its existing sign-in (default on). */ restoreSignIn?: boolean }
// This orchestration stays in one owner so request/account/document fences cannot diverge.
// Grok is not listed: its CLI default model is used, and a status probe would reset a finished answer.
const CATALOG_PROVIDERS=new Set<ProviderId>(['openai','claude','gemini']);
export function installAiPanel(deps: PanelDeps, transport: AiTransport = nativeTransport, panelOptions: PanelOptions = {}): () => void {
  const workflowEnabled=panelOptions.workflow!==false;
  let workflowSources:{id:string;text:string}[]=[];
  let workflowAbort:AbortController|null=null,workflowClient:WorkflowModelClient|undefined,retainedSelection:Capture|undefined;
  let lastWorkflow:{identity:string;summary:string}|undefined;
  const routerEnabled = panelOptions.router !== false;
  const area = document.getElementById('editor-area');
  if (!area?.parentElement) throw new Error('editor area unavailable');
  const workspace = document.createElement('div'); workspace.className = 'achmage-workspace';
  area.before(workspace); workspace.append(area);
  const panel = document.createElement('aside'); panel.className = 'achmage-ai'; panel.id = 'achmage-ai-panel'; panel.setAttribute('aria-label', 'Achmage AI 채팅');
  panel.innerHTML = PANEL_MARKUP; workspace.append(panel);
  const opener = document.createElement('button'); opener.className = 'achmage-ai-opener'; opener.innerHTML = AI_BADGE; opener.setAttribute('aria-label', 'Achmage AI 문서 도우미'); opener.setAttribute('title', 'Achmage AI 문서 도우미'); opener.setAttribute('aria-controls', panel.id);
  const toolbar = document.getElementById('icon-toolbar');
  let toolbarTrack: HTMLDivElement | null = null, toolbarScroll: HTMLDivElement | null = null;
  if (toolbar) {
    toolbarScroll = document.createElement('div'); toolbarScroll.className = 'achmage-toolbar-scroll';
    toolbarScroll.setAttribute('aria-label', '문서 도구 모음'); toolbarScroll.tabIndex = 0;
    toolbarTrack = document.createElement('div'); toolbarTrack.className = 'achmage-toolbar-track';
    toolbarTrack.append(...Array.from(toolbar.children)); toolbarScroll.append(toolbarTrack); toolbar.append(toolbarScroll, opener);
  } else (document.getElementById('menu-bar') ?? workspace).append(opener);
  const q = <T extends HTMLElement>(selector: string) => panel.querySelector<T>(selector)!;
  const button = (name: string) => q<HTMLButtonElement>(`[data-action="${name}"]`);
  // Toolbar buttons that open an extension's action.
  const extensionButtons: [string, string][] = [['templates','document-templates'],['research','research'],['mcp','research-settings']];
  const prompt = q<HTMLTextAreaElement>('.achmage-prompt'), mode = q<HTMLInputElement>('.achmage-edit-mode');
  // If an edit and its rollback both fail, the document as it was just before opens in a new window.
  const doc = new AiDocument(deps.wasm, deps.input, deps.eventBus, deps.view, deps.dirty, bytes => openRecoveredDocumentWindow(bytes, deps.wasm.fileName));
  // Content identity only (same fields as AiDocument.owns): saving (dirty) or re-pagination must not discard a result.
  const generationIdentity = () => { if (deps.wasm.pageCount === 0) return 'home'; const s = doc.identity(); return JSON.stringify([s.documentEpoch, s.changeSeq, s.documentSha256]); };
  const stopInline = installInlineEditor(deps, doc, workflowEnabled);
  const stopRuntime = installRuntimeTools();
  const stopTelegram = installTelegramSettings();
  let stopImage: () => void = () => {};
  let disposed = false, polling = false, composing = false, applying = false, closed = false;
  let extensionActions: PanelAction[] = [];
  let width = 380, history: ChatEntry[] = [], renderedHistory = '', renderedModels = '', renderedProviders = '';
  let loginIntent: { provider: ProviderId; until: number } | null = null;
  /** The provider chosen in an earlier session, selected again once it is available (first 20 s after launch). */
  let savedProvider: ProviderId | null = null; const providerRestoreUntil = panelOptions.restoreSignIn === false ? 0 : Date.now() + 20_000, restoreChecked = new Set<ProviderId>();
  try { savedProvider = loadProvider(localStorage); } catch { savedProvider = null; }
  try { history = workflowEnabled?[]:loadHistory(localStorage); const saved = localStorage.getItem(PANEL_WIDTH_KEY); if (saved !== null) width = panelWidth(Number(saved)); } catch { /* unavailable storage keeps a working in-memory session */ }
  type RouterPlan = { text: string; template?: DocumentTemplate; card: DocumentStateCard; templates: TemplateOffer[]; document: string; selection: string };
  let request: { id: string; payload: string; mask?: MaskedText; failed?: boolean; completedAt?: number; routedMs?: number; lastTextLength?: number; lastTextAt?: number; model?: string; effort?: string; router?: RouterPlan; capture?: Capture; structured?: StructuredCapture; kordoc?: string; blockPatch?: { blocks: string[] }; local?: boolean; inPlace?: { identity: RhwpDocumentStateV1; hideFirstPage: boolean; toc?: boolean }; styleContext?: DocumentTemplate; notices?: string[]; startedAt: number; firstTextAt?: number; session: string; provider: ProviderId; completed: boolean; stale: boolean } | null = null;
  /** The AI only hears turns after this point; '새 대화 시작' moves it. Plain answers can be inserted as-is. */
  let contextFrom = 0, lastAnswer: string | undefined, conversationSession: string | null = null;
  let profile: UserProfile = {};
  try { profile = loadProfile(localStorage); } catch { /* storage unavailable: no profile */ }
  /** Buttons under the last answer: clarification choices or a retry. They run without another routing turn. */
  let choices: { session: string; options: { label: string; run: () => void }[] } | null = null;
  const choiceBox = document.createElement('div'); choiceBox.className = 'achmage-clarify'; choiceBox.hidden = true; q('.achmage-transcript').append(choiceBox);
  let documentTemplates: ReturnType<typeof installDocumentTemplates> | undefined;
  let lastApplied: { session: string; range: ParagraphRange; paragraphs: string[] } | undefined;
  /** Why a send cannot start now, in terms of what is happening and what to do. */
  const busyMessage = (): string => {
    const state = connection.current;
    if (composing) return '한글 입력을 마친 뒤 보내세요.';
    if (applying) return '문서에 반영하는 중입니다. 잠시만 기다려 주세요.';
    if (state?.auth.status !== 'signed_in') return '먼저 AI 계정을 연결하세요.';
    if (state.turn?.status === 'running' || state.busy) return '앞선 요청을 처리하고 있습니다. 끝날 때까지 기다리거나 ■ 버튼으로 중지하세요.';
    return '연결 상태를 확인하는 중입니다. 잠시 뒤 다시 보내 주세요.';
  };
  /** "AI 3.2초 · 적용 0.4초": waiting for the model and local application are reported separately. */
  const seconds = (ms: number) => ms < 10_000 ? (ms / 1000).toFixed(1) + '초' : Math.round(ms / 1000) + '초';
  const timing = (done: { startedAt: number; completedAt?: number; routedMs?: number; local?: boolean }, applyMs: number) =>
    // A request the app handled alone spent no time waiting for a model.
    done.local ? `(${done.routedMs !== undefined ? '요청 이해 ' + seconds(done.routedMs) + ' · ' : ''}조판·적용 ${seconds(applyMs)})`
      : `(${done.routedMs !== undefined ? '요청 이해 ' + seconds(done.routedMs) + ' · ' : ''}AI ${seconds((done.completedAt ?? performance.now()) - done.startedAt)} · 적용 ${seconds(applyMs)})`;
  let publishedWorking = false;
  // Outcomes kept only in the transcript are also told to a waiting inline popover.
  const settle = (text: string, tone: 'error' | 'info') => publishPanelStatus({ working: false, final: true, message: { text, tone } });
  const message = (text: string, tone: 'error' | 'success' | 'info' = 'error') => { const element = q('.achmage-message'); element.textContent = text; element.dataset.tone = tone; if (text) publishPanelStatus({ working: publishedWorking, message: { text, tone } }); };
  const connection = new AiConnection(transport, render);
  workflowClient=new WorkflowModelClient(connection);
  const setWidth = (value: number) => { width = panelWidth(value); panel.style.setProperty('--achmage-panel-width', width + 'px'); q('.achmage-resize').setAttribute('aria-valuenow', String(width)); };
  const saveWidth = () => { try { localStorage.setItem(PANEL_WIDTH_KEY, String(width)); } catch { /* optional preference */ } };
  setWidth(width);
  function setClosed(value: boolean): void {
    closed = value; panel.hidden = value; workspace.classList.toggle('ai-closed', value); opener.setAttribute('aria-expanded', String(!value));
    if (value) opener.focus(); else { prompt.focus(); void refresh(); }
    window.dispatchEvent(new Event('resize'));
  }
  function remember(entry: ChatEntry): void {
    history = addHistory(history, entry);
    try { if (!saveHistory(localStorage, history)) message('대화 저장 공간이 부족합니다. 현재 창에서는 계속 사용할 수 있습니다.'); } catch { message('대화는 현재 창에서만 유지됩니다.'); }
  }
  /** Personal identifiers were masked before sending; the reply gets the original values back locally. */
  function restoredReply(active: { mask?: MaskedText } | null | undefined, text: string): { text: string; unknown: string[]; missing: number } {
    if (!active?.mask?.tokens.size) return { text, unknown: [], missing: 0 };
    return restorePersonal(text, active.mask);
  }
  /** What a chat entry says to a reader: validated edit plans as their body text, tabs as spaces. */
  function entryText(entry: ChatEntry): string {
    let visibleText = entry.text;
    if (entry.role === 'assistant') {
      try { visibleText = decodeStructuredResponse(entry.text, { validateFonts: false }).paragraphs.map(p => p.table ? p.table.map(row => row.map(cell => cell.runs.map(r => r.text).join('')).join(' · ')).join('\n') : p.runs.map(r => r.text).join('')).join('\n\n'); } catch { if (/"schemaVersion"\s*:\s*[12]/u.test(entry.text)) visibleText='문서 편집 응답을 확인하지 못했습니다.'; }
    }
    // Edited body text keeps its list marker + tab; a tab is meaningless in the chat bubble.
    return visibleText.replace(/\t/g, ' ');
  }
  function renderHistory(): void {
    const transcript = q('.achmage-transcript'), follow = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80;
    const visible = workflowEnabled?history:history.filter(entry => entry.provider === connection.current?.selectedProvider);
    const signature = JSON.stringify(visible); if (signature === renderedHistory) return;
    renderedHistory = signature; const host = q('.achmage-history'); host.replaceChildren();
    for (const entry of visible) {
      const item = document.createElement('article'); item.className = 'achmage-chat-entry ' + entry.role;
      const label = document.createElement('small'); label.textContent = entry.role === 'user' ? '나' : 'Achmage';
      const text = document.createElement('div');
      text.textContent = entryText(entry); item.append(label, text); host.append(item);
    }
    q('.achmage-empty').hidden = visible.length > 0;
    if (follow) transcript.scrollTop = transcript.scrollHeight;
  }
  /** At launch: select the provider chosen last time, then pick up the sign-in this computer already has
   * (a status check only, on every OS and provider; it never starts a new login). */
  function restoreProvider(): void {
    const state = connection.current;
    if (Date.now() > providerRestoreUntil || !state || connection.busy || state.commandPending || state.busy || loginIntent) return;
    if (savedProvider && state.selectedProvider !== savedProvider) {
      if (!state.providers.some(p => p.id === savedProvider && p.available)) return;
      const provider = savedProvider; savedProvider = null;
      void act({ type: 'select_provider', provider });
      return;
    }
    savedProvider = null;
    if (!restoreChecked.has(state.selectedProvider) && state.auth.status === 'signed_out') {
      restoreChecked.add(state.selectedProvider);
      void act({ type: 'restore_connection' });
    }
  }
  function render(): void {
    if (disposed) return;
    workflowClient?.accept(connection.current);
    restoreProvider();
    const state = connection.current, locked = connection.busy || state?.commandPending === true || applying;
    const signed = state?.auth.status === 'signed_in', running = state?.turn?.status === 'running' || !!workflowAbort;
    if (authSession(state) !== conversationSession) { conversationSession = authSession(state); lastAnswer = undefined; lastApplied = undefined; choices = null; }
    if (request && !sameAuthSession(state, request.session)) {
      request = null;
      message('로그인 상태가 바뀌어 이전 계정의 요청을 버렸습니다.');
    }
    if (state) {
      const label = state.providers.find(p => p.id === state.selectedProvider)?.label ?? state.selectedProvider;
      const providerKey = JSON.stringify(state.providers);
      if (providerKey !== renderedProviders) { renderedProviders = providerKey; const select = q<HTMLSelectElement>('.achmage-provider-switch'); select.replaceChildren(); for (const provider of state.providers) { const option = document.createElement('option'); option.value = provider.id; option.textContent = provider.available ? provider.label : `${provider.label} · 사용 불가`; option.title = provider.available ? provider.label : provider.unavailableReason || '연결 준비 중'; option.disabled = !provider.available; select.append(option); } }
      q<HTMLSelectElement>('.achmage-provider-switch').value = state.selectedProvider;
      const status = ({ signed_out: '로그인하지 않음', pending: '공식 인증을 기다리는 중', signed_in: '연결됨', expired: '로그인이 만료됨', error: '연결 실패' })[state.auth.status];
      q('.achmage-account').textContent = `${label} · ${status}${state.auth.accountLabel ? ' · ' + state.auth.accountLabel : ''}${state.auth.plan ? ' · ' + state.auth.plan : ''}`;
      button('account').textContent = signed ? label : '계정';
      q('.achmage-login-status').textContent = state.auth.message || status;
      q('.achmage-usage').textContent = usageLabel(state.usage); q('.achmage-usage').hidden = !q('.achmage-usage').textContent;
      q('.achmage-native-notice').textContent = [state.notice, request && state.turn?.requestId === request.id && state.turn.status === 'error' ? state.turn.message || '응답을 완료하지 못했습니다.' : ''].filter(Boolean).join('\n');
      q('.achmage-persistence').textContent = state.sessionPersistence === 'process_only' ? '현재 연결은 앱을 닫으면 종료됩니다.' : '';
      const models = state.models ?? [];
      const modelKey = JSON.stringify([state.selectedProvider, models]);
      if (modelKey !== renderedModels) { renderedModels = modelKey; const select = q<HTMLSelectElement>('.achmage-model'); const previous=select.value; select.replaceChildren(); for (const model of models) { const option = document.createElement('option'); option.value = model.id; option.textContent = model.label; select.append(option); } if (models[0]) select.value = models.some(m=>m.id===previous)?previous:(models.find(m=>m.isDefault)??models[0]).id; }
      q('.achmage-model-label').hidden = models.length === 0;
      const selectedModel=models.find(model=>model.id===q<HTMLSelectElement>('.achmage-model').value);
      q<HTMLSelectElement>('.achmage-model').title=selectedModel?.label??'AI 모델';
      const efforts=selectedModel?.supportedReasoningEfforts??[], effort=q<HTMLSelectElement>('.achmage-effort');
      const effortKey=JSON.stringify([state.selectedProvider,selectedModel?.id,efforts]);
      if(effort.dataset.catalog!==effortKey){const previous=effort.value;effort.dataset.catalog=effortKey;effort.replaceChildren();for(const item of efforts){const option=document.createElement('option');option.value=item.reasoningEffort;option.textContent=item.reasoningEffort;option.title=item.description??'';effort.append(option);}effort.value=efforts.some(item=>item.reasoningEffort===previous)?previous:selectedModel?.defaultReasoningEffort??efforts[0]?.reasoningEffort??'';}
      q('.achmage-effort-label').hidden=efforts.length===0;
      effort.disabled=locked||!!running;
      q('.achmage-model-status').textContent=state.modelCatalogStatus==='loading'?'계정에서 사용 가능한 모델을 확인하고 있습니다.':state.modelCatalogStatus==='error'?state.modelCatalogMessage??'모델 목록을 확인하지 못했습니다. 계정 메뉴에서 다시 불러오세요.':signed&&models.length===0?'공식 기본 모델을 사용합니다.':'';
      button('tools').hidden=state.selectedProvider!=='gemini';
      if (request && state.turn?.requestId === request.id && state.turn.text && request.firstTextAt === undefined) { request.firstTextAt = performance.now(); performance.measure('achmage:first-response', { start: request.startedAt, end: request.firstTextAt }); }
      if (request && state.turn?.requestId === request.id) { const length = (state.turn.text || '').length; if (length !== request.lastTextLength) { request.lastTextLength = length; request.lastTextAt = performance.now(); } }
      if (request && !request.completed && acceptsCompletion(request, authSession(state), state.turn)) {
        request.completed = true; request.completedAt = performance.now(); if (request.failed) choices = null;
        performance.measure('achmage:response-complete', { start: request.startedAt, end: performance.now() });
        const reply = restoredReply(request, state.turn?.text || '');
        if (request.router) { const routed = request; void routeReply(routed, reply.text); }
        else {
          // A document draft belongs in the document window; the chat keeps a short, human-readable line.
          remember({ id: request.id, provider: request.provider, role: 'assistant', text: request.blockPatch ? blockPatchHistory(reply.text, request.blockPatch.blocks.length) : request.kordoc ? documentDraftSummary(reply.text) : reply.text, at: Date.now() });
          if (request.capture || request.structured || request.kordoc) {
            const completed = request;
            if (reply.unknown.length) { if (request === completed) request = null; message('AI 응답에 보내지 않은 개인정보 표시(' + reply.unknown.join(', ') + ')가 있어 문서에 적용하지 않았습니다.'); }
            else { if (reply.missing && !completed.blockPatch) (completed.notices ??= []).push(`AI 결과에서 개인정보 ${reply.missing}건이 빠졌습니다. 필요하면 다시 넣어 주세요.`); void applyResponse(completed, reply.text); }
          }
        }
      }
    }
    // A failed turn stays the active request (a late completion still applies) but offers a retry.
    if (state && request && !request.completed && !request.failed && sameAuthSession(state, request.session) && state.turn?.requestId === request.id && state.turn.status === 'error') {
      const failed = request; failed.failed = true;
      remember({ id: failed.id + ':error', provider: failed.provider, role: 'assistant', text: `요청을 끝내지 못했습니다. ${state.turn.message || ''}`.trim(), at: Date.now() });
      choices = { session: failed.session, options: [{ label: '다시 시도', run: () => void resend(failed) }] };
      settle(`요청을 끝내지 못했습니다. ${state.turn.message || ''} 사이드 패널에서 다시 시도할 수 있습니다.`.replace(/\s+/g, ' ').trim(), 'error');
    }
    renderHistory();
    q('.achmage-login').hidden = signed;
    q('.achmage-composer').hidden = !signed;
    for (const choice of panel.querySelectorAll<HTMLButtonElement>('[data-provider]')) {
      const provider = state?.providers.find(p => p.id === choice.dataset.provider);
      choice.disabled = !provider?.available || locked || state?.busy === true || composing || state?.auth.status === 'pending';
      choice.title = provider?.available ? `${provider.label} 연결` : provider?.unavailableReason || '연결 준비 중';
    }
    button('cancel-login').hidden = state?.auth.status !== 'pending'; button('cancel-login').disabled = locked;
    button('logout').disabled = locked || state?.busy === true || !signed;
    // Signed out, a look-only recompose still runs (the app typesets it); anything else says to sign in first.
    button('send').disabled = !!workflowAbort || locked || state?.busy === true || composing || !prompt.value.trim() || signed && state?.selectedProvider==='openai'&&state.modelCatalogStatus!==undefined&&state.modelCatalogStatus!=='ready';
    button('cancel-turn').hidden = !running; button('cancel-turn').disabled = locked;
    button('send').hidden = !!running;
    mode.disabled = locked || !!running; prompt.readOnly = locked;
    q<HTMLSelectElement>('.achmage-model').disabled = locked || !!running;
    q('.achmage-edit-label').hidden = !mode.checked;
    let writingTemplate:DocumentTemplate|undefined;try{writingTemplate=documentTemplates?.current();}catch{/* send shows the actionable storage error */}
    // The hint is the same route send() takes, so the user sees what will change before sending.
    const typed=!!prompt.value.trim()&&signed;
    const hintRoute=!workflowEnabled&&typed&&(mode.checked||!routerEnabled)?classifyRequest(routeInput(prompt.value,{captured:false,whole:false,template:!!writingTemplate})):null;
    q('.achmage-writing-hint').hidden = !typed;
    q('.achmage-writing-hint').textContent=hintRoute?describeRoute(hintRoute,prompt.value,writingTemplate?.name):typed?`AI가 요청을 판단합니다${deps.input?.getSelection()?' · 선택 영역 기준':''}${writingTemplate?' · 서식 '+writingTemplate.name:''} · 문서를 바꾸면 Ctrl+Z로 되돌리기`:'';
    q('.achmage-writing-hint').dataset.route=hintRoute?.kind??(typed?'router':'');
    for (const [name,id] of extensionButtons) button(name).disabled = !extensionActions.some(action => action.id === id);
    button('template-add').disabled = !extensionActions.some(action => action.id === 'document-templates');
    for (const item of panel.querySelectorAll<HTMLElement>('[data-provider-tool]')) item.hidden = item.dataset.providerTool !== state?.selectedProvider;
    button('clear-history').disabled = locked || !!running;
    button('new-conversation').disabled = locked || !!running;
    button('restore-history').disabled=locked||!!running||history.length>0;
    q<HTMLSelectElement>('.achmage-provider-switch').disabled = !!workflowAbort || locked || state?.busy === true || composing;
    const currentTurn = request && sameAuthSession(state, request.session) && state?.turn?.requestId === request.id;
    q('.achmage-answer').hidden = !currentTurn || !!request?.completed || !!request?.structured || !!request?.kordoc || !state?.turn?.text || !!request?.router && looksLikeRouterAction(state.turn.text);
    q('.achmage-answer').textContent = currentTurn && !request?.structured && !request?.kordoc && !(request?.router && looksLikeRouterAction(state?.turn?.text || '')) ? restoredReply(request, state?.turn?.text || '').text : '';
    q('.achmage-pending').hidden = !(!!workflowAbort || state?.auth.status === 'pending' || currentTurn && running || applying);
    const now = performance.now(), waited = request && !applying ? now - request.startedAt : 0;
    const silentFor = request && running ? now - (request.lastTextAt ?? request.startedAt) : 0, started = !!request?.lastTextLength;
    const stage = applying ? '문서에 반영하고 있어요' : request?.router ? '요청을 이해하고 있어요' : request?.blockPatch ? '바꿀 부분을 고르고 있어요' : request?.kordoc ? '서식에 맞춰 문서를 쓰고 있어요' : request?.structured ? '문서 내용을 준비하고 있어요' : '답변을 준비하고 있어요';
    const stalled = started && silentFor > 30_000;
    q('.achmage-pending-label').textContent = stage + (waited >= 2000 ? ` · ${Math.floor(waited / 1000)}초` : '') + (stalled ? ` · ${Math.floor(silentFor / 1000)}초째 새 내용이 없습니다. 기다리거나 ■로 중지하세요.` : !started && waited >= 20_000 && running ? ' · AI가 내용을 구상하고 있어요' : '');
    button('cancel-turn').classList.toggle('is-emphasized', stalled);
    const showChoices = !!choices && sameAuthSession(state, choices.session) && (!request || !!request.failed) && !locked;
    choiceBox.hidden = !showChoices;
    const choiceKey = showChoices ? JSON.stringify(choices!.options.map(option => option.label)) : '';
    if (choiceBox.dataset.key !== choiceKey) {
      choiceBox.dataset.key = choiceKey; choiceBox.replaceChildren();
      if (showChoices) for (const option of choices!.options) {
        const choice = document.createElement('button'); choice.type = 'button'; choice.textContent = option.label;
        choice.onclick = () => { if (!choices) return; choices = null; option.run(); };
        choiceBox.append(choice);
      }
    }
    panel.classList.toggle('is-working', state?.auth.status === 'pending' || !!running || applying);
    const working = !!workflowAbort || !!running || applying || (!!request && !request.completed && !request.failed);
    if (working !== publishedWorking) { publishedWorking = working; publishPanelStatus({ working }); }
  }
  async function applyResponse(completed: NonNullable<typeof request>, reply: string, asWritten = false): Promise<void> {
    if (!completed.capture && !completed.structured && !completed.kordoc) return;
    if (completed.blockPatch && !asWritten) {
      // The model answered with the blocks it changes; every other block is typeset exactly as read.
      const blocks = completed.blockPatch.blocks;
      try {
        const patch = parseBlockPatch(reply, blocks.length), fixes: string[] = [], missing = new Set<string>();
        for (const change of patch.changes) {
          // A token written with JSON escapes (\u3014…) only becomes visible after decoding.
          const restored = completed.mask ? restorePersonal(change.markdown, completed.mask) : { text: change.markdown, unknown: [] };
          if (restored.unknown.length || hasPersonalToken(restored.text)) throw Error('AI 응답에 보내지 않은 개인정보 표시가 있어 문서에 적용하지 않았습니다.');
          const weekdays = fixWeekdays(restored.text), profiled = fillProfile(weekdays.text, profile, { json: false });
          fixes.push(...weekdays.fixes); profiled.missing.forEach(field => missing.add(field)); change.markdown = profiled.text;
        }
        const notices = completed.notices ??= [];
        notices.unshift(patch.changes.length ? `AI가 ${blockPatchSummary(patch, blocks.length)} 나머지 블록은 원문 그대로입니다.` : 'AI가 바꿀 내용이 없다고 답해 원문 그대로 조판했습니다.');
        if (fixes.length) notices.push('요일을 바로잡았습니다: ' + fixes.join(', '));
        if (missing.size) notices.push(`내 정보의 ${[...missing].join('·')}이(가) 비어 있어 〔${[...missing][0]}〕 자리를 남겼습니다. 계정 메뉴의 '문서에 넣을 내 정보'에서 채울 수 있습니다.`);
        reply = applyBlockPatch(blocks, patch); asWritten = true;
      } catch (error) { message(error instanceof Error ? error.message : 'AI 응답을 문서에 적용하지 못했습니다.'); return; }
    }
    // Weekdays are computed, not trusted: a written "2026. 1. 1.(수)" becomes (목) before it is applied.
    // The user's own manuscript (asWritten) is typeset exactly as pasted.
    const weekdays = asWritten ? { text: reply, fixes: [] as string[] } : fixWeekdays(reply), profiled = asWritten ? { text: weekdays.text, missing: [] as string[] } : fillProfile(weekdays.text, profile, { json: !!completed.structured }), text = profiled.text;
    if (weekdays.fixes.length) (completed.notices ??= []).push('요일을 바로잡았습니다: ' + weekdays.fixes.join(', '));
    if (profiled.missing.length) (completed.notices ??= []).push(`내 정보의 ${profiled.missing.join('·')}이(가) 비어 있어 〔${profiled.missing[0]}〕 자리를 남겼습니다. 계정 메뉴의 '문서에 넣을 내 정보'에서 채울 수 있습니다.`);
    applying = true;
    const applyStarted = performance.now();
    try {
      if(completed.kordoc&&completed.styleContext){
        const inPlace=completed.inPlace,name=completed.styleContext.name;
        const result=await createKordocDocument(text,completed.styleContext,()=>!disposed&&request===completed&&!composing&&!completed.stale&&(completed.local||sameAuthSession(connection.current,completed.session))&&generationIdentity()===completed.kordoc,
          inPlace?async bytes=>{const applied=await doc.applyWholeDocument(inPlace.identity,bytes,{hideFirstPage:inPlace.hideFirstPage,toc:inPlace.toc});return [...replacedLayoutNotices(applied.removedLayout),...(applied.toc?[`목차 ${applied.toc.entries}줄에 쪽 번호(${applied.toc.pages.join(', ')})를 넣었습니다.`]:[]),...(applied.tocFailure?[`목차 쪽 번호는 넣지 못했습니다(${applied.tocFailure}). 문서는 그대로 적용했습니다.`]:[])];}:undefined);
        if(request===completed)request=null;
        lastApplied=undefined;
        const headline=result.placement==='current'?`현재 문서를 '${name}' 서식으로 바꿨습니다. Ctrl+Z 한 번으로 되돌릴 수 있습니다.`
          :result.fallbackReason?`${result.fallbackReason} 그래서 '${name}' 서식 결과를 새 창으로 열었습니다. 기존 문서는 그대로입니다.`
          :'선택한 템플릿으로 새 문서를 열었습니다. 기존 문서는 그대로 유지됩니다.';
        message([headline,...(completed.notices??[]),...result.warnings.filter(userFacingEngineNotice),timing(completed,performance.now()-applyStarted)].join('\n'),'success');
        return;
      }
      if (composing || completed.stale || !sameAuthSession(connection.current, completed.session) || (completed.structured ? !doc.isStructuredCurrent(completed.structured) : !doc.isCurrent(completed.capture!))) throw new Error('문서 또는 선택이 바뀌어 자동 편집을 멈췄습니다. 원하는 위치에서 다시 요청하세요.');
      if (!text.trim()) throw new Error('빈 응답은 문서에 적용하지 않았습니다.');
      if (completed.structured) {
        completed.notices ??= [];
        const plan = decodeStructuredResponse(text, { notices: completed.notices, template: completed.styleContext });
        const requestedFonts = [...new Set(structuredParagraphs(plan).flatMap(p => p.runs.map(r => r.fontFamily)))];
        const families = requestedFonts.map(name => resolveDesktopFont(name)?.family ?? name);
        const fontStarted = performance.now();
        const available = await ensureDesktopFontsAvailable(families);
        performance.measure('achmage:font-ready', { start: fontStarted, end: performance.now() });
        const missing = requestedFonts.filter((_, index) => !available.has(families[index]));
        if (missing.length) throw new Error('실제로 사용할 수 없는 글꼴이 있어 편집을 멈췄습니다: ' + missing.join(', '));
        if (disposed || request !== completed || composing || completed.stale || !sameAuthSession(connection.current, completed.session) || !doc.isStructuredCurrent(completed.structured)) throw new Error('문서 또는 계정이 바뀌어 자동 편집을 멈췄습니다.');
        await doc.applyStructured(completed.structured, plan);
        lastApplied = plan.paragraphs.some(p=>p.table) ? undefined : { session: completed.session, range: { ...completed.structured.range, paragraphCount: plan.paragraphs.length }, paragraphs: plan.paragraphs.map(p => p.runs.map(r => r.text).join('')) };
      } else {
        await doc.apply(completed.capture!, unwrapQuotedReply(text, completed.capture!.before));
        // A selection/inline edit is also "the part just written": "더 짧게" can follow it without reselecting.
        const multi = completed.capture?.multi;
        // A cell's paragraphs are not body paragraphs, so a cell edit is not remembered as a body range (review LOW 10).
        if (!multi || multi.cell) lastApplied = undefined;
        if (multi && !multi.cell) {
          const section = multi.start.sectionIndex, first = multi.start.paragraphIndex, count = normalizeMultiReplacement(unwrapQuotedReply(text, completed.capture!.before), completed.capture!.before).split('\n').length;
          lastApplied = undefined;
          try { lastApplied = { session: completed.session, range: { section, startParagraph: first, paragraphCount: count }, paragraphs: Array.from({ length: count }, (_, i) => { const n = deps.wasm.getParagraphLength(section, first + i); return n ? deps.wasm.getTextRange(section, first + i, 0, n) : ''; }) }; } catch { lastApplied = undefined; }
        }
      }
      if (request === completed) request = null;
      message([...(completed.notices ?? []), '문서에 반영했습니다. Ctrl+Z로 되돌릴 수 있습니다. ' + timing(completed, performance.now() - applyStarted)].join('\n'), 'success');
    } catch (error) { message(error instanceof Error ? error.message : '문서 편집을 완료하지 못했습니다.'); }
    finally { performance.measure('achmage:document-apply', { start: applyStarted, end: performance.now() }); applying = false; render(); }
  }
  async function refresh(): Promise<void> {
    if (polling || disposed || connection.busy || !loginIntent && !shouldPoll(connection.current, document.hidden, closed)) return;
    polling = true;
    try { await connection.refresh(); } catch { message('연결을 확인하지 못했습니다. 계정 메뉴에서 다시 확인하세요.'); }
    finally { polling = false; void continueLogin(); }
  }
  async function act(action: AiAction): Promise<boolean> {
    message('');
    try { await connection.send(action); return true; }
    catch { message('요청 결과를 확인하지 못했습니다. 자동 재시도하지 않았습니다. 계정 메뉴에서 연결을 확인하세요.'); return false; }
  }
  async function continueLogin(): Promise<void> {
    if (!loginIntent || disposed || connection.busy) return;
    const state = connection.current;
    if (Date.now() > loginIntent.until) { loginIntent = null; message('연결 확인이 오래 걸리고 있습니다. 잠시 후 다시 눌러 주세요.'); return; }
    if (!state || state.commandPending || state.busy || state.selectedProvider !== loginIntent.provider) return;
    loginIntent = null;
    // Claude signs in with the user's choice: a Claude subscription, or an Anthropic Console account billed by API usage.
    const useConsole = state.selectedProvider === 'claude' && q<HTMLSelectElement>('.achmage-claude-method-select').value === 'console';
    if (state.auth.status !== 'signed_in' && state.auth.status !== 'pending') await act({ type: useConsole ? 'begin_console_login' : 'begin_login' });
  }
  function routeInput(text: string, extra: Pick<RouteInput, 'captured' | 'whole' | 'template'>, editMode = mode.checked): RouteInput {
    const open = deps.wasm.pageCount > 0;
    return { text, editMode, hasSelection: !!deps.input?.getSelection(), ...extra, documentOpen: open, blankDocument: open && doc.isBlank() };
  }
  /** Conversation facts the router may use: the last applied range and the last plain answer. */
  function withConversation(card: DocumentStateCard, session: string): DocumentStateCard {
    const recent = lastApplied?.session === session ? lastApplied : undefined, joined = recent?.paragraphs.join('\n') ?? '';
    return { ...card, recentEdit: recent ? { paragraphs: recent.paragraphs.length, preview: Array.from(joined).length > 300 ? Array.from(joined).slice(0, 300).join('') + '…' : joined } : null, lastAnswer: lastAnswer ?? null };
  }
  /** Where a routed request will act: selection and caret (a click while the model decides must stop it). */
  function selectionSignature(): string {
    try {
      const c = deps.input?.getCursorPosition();
      const caret = c ? [c.sectionIndex, c.paragraphIndex, c.charOffset, c.parentParaIndex, c.controlIndex, c.cellIndex, c.cellParaIndex, c.isTextBox ?? false] : null;
      return JSON.stringify({ selection: deps.input?.getSelection() ?? null, caret });
    } catch { return ''; }
  }
  /** The templates the user sees (hidden built-ins left out, my templates and packs in); blank-form packs cannot be written into. */
  function visibleTemplates(): DocumentTemplate[] {
    return (documentTemplates?.list?.() ?? [...BUILTIN_DOCUMENT_TEMPLATES]).filter(t => t.pack?.strategy !== 'fixed');
  }
  function templateOffers(current?: DocumentTemplate): TemplateOffer[] {
    const visible = visibleTemplates(), list = [...visible, ...(current && !visible.some(t => t.id === current.id) ? [current] : [])];
    return list.map(t => ({ id: t.id, name: t.name, group: templateGroup(t) }));
  }
  function findTemplate(id: string, current?: DocumentTemplate): DocumentTemplate | undefined {
    if (current?.id === id) return current;
    const found = visibleTemplates().find(t => t.id === id);
    return found ? structuredClone(found) : undefined;
  }
  /** Interpreting a request needs little reasoning; the user's chosen effort is kept for the work itself. */
  function routerEffort(): string | undefined {
    const state = connection.current; if (state?.selectedProvider !== 'openai') return undefined;
    const model = state.models?.find(m => m.id === q<HTMLSelectElement>('.achmage-model').value);
    const efforts = (model?.supportedReasoningEfforts ?? []).map(e => e.reasoningEffort);
    return ['minimal', 'low'].find(e => efforts.includes(e));
  }
  async function send(captured?: Capture, instruction?: string, options: { whole?: boolean; routed?: boolean } = {}): Promise<void> {
    const state = connection.current;
    const text = (instruction ?? prompt.value).trim();
    let template: DocumentTemplate | undefined;
    // A broken saved template never blocks a request that does not need one (F12).
    try { template=documentTemplates?.current(); } catch { template=undefined; message('저장된 문서 서식을 읽지 못해 서식 없이 진행합니다. 서식 창에서 확인해 주세요.', 'info'); }
    // "문서 전체를 이 서식으로 바꿔줘" is typeset by the app: no sign-in, no routing turn, nothing sent anywhere.
    if(workflowEnabled){await sendWorkflow(text,captured,template,instruction===undefined);return;}
    const look = lookOnlyRoute(text, captured, template, options.whole === true);
    if (composing || applying || connection.busy || state?.commandPending || state?.busy || !look && state?.auth.status !== 'signed_in') { message(busyMessage()); return; }
    const session = authSession(state);
    if (!text || !session && !look) return;
    choices = null;
    if (look) { await execute(look, { text, template, session: session ?? '', local: true, rememberUser: true, clearPrompt: instruction === undefined }); return; }
    if (!session) return;
    // Explicit UI requests (inline popover, Ctrl+A, the "선택한 본문 수정" toggle) already say what to change.
    // A formatting wording on a captured selection may mean "just bold it" or "rewrite with this font"; the router decides.
    const explicit = (!!captured && !(routerEnabled && needsStructure(text))) || options.whole === true || mode.checked && !options.routed;
    if (explicit || !routerEnabled) {
      const route = classifyRequest(routeInput(text, { captured: !!captured, whole: options.whole === true, template: !!template }, options.routed ? false : mode.checked));
      await execute(route, { text, captured, template, session, rememberUser: true, clearPrompt: instruction === undefined });
      return;
    }
    await startRouter(text, template, session, instruction === undefined);
  }
  async function sendWorkflow(text:string,captured:Capture|undefined,template:DocumentTemplate|undefined,clearPrompt:boolean):Promise<void>{
    const state=connection.current,session=authSession(state);
    if(!text)return;
    if(!session||!state||workflowAbort||composing||applying||connection.busy||state.commandPending||state.busy){message(busyMessage());return;}
    const controller=new AbortController();workflowAbort=controller;choices=null;request=null;
    const requestDocument=generationIdentity();let draft:WorkflowDraft|null=null;
    const prior=conversationContext(history.map(e=>({...e,provider:state.selectedProvider})),state.selectedProvider,contextFrom);
    const id=crypto.randomUUID();workflowSources.push({id,text});remember({id,provider:state.selectedProvider,role:'user',text,at:Date.now()});if(clearPrompt)prompt.value='';
    try{
      let selection=captured;
      if(!selection)try{selection=doc.captureSelection();}catch{selection=retainedSelection;}
      if(selection?.multi&&generationIdentity()!==JSON.stringify([selection.multi.identity.documentEpoch,selection.multi.identity.changeSeq,selection.multi.identity.documentSha256]))selection=undefined;
      if(deps.wasm.pageCount>0)draft=new WorkflowDraft(deps.wasm,doc.identity(),selection?.multi);
      const actions=['write_new_document','restyle_document','refresh_toc','recompose_document','insert_at_caret','insert_answer','undo'];
      const result=await runWorkflow({text,history:prior,sources:workflowSources,selection:selection?{text:selection.before,exact:!!selection.multi}:null,focus:draft?.map.focus(deps.input.getCursorPosition()),templates:templateOffers(template),actions,recent:lastWorkflow?.identity===requestDocument?lastWorkflow.summary:undefined},draft,{
        ask:(payload,signal)=>workflowClient!.ask(payload,signal,{model:q<HTMLSelectElement>('.achmage-model').value||undefined,...(state.selectedProvider==='openai'?{reasoningEffort:q<HTMLSelectElement>('.achmage-effort').value||undefined}:{})}),
        progress:label=>{message(label,'info');render();},
        fonts:async()=>[...new Set((await detectDesktopFontEntries()).map(f=>f.family))],
        commit:async d=>{if(d.fonts.length){const available=await ensureDesktopFontsAvailable(d.fonts);if(d.fonts.some(f=>!available.has(f)))throw Error('요청한 글꼴을 이 컴퓨터에서 찾지 못했습니다.');}if(controller.signal.aborted||!sameAuthSession(connection.current,session)||generationIdentity()!==requestDocument)throw Error('문서나 계정이 바뀌어 적용하지 않았습니다. 다시 요청하세요.');applying=true;render();try{return await d.commit(doc);}finally{applying=false;}},
        action:async call=>{
          if(!actions.includes(call.action))throw Error('현재 지원하는 작업이 아닙니다.');
          if(controller.signal.aborted||generationIdentity()!==requestDocument||!sameAuthSession(connection.current,session))throw Error('문서나 계정이 바뀌었습니다.');
          if(call.action==='undo'){if(lastWorkflow?.identity!==requestDocument)throw Error('직전 AI 작업 뒤 문서가 바뀌어 자동으로 되돌리지 않았습니다. Ctrl+Z 기록을 확인하세요.');deps.undo();lastWorkflow=undefined;message('직전 AI 작업을 되돌렸습니다.','success');return;}
          const chosen=call.templateId?findTemplate(call.templateId,template):template;
          if(call.templateId&&!chosen)throw Error('선택한 서식을 찾을 수 없습니다.');
          workflowAbort=null;
          if(!await runOperation(call.action as OperationId,text,call.instruction,chosen,session,false))throw Error('작업을 시작하지 못했습니다. 표시된 원인을 확인하세요.');
        },
      },controller.signal);
      if(!result.delegated){lastAnswer=result.text;remember({id:id+':result',provider:state.selectedProvider,role:'assistant',text:result.text,at:Date.now()});if(result.changed)lastWorkflow={identity:generationIdentity(),summary:result.text};message(result.text,result.changed?'success':'info');settle(result.text,'info');}
    }catch(error){const text=error instanceof Error?error.message:'작업을 완료하지 못했습니다.';remember({id:id+':error',provider:state.selectedProvider,role:'assistant',text,at:Date.now()});message(text);settle(text,'error');}
    finally{draft?.close();workflowAbort=null;render();}
  }
  /** A recompose of the open document that only asks for a new look, recognised without a model. */
  function lookOnlyRoute(text: string, captured: Capture | undefined, template: DocumentTemplate | undefined, whole: boolean): Route | undefined {
    if (!text || captured || template?.pack || !template && !whole || deps.wasm.pageCount === 0) return undefined;
    // Only a clear look-only wording skips the model; Ctrl+A with no template chosen must say it ("서식만", "내용은 그대로").
    if (!(template ? asksOnlyForLook(text) : AS_WRITTEN_REQUEST.test(text) && asksOnlyForLook(text))) return undefined;
    const route = classifyRequest(routeInput(text, { captured: false, whole, template: !!template }, false));
    return route.kind === 'compose' && route.recompose ? route : undefined;
  }
  /** One model turn decides what a free-form message means (answer, one operation, or a short question). */
  async function startRouter(text: string, template: DocumentTemplate | undefined, session: string, clearPrompt: boolean): Promise<void> {
    const state = connection.current!;
    const card = withConversation(buildDocumentStateCard(deps.wasm, deps.input, template ? { id: template.id, name: template.name } : null), session);
    const templates = templateOffers(template);
    const recent = conversationContext(history, state.selectedProvider, contextFrom);
    const payload = routerPrompt({ text, card, templates, history: recent });
    const id = crypto.randomUUID();
    const model = q<HTMLSelectElement>('.achmage-model').value || undefined, effort = routerEffort(), mask = maskPersonal(payload);
    request = { id, payload: mask.text, mask, model, effort, router: { text, template, card, templates, document: generationIdentity(), selection: selectionSignature() }, startedAt: performance.now(), session, provider: state.selectedProvider, completed: false, stale: false };
    remember({ id, provider: state.selectedProvider, role: 'user', text, at: Date.now() }); render();
    if (await act({ type: 'send', prompt: mask.text, requestId: id, ...(model ? { model } : {}), ...(effort ? { reasoningEffort: effort } : {}) })) { if (clearPrompt) prompt.value = ''; if (mask.tokens.size) message(maskNotice(mask), 'info'); }
    render();
  }
  async function routeReply(routed: NonNullable<typeof request>, reply: string): Promise<void> {
    const plan = routed.router!; if (request === routed) request = null;
    const decision = decodeRouterReply(reply, plan.card, plan.templates);
    if (decision.kind === 'answer') { lastAnswer = decision.text; remember({ id: routed.id, provider: routed.provider, role: 'assistant', text: decision.text, at: Date.now() }); render(); return; }
    if (decision.kind === 'invalid') { message('요청을 문서 작업으로 정하지 못했습니다. ' + decision.reason); render(); return; }
    if (disposed || !sameAuthSession(connection.current, routed.session)) return;
    const routedMs = (routed.completedAt ?? performance.now()) - routed.startedAt;
    // A choice runs later: it re-checks that the document, selection and caret are what was asked about.
    const later = (op: OperationId, instruction: string, template: DocumentTemplate | undefined, rich: boolean, params: { format?: TextFormat; calc?: string } = {}) => () => {
      if (generationIdentity() !== plan.document || selectionSignature() !== plan.selection) { message('질문 뒤에 문서나 선택이 바뀌었습니다. 다시 요청해 주세요.'); render(); return; }
      const fresh = offerOperations(withConversation(buildDocumentStateCard(deps.wasm, deps.input, template ? { id: template.id, name: template.name } : null), routed.session)).find(offer => offer.id === op);
      if (!fresh?.available) { message(fresh?.reason ?? '지금은 그 작업을 할 수 없습니다.'); render(); return; }
      void runOperation(op, plan.text, instruction, template, routed.session, rich, undefined, params);
    };
    if (decision.kind === 'clarify') {
      remember({ id: routed.id, provider: routed.provider, role: 'assistant', text: decision.question, at: Date.now() });
      choices = { session: routed.session, options: decision.options.map(option => ({ label: option.label, run: later(option.op, '', plan.template, false) })) };
      settle('AI가 확인 질문을 했습니다. 사이드 패널에서 고르세요.', 'info'); render(); return;
    }
    if (generationIdentity() !== plan.document || selectionSignature() !== plan.selection) { message('요청을 이해하는 동안 문서·선택·커서가 바뀌어 멈췄습니다. 다시 보내 주세요.'); if (!prompt.value.trim()) prompt.value = plan.text; render(); return; }
    // The model may pick a different template only when the user named it.
    const named = decision.templateId ? findTemplate(decision.templateId, plan.template) : undefined;
    const template = named && mentionsTemplate(plan.text, named.name) ? named : plan.template;
    // Last line of defence: rewriting the whole document needs the user's own words to point at the whole document.
    if ((decision.op === 'recompose_document' || decision.op === 'restyle_document' || decision.op === 'edit_whole_body') && (!!plan.card.selection || !WHOLE_DOCUMENT_SCOPE.test(plan.text))) {
      remember({ id: routed.id, provider: routed.provider, role: 'assistant', text: `${describeOperation(decision.op, template?.name)} 문서 전체가 바뀌는 작업이라 진행 전에 확인합니다.`, at: Date.now() });
      choices = { session: routed.session, options: [{ label: '진행', run: later(decision.op, decision.instruction, template, decision.rich === true, { format: decision.format, calc: decision.calc }) }, { label: '취소', run: () => { message('요청을 취소했습니다. 문서는 바뀌지 않았습니다.', 'info'); render(); } }] };
      settle('문서 전체가 바뀌는 작업이라 사이드 패널에서 진행 여부를 고르세요.', 'info'); render(); return;
    }
    if (!await runOperation(decision.op, plan.text, decision.instruction, template, routed.session, decision.rich === true, routedMs, { format: decision.format, calc: decision.calc }) && !prompt.value.trim()) prompt.value = plan.text;
  }
  async function runOperation(op: OperationId, text: string, instruction: string, template: DocumentTemplate | undefined, session: string, rich: boolean, routedMs?: number, params: { format?: TextFormat; calc?: string } = {}): Promise<boolean> {
    const card = withConversation(buildDocumentStateCard(deps.wasm, deps.input, template ? { id: template.id, name: template.name } : null), session);
    const promptText = instruction && instruction !== text ? `${text}\n(요청 해석: ${instruction})` : text;
    const started = await execute(routeForOperation(op, card, rich, params), { text, promptText, template, session, rememberUser: false, clearPrompt: false, routed: true, ...(routedMs !== undefined ? { routedMs } : {}) });
    // The plan line is written only for work that actually started.
    if (started) { remember({ id: crypto.randomUUID(), provider: connection.current?.selectedProvider ?? 'openai', role: 'assistant', text: describeOperation(op, template?.name), at: Date.now() }); render(); }
    return started;
  }
  /** '서식만 바꾸기': no model call and no sign-in needed; the text stays, one Ctrl+Z restores the look. */
  async function restyle(template: DocumentTemplate | undefined, text = ''): Promise<boolean> {
    if (composing || applying) { message(busyMessage()); return false; }
    if (!template) { message('문서 서식 버튼에서 적용할 서식을 선택해 주세요. 글 내용은 그대로 두고 서식만 바꿉니다.'); return false; }
    applying = true; render(); const started = performance.now();
    try {
      // Explicit wording such as "본문은 맑은 고딕 11pt로" adjusts the template first (E3).
      const resolved = text.trim() ? resolveDocumentTemplate(template, text) : { template, notices: [] as string[] }, families = [...new Set(Object.values(resolved.template.roles).map(role => role.fontFamily))];
      const available = await ensureDesktopFontsAvailable(families), missing = families.filter(family => !available.has(family));
      if (missing.length) throw Error(`서식에 지정한 글꼴을 이 컴퓨터에서 찾지 못했습니다: ${missing.join(', ')}`);
      const result = await doc.applyRestyle(doc.identity(), resolved.template);
      lastApplied = undefined;
      const kept = [result.kept.frontMatter ? `표지·목차 ${result.kept.frontMatter}문단` : '', result.kept.layoutTables ? `디자인 표 ${result.kept.layoutTables}개` : '', result.kept.nestedTables ? `표 안의 표 ${result.kept.nestedTables}개` : ''].filter(Boolean);
      message([`'${template.name}' 서식만 적용했습니다(AI 없이, ${seconds(performance.now() - started)}). ${result.summary}.`, kept.length ? `${kept.join(', ')}는 그대로 두었습니다.` : '', ...resolved.notices, 'Ctrl+Z 한 번으로 되돌릴 수 있습니다.'].filter(Boolean).join(' '), 'success');
      return true;
    } catch (error) { message(error instanceof Error ? error.message : '서식을 바꾸지 못했습니다.'); return false; }
    finally { applying = false; render(); }
  }
  /** Contents page numbers from the current layout (T15). */
  async function refreshToc(): Promise<boolean> {
    if (composing || applying) { message(busyMessage()); return false; }
    applying = true; render();
    try {
      const result = await doc.applyTocRefresh(doc.identity());
      message(`목차 ${result.entries}줄에 쪽 번호를 넣었습니다(${result.pages.join(', ')}쪽, AI 없이). Ctrl+Z로 되돌릴 수 있습니다.`, 'success'); return true;
    } catch (error) { message(error instanceof Error ? error.message : '목차를 새로 고치지 못했습니다.'); return false; }
    finally { applying = false; render(); }
  }
  /** A named local calculator on the selection (T11): the code computes, the model only picked which one. */
  async function calculate(calc: string | undefined): Promise<boolean> {
    if (composing || applying) { message(busyMessage()); return false; }
    try {
      const capture = doc.captureSelection(), choice = calculatorChoices(capture.before).find(c => c.label === calc);
      if (!choice) { message('선택한 내용에 맞는 계산을 찾지 못했습니다. 금액·날짜·두 수를 선택해 주세요.'); return false; }
      applying = true; render();
      await doc.apply(capture, choice.result); lastApplied = undefined;
      message(`${choice.label}: ${choice.result} (AI 계산 없음). Ctrl+Z로 되돌릴 수 있습니다.`, 'success'); return true;
    } catch (error) { message(error instanceof Error ? error.message : '계산 결과를 넣지 못했습니다.'); return false; }
    finally { applying = false; render(); }
  }
  /** A selected rough draft becomes headings, items and real tables, with no text generated. */
  async function tidyDraft(template: DocumentTemplate | undefined): Promise<boolean> {
    if (composing || applying) { message(busyMessage()); return false; }
    applying = true; render(); const started = performance.now();
    try {
      const result = await tidySelectedDraft(doc, template); lastApplied = undefined;
      message(`선택한 초안을 ${result.paragraphs}개 문단·표로 정리했습니다(AI 없이 적용 ${seconds(performance.now() - started)}${template ? `, '${template.name}' 서식` : ''}). Ctrl+Z로 되돌릴 수 있습니다.`, 'success');
      return true;
    } catch (error) { message(error instanceof Error ? error.message : '초안을 정리하지 못했습니다.'); return false; }
    finally { applying = false; render(); }
  }
  /** Character formatting of the selection only; the model named the values, nothing else is generated. */
  async function formatText(format: TextFormat | undefined): Promise<boolean> {
    if (composing || applying) { message(busyMessage()); return false; }
    if (!format) { message('바꿀 글자 서식을 정하지 못했습니다. 예: "선택한 부분 굵게 해줘"'); return false; }
    applying = true; render(); const started = performance.now();
    try {
      if (format.fontFamily && !(await ensureDesktopFontsAvailable([format.fontFamily])).has(format.fontFamily)) throw Error(`'${format.fontFamily}' 글꼴을 이 컴퓨터에서 찾지 못했습니다.`);
      const result = await doc.applyTextFormat(format); lastApplied = undefined;
      message(`선택한 글자 ${result.chars}자에 ${describeTextFormat(format)}을 적용했습니다(AI 없이 적용 ${seconds(performance.now() - started)}). Ctrl+Z로 되돌릴 수 있습니다.`, 'success');
      return true;
    } catch (error) { message(error instanceof Error ? error.message : '글자 서식을 바꾸지 못했습니다.'); return false; }
    finally { applying = false; render(); }
  }
  /** routed: chosen by the model, so it never escalates into a different operation on failure. */
  interface ExecutionContext { text: string; promptText?: string; captured?: Capture; template?: DocumentTemplate; session: string; rememberUser: boolean; clearPrompt: boolean; routedMs?: number; routed?: boolean; /** Handled by the app alone (no model): no AI session is needed. */ local?: boolean }
  /** Returns whether the work started (a request was sent, or a local change was applied). */
  async function execute(route: Route, ctx: ExecutionContext): Promise<boolean> {
    if (route.kind === 'clear-checkboxes') {
      if(composing||applying) {message(busyMessage());return false;}
      applying=true;render();
      try {const result=await doc.clearCheckboxes();lastApplied=undefined;
        const summary=result.found ? `양식 체크박스 ${result.found}개 중 ${result.changed}개를 해제했습니다. 기존 서식은 유지됩니다. Ctrl+Z로 되돌릴 수 있습니다. 문자·그림 체크 표시는 포함하지 않습니다.` : '편집 가능한 양식 체크박스를 찾지 못했습니다. 문자나 그림으로 된 체크 표시는 별도 편집이 필요합니다.';
        remember({id:crypto.randomUUID(),provider:connection.current?.selectedProvider??'openai',role:'assistant',text:summary,at:Date.now()});message(summary,'info');return true;
      }catch(error){message(error instanceof Error?error.message:'체크박스를 해제하지 못했습니다.');return false;}
      finally{applying=false;render();}
    }
    if (route.kind === 'restyle') return restyle(ctx.template, ctx.routed?'':ctx.text);
    if (route.kind === 'text-format') return formatText(route.format);
    if (route.kind === 'tidy-draft') return tidyDraft(ctx.template);
    if (route.kind === 'calculate') return calculate(route.calc);
    if (route.kind === 'toc') return refreshToc();
    const state = connection.current;
    // A local request (typeset by the app) also runs before this window has read the AI state.
    if (!state && !ctx.local || composing || applying || connection.busy || state?.commandPending || state?.busy || !ctx.local && !sameAuthSession(state, ctx.session)) { message(busyMessage()); return false; }
    const provider: ProviderId = state?.selectedProvider ?? 'openai';
    let captured = ctx.captured;
    const { text, template, session } = ctx, ask = ctx.promptText ?? text;
    if (route.kind === 'insert-answer') {
      // The answer is already here: inserting it needs no model call, and stays one Ctrl+Z.
      if (!lastAnswer) { message('넣을 직전 답변이 없습니다.'); return false; }
      applying = true; render(); const started = performance.now();
      try { await doc.apply(doc.captureInsertion(), lastAnswer); lastApplied = undefined; message(`직전 답변을 커서 위치에 넣었습니다. Ctrl+Z로 되돌릴 수 있습니다. (적용 ${seconds(performance.now() - started)})`, 'success'); return true; }
      catch (error) { message(error instanceof Error ? error.message : '답변을 넣지 못했습니다.'); return false; }
      finally { applying = false; render(); }
    }
    const id = crypto.randomUUID(); let payload = ask, capture: Capture | undefined, structured: StructuredCapture | undefined, styleContext: DocumentTemplate | undefined, kordoc:string|undefined, inPlace:{identity:RhwpDocumentStateV1;hideFirstPage:boolean;toc?:boolean}|undefined, notices: string[] = [], documentRead: DocumentManuscript | undefined, asWrittenDocument = false, documentMask: MaskedText | undefined;
    if (route.kind === 'needs-template') { message('문서 서식 버튼에서 적용할 서식을 선택해 주세요. 현재 본문은 앱이 직접 읽습니다.'); return false; }
    if ((route.kind === 'structured' || route.kind === 'selection-edit') && route.usesSelection && !captured) {
      try { captured = doc.captureSelection(); } catch (error) { message(error instanceof Error ? error.message : '선택한 본문을 읽지 못했습니다.'); return false; }
    }
    /** Template-engine authoring: a new document, a blank window, or the open document recomposed (one Ctrl+Z). */
    // asWritten: a recompose that only asks for the look may be typeset from the document itself, with no model.
    const compose = async (recompose: boolean, fallback: boolean, extraNotices: string[] = [], asWritten = false): Promise<boolean> => {
      // Whole-document inline edits always run; without a chosen style the default report template is used and disclosed.
      const chosen = template ?? (fallback ? structuredClone(BUILTIN_DOCUMENT_TEMPLATES[0]) : undefined);
      if (!chosen) { message('문서 서식 버튼에서 적용할 서식을 선택해 주세요. 현재 본문은 앱이 직접 읽습니다.'); return false; }
      if (chosen.pack?.strategy === 'fixed') { message(`'${chosen.name}'은 빈 양식 채우기 전용이라 문서 생성은 미지원입니다. 문서 서식 창의 '빈 양식 열기'를 쓰세요.`); return false; }
      try{
        const resolved=ctx.routed?{template:chosen,notices:[]}:resolveDocumentTemplate(chosen,text);styleContext=resolved.template;notices=[...resolved.notices,...extraNotices,...(fallback&&!template?[`선택한 문서 서식이 없어 '${chosen.name}' 서식으로 다시 구성했습니다.`]:[])];kordoc=generationIdentity();
        // The open document is read by the app, never retyped: as written (no model), or as numbered blocks the model patches.
        documentRead=recompose?documentManuscript(captureWholeDocumentContext(deps.wasm).sections):undefined;
        const wording=`${text}\n${ask}`;asWrittenDocument=!!documentRead&&asWritten&&!styleContext.pack&&asksOnlyForLook(wording);
        if(documentRead){notices.push(...documentManuscriptNotices(documentRead));const chars=documentRead.blocks.reduce((n,b)=>n+b.length,0);if(!asWrittenDocument&&chars>MODEL_DOCUMENT_CHARS)throw Error(`문서가 너무 길어(약 ${chars.toLocaleString()}자) AI가 한 번에 읽을 수 없습니다. 내용은 그대로 두고 서식만 바꾸는 요청은 AI 없이 바로 조판합니다.`);}
        // Typeset as written, a document whose title or chapters are not plain lines (or that has none) gets no
        // cover or contents page instead of an engine refusal: the engine builds them from # and ## headings.
        if(asWrittenDocument&&documentRead){const layout=templateLayout(styleContext),title=documentRead.blocks.some(b=>/^# /.test(b)),chapters=documentRead.blocks.some(b=>/^## /.test(b)),cover=layout.cover&&!title,toc=layout.toc&&!chapters;
          if(cover||toc){styleContext={...styleContext,layout:{...layout,...(cover?{cover:false}:{}),...(toc?{toc:false}:{})}};notices.push(`문서에서 ${cover&&toc?'제목과 장 제목':cover?'제목':'장 제목'}을 찾지 못해 ${cover&&toc?'표지와 목차':cover?'표지':'목차'} 없이 조판했습니다.`);}}
        // "바꿔/적용" of the open document, or a fresh blank document, is filled in this window (one Ctrl+Z).
        if(deps.wasm.pageCount>0&&(recompose||doc.isBlank())){const layout=templateLayout(styleContext);inPlace={identity:doc.identity(),hideFirstPage:layout.cover&&COVER_TOC_PRESETS.includes(layout.enginePreset),toc:layout.toc===true};}
        applying=true;render();const families=await prepareKordocAuthoring(styleContext);
        const available=await ensureDesktopFontsAvailable(families);
        if(families.some(family=>!available.has(family)))throw Error('템플릿에 지정한 글꼴을 사용할 수 없습니다. 문서 서식에서 글꼴을 확인하세요.');
        if(disposed||composing||!ctx.local&&!sameAuthSession(connection.current,session)||generationIdentity()!==kordoc)throw Error('문서 또는 계정이 바뀌어 작성을 멈췄습니다.');
        const shown=documentRead&&!asWrittenDocument&&!ctx.local?maskedDocumentBlocks(documentRead):undefined;documentMask=shown?.mask;
        payload=kordocAuthoringPrompt(ask,styleContext,shown?.blocks);
        return true;
      }catch(error){message(error instanceof Error?error.message:'문서 엔진을 준비하지 못했습니다.');return false;}
      finally{applying=false;render();}
    };
    /** Typesets Markdown the app read itself (no model call, no tokens); the result is still one Ctrl+Z. */
    const typesetLocally = async (markdown: string, headline: string): Promise<boolean> => {
      const local: NonNullable<typeof request> = { id, payload: '', kordoc, inPlace, styleContext, notices: [headline, ...notices], startedAt: performance.now(), session, provider: provider, completed: true, stale: false, local: true };
      request = local;
      if (ctx.rememberUser) remember({ id, provider: provider, role: 'user', text, at: Date.now() });
      if (ctx.clearPrompt) prompt.value = '';
      render();
      await applyResponse(local, markdown, true);
      if (request === local) request = null;
      render();
      return true;
    };
    if (route.kind === 'compose') {
      if (!await compose(route.recompose, route.fallbackTemplate, [], true)) return false;
      // The open document in a new look, sentences untouched: read and typeset by the app (within the snapshot bounds).
      if (route.recompose && asWrittenDocument && documentRead && kordoc && styleContext)
        return typesetLocally(documentMarkdown(documentRead.blocks), `AI가 글을 다시 쓰지 않고, 열린 문서의 제목·항목·표를 앱이 읽어 '${styleContext.name}' 서식으로 조판했습니다. 문장은 그대로이고 번호·기호는 서식의 모양을 따릅니다. 내용까지 고치려면 '요약해서', '고쳐서'처럼 함께 요청하세요.`);
      // A long pasted manuscript to be put into the template is typeset as written, without a model:
      // retyping 25 pages would hit the model's output length and could change the text.
      const { instruction, manuscript } = splitManuscript(text), manuscriptChars = Array.from(manuscript).length;
      if (!route.recompose && kordoc && styleContext && manuscriptChars > LOCAL_MANUSCRIPT_CHARS && !REWRITE_REQUEST.test(instruction))
        return typesetLocally(manuscriptMarkdown(manuscript), `원고가 길어(${manuscriptChars.toLocaleString()}자) AI가 다시 쓰지 않고, 원고의 제목·항목·표 구조를 앱이 읽어 '${styleContext.name}' 서식으로 조판했습니다(문장은 그대로).`);
    } else if (route.kind === 'structured') {
      try {
        if (captured && !doc.isCurrent(captured)) throw new Error('선택한 본문이 바뀌었습니다. 다시 선택하세요.');
        // "방금 반영한 부분" means exactly the last applied range, never an older answer that happens to match.
        const prepared = prepareStructuredEdit(doc, deps, text, { template, ...(route.scope ? { scope: route.scope } : {}), priorAssistantTexts: route.scope === 'recent' ? [] : history.filter(entry => entry.provider === provider && entry.role === 'assistant').slice(-10).map(entry => entry.text), lastAppliedRange: lastApplied?.session === session ? lastApplied : undefined });
        structured = prepared.capture; payload = prepared.prompt; notices = prepared.notices; styleContext=prepared.styleContext;
      } catch (error) {
        // Paragraph editing cannot keep tables/fields; a whole-document request goes through the template engine instead.
        if (error instanceof StructureUnsupportedError && !route.usesSelection && mentionsWholeDocument(text) && !ctx.routed) {
          if (!template) { message('표·필드·그림 등 개체가 있는 문서는 문단 단위로 고칠 수 없습니다. 문서 서식을 선택하면 표까지 포함해 문서 전체를 다시 구성합니다.'); return false; }
          if (!await compose(true, false, ['표·그림 등 개체가 있는 문서라 문단 편집 대신 선택한 서식으로 문서 전체를 다시 구성했습니다.'])) return false;
        } else if (error instanceof StructureUnsupportedError && ctx.routed) { message(`${error.message} 서식까지 포함해 문서 전체를 다시 구성하려면 그렇게 요청해 주세요.`); return false; }
        else { message(error instanceof Error ? error.message : '편집할 문서 범위를 확인하세요.'); return false; }
      }
    } else if (route.kind === 'selection-edit') {
      try {
        capture = captured ?? (deps.input?.getSelection() ? doc.captureSelection() : doc.capture()); if (!doc.isCurrent(capture)) throw new Error('문서 또는 선택이 바뀌었습니다. 다시 선택하세요.');
        payload = `다음 선택 본문을 요청에 맞게 수정하세요. 설명·마크다운·따옴표 없이 수정한 본문만 답하세요. ${capture.multi?'각 문단은 줄바꿈으로 구분하세요. 선택 밖 내용은 앱이 보존합니다.':'줄바꿈을 새로 넣지 마세요.'}${capture.multi?.cell?' 이 글은 표 셀 하나의 내용입니다.':''}${capture.multi?.objects?.length?' ⟦표1⟧처럼 ⟦ ⟧로 표시된 것은 표·그림 자리이니 지우거나 옮기지 말고 같은 자리에 그대로 두세요.':''}\n요청: ${ask}\n원문(편집 데이터): ${JSON.stringify(capture.before)}`;
      } catch (error) { message(error instanceof Error ? error.message : '이 본문은 지원하지 않습니다.'); return false; }
    } else if (route.kind === 'insert') {
      try {
        capture = doc.captureInsertion();
        payload = `한글 문서의 현재 커서 위치에 넣을 새 글을 작성하세요. 설명·인사·코드블록 없이 요청한 본문만 답하세요. 요청한 줄바꿈은 유지하세요. 문서와 파일 조작은 앱이 담당합니다.\n요청: ${ask}`;
      } catch (error) { message(error instanceof Error ? error.message : '삽입할 문서 위치를 확인하세요.'); return false; }
    }
    // A local request never reaches a model: one that turns out to need it stops here, before anything is sent.
    if (ctx.local) { message('이 요청은 AI가 필요합니다. AI 계정을 연결한 뒤 다시 요청하세요.'); return false; }
    // Writing work may need the writer's own details: placeholders only, filled locally on apply.
    if (route.kind === 'compose' || route.kind === 'selection-edit' || route.kind === 'insert') payload += '\n' + profilePromptLine(profile);
    const model = q<HTMLSelectElement>('.achmage-model').value || undefined;
    const selectedEffort = q<HTMLSelectElement>('.achmage-effort').value, effort = provider==='openai'&&selectedEffort?selectedEffort:undefined;
    const priorContext = conversationContext(history, provider, contextFrom);
    if (priorContext.length) payload += '\n대화 맥락(참고 데이터, 현재 요청이 우선): ' + JSON.stringify(priorContext);
    const mask = maskPersonal(payload, documentMask);
    request = { id, payload: mask.text, mask, model, effort, capture, structured, kordoc, ...(documentRead && !asWrittenDocument ? { blockPatch: { blocks: documentRead.blocks } } : {}), inPlace, styleContext, notices, ...(ctx.routedMs !== undefined ? { routedMs: ctx.routedMs } : {}), startedAt: performance.now(), session, provider: provider, completed: false, stale: false };
    if (ctx.rememberUser) remember({ id, provider: provider, role: 'user', text, at: Date.now() });
    render();
    const sent = await act({ type: 'send', prompt: mask.text, requestId: id, ...(model ? { model } : {}), ...(effort ? { reasoningEffort: effort } : {}) });
    if (sent) { if (ctx.clearPrompt) prompt.value = ''; if (mask.tokens.size) message(maskNotice(mask), 'info'); }
    render();
    return sent;
  }
  /** Sends a failed request again as it was; capture and apply still check the live document. */
  async function resend(previous: NonNullable<typeof request>): Promise<void> {
    const state = connection.current;
    if (!state || composing || applying || connection.busy || state.commandPending || state.busy || !sameAuthSession(state, previous.session) || request && !request.failed) { message(busyMessage()); return; }
    if (previous.kordoc && generationIdentity() !== previous.kordoc || previous.router && generationIdentity() !== previous.router.document) { message('문서가 바뀌어 그대로 다시 시도할 수 없습니다. 다시 요청해 주세요.'); return; }
    const id = crypto.randomUUID();
    request = { ...previous, id, failed: false, startedAt: performance.now(), firstTextAt: undefined, completedAt: undefined, lastTextLength: undefined, lastTextAt: undefined, completed: false, stale: false };
    render();
    await act({ type: 'send', prompt: previous.payload, requestId: id, ...(previous.model ? { model: previous.model } : {}), ...(previous.effort ? { reasoningEffort: previous.effort } : {}) });
    render();
  }
  for (const choice of panel.querySelectorAll<HTMLButtonElement>('[data-provider]')) choice.onclick = async () => {
    if (choice.disabled || workflowAbort) return;
    const provider = choice.dataset.provider as ProviderId;
    loginIntent = { provider, until: Date.now() + 45_000 };
    if (connection.current?.selectedProvider !== provider && !await act({ type: 'select_provider', provider })) { loginIntent = null; return; }
    saveProvider(localStorage, provider); savedProvider = null;
    await continueLogin();
  };
  button('cancel-login').onclick = () => { loginIntent = null; void act({ type: 'cancel_login' }); };
  q<HTMLSelectElement>('.achmage-provider-switch').onchange = () => { loginIntent = null; const provider = q<HTMLSelectElement>('.achmage-provider-switch').value as ProviderId; savedProvider = null; void act({ type: 'select_provider', provider }).then(ok => { if (ok) saveProvider(localStorage, provider); }); };
  button('logout').onclick = () => { workflowAbort?.abort(); request = null; void act({ type: 'logout' }); };
  // Only providers whose official CLI lists models re-read the catalog; the others keep their status-only refresh.
  button('refresh').onclick = () => { const current=connection.current; if(current&&CATALOG_PROVIDERS.has(current.selectedProvider)&&current.auth.status==='signed_in')void act({type:'refresh_models'});else void refresh(); };
  q<HTMLSelectElement>('.achmage-model').onchange=()=>render();
  button('send').onclick = () => { void send(); };
  button('cancel-turn').onclick = () => { if(workflowAbort){workflowAbort.abort();return;} const id = connection.current?.turn?.id; request = null; if (id) void act({ type: 'cancel_turn', turnId: id }); };
  const profileHost = q('.achmage-profile-fields');
  for (const field of PROFILE_FIELDS) { const label = document.createElement('label'); label.textContent = field.label; const input = document.createElement('input'); input.setAttribute('data-profile', field.key); input.value = profile[field.key] ?? ''; label.append(input); profileHost.append(label); }
  q<HTMLTextAreaElement>('.achmage-profile-style').value = profile.styleNote ?? '';
  button('profile-save').onclick = () => {
    const next: UserProfile = { styleNote: q<HTMLTextAreaElement>('.achmage-profile-style').value };
    for (const field of PROFILE_FIELDS) next[field.key] = q<HTMLInputElement>(`[data-profile="${field.key}"]`).value;
    try { saveProfile(localStorage, next); profile = loadProfile(localStorage); message('내 정보를 저장했습니다. 이 컴퓨터에만 보관됩니다.', 'info'); } catch { message('내 정보를 저장하지 못했습니다.'); }
  };
  button('profile-clear').onclick = () => {
    try { saveProfile(localStorage, {}); } catch { /* nothing stored */ }
    profile = {}; for (const field of PROFILE_FIELDS) q<HTMLInputElement>(`[data-profile="${field.key}"]`).value = ''; q<HTMLTextAreaElement>('.achmage-profile-style').value = '';
    message('내 정보를 지웠습니다.', 'info');
  };
  button('profile-export').onclick = () => {
    // The saved values only (never the unsaved form), as JSON the user can keep or move to another computer.
    const saved = loadProfile(localStorage);
    if (!Object.values(saved).some(value => value)) { message('저장된 내 정보가 없습니다.', 'info'); return; }
    void navigator.clipboard.writeText(JSON.stringify(saved, null, 2)).then(() => message('저장된 내 정보를 JSON으로 클립보드에 복사했습니다.', 'info'), () => message('클립보드에 복사하지 못했습니다.'));
  };
  button('new-conversation').onclick = () => { if (workflowAbort || connection.busy || connection.current?.busy || connection.current?.turn?.status === 'running' || applying) return; history = [];workflowSources=[]; contextFrom = 0; lastWorkflow=undefined;retainedSelection=undefined;request = null; prompt.value = ''; try { localStorage.removeItem(CHAT_STORAGE_KEY); } catch { /* memory reset still works */ } lastAnswer = undefined; lastApplied = undefined; choices = null; q('.achmage-account-menu').hidden = true; message('새 대화를 시작했습니다. 문서와 계정 연결은 유지됩니다.', 'info'); render(); };
  button('restore-history').onclick=()=>{if(workflowAbort||applying||connection.current?.busy||history.length)return;history=loadHistory(localStorage);contextFrom=0;message(history.length?'이전 대화를 불러왔습니다. 현재 문서를 다시 확인하며 이어갑니다.':'저장된 대화가 없습니다.','info');render();};
  button('clear-history').onclick = () => { if (confirm('이 기기에 보관된 모든 제공자의 대화를 지울까요? 문서는 바뀌지 않습니다.')) { history = []; try { localStorage.removeItem(CHAT_STORAGE_KEY); } catch { /* memory still cleared */ } render(); } };
  button('account').onclick = () => { const element = q('.achmage-account-menu'); element.hidden = !element.hidden; button('account').setAttribute('aria-expanded', String(!element.hidden)); };
  button('tools').onclick = () => { const element = q('.achmage-more'); element.hidden = !element.hidden; button('tools').setAttribute('aria-expanded', String(!element.hidden)); };
  for (const [name,id] of extensionButtons) button(name).onclick = () => extensionActions.find(action => action.id === id)?.run();
  // A Hangul file becomes one of my templates locally (no model call); the template window shows the result.
  button('template-add').onclick = () => requestTemplateImport();
  mode.onchange = render;
  opener.onclick = () => setClosed(!closed); button('toggle').onclick = () => setClosed(true); opener.setAttribute('aria-expanded','true');
  panel.addEventListener('keydown', event => { event.stopPropagation(); if (event.key === 'Escape' && !composing) { event.preventDefault(); setClosed(true); } });
  prompt.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !composing) { event.preventDefault(); void send(); } });
  const compositionStart = () => { composing = true; render(); }, compositionEnd = () => { composing = false; render(); };
  document.addEventListener('compositionstart', compositionStart, true); document.addEventListener('compositionend', compositionEnd, true); prompt.addEventListener('input', render);
  const resize = q('.achmage-resize'); let dragging = false;
  resize.onpointerdown = event => { dragging = true; resize.setPointerCapture(event.pointerId); event.preventDefault(); };
  resize.onpointermove = event => { if (dragging) setWidth(panel.getBoundingClientRect().right - event.clientX); };
  resize.onpointerup = () => { dragging = false; saveWidth(); window.dispatchEvent(new Event('resize')); };
  resize.onpointercancel = () => { dragging = false; saveWidth(); };
  resize.onkeydown = event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setWidth(width + (event.key === 'ArrowLeft' ? 20 : -20)); saveWidth(); window.dispatchEvent(new Event('resize')); } };
  const editListener = (event: Event) => { const detail = (event as CustomEvent<PanelEditRequest>).detail; setClosed(false); if (detail?.capture && typeof detail.instruction === 'string') void send(detail.capture, detail.instruction); };
  document.addEventListener(PANEL_EDIT_EVENT, editListener);
  const wholeListener = (event: Event) => { const detail = (event as CustomEvent<{ instruction: string }>).detail; setClosed(false); if (typeof detail?.instruction === 'string') void send(undefined, detail.instruction, { whole: true }); };
  document.addEventListener(PANEL_WHOLE_EDIT_EVENT, wholeListener);
  const askListener = (event: Event) => { const detail = (event as CustomEvent<{ instruction: string }>).detail; setClosed(false); if (typeof detail?.instruction === 'string') void send(undefined, detail.instruction, { routed: true }); };
  document.addEventListener(PANEL_ASK_EVENT, askListener);
  const restyleListener = () => { setClosed(false); let template: DocumentTemplate | undefined; try { template = documentTemplates?.current(); } catch { message('저장된 문서 서식을 읽지 못했습니다.'); return; } void restyle(template); };
  document.addEventListener(PANEL_RESTYLE_EVENT, restyleListener);
  const tocListener = () => { setClosed(false); void refreshToc(); };
  document.addEventListener(PANEL_TOC_EVENT, tocListener);
  const stopActions = watchPanelActions(actions => { extensionActions = actions; const host = q('[data-extension-menu]'); host.replaceChildren(); for (const action of actions.filter(action => action.id === 'google-runtime')) { const item = document.createElement('button'); item.textContent = 'Gemini 연결 관리'; item.dataset.providerTool = 'gemini'; item.setAttribute('data-provider-tool','gemini'); item.hidden = connection.current?.selectedProvider !== 'gemini'; item.onclick = () => { q('.achmage-more').hidden = true; action.run(); }; host.append(item); }
    // The Telegram remote connection is not tied to a provider: always offered.
    for (const action of actions.filter(action => action.id === 'telegram')) { const item = document.createElement('button'); item.textContent = action.label; item.dataset.panelTool = 'telegram'; item.onclick = () => { q('.achmage-more').hidden = true; action.run(); }; host.append(item); }
    render(); });
  documentTemplates=installDocumentTemplates(template=>{button('templates').title=template?'문서 서식 · '+template.name:'문서 서식 선택';button('templates').setAttribute('aria-label',button('templates').title);button('templates').setAttribute('aria-pressed',String(!!template));});
  const stopResearch = installResearchExtension({ content: q('[data-extension-content]'), registerAction: registerPanelAction, onAttachContext: text => {
    if (composing || connection.busy || connection.current?.commandPending) { message('진행 중인 입력을 마친 뒤 첨부해 주세요.'); return; }
    const value = [prompt.value.trimEnd(), text].filter(Boolean).join('\n\n');
    prompt.value = value; message('출처를 입력창에 첨부했습니다. 확인 후 보내세요.', 'info'); render();
  }, onInsertCitation: text => {
    // The source record as retrieved, at the caret, with no model call; one Ctrl+Z removes it.
    if (composing || applying) { message(busyMessage()); return; }
    let capture: ReturnType<typeof doc.captureInsertion>;
    try { capture = doc.captureInsertion(); } catch (error) { message(error instanceof Error ? error.message : '인용을 넣을 위치를 확인하세요.'); return; }
    // A citation is always its own paragraph: after the line it follows, before the line it starts,
    // or between the two halves of a line the caret is inside.
    const line = Array.from(capture.insertion.paragraph), at = capture.insertion.position.charOffset;
    const placed = !line.length ? text : at >= line.length ? '\n' + text : at === 0 ? text + '\n' : '\n' + text + '\n';
    applying = true; render();
    void doc.apply(capture, placed).then(() => { lastApplied = undefined; message('출처 인용을 커서 위치에 넣었습니다(AI 없이). Ctrl+Z로 되돌릴 수 있습니다.', 'success'); }, error => message(error instanceof Error ? error.message : '인용을 넣지 못했습니다.')).finally(() => { applying = false; render(); });
  } });
  const selectionOff=deps.eventBus.on('selection-changed',()=>{try{retainedSelection=doc.captureSelection();}catch{if(!(document.activeElement as HTMLElement|null)?.closest?.('.achmage-ai,.achmage-inline-popover'))retainedSelection=undefined;}});
  const offs = ['document-mutated','desktop-document-loaded','cursor-moved','selection-changed'].map(name => deps.eventBus.on(name, () => { if (request?.capture && !doc.isCurrent(request.capture)) request.stale = true; if (request?.structured && !doc.isStructuredCurrent(request.structured)) request.stale = true; render(); }));
  const timer = window.setInterval(() => { void refresh(); }, 500); render(); void refresh();
  return () => { disposed = true; workflowAbort?.abort();workflowClient?.fail('창이 닫혀 요청을 중지했습니다.');selectionOff();clearInterval(timer); offs.forEach(off => off()); stopResearch(); stopActions(); stopInline(); stopRuntime(); stopTelegram(); stopImage(); documentTemplates?.dispose();doc.dispose(); document.removeEventListener(PANEL_EDIT_EVENT, editListener); document.removeEventListener(PANEL_WHOLE_EDIT_EVENT, wholeListener); document.removeEventListener(PANEL_ASK_EVENT, askListener); document.removeEventListener(PANEL_RESTYLE_EVENT, restyleListener); document.removeEventListener(PANEL_TOC_EVENT, tocListener); document.removeEventListener('compositionstart', compositionStart, true); document.removeEventListener('compositionend', compositionEnd, true); workspace.before(area); workspace.remove(); opener.remove(); if (toolbar && toolbarTrack) toolbar.append(...Array.from(toolbarTrack.children)); toolbarScroll?.remove(); };
}
