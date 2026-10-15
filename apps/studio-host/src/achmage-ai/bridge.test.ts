import { describe, expect, it, vi } from 'vitest';
import { AiConnection, authSession, sameAuthSession, shouldPoll, usageLabel, type AiState } from './bridge';
const state = (generation: number): AiState => ({ generation, providers: [], selectedProvider: 'openai', auth: { status: 'signed_out' }, usage: {}, turn: null });
describe('Achmage native bridge fences', () => {
  it('keeps pending login/turn/native command polling even when hidden or collapsed', () => {
    expect(shouldPoll(state(0), true, true)).toBe(false);
    expect(shouldPoll({ ...state(1), auth: { status: 'pending' } }, true, true)).toBe(true);
    expect(shouldPoll({ ...state(2), turn: { id: 't1', status: 'running' } }, true, true)).toBe(true);
    expect(shouldPoll({ ...state(3), busy: true }, true, true)).toBe(true);
    expect(shouldPoll({ ...state(4), turn: { id: null, status: 'idle' } }, false, false)).toBe(true);
  });
  it('waits for native dispatch acknowledgement while lifecycle busy remains cancellable', async () => {
    const transport = { state: vi.fn().mockResolvedValueOnce({ ...state(1), commandPending: true }).mockResolvedValueOnce({ ...state(2), busy: true, commandPending: false, auth: { status: 'pending' } }), action: vi.fn().mockResolvedValue(state(3)) };
    const connection = new AiConnection(transport, () => {}); await connection.refresh();
    await expect(connection.send({ type: 'cancel_login' })).rejects.toThrow(); expect(transport.action).not.toHaveBeenCalled();
    await connection.refresh(); await connection.send({ type: 'cancel_login' }); expect(transport.action).toHaveBeenCalledTimes(1);
  });
  it('invalidates account-bound proposals on signout, failure and generation change', () => {
    const signed: AiState = { ...state(1), auth: { status: 'signed_in', sessionGeneration: '90071992547409930' } };
    const capture = authSession(signed)!; expect(sameAuthSession(signed, capture)).toBe(true);
    expect(sameAuthSession({ ...signed, auth: { ...signed.auth, sessionGeneration: '90071992547409931' } }, capture)).toBe(false);
    for (const status of ['signed_out', 'pending', 'expired', 'error'] as const)
      expect(sameAuthSession({ ...signed, auth: { ...signed.auth, status } }, capture)).toBe(false);
    expect(authSession({ ...signed, auth: { status: 'signed_in' } })).toBeNull();
  });
  it('keeps unknown usage distinct from reported zero', () => {
    expect(usageLabel({})).toBe('');
    expect(usageLabel({ outputTokens: 1200 })).toBe('출력 1,200');
    expect(usageLabel({ inputTokens: 0, remainingPercent: 0 })).toContain('입력 0');
    expect(usageLabel({ inputTokens: NaN, remainingPercent: -1 })).not.toContain('NaN');
  });
  it('does not let a delayed poll overwrite an action result', async () => {
    let resolve!: (value: AiState) => void;
    const transport = { state: vi.fn().mockResolvedValueOnce(state(1)).mockImplementationOnce(() => new Promise<AiState>(r => { resolve = r; })), action: vi.fn().mockResolvedValue(state(3)) };
    const connection = new AiConnection(transport, () => {});
    await connection.refresh(); const poll = connection.refresh();
    await connection.send({ type: 'begin_login' }); resolve(state(2)); await poll;
    expect(connection.current?.generation).toBe(3);
    expect(transport.action).toHaveBeenCalledWith(1, { type: 'begin_login' });
  });
  it('rejects concurrent actions and never retries uncertain mutation', async () => {
    let reject!: (error: Error) => void;
    const transport = { state: vi.fn().mockResolvedValue(state(0)), action: vi.fn().mockImplementation(() => new Promise<AiState>((_, r) => { reject = r; })) };
    const connection = new AiConnection(transport, () => {}); await connection.refresh();
    const send = connection.send({ type: 'begin_login' });
    await expect(connection.send({ type: 'logout' })).rejects.toThrow();
    reject(new Error('transport unavailable')); await expect(send).rejects.toThrow();
    expect(connection.busy).toBe(false); expect(transport.action).toHaveBeenCalledTimes(1);
  });
  it('rejects unsafe generation without replacing last state', async () => {
    const transport = { state: vi.fn().mockResolvedValueOnce(state(1)).mockResolvedValueOnce(state(Number.MAX_SAFE_INTEGER + 1)), action: vi.fn() };
    const connection = new AiConnection(transport, () => {}); await connection.refresh();
    await expect(connection.refresh()).rejects.toThrow(); expect(connection.current?.generation).toBe(1);
  });
});
