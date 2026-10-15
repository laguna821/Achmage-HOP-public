import { ResearchConnection } from './connection';
import { McpConnection } from './mcp-connection';
import { settingsView } from './settings-view';
import { citation, nativeTransport, sourceStatus, type Transport, type SearchResult, type Catalog } from './types';
export * from './types';
export { ResearchConnection } from './connection';
type Options = { content: HTMLElement; transport?: Transport;
  registerAction?: (action: { id: string; label: string; run: () => void }) => (() => void) | void;
  onAttachContext?: (text: string) => void; onInsertCitation?: (text: string) => void };
function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag); if (text) el.textContent = text; return el;
}
function button(label: string, run: () => void) { const b = element('button', label); b.type = 'button'; b.addEventListener('click', run); return b; }
/** The sources ticked last time, kept in this window profile (a convenience; a fresh profile starts from the defaults). */
const SELECTED_KEY = 'achmage.hop.research.selected.v1';
const DEFAULT_SOURCES = ['crossref', 'europe-pmc'];
function remembered(): string[] {
  try { const value = JSON.parse(localStorage.getItem(SELECTED_KEY) ?? 'null') as unknown; return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []; } catch { return []; }
}
function remember(ids: Iterable<string>): void { try { localStorage.setItem(SELECTED_KEY, JSON.stringify([...ids])); } catch { /* storage unavailable: the selection lasts for this session */ } }
type View = 'search' | 'settings';
/** Mount once into the AI extension slot; no dependency on provider login or automatic model sending. */
export function installResearchExtension(options: Options): () => void {
  const transport = options.transport ?? nativeTransport, connection = new ResearchConnection(transport);
  const mcp = new McpConnection(transport);
  const root = element('section'); root.className = 'achmage-research'; root.hidden = true;
  const title = element('h3', '자료 검색'), query = element('input'); query.placeholder = '공개 논문·공식 자료 검색'; query.setAttribute('aria-label', '자료 검색어');
  const status = element('p'), sources = element('div'), packs = element('select'), results = element('div'), settings = element('div');
  const searchPane = element('div'), settingsPane = element('div');
  const selected = new Set<string>(remembered()), open = new Set<string>(), notes = new Map<string, string>();
  let disposed = false, loading = false, epoch = 0, loadEpoch = 0;
  const close = button('닫기', () => { root.hidden = true; void connection.cancel(); void mcp.cancel(); });
  const cancel = button('검색 취소', () => { epoch++; void connection.cancel(); status.textContent = '취소됨'; loading = false; search.disabled = false; });
  const search = button('검색', () => { void run(); });
  const toSettings = button('연결 설정', () => show('settings')), toSearch = button('검색으로 돌아가기', () => show('search'));
  packs.setAttribute('aria-label', '리서치 팩');
  function show(view: View) {
    searchPane.hidden = view !== 'search'; settingsPane.hidden = view !== 'settings';
    title.textContent = view === 'search' ? '자료 검색' : '자료 검색 연결 설정';
  }
  async function load() {
    const current = ++loadEpoch;
    try {
      const catalog = await connection.catalog(); if (disposed || current !== loadEpoch) return;
      render(catalog);
    } catch { if (!disposed && current === loadEpoch) status.textContent = '리서치 연결을 불러오지 못했습니다. 네이티브 연결 상태를 확인하세요.'; }
  }
  function render(catalog: Catalog) {
    const ready = (id: string) => catalog.sources.some(s => s.id === id && s.runtimeStatus === 'ready');
    for (const id of selected) if (!ready(id)) selected.delete(id);
    if (!selected.size) DEFAULT_SOURCES.filter(ready).forEach(id => selected.add(id));
    sources.replaceChildren(); packs.replaceChildren(element('option', '팩 선택'));
    for (const pack of catalog.packs) { const o = element('option', pack.name); o.value = pack.id; packs.append(o); }
    packs.onchange = () => { const pack = catalog.packs.find(p => p.id === packs.value); selected.clear(); pack?.sourceIds.forEach(id => { if (ready(id)) selected.add(id); }); remember(selected); refreshChecks(); };
    for (const source of catalog.sources) {
      // The custom connection is used tool by tool from its card, not from the search box.
      if (source.id === 'custom-mcp') continue;
      const label = element('label'), check = element('input'); check.type = 'checkbox'; check.value = source.id;
      check.disabled = source.runtimeStatus !== 'ready'; check.checked = selected.has(source.id);
      check.onchange = () => { if (check.checked) selected.add(source.id); else selected.delete(source.id); remember(selected); };
      label.append(check, document.createTextNode(source.name + (check.disabled ? ` · ${sourceStatus(source)}` : ''))); sources.append(label);
    }
    settings.replaceChildren(settingsView(catalog, { transport, mcp, reload: load, open, notes }));
    status.textContent = '검색 결과는 출처 자료입니다. 키가 필요한 소스와 법령·KOSIS는 연결 설정에서 켭니다.';
  }
  function refreshChecks() { sources.querySelectorAll<HTMLInputElement>('input').forEach(c => { c.checked = selected.has(c.value) && !c.disabled; }); }
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
      if (record.snippet) { const snippet = element('p', record.snippet); snippet.className = 'achmage-research-snippet'; item.append(snippet); }
      record.caveats.forEach(c => item.append(element('small', c)));
      if (options.onAttachContext) item.append(button('채팅에 출처 첨부', () => options.onAttachContext?.(citation(record))));
      if (options.onInsertCitation) item.append(button('인용 삽입', () => options.onInsertCitation?.(citation(record)))); results.append(item);
    }
  }
  searchPane.append(query, packs, sources, search, cancel, toSettings, status, results);
  settingsPane.append(toSearch, settings);
  root.append(title, close, searchPane, settingsPane); options.content.append(root); show('search');
  /** The panel button toggles its view; the other view's button switches to it. */
  const opener = (view: View) => () => {
    const showing = !root.hidden && (view === 'search' ? !searchPane.hidden : !settingsPane.hidden);
    root.hidden = showing; if (!showing) { show(view); void load(); }
  };
  const unregisterSearch = options.registerAction?.({ id: 'research', label: '자료 검색', run: opener('search') });
  const unregisterSettings = options.registerAction?.({ id: 'research-settings', label: '자료 검색 연결 설정', run: opener('settings') });
  // Hosts without an action registry may expose this button in their own settings view.
  if (!options.registerAction) { const openButton = button('자료 검색', opener('search')); options.content.prepend(openButton); return () => { disposed = true; epoch++; connection.dispose(); mcp.dispose(); openButton.remove(); root.remove(); }; }
  return () => { disposed = true; epoch++; connection.dispose(); mcp.dispose(); unregisterSearch?.(); unregisterSettings?.(); root.remove(); };
}
