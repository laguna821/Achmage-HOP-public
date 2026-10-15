import { invoke } from '@tauri-apps/api/core';
export type ProviderId = 'openai' | 'claude' | 'gemini' | 'grok';
export interface AiModel { id:string;label:string;isDefault?:boolean;defaultReasoningEffort?:string|null;supportedReasoningEfforts?:{reasoningEffort:string;description?:string}[] }
export interface AiState {
  generation: number;
  providers: { id: ProviderId; label: string; available: boolean; unavailableReason?: string | null; authMethods: string[] }[];
  selectedProvider: ProviderId;
  busy?: boolean;
  commandPending?: boolean;
  notice?: string | null;
  sessionPersistence?: string | null;
  models?: AiModel[];
  modelCatalogStatus?: 'idle'|'loading'|'ready'|'error';
  modelCatalogErrorCode?: string|null;
  modelCatalogMessage?: string|null;
  auth: { status: 'signed_out' | 'pending' | 'signed_in' | 'expired' | 'error'; sessionGeneration?: string | null; accountLabel?: string | null; plan?: string | null; message?: string | null; phase?: string | null; errorCode?: string | null };
  usage: { inputTokens?: number | null; outputTokens?: number | null; remainingPercent?: number | null; source?: string | null; updatedAt?: string | null };
  turn: { id: string | null; requestId?: string | null; status: 'idle' | 'running' | 'completed' | 'cancelled' | 'error'; text?: string | null; message?: string | null } | null;
}
export type AiAction = { type: 'select_provider'; provider: ProviderId } | { type: 'restore_connection' | 'begin_login' | 'begin_console_login' | 'cancel_login' | 'logout' | 'refresh_models' } | { type: 'send'; prompt: string; requestId: string; model?: string; reasoningEffort?:string } | { type: 'cancel_turn'; turnId: string };
export interface AiTransport { state(): Promise<AiState>; action(expectedGeneration: number, action: AiAction): Promise<AiState> }
export const nativeTransport: AiTransport = {
  state: () => invoke('achmage_ai_state'),
  action: (expectedGeneration, action) => invoke('achmage_ai_action', { request: { expectedGeneration, action } }),
};
export function authSession(state: AiState | null): string | null {
  return state?.auth.status === 'signed_in' && typeof state.auth.sessionGeneration === 'string' && state.auth.sessionGeneration.length > 0 ? state.auth.sessionGeneration : null;
}
export function sameAuthSession(state: AiState | null, captured: string): boolean {
  return authSession(state) === captured;
}
export function shouldPoll(state: AiState | null, hidden: boolean, collapsed: boolean): boolean {
  return !hidden && !collapsed || state?.busy === true || state?.commandPending === true || state?.auth.status === 'pending' || state?.turn?.status === 'running';
}
export function usageLabel(u: AiState['usage']): string {
  // Only values the provider actually reports are shown; nothing is estimated or labelled as missing.
  const count = (v: number | null | undefined) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v.toLocaleString() : null;
  const remaining = typeof u.remainingPercent === 'number' && Number.isFinite(u.remainingPercent) && u.remainingPercent >= 0 && u.remainingPercent <= 100 ? u.remainingPercent + '%' : null;
  return [['입력', count(u.inputTokens)], ['출력', count(u.outputTokens)], ['잔여', remaining]].filter(([, value]) => value !== null).map(([label, value]) => `${label} ${value}`).join(' · ');
}
/** One transport action at a time; stale polls cannot replace newer state. */
export class AiConnection {
  current: AiState | null = null;
  busy = false;
  constructor(private transport: AiTransport, private changed: () => void) {}
  private accept(state: AiState): void {
    if (!Number.isSafeInteger(state.generation) || state.generation < 0) throw new Error('invalid generation');
    if (!this.current || state.generation >= this.current.generation) this.current = state;
    this.changed();
  }
  async refresh(): Promise<void> { this.accept(await this.transport.state()); }
  async send(action: AiAction): Promise<void> {
    if (this.busy || !this.current || this.current.commandPending) throw new Error('연결 상태를 먼저 확인하세요.');
    this.busy = true; this.changed();
    try { this.accept(await this.transport.action(this.current.generation, action)); }
    finally { this.busy = false; this.changed(); }
  }
}
