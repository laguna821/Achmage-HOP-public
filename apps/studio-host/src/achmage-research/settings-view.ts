import type { McpConnection } from './mcp-connection';
import { mcpView } from './mcp-view';
import { sourceStatus, type Catalog, type Job, type Source, type Transport } from './types';

/**
 * One card per source, grouped by research pack: a status badge, keys stored only in the OS credential
 * store (shown as "저장됨", never read back), the source's own choices, and a test that proves the key
 * and address work. Korean Law and KOSIS connect with one switch (saved as it is flipped) to their registered address.
 */
export interface SettingsViewOptions {
  transport: Transport;
  mcp: McpConnection;
  /** Reloads the catalog and redraws both views. */
  reload: () => Promise<void>;
  /** Cards the user has open survive the redraw that follows a save. */
  open: Set<string>;
  /** The last outcome per card, shown again after the redraw. */
  notes: Map<string, string>;
}

/** A fixed query that only proves the key and address work (OpenDART takes a company code). */
const TEST_QUERY: Record<string, string> = { opendart: '00126380' };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag); if (text) e.textContent = text; return e;
}
function button(label: string, run: () => void): HTMLButtonElement { const b = el('button', label); b.type = 'button'; b.addEventListener('click', run); return b; }
function link(label: string, href: string): HTMLAnchorElement { const a = el('a', label); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a; }
const reason = (e: unknown) => e instanceof Error ? e.message : typeof e === 'string' ? e : '';
/** The native side reports a few conditions in English; the card says them in Korean. */
function explain(message: string): string {
  if (message === 'MCP provider credential is missing') return 'OC 값(키)이 저장되어 있지 않습니다. 키를 넣고 다시 저장하세요.';
  if (/^Missing credential/.test(message)) return '필요한 키가 저장되어 있지 않습니다. 키를 넣고 다시 저장하세요.';
  if (/credential store/i.test(message)) return 'OS 자격 증명 저장소를 열 수 없습니다(잠겨 있거나 없음). 키 저장소를 확인하세요.';
  if (message === 'Save an explicit MCP endpoint before connecting') return '연결하기 전에 서버 주소를 넣고 저장하세요.';
  if (message === 'Credential requires HTTP transport') return '키는 HTTP 연결에서만 쓸 수 있습니다. 연결 방식을 HTTP로 바꾸세요.';
  if (message === 'This credential is restricted to its registered provider origin' || message === 'MCP credential origin mismatch') return '저장한 키는 처음 등록한 서버 주소에서만 쓸 수 있습니다. 주소를 바꿨다면 키를 다시 저장하세요.';
  return message || '완료하지 못했습니다.';
}

/** One search with a fixed query and one result: proves the stored key and address work, uses the source's quota once. */
export async function testSearch(transport: Transport, sourceId: string, delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms))): Promise<number> {
  const { jobId } = await transport({ op: 'start', request: { sourceId, query: TEST_QUERY[sourceId] ?? '교육', limit: 1 } }) as { jobId: string };
  for (let i = 0; i < 240; i++) {
    const job = await transport({ op: 'poll', jobId }) as Job;
    if (job.status === 'completed') return job.result.records.length;
    if (job.status === 'failed') throw Error(job.message);
    if (job.status !== 'running') throw Error('확인을 취소했습니다.');
    await delay(250);
  }
  await transport({ op: 'cancel', jobId }).catch(() => undefined);
  throw Error('응답이 늦어 확인을 멈췄습니다.');
}

export function settingsView(catalog: Catalog, options: SettingsViewOptions): HTMLElement {
  const root = el('div'); root.className = 'achmage-research-settings';
  root.append(el('p', '키는 이 컴퓨터의 OS 자격 증명 저장소에만 저장되고 설정 파일에는 들어가지 않습니다. 키가 필요 없는 공개 소스(Crossref, OpenAlex, RISS, PubMed, Europe PMC)는 설정 없이 바로 검색할 수 있습니다.'));
  const placed = new Set<string>(), byId = new Map(catalog.sources.map(s => [s.id, s]));
  const group = (title: string, sources: Source[]) => {
    const fresh = sources.filter(s => !placed.has(s.id)); if (!fresh.length) return;
    root.append(el('h4', title)); for (const s of fresh) { placed.add(s.id); root.append(card(s, options)); }
  };
  for (const pack of catalog.packs) group(pack.name, pack.sourceIds.map(id => byId.get(id)).filter((s): s is Source => !!s));
  group('그 밖의 연결', catalog.sources);
  return root;
}

