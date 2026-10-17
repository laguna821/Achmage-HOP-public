// The hidden window that runs the Kordoc engine for the desktop side when no document window is involved (the
// Telegram gateway, which may run with no window at all). It takes one job at a time from the desktop side and
// answers with the checked response, or the code of the failure; the desktop side closes the window afterwards.
import { invoke } from '@tauri-apps/api/core';
import { createKordocWebEngine, KordocEngineError } from '../achmage-ai/kordoc-web-engine';

interface Job { id: string; input: Record<string, unknown> }
type Reply = { ok: true; response: unknown } | { ok: false; code: string };

const engine = createKordocWebEngine();
// Set by the desktop side for this window only: a page of an earlier window can neither take nor answer a job.
const generation = (window as unknown as { __ACHMAGE_KORDOC_HOST_GENERATION__?: unknown }).__ACHMAGE_KORDOC_HOST_GENERATION__;

async function serve(): Promise<void> {
  if (typeof generation !== 'number') return;
  for (;;) {
    const job = await invoke<Job | null>('achmage_kordoc_host_next', { generation });
    if (!job) continue;
    let reply: Reply;
    try {
      reply = { ok: true, response: await engine.request(job.input) };
    } catch (error) {
      reply = { ok: false, code: error instanceof KordocEngineError ? error.code : 'worker_io' };
    }
    try {
      await invoke('achmage_kordoc_host_reply', { generation, id: job.id, reply });
    } catch {
      // The answer did not get through (too large or refused): the desktop side must not wait for it until its time
      // limit. If even this fails, the window is gone.
      await invoke('achmage_kordoc_host_reply', { generation, id: job.id, reply: { ok: false, code: 'worker_io' } });
    }
  }
}

// An error here means the desktop side closed the window or refused it; the window has nothing left to do.
void serve().catch(() => undefined);
