import { invoke } from '@tauri-apps/api/core';
import { registerPanelAction } from './panel-events';
import './telegram-settings.css';

/** Status the desktop returns from every achmage_telegram_* command (the token itself never crosses). */
export interface TelegramView {
  status: { state: 'disabled' | 'connecting' | 'running' | 'stopped'; botUsername?: string; reason?: string };
  botUsername: string | null; hasToken: boolean; enabled: boolean; keepRunning: boolean; autostart: boolean;
  pending: { userId: number; displayName: string; createdAt: number; expiresAt: number }[];
  allowed: { userId: number; displayName: string; approvedAt: number }[];
  approvalLockedUntil: number | null;
}
export type TelegramTransport = (command: string, args?: Record<string, unknown>) => Promise<TelegramView>;

/** Shape check before anything is sent; the desktop checks it again and verifies it with Telegram. */
export function looksLikeBotToken(value: string): boolean { return /^\d{5,15}:[A-Za-z0-9_-]{35,}$/u.test(value.trim()); }
export function looksLikeApprovalCode(value: string): boolean { return /^\d{8}$/u.test(value.replace(/\s/gu, '')); }

export function statusLine(view: TelegramView | null): string {
  if (!view) return '연결 상태를 확인하는 중입니다.';
  if (!view.hasToken) return '봇 토큰이 없습니다. 아래 순서대로 봇을 만들고 토큰을 넣으세요.';
  const bot = view.botUsername ? `@${view.botUsername}` : '봇';
  switch (view.status.state) {
    case 'running': return `${bot} 연결됨. 승인한 사람만 대화할 수 있습니다.`;
    case 'connecting': return `${bot}에 연결하는 중입니다.`;
    case 'stopped': return `${bot} 연결이 멈췄습니다: ${view.status.reason ?? '이유를 알 수 없습니다.'}`;
    default: return `${bot} 연결이 꺼져 있습니다.`;
  }
}

