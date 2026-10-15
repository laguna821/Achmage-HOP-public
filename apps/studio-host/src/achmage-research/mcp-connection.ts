import type { Action, Job, OAuthPending, McpResult, Transport } from './types';
/** A separate explicit operation lane. No model-selected calls or automatic retries. */
export class McpConnection {
  private epoch = 0;
  private job: string | undefined;
  private disposed = false;
  constructor(private transport: Transport, private delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))) {}
  async run(action: Extract<Action, { op: 'mcp_list' | 'mcp_call' | 'oauth_start' }>, onAuthorizationPending?: (state: OAuthPending) => void): Promise<McpResult | undefined> {
    if (this.disposed) throw Error('MCP connection disposed');
    const pending = this.cancel(), epoch = this.epoch; await pending;
    if (this.disposed || epoch !== this.epoch) return;
    const { jobId } = await this.transport(action) as { jobId: string };
    if (this.disposed || epoch !== this.epoch) { await this.transport({ op: 'cancel', jobId }); return; }
    this.job = jobId;
    try {
      while (!this.disposed && epoch === this.epoch) {
        const state = await this.transport({ op: 'poll', jobId }) as Job | OAuthPending;
        if (this.disposed || epoch !== this.epoch) return;
        if (state.status === 'mcp_completed') return state.result;
        if (state.status === 'failed') throw Error(state.message);
        if (state.status === 'cancelled') return;
        if (state.status === 'completed') throw Error('Unexpected MCP result type');
        if (state.status === 'oauth_pending') onAuthorizationPending?.(state);
        await this.delay(250);
      }
    } finally { if (this.job === jobId) this.job = undefined; }
  }
  async cancel(): Promise<void> {
    this.epoch++; const jobId = this.job; this.job = undefined;
    if (jobId) await this.transport({ op: 'cancel', jobId }).catch(() => undefined);
  }
  dispose(): void { this.disposed = true; void this.cancel(); }
}
