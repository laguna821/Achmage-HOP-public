import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpConnection } from './mcp-connection';
import { settingsView, testSearch } from './settings-view';
import type { Action, Catalog, Source } from './types';

// Small DOM boundary double; the production view code runs unchanged.
class Node extends EventTarget {
  children: (Node | string)[] = []; className = ''; textContent = ''; value = ''; checked = false; disabled = false; hidden = false; open = false;
  type = ''; placeholder = ''; autocomplete = ''; href = ''; target = ''; rel = ''; dataset: Record<string, string> = {};
  onclick: (() => unknown) | null = null; onchange: (() => unknown) | null = null;
  constructor(public tag: string) { super(); }
  append(...items: (Node | string)[]) { this.children.push(...items); }
  replaceChildren(...items: (Node | string)[]) { this.children = [...items]; }
  setAttribute() {}
  get isConnected() { return true; }
  all(): Node[] { return this.children.flatMap(c => typeof c === 'string' ? [] : [c, ...c.all()]); }
  text(): string { return this.textContent + this.children.map(c => typeof c === 'string' ? c : c.text()).join(''); }
  click() { this.dispatchEvent(new Event('click')); void this.onclick?.(); }
}
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const base = (over: Partial<Source>): Source => ({ id: 'x', name: 'X', operator: 'Operator', protocol: 'native', role: 'index', docsUrl: 'https://docs.example/',
  runtimeStatus: 'ready', missingFields: [], settings: { options: {} }, secretFields: [], optionFields: [], storedSecrets: {}, ...over });
const catalog: Catalog = { cmdsCommit: 'x', packs: [{ id: 'korean-facts', name: 'Korean Facts', sourceIds: ['korean-law', 'kosis'] }], sources: [
  base({ id: 'korean-law', name: 'Korean Law MCP', protocol: 'mcp', runtimeStatus: 'off', secretFields: [{ id: 'oc', label: 'OC credential', required: true }], storedSecrets: { oc: false }, issueUrl: 'https://open.law.go.kr/', effectiveEndpoint: 'https://mcp.gomdori.app/law' }),
  base({ id: 'kosis', name: 'KOSIS MCP', protocol: 'mcp', runtimeStatus: 'ready', thirdPartyOperator: true, settings: { options: {}, enabled: true }, effectiveEndpoint: 'https://kosismcp2026.vercel.app/api/mcp' }),
  base({ id: 'naver', name: 'NAVER', runtimeStatus: 'needs_configuration', missingFields: ['api-key'],
    secretFields: [{ id: 'key-id', label: 'Client ID', required: true }, { id: 'api-key', label: 'Client Secret', required: true }], storedSecrets: { 'key-id': true, 'api-key': false },
    optionFields: [{ id: 'credential-service', label: 'Credential service', required: true, defaultValue: 'auto', description: 'Auto tries API HUB first.', choices: [{ value: 'auto', label: 'Auto' }, { value: 'api-hub', label: 'API HUB' }] }] }),
  base({ id: 'crossref', name: 'Crossref', connectionVerified: true }),
] };
let calls: Action[], reload: ReturnType<typeof vi.fn<() => Promise<void>>>;
function transport(answers: Partial<Record<Action['op'], unknown>> = {}) {
  return async (action: Action) => { calls.push(action); return answers[action.op] ?? { ok: true }; };
}
function view(t = transport()) {
  const open = new Set<string>(), notes = new Map<string, string>();
  const root = settingsView(catalog, { transport: t, mcp: new McpConnection(t, async () => {}), reload, open, notes }) as unknown as Node;
  const card = (id: string) => root.all().find(n => n.dataset.source === id)!;
  const press = (id: string, label: string) => card(id).all().find(n => n.tag === 'button' && n.textContent === label)!.click();
  return { root, card, press, open, notes };
}
beforeEach(() => { calls = []; reload = vi.fn(async () => {}); vi.stubGlobal('document', { createElement: (tag: string) => new Node(tag) }); });