/** "14:05까지" in local time for a Unix-seconds deadline. */
export function untilText(seconds: number): string {
  const d = new Date(seconds * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}까지`;
}

const HELP = '1) 텔레그램에서 @BotFather에게 /newbot을 보내 봇을 만들고 받은 토큰을 붙여 넣습니다.\n2) 휴대폰에서 내 봇에게 아무 말이나 보내면 8자리 코드가 옵니다.\n3) 그 코드를 아래 \'승인 대기\'에 입력하면 그 계정만 대화할 수 있습니다.\n휴대폰에서 대화, /doc 문서 만들기(HWPX 파일로 받기), /ask 열린 문서 질문을 쓸 수 있습니다. /help 로 전체 명령을 봅니다.\n원격 요청은 이 PC에 로그인된 AI를 도구 없는 모드로만 씁니다. 열린 문서 질문에는 그 문서의 본문을 AI에 보내고, 답장과 파일은 텔레그램 서버를 거칩니다.';

/** Settings for the owner's Telegram bot: token (stored in the OS keychain by the desktop), approvals, background use. */
export function installTelegramSettings(transport: TelegramTransport = (command, args) => invoke<TelegramView>(command, args)): () => void {
  const dialog = document.createElement('dialog'); dialog.className = 'achmage-telegram-dialog';
  dialog.innerHTML = `<h2>텔레그램 원격 연결</h2><p class="tg-help"></p><p class="tg-status" role="status"></p>
<section><label class="tg-token-label">봇 토큰<input type="password" class="tg-token" autocomplete="off" spellcheck="false" placeholder="123456789:AA…"></label>
<div class="tg-row"><button type="button" data-tg="save">토큰 저장</button><button type="button" data-tg="clear">토큰 지우기</button></div></section>
<section class="tg-switches"><label><input type="checkbox" data-tg="enabled"> 텔레그램 연결 사용</label>
<label><input type="checkbox" data-tg="keep"> 창을 모두 닫아도 트레이에서 계속 실행</label>
<label><input type="checkbox" data-tg="autostart"> 컴퓨터에 로그인하면 백그라운드로 시작</label></section>
<section><h3>승인 대기</h3><ul class="tg-pending"></ul><div class="tg-row"><input class="tg-code" inputmode="numeric" maxlength="9" placeholder="휴대폰에 온 8자리 코드"><button type="button" data-tg="approve">승인</button></div><p class="tg-lock" hidden></p></section>
<section><h3>허용한 사람</h3><ul class="tg-allowed"></ul></section>
<p class="tg-error" role="alert"></p><footer><button type="button" data-tg="close">닫기</button></footer>`;
  dialog.querySelector<HTMLElement>('.tg-help')!.textContent = HELP;
  document.body.append(dialog);
  const q = <T extends HTMLElement>(s: string) => dialog.querySelector<T>(s)!;
  const control = <T extends HTMLElement>(name: string) => q<T>(`[data-tg="${name}"]`);
  const token = q<HTMLInputElement>('.tg-token'), code = q<HTMLInputElement>('.tg-code'), error = q<HTMLElement>('.tg-error');
  let view: TelegramView | null = null, pending = false, disposed = false;

  const item = (text: string, action?: { label: string; run: () => void }) => {
    const li = document.createElement('li'); const span = document.createElement('span'); span.textContent = text; li.append(span);
    if (action) { const b = document.createElement('button'); b.type = 'button'; b.textContent = action.label; b.onclick = action.run; li.append(b); }
    return li;
  };
  function render(): void {
    q<HTMLElement>('.tg-status').textContent = statusLine(view);
    const has = !!view?.hasToken;
    control<HTMLInputElement>('enabled').checked = !!view?.enabled; control<HTMLInputElement>('keep').checked = !!view?.keepRunning; control<HTMLInputElement>('autostart').checked = !!view?.autostart;
    for (const name of ['enabled', 'keep', 'autostart', 'clear', 'approve']) control<HTMLInputElement>(name).disabled = pending || !has;
    control<HTMLButtonElement>('save').disabled = pending;
    // Display names come from strangers on Telegram: text only, never markup.
    q<HTMLElement>('.tg-pending').replaceChildren(...(view?.pending.length ? view.pending.map(p => item(`${p.displayName} · ${untilText(p.expiresAt)}`)) : [item('대기 중인 요청이 없습니다.')]));
    q<HTMLElement>('.tg-allowed').replaceChildren(...(view?.allowed.length ? view.allowed.map(a => item(a.displayName, { label: '해제', run: () => { void act('achmage_telegram_revoke', { userId: a.userId }); } })) : [item('아직 없습니다.')]));
    const lock = q<HTMLElement>('.tg-lock'); lock.hidden = !view?.approvalLockedUntil;
    if (view?.approvalLockedUntil) lock.textContent = `코드를 여러 번 잘못 입력해 ${untilText(view.approvalLockedUntil)} 승인을 막았습니다.`;
  }
  async function act(command: string, args?: Record<string, unknown>): Promise<boolean> {
    if (pending || disposed) return false;
    // A status refresh keeps the last error visible; any other action starts clean.
    pending = true; if (command !== 'achmage_telegram_status') error.textContent = ''; render();
    try { view = await transport(command, args); return true; }
    catch (e) { if (!disposed) error.textContent = typeof e === 'string' ? e : '요청을 처리하지 못했습니다.'; return false; }
    finally { if (!disposed) { pending = false; render(); } }
  }
  control<HTMLButtonElement>('save').onclick = () => {
    const value = token.value.trim();
    if (!looksLikeBotToken(value)) { error.textContent = '봇 토큰 형식이 아닙니다. @BotFather가 준 토큰 전체를 붙여 넣으세요.'; return; }
    void act('achmage_telegram_set_token', { token: value }).then(ok => { if (ok) token.value = ''; });
  };
  control<HTMLButtonElement>('clear').onclick = () => { void act('achmage_telegram_clear_token'); };
  control<HTMLInputElement>('enabled').onchange = e => { void act('achmage_telegram_set_enabled', { enabled: (e.target as HTMLInputElement).checked }); };
  control<HTMLInputElement>('keep').onchange = e => { void act('achmage_telegram_set_keep_running', { keepRunning: (e.target as HTMLInputElement).checked }); };
  control<HTMLInputElement>('autostart').onchange = e => { void act('achmage_telegram_set_autostart', { enabled: (e.target as HTMLInputElement).checked }); };
  control<HTMLButtonElement>('approve').onclick = () => {
    const value = code.value.replace(/\s/gu, '');
    if (!looksLikeApprovalCode(value)) { error.textContent = '휴대폰에 온 8자리 숫자를 입력하세요.'; return; }
    void act('achmage_telegram_approve', { code: value }).then(ok => { if (ok) code.value = ''; });
  };
  control<HTMLButtonElement>('close').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { token.value = ''; code.value = ''; });
  const remove = registerPanelAction({ id: 'telegram', label: '텔레그램 원격 연결', run: () => { if (!dialog.open) dialog.showModal(); void act('achmage_telegram_status'); } });
  // New pairing requests appear while the dialog is open.
  const timer = window.setInterval(() => { if (dialog.open && !pending) void act('achmage_telegram_status'); }, 3000);
  render();
  return () => { disposed = true; clearInterval(timer); remove(); dialog.close(); dialog.remove(); };
}
