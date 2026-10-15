import { McpConnection } from './mcp-connection';
import type { Source, McpResult, Transport } from './types';
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = ''): HTMLElementTagNameMap[K] { const e = document.createElement(tag); e.textContent = text; return e; }
export function mcpView(source: Source, connection: McpConnection, transport: Transport): HTMLElement {
  const root = el('section'), output = el('pre'), tools = el('div'), status = el('p');
  root.append(el('h4', `${source.name} · 명시 MCP 도구`), el('p', '서버의 도구와 결과는 외부 자료입니다. 인수를 확인한 뒤 실행하며 채팅이나 문서로 자동 전송하지 않습니다.'));
  const list = el('button', '도구 목록 연결'); list.type = 'button'; list.disabled = source.missingFields.length > 0;
  const cancel = el('button', 'MCP 작업 취소'); cancel.type = 'button'; cancel.onclick = () => { void connection.cancel(); status.textContent = '로컬 취소됨. 서버에서 이미 실행된 결과는 취소가 보장되지 않습니다.'; };
  if (source.id === 'custom-mcp') {
    const login = el('button', 'MCP OAuth 로그인'); login.type = 'button';
    login.disabled = !source.settings.options.oauth_client_id || source.settings.options.transport === 'stdio';
    login.onclick = () => { void (async () => {
      login.disabled = true; status.textContent = 'OAuth 제공자 확인 중…';
      try {
        const result = await connection.run({ op:'oauth_start', sourceId:source.id }, pending => {
          if (root.isConnected) status.textContent = pending.login_browser_open || '브라우저에서 인증을 마치세요. 이 창에서는 인증키를 표시하지 않습니다.';
        });
        if (result && root.isConnected) status.textContent = 'OAuth 인증 저장 완료. 도구 목록을 연결하세요.';
      } catch (e) { if (root.isConnected) status.textContent = e instanceof Error ? e.message : 'OAuth 인증 실패'; }
      finally { login.disabled = false; }
    })(); };
    const logout = el('button', 'MCP OAuth 연결 해제'); logout.type = 'button'; logout.onclick = () => { void transport({op:'oauth_disconnect',sourceId:source.id}).then(()=>{status.textContent='저장된 MCP OAuth 인증을 삭제했습니다.';}).catch(()=>{status.textContent='OS 저장소의 인증 삭제를 확인하지 못했습니다.';}); };
    root.append(login, logout);
  }
  function show(result: McpResult) {
    output.textContent = JSON.stringify(result.result, null, 2);
    status.textContent = `${result.endpoint} · ${result.retrievedAt} · SHA-256 ${result.resultSha256}${result.sessionCloseConfirmed ? '' : ' · 연결 종료 미확인'}`;
  }
  list.onclick = () => { void (async () => {
    list.disabled = true; tools.replaceChildren(); status.textContent = '도구 목록 확인 중…';
    try {
      const result = await connection.run({ op: 'mcp_list', sourceId: source.id }); if (!result || !root.isConnected) return; show(result);
      const payload = result.result as { tools?: unknown[]; nextCursor?: string };
      if (!Array.isArray(payload.tools)) throw Error('서버 도구 목록 형식이 올바르지 않습니다.');
      for (const raw of payload.tools.slice(0, 100)) {
        const tool = raw as { name?: unknown; description?: unknown; inputSchema?: unknown };
        if (typeof tool.name !== 'string' || !tool.name || tool.name.length > 256) continue;
        const name = tool.name, row = el('details'); row.append(el('summary', name));
        if (typeof tool.description === 'string') row.append(el('p', tool.description));
        row.append(el('pre', JSON.stringify(tool.inputSchema, null, 2)));
        const args = el('textarea'); args.value = '{}'; args.setAttribute('aria-label', `${name} JSON 인수`);
        const call = el('button', '이 인수로 실행'); call.type = 'button';
        call.onclick = () => { void (async () => {
          call.disabled = true;
          try {
            if (new TextEncoder().encode(args.value).length > 65536) throw Error('인수는 64 KiB 이하여야 합니다.');
            const arguments_ = JSON.parse(args.value) as unknown;
            if (!arguments_ || typeof arguments_ !== 'object' || Array.isArray(arguments_)) throw Error('인수는 JSON 객체여야 합니다.');
            status.textContent = `${name} 실행 중…`;
            const value = await connection.run({ op: 'mcp_call', sourceId: source.id, name, arguments: arguments_ as Record<string, unknown> });
            if (value && root.isConnected) show(value);
          } catch (e) { if (root.isConnected) status.textContent = e instanceof Error ? e.message : 'MCP 실행 실패'; }
          finally { call.disabled = false; }
        })(); };
        row.append(args, call); tools.append(row);
      }
      if (payload.nextCursor) tools.append(el('p', '다음 목록 페이지가 있습니다. 현재 화면은 첫 페이지를 표시합니다.'));
    } catch (e) { if (root.isConnected) status.textContent = e instanceof Error ? e.message : 'MCP 연결 실패'; }
    finally { list.disabled = source.missingFields.length > 0; }
  })(); };
  root.append(list, cancel, status, tools, output); return root;
}
