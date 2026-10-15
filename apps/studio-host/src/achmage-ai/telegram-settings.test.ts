import { describe, expect, it } from 'vitest';
import { looksLikeApprovalCode, looksLikeBotToken, statusLine, untilText, type TelegramView } from './telegram-settings';

const view = (patch: Partial<TelegramView> = {}): TelegramView => ({
  status: { state: 'disabled' }, botUsername: 'hop_owner_bot', hasToken: true, enabled: false, keepRunning: false, autostart: false,
  pending: [], allowed: [], approvalLockedUntil: null, ...patch,
});

describe('Telegram settings', () => {
  it('accepts only bot-token shapes and 8-digit approval codes before anything is sent', () => {
    expect(looksLikeBotToken(`123456789:${'A'.repeat(35)}`)).toBe(true);
    for (const bad of ['', '123:short', 'abc:' + 'A'.repeat(35), `123456789:${'A'.repeat(34)}`, `123456789 ${'A'.repeat(35)}`]) expect(looksLikeBotToken(bad)).toBe(false);
    expect(looksLikeApprovalCode('1234 5678')).toBe(true);
    for (const bad of ['1234567', '123456789', 'abcdefgh']) expect(looksLikeApprovalCode(bad)).toBe(false);
  });

  it('says what state the bot is in without exposing anything secret', () => {
    expect(statusLine(null)).toContain('확인하는 중');
    expect(statusLine(view({ hasToken: false }))).toContain('봇 토큰이 없습니다');
    expect(statusLine(view({ status: { state: 'running' } }))).toBe('@hop_owner_bot 연결됨. 승인한 사람만 대화할 수 있습니다.');
    expect(statusLine(view({ status: { state: 'stopped', reason: '다른 프로그램이 이 봇을 쓰고 있습니다.' } }))).toContain('다른 프로그램');
    expect(statusLine(view())).toContain('꺼져 있습니다');
  });

  it('shows a local HH:MM deadline', () => {
    const at = new Date(2026, 9, 15, 14, 5).getTime() / 1000;
    expect(untilText(at)).toBe('14:05까지');
  });
});
