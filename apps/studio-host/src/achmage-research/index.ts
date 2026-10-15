import { ResearchConnection } from './connection';
import { McpConnection } from './mcp-connection';
import { mcpView } from './mcp-view';
import { citation, nativeTransport, type Transport, type Source, type SearchResult } from './types';
export * from './types';
export { ResearchConnection } from './connection';
type Options = { content: HTMLElement; transport?: Transport;
  registerAction?: (action: { id: string; label: string; run: () => void }) => (() => void) | void;
  onAttachContext?: (text: string) => void; onInsertCitation?: (text: string) => void };
function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag); if (text) el.textContent = text; return el;
}
function button(label: string, run: () => void) { const b = element('button', label); b.type = 'button'; b.addEventListener('click', run); return b; }
/** Mount once into the AI extension slot; no dependency on provider login or automatic model sending. */
export function installResearchExtension(options: Options): () => void {
  const transport = options.transport ?? nativeTransport, connection = new ResearchConnection(transport);
  const mcp = new McpConnection(transport);
  const root = element('section'); root.className = 'achmage-research'; root.hidden = true;
  const title = element('h3', '자료 검색'), query = element('input'); query.placeholder = '공개 논문·공식 자료 검색'; query.setAttribute('aria-label', '자료 검색어');
  const status = element('p'), sources = element('div'), packs = element('select'), results = element('div'), settings = element('div');
  const selected = new Set<string>(); let disposed = false, loading = false, epoch = 0, loadEpoch = 0;
  const close = button('닫기', () => { root.hidden = true; void connection.cancel(); void mcp.cancel(); });
  const cancel = button('검색 취소', () => { epoch++; void connection.cancel(); status.textContent = '취소됨'; loading = false; search.disabled = false; });
  const search = button('검색', () => { void run(); });
  packs.setAttribute('aria-label', '리서치 팩');
  async function load() {
    const current = ++loadEpoch;
    try {
      const catalog = await connection.catalog(); if (disposed || current !== loadEpoch) return;
      for (const id of selected) if (!catalog.sources.some(s => s.id === id && s.runtimeStatus === 'ready')) selected.delete(id);
      sources.replaceChildren(); packs.replaceChildren(element('option', '팩 선택')); settings.replaceChildren();
      for (const pack of catalog.packs) { const o = element('option', pack.name); o.value = pack.id; packs.append(o); }
      packs.onchange = () => { const pack = catalog.packs.find(p => p.id === packs.value); selected.clear(); pack?.sourceIds.forEach(id => { if (catalog.sources.some(s => s.id === id && s.runtimeStatus === 'ready')) selected.add(id); }); refreshChecks(); };
      for (const source of catalog.sources) {
        const label = element('label'), check = element('input'); check.type = 'checkbox'; check.value = source.id;
        check.disabled = source.runtimeStatus !== 'ready'; check.checked = selected.has(source.id);
        check.onchange = () => { if (check.checked) selected.add(source.id); else selected.delete(source.id); };
        label.append(check, document.createTextNode(source.name + (check.disabled ? ` · ${source.protocol === 'mcp' ? '명시 MCP 연결 필요' : '설정 필요'}` : ''))); sources.append(label);
        settings.append(sourceSettings(source));
        if (source.protocol === 'mcp') settings.append(mcpView(source, mcp, transport));
      }
      if (!selected.size) { selected.add('crossref'); selected.add('europe-pmc'); refreshChecks(); }
      status.textContent = '검색 결과는 출처 자료입니다. 키가 필요한 연결은 설정 후 사용할 수 있습니다.';
    } catch { if (!disposed && current === loadEpoch) status.textContent = '리서치 연결을 불러오지 못했습니다. 네이티브 연결 상태를 확인하세요.'; }
  }
  function refreshChecks() { sources.querySelectorAll<HTMLInputElement>('input').forEach(c => { c.checked = selected.has(c.value) && !c.disabled; }); }
  function sourceSettings(source: Source): HTMLElement {
    const detail = element('details'), summary = element('summary', `${source.name} 연결 설정`); detail.append(summary);
    const link = element('a', '연결 안내'); link.href = source.docsUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; detail.append(link);
    // Who runs the server: the key and search terms entered here go to that operator.
    detail.append(element('p', `운영: ${source.operator}. 입력한 키와 검색어는 이 운영 서버로 전송됩니다.`));
    const secretInputs = new Map<string, HTMLInputElement>(), optionInputs = new Map<string, HTMLInputElement>();
    for (const field of source.secretFields) { const label = element('label', field.label), input = element('input'); input.type = 'password'; input.autocomplete = 'new-password'; label.append(input); detail.append(label); secretInputs.set(field.id, input);
      detail.append(button('이 키 삭제', () => { void transport({ op: 'set_secret', sourceId: source.id, field: field.id, value: null }).then(load).catch(() => { status.textContent = 'OS 키 저장소에서 삭제하지 못했습니다.'; }); })); }
    for (const field of source.optionFields) { const label = element('label', field.label), input = element('input'); input.value = source.settings.options[field.id] ?? field.defaultValue ?? ''; label.append(input); detail.append(label); optionInputs.set(field.id, input); }
    detail.append(button('설정 저장', () => { void (async () => {
      try { for (const [field, input] of secretInputs) { if (input.value) { const value = input.value; input.value = ''; await transport({ op: 'set_secret', sourceId: source.id, field, value }); } }
        await transport({ op: 'configure', sourceId: source.id, settings: { options: Object.fromEntries([...optionInputs].filter(([, i]) => i.value).map(([k, i]) => [k, i.value])) } }); await load();
      } catch (e) { const reason = e instanceof Error ? e.message : typeof e === 'string' ? e : ''; status.textContent = `저장하지 못했습니다${reason ? `: ${reason}` : '.'} OS 자격증명 저장소와 입력을 확인하세요.`; }
    })(); })); return detail;
  }
  async function run() {
    if (loading) return; const current = ++epoch; loading = true; search.disabled = true; results.replaceChildren(); status.textContent = '검색 중…';
    try { await connection.search(query.value, [...selected], (source, result) => {
      if (disposed || current !== epoch) return;
      if (result instanceof Error) results.append(element('p', `${source}: ${result.message}`)); else renderResults(source, result);
    }); if (!disposed && current === epoch) status.textContent = '검색 완료. 결과를 확인한 뒤 첨부하세요.';
    } catch (e) { if (!disposed && current === epoch) status.textContent = e instanceof Error ? e.message : '검색 실패'; }
    finally { if (current === epoch) { loading = false; search.disabled = false; } }
  }
  function renderResults(source: string, result: SearchResult) {
    results.append(element('h4', `${source} · ${result.records.length}건${result.cacheHit ? ' · 캐시' : ''}`));
    result.warnings.forEach(w => results.append(element('p', w)));
    for (const record of result.records) {
      const item = element('article'), heading = element('strong', record.title), meta = element('p', `${record.operator} · ${record.publishedAt || '발행일 미상'} · 조회 ${record.retrievedAt}`);
      item.append(heading, meta); if (record.url && /^https?:\/\//i.test(record.url)) { const a = element('a', '원문 출처'); a.href = record.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; item.append(a); }
      if (record.snippet) item.append(element('p', record.snippet)); record.caveats.forEach(c => item.append(element('small', c)));
      if (options.onAttachContext) item.append(button('채팅에 출처 첨부', () => options.onAttachContext?.(citation(record))));
      if (options.onInsertCitation) item.append(button('인용 삽입', () => options.onInsertCitation?.(citation(record)))); results.append(item);
    }
  }
  root.append(title, close, query, packs, sources, search, cancel, status, results, settings); options.content.append(root);
  const unregister = options.registerAction?.({ id: 'research', label: '자료 검색', run: () => { root.hidden = !root.hidden; if (!root.hidden) void load(); } });
  // Hosts without an action registry may expose this button in their own settings view.
  if (!options.registerAction) { const opener = button('자료 검색', () => { root.hidden = !root.hidden; if (!root.hidden) void load(); }); options.content.prepend(opener); return () => { disposed = true; epoch++; connection.dispose(); mcp.dispose(); opener.remove(); root.remove(); }; }
  return () => { disposed = true; epoch++; connection.dispose(); mcp.dispose(); unregister?.(); root.remove(); };
}
