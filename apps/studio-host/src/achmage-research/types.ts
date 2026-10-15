import { maskPersonal, maskPersonalDeep, PERSONAL_LABELS } from '../achmage-ai/outbound-gate';
export type Evidence = {
  sourceId: string; sourceName: string; operator: string; role: string;
  title: string; url: string; retrievedAt: string; publishedAt?: string | null;
  identifiers: Record<string, string>; snippet?: string | null; authors: string[];
  publicationName?: string | null; editorialStatus: string; caveats: string[];
};
export type SearchResult = { records: Evidence[]; warnings: string[]; nextCursor?: string | null;
  provenance: { endpoint: string; responseSha256: string; status: number; retrievedAt: string }[]; cacheHit: boolean };
export type Job = { status: 'running' | 'cancelled' } | { status: 'failed'; message: string } | { status: 'completed'; result: SearchResult } | { status: 'mcp_completed'; result: McpResult };
export type OAuthPending = { status: 'oauth_pending'; login_browser_open?: string };
export type McpResult = { sourceId: string; endpoint: string; retrievedAt: string; resultSha256: string; result: unknown; sessionCloseConfirmed: boolean; untrusted: true; automaticRetry: false };
export type Source = { id: string; name: string; operator: string; protocol: 'native' | 'mcp'; role: string;
  docsUrl: string; runtimeStatus: string; missingFields: string[]; settings: { options: Record<string, string> };
  secretFields: { id: string; label: string; required: boolean }[];
  optionFields: { id: string; label: string; defaultValue?: string; required: boolean }[];
};
export type Catalog = { sources: Source[]; packs: { id: string; name: string; sourceIds: string[] }[]; cmdsCommit: string };
export type Action = { op: 'catalog' } | { op: 'configure'; sourceId: string; settings: { options: Record<string, string> } }
  | { op: 'set_secret'; sourceId: string; field: string; value: string | null }
  | { op: 'start'; request: { sourceId: string; query: string; limit: number; cursor?: string } }
  | { op: 'mcp_list'; sourceId: string; cursor?: string }
  | { op: 'mcp_call'; sourceId: string; name: string; arguments: Record<string, unknown> }
  | { op: 'oauth_start'; sourceId: string }
  | { op: 'oauth_disconnect'; sourceId: string }
  | { op: 'poll' | 'cancel'; jobId: string };
export type Transport = (action: Action) => Promise<unknown>;
export const nativeTransport: Transport = async action => {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke('achmage_research', { action: gateResearchAction(action) });
};
/**
 * Searches and MCP calls leave the computer: a search term with personal identifiers is not sent
 * (a masked term would only return noise), and MCP tool arguments are masked.
 */
export function gateResearchAction(action: Action): Action {
  if (action.op === 'start') {
    const masked = maskPersonal(action.request.query);
    if (masked.tokens.size) throw Error(`검색어에 개인정보(${masked.kinds.map(kind => PERSONAL_LABELS[kind]).join('·')})가 있어 외부 검색에 보내지 않았습니다. 그 부분을 빼고 검색하세요.`);
  }
  if (action.op === 'mcp_call') return { ...action, arguments: maskPersonalDeep(action.arguments).value };
  return action;
}
export function citation(record: Evidence): string {
  return `${record.authors.length ? record.authors.join(', ') + '. ' : ''}${record.title}${record.publishedAt ? ` (${record.publishedAt})` : ''}. ${record.publicationName || record.sourceName}. ${record.url}\n조회: ${record.retrievedAt} · ${record.operator} · ${record.sourceId}`;
}
