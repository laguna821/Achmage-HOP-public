import type { Capture } from './document';
export const PANEL_EDIT_EVENT = 'achmage:request-edit';
export interface PanelEditRequest { capture: Capture; instruction: string }
export function requestPanelEdit(capture: Capture, instruction: string): void {
  document.dispatchEvent(new CustomEvent<PanelEditRequest>(PANEL_EDIT_EVENT, { detail: { capture, instruction } }));
}
/** Whole open document (e.g. Ctrl+A with tables): rewritten in place through the template engine, one Ctrl+Z. */
export const PANEL_WHOLE_EDIT_EVENT = 'achmage:request-whole-edit';
export function requestPanelWholeEdit(instruction: string): void {
  document.dispatchEvent(new CustomEvent<{ instruction: string }>(PANEL_WHOLE_EDIT_EVENT, { detail: { instruction } }));
}
export interface PanelAction { id: string; label: string; run(): void }
const actions = new Map<string, PanelAction>();
const listeners = new Set<() => void>();
export function registerPanelAction(action: PanelAction): () => void {
  if (actions.has(action.id)) throw new Error('duplicate panel action');
  actions.set(action.id, action); listeners.forEach(fn => fn());
  return () => { if (actions.get(action.id) === action) { actions.delete(action.id); listeners.forEach(fn => fn()); } };
}
export function watchPanelActions(render: (values: PanelAction[]) => void): () => void {
  const update = () => render([...actions.values()]); listeners.add(update); update(); return () => { listeners.delete(update); };
}
/** '서식 추가하기' (서식 menu, AI panel): pick a Hangul file and keep its look as one of my templates. */
export const TEMPLATE_IMPORT_EVENT = 'achmage:template-import';
export function requestTemplateImport(): void {
  document.dispatchEvent(new CustomEvent(TEMPLATE_IMPORT_EVENT));
}
/** '문서 서식 관리' (서식 menu): opens the template window. */
export const TEMPLATE_MANAGE_EVENT = 'achmage:template-manage';
export function requestTemplateManage(): void {
  document.dispatchEvent(new CustomEvent(TEMPLATE_MANAGE_EVENT));
}
/** '서식만 바꾸기' from the template window: the open document takes the selected template's look, locally. */
export const PANEL_RESTYLE_EVENT = 'achmage:request-restyle';
export function requestPanelRestyle(): void {
  document.dispatchEvent(new CustomEvent(PANEL_RESTYLE_EVENT));
}
/** '목차 쪽 번호 새로 고침' from the right-click menu: no model call, one Ctrl+Z, outcome in the panel. */
export const PANEL_TOC_EVENT = 'achmage:request-toc-refresh';
export function requestPanelTocRefresh(): void {
  document.dispatchEvent(new CustomEvent(PANEL_TOC_EVENT));
}
/** A free-form request from the inline editor at the caret; the panel's router decides what it changes. */
export const PANEL_ASK_EVENT = 'achmage:request-ask';
export function requestPanelAsk(instruction: string): void {
  document.dispatchEvent(new CustomEvent<{ instruction: string }>(PANEL_ASK_EVENT, { detail: { instruction } }));
}
/** What the panel is doing and saying, so the inline popover that handed a request over never looks unresponsive. */
export const PANEL_STATUS_EVENT = 'achmage:panel-status';
/** `final` marks an outcome that waits on the user in the panel (a failed turn, a question, a confirmation). */
export interface PanelStatus { working: boolean; final?: boolean; message?: { text: string; tone: 'error' | 'success' | 'info' } }
export function publishPanelStatus(status: PanelStatus): void {
  document.dispatchEvent(new CustomEvent<PanelStatus>(PANEL_STATUS_EVENT, { detail: status }));
}
