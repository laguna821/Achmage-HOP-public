import type { ProviderId } from './bridge';
import { maskSafeEnd } from './outbound-gate';

export const CHAT_STORAGE_KEY = 'achmage.hop.chat.v1';
export const PANEL_WIDTH_KEY = 'achmage.hop.panel.width';
/** The AI provider the user last chose; restored on the next launch so they need not pick it again. */
export const PROVIDER_KEY = 'achmage.hop.provider.v1';
export const MAX_CHAT_BYTES = 512 * 1024;
export interface ChatEntry { id: string; provider: ProviderId; role: 'user' | 'assistant'; text: string; at: number }
export interface StoragePort { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
const providers = new Set(['openai', 'claude', 'gemini', 'grok']);
export function loadProvider(storage: Pick<StoragePort, 'getItem'>): ProviderId | null {
  try { const value = storage.getItem(PROVIDER_KEY); return value && providers.has(value) ? value as ProviderId : null; } catch { return null; }
}
export function saveProvider(storage: Pick<StoragePort, 'setItem'>, provider: ProviderId): void {
  try { storage.setItem(PROVIDER_KEY, provider); } catch { /* optional preference */ }
}
export function panelWidth(value: number): number { return Number.isFinite(value) ? Math.max(320, Math.min(560, Math.round(value))) : 380; }
/** A user message keeps at most this much text in the history: a pasted 25-page manuscript must not push the whole history out. */
export const MAX_STORED_ENTRY_CHARS = 8000;
const storedEntry = (entry: ChatEntry): ChatEntry => {
  const chars = Array.from(entry.text);
  return entry.role !== 'user' || chars.length <= MAX_STORED_ENTRY_CHARS ? entry : { ...entry, text: `${chars.slice(0, MAX_STORED_ENTRY_CHARS).join('')}\n[…${chars.length - MAX_STORED_ENTRY_CHARS}자는 대화 기록에 저장하지 않았습니다]` };
};
export function boundedHistory(entries: ChatEntry[]): ChatEntry[] {
  const result = entries.slice(-100).map(storedEntry);
  while (result.length && new TextEncoder().encode(JSON.stringify(result)).length > MAX_CHAT_BYTES) result.shift();
  return result;
}
export function loadHistory(storage: StoragePort): ChatEntry[] {
  try {
    const raw = storage.getItem(CHAT_STORAGE_KEY);
    if (!raw || new TextEncoder().encode(raw).length > MAX_CHAT_BYTES) return [];
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return boundedHistory(value.filter((v): v is ChatEntry => !!v && typeof v === 'object' && typeof v.id === 'string' && v.id.length < 200 && providers.has(v.provider) && (v.role === 'user' || v.role === 'assistant') && typeof v.text === 'string' && Number.isFinite(v.at)).map(v => ({ id:v.id,provider:v.provider,role:v.role,text:v.text,at:v.at })));
  } catch { return []; }
}
export function saveHistory(storage: StoragePort, entries: ChatEntry[]): boolean {
  try { storage.setItem(CHAT_STORAGE_KEY, JSON.stringify(boundedHistory(entries))); return true; } catch { return false; }
}
export function addHistory(entries: ChatEntry[], entry: ChatEntry): ChatEntry[] {
  return boundedHistory([...entries.filter(v => !(v.id === entry.id && v.role === entry.role)), entry]);
}
export function acceptsCompletion(active: { id: string; session: string } | null, session: string | null, turn: { requestId?: string | null; status: string } | null | undefined): boolean {
  return !!active && session === active.session && turn?.requestId === active.id && turn.status === 'completed';
}

/**
 * The original is sent as a JSON string, and models sometimes echo the quotes. Outer quotes the
 * original did not have are removed, but only when unambiguous ("A" 그리고 "B" is left alone).
 */
export function unwrapQuotedReply(reply: string, before: string): string {
  const text = reply.trim(), original = before.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"') && !original.startsWith('"')) {
    try { const value: unknown = JSON.parse(text); if (typeof value === 'string') return value; } catch { /* not a JSON string literal */ }
    const inner = text.slice(1, -1); return inner.includes('"') ? reply : inner;
  }
  for (const [open, close] of [['\u201c', '\u201d'], ['\u300c', '\u300d']] as const) {
    if (text.length >= 2 && text.startsWith(open) && text.endsWith(close) && !original.startsWith(open)) {
      const inner = text.slice(1, -1); return inner.includes(open) || inner.includes(close) ? reply : inner;
    }
  }
  return reply;
}

/** Preserve the original brief through clarification turns, within a bounded session budget. */
export function conversationContext(entries: ChatEntry[], provider: ProviderId, since = 0): { role: 'user' | 'assistant'; text: string }[] {
  const session = entries.filter(e => e.provider === provider && e.at >= since);
  const chosen = session.length > 24 ? [session[0], ...session.slice(-23)] : session;
  const first = chosen[0];
  if (!first) return [];
  const firstChars = Array.from(first.text);
  const brief = {role:first.role,text:firstChars.slice(0,maskSafeEnd(firstChars,8000)).join('')};
  let remaining = 48000 - Array.from(brief.text).length;
  const tail: {role:'user'|'assistant';text:string}[] = [];
  for (const entry of chosen.slice(1).reverse()) {
    if (remaining <= 0) break;
    const all=Array.from(entry.text),chars=all.slice(0,maskSafeEnd(all,Math.min(8000,remaining)));
    remaining-=chars.length;
    tail.unshift({role:entry.role,text:chars.join('')});
  }
  return [brief,...tail];
}