function card(source: Source, o: SettingsViewOptions): HTMLElement {
  const box = el('details'); box.className = 'achmage-research-card'; box.dataset.source = source.id; box.open = o.open.has(source.id);
  box.addEventListener('toggle', () => { if (box.open) o.open.add(source.id); else o.open.delete(source.id); });
  const summary = el('summary'), badge = el('span', sourceStatus(source));
  badge.className = `achmage-research-badge is-${source.runtimeStatus}${source.connectionVerified ? ' is-verified' : ''}`;
  summary.append(el('strong', source.name), badge); box.append(summary);
  // Who runs the server: the key and search terms entered here go to that operator.
  box.append(el('p', `운영: ${source.operator}. ${source.secretFields.length ? '입력한 키와 검색어는' : '검색어는'} 이 운영 서버로 전송됩니다.`));
  if (source.thirdPartyOperator) box.append(el('p', `제3자가 운영하는 서버입니다. ${source.id === 'kosis' ? 'KOSIS(국가통계포털) 운영 기관' : '법제처'}의 공식 서비스가 아니며, 보낸 ${source.secretFields.length ? '검색어와 키' : '검색어'}를 운영자가 기록할 수 있습니다.${source.id === 'kosis' ? ' 운영자를 확인하지 못한 시범 서버입니다.' : ''}`));
  if (source.freeBoundary) box.append(el('small', `이용 한도: ${source.freeBoundary}`));
  const links = el('p'); links.append(link('키 발급·사용 안내', source.docsUrl));
  if (source.issueUrl) links.append(' · ', link('키 발급 사이트', source.issueUrl));
  box.append(links);
  const preset = source.protocol === 'mcp' && source.id !== 'custom-mcp';
  const toggle = el('input'); toggle.type = 'checkbox'; toggle.checked = source.runtimeStatus !== 'off';
  if (preset) {
    const label = el('label'); label.append(toggle, ' 연결 켜기'); box.append(label);
    box.append(el('small', `켜면 검색어${source.secretFields.length ? '와 키' : ''}가 ${source.effectiveEndpoint ?? '등록된 주소'}로 갑니다. 끄면 이 서버로 아무것도 보내지 않습니다.`));
  }
  const secrets = new Map<string, HTMLInputElement>(), fields = new Map<string, HTMLInputElement | HTMLSelectElement>();
  for (const field of source.secretFields) {
    const label = el('label', field.label), input = el('input'), stored = source.storedSecrets?.[field.id] === true;
    input.type = 'password'; input.autocomplete = 'new-password';
    input.placeholder = stored ? '저장됨 · 바꿀 때만 새로 입력' : field.placeholder ?? (field.required ? '필수' : '선택');
    label.append(input); box.append(label); secrets.set(field.id, input);
    if (stored) box.append(button('이 키 삭제', () => { void o.transport({ op: 'set_secret', sourceId: source.id, field: field.id, value: null })
      .then(() => { o.notes.set(source.id, '키를 삭제했습니다.'); return o.reload(); })
      .catch(() => { result.textContent = 'OS 키 저장소에서 삭제하지 못했습니다.'; }); }));
  }
  for (const field of source.optionFields) {
    const label = el('label', field.label), value = source.settings.options[field.id] ?? field.defaultValue ?? '';
    let input: HTMLInputElement | HTMLSelectElement;
    if (field.choices?.length) {
      const select = el('select'); for (const choice of field.choices) { const option = el('option', choice.label); option.value = choice.value; select.append(option); }
      select.value = field.choices.some(c => c.value === value) ? value : field.choices[0].value; input = select;
    } else { const text = el('input'); text.value = value; if (field.placeholder) text.placeholder = field.placeholder; input = text; }
    label.append(input); box.append(label); if (field.description) box.append(el('small', field.description)); fields.set(field.id, input);
  }
  const result = el('p', o.notes.get(source.id) ?? ''); result.className = 'achmage-research-card-result'; o.notes.delete(source.id);
  /** Typed keys go to the OS credential store, then the options and the switch replace the saved settings. */
  const save = async () => {
    for (const [field, input] of secrets) if (input.value) { const value = input.value; input.value = ''; await o.transport({ op: 'set_secret', sourceId: source.id, field, value }); }
    const kept = Object.fromEntries([...fields].filter(([, i]) => i.value).map(([k, i]) => [k, i.value]));
    await o.transport({ op: 'configure', sourceId: source.id, settings: { options: kept, ...(preset ? { enabled: toggle.checked } : {}) } });
  };
  const run = (work: () => Promise<string>) => () => { void (async () => {
    actions.forEach(b => { b.disabled = true; }); result.textContent = '확인 중…';
    try { o.notes.set(source.id, await work()); o.open.add(source.id); await o.reload(); }
    catch (e) { result.textContent = explain(reason(e)); actions.forEach(b => { b.disabled = false; }); }
  })(); };
  const actions = [
    button('저장', run(async () => { await save(); return '저장했습니다.'; })),
    // Testing saves first: the test always uses what is stored, never what is only typed.
    button('저장하고 연결 시험', run(async () => {
      await save();
      if (source.protocol === 'mcp') {
        const listed = await o.mcp.run({ op: 'mcp_list', sourceId: source.id });
        const tools = (listed?.result as { tools?: unknown[] } | undefined)?.tools;
        return `연결했습니다. 서버 도구 ${Array.isArray(tools) ? tools.length : 0}개를 확인했습니다.`;
      }
      return `연결했습니다. 시험 검색 결과 ${await testSearch(o.transport, source.id)}건(이 소스의 사용량 1회).`;
    })),
  ];
  // The switch is the whole connection: flipping it saves (with any key typed above).
  if (preset) toggle.addEventListener('change', run(async () => { await save(); return toggle.checked ? '연결을 켰습니다.' : '연결을 껐습니다. 이 서버로 아무것도 보내지 않습니다.'; }));
  box.append(...actions, result);
  if (source.protocol === 'mcp') {
    const advanced = el('details'); advanced.append(el('summary', '고급: 도구 직접 실행'), mcpView(source, o.mcp, o.transport)); box.append(advanced);
  }
  return box;
}