describe('research connection settings (CMDS-style cards)', () => {
  it('groups cards by pack with a status badge, a key-issuing link and stored-key placeholders that never show the key', () => {
    const { root, card } = view();
    expect(root.children.filter((n): n is Node => typeof n !== 'string' && n.tag === 'h4').map(n => n.textContent)).toEqual(['Korean Facts', '그 밖의 연결']);
    const law = card('korean-law');
    expect(law.text()).toContain('꺼짐');
    expect(law.all().find(n => n.tag === 'a' && n.textContent === '키 발급 사이트')?.href).toBe('https://open.law.go.kr/');
    expect(law.all().find(n => n.type === 'checkbox')?.checked).toBe(false);
    expect(card('crossref').text()).toContain('연결 확인됨');
    const naver = card('naver'), inputs = naver.all().filter(n => n.type === 'password');
    expect(inputs.map(i => i.placeholder)).toEqual(['저장됨 · 바꿀 때만 새로 입력', '필수']);
    expect(naver.all().filter(n => n.textContent === '이 키 삭제')).toHaveLength(1);
    const select = naver.all().find(n => n.tag === 'select')!;
    expect(select.value).toBe('auto'); expect(select.children).toHaveLength(2);
    expect(naver.text()).toContain('Auto tries API HUB first.');
  });
  it('turns Korean Law on with one switch: the key goes to the credential store, the settings only say "enabled"', async () => {
    const { card, press, notes } = view();
    const law = card('korean-law'), oc = law.all().find(n => n.type === 'password')!, toggle = law.all().find(n => n.type === 'checkbox')!;
    oc.value = 'my-oc'; toggle.checked = true;
    press('korean-law', '저장'); await flush();
    expect(calls).toEqual([{ op: 'set_secret', sourceId: 'korean-law', field: 'oc', value: 'my-oc' }, { op: 'configure', sourceId: 'korean-law', settings: { options: {}, enabled: true } }]);
    expect(oc.value).toBe(''); expect(reload).toHaveBeenCalledTimes(1); expect(notes.get('korean-law')).toBe('저장했습니다.');
  });
  it('tests a native source with one fixed search after saving, and an MCP server by listing its tools', async () => {
    const answers = { start: { jobId: 'j' }, poll: { status: 'completed', result: { records: [{}], warnings: [], provenance: [], cacheHit: false } } };
    const { press, notes } = view(transport(answers));
    press('crossref', '저장하고 연결 시험'); await flush();
    expect(calls.map(c => c.op)).toEqual(['configure', 'start', 'poll']);
    expect(calls[1]).toEqual({ op: 'start', request: { sourceId: 'crossref', query: '교육', limit: 1 } });
    expect(notes.get('crossref')).toContain('시험 검색 결과 1건');
    calls = [];
    const mcp = view(transport({ mcp_list: { jobId: 'm' }, poll: { status: 'mcp_completed', result: { result: { tools: [{}, {}, {}] } } } }));
    mcp.press('kosis', '저장하고 연결 시험'); await flush();
    expect(calls.map(c => c.op)).toEqual(['configure', 'mcp_list', 'poll']);
    expect(calls[0]).toEqual({ op: 'configure', sourceId: 'kosis', settings: { options: {}, enabled: true } });
    expect(mcp.notes.get('kosis')).toContain('서버 도구 3개');
  });
  it('shows why a test failed instead of a stale success', async () => {
    const { card, press, notes } = view(transport({ start: { jobId: 'j' }, poll: { status: 'failed', message: 'HTTP 401' } }));
    press('crossref', '저장하고 연결 시험'); await flush();
    expect(card('crossref').text()).toContain('HTTP 401'); expect(notes.has('crossref')).toBe(false); expect(reload).not.toHaveBeenCalled();
  });
  it('saves the switch as it is flipped, and says plainly that a third party runs the server', async () => {
    const { card, notes } = view();
    const toggle = card('korean-law').all().find(n => n.type === 'checkbox')!;
    toggle.checked = true; toggle.dispatchEvent(new Event('change')); await flush();
    expect(calls).toEqual([{ op: 'configure', sourceId: 'korean-law', settings: { options: {}, enabled: true } }]);
    expect(notes.get('korean-law')).toBe('연결을 켰습니다.');
    expect(card('kosis').text()).toContain('제3자가 운영하는 서버입니다');
    expect(card('kosis').text()).toContain('운영자를 확인하지 못한 시범 서버입니다');
  });
  it('says a missing key in Korean instead of the native English message', async () => {
    const { card, press } = view(transport({ mcp_list: { jobId: 'm' }, poll: { status: 'failed', message: 'MCP provider credential is missing' } }));
    press('kosis', '저장하고 연결 시험'); await flush();
    expect(card('kosis').text()).toContain('OC 값(키)이 저장되어 있지 않습니다');
  });
  it('proves an OpenDART key with a company code, since that source takes nothing else', async () => {
    calls = [];
    await testSearch(transport({ start: { jobId: 'j' }, poll: { status: 'completed', result: { records: [], warnings: [], provenance: [], cacheHit: false } } }), 'opendart');
    expect(calls[0]).toEqual({ op: 'start', request: { sourceId: 'opendart', query: '00126380', limit: 1 } });
  });
});
