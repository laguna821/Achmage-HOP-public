import type { Transport, Catalog, Job, SearchResult } from './types';
/** Owns only explicitly requested searches. Stale async completions never replace current results. */
export class ResearchConnection {
  private generation = 0;
  private jobs = new Set<string>();
  private disposed = false;
  constructor(private transport: Transport, private delay: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms))) {}
  async catalog(): Promise<Catalog> { return this.transport({ op: 'catalog' }) as Promise<Catalog>; }
  async search(query: string, sources: string[], onResult: (source: string, result: SearchResult | Error) => void): Promise<void> {
    if (this.disposed) throw Error('Research connection disposed');
    const cancelling = this.cancel();
    const generation = this.generation;
    await cancelling;
    if (this.disposed || generation !== this.generation) return;
    if (!query.trim() || new TextEncoder().encode(query).length > 4096) throw Error('검색어는 1–4096 바이트여야 합니다.');
    const selected = [...new Set(sources)];
    if (!selected.length || selected.length > 8) throw Error('검색 소스를 1–8개 선택하세요.');
    await Promise.all(selected.map(async source => {
      let id: string | undefined;
      try {
        const started = await this.transport({ op: 'start', request: { sourceId: source, query, limit: 10 } }) as { jobId: string };
        id = started.jobId;
        if (this.disposed || generation !== this.generation) { await this.transport({ op: 'cancel', jobId: id }); return; }
        this.jobs.add(id);
        while (!this.disposed && generation === this.generation) {
          const job = await this.transport({ op: 'poll', jobId: id }) as Job;
          if (this.disposed || generation !== this.generation) return;
          if (job.status === 'completed') { onResult(source, job.result); return; }
          if (job.status === 'failed') throw Error(job.message);
          if (job.status === 'cancelled') return;
          await this.delay(250);
        }
      } catch (error) {
        if (!this.disposed && generation === this.generation) onResult(source, error instanceof Error ? error : Error('검색 실패'));
      } finally { if (id) this.jobs.delete(id); }
    }));
  }
  async cancel(): Promise<void> {
    this.generation++;
    const jobs = [...this.jobs]; this.jobs.clear();
    await Promise.allSettled(jobs.map(jobId => this.transport({ op: 'cancel', jobId })));
  }
  dispose(): void { this.disposed = true; void this.cancel(); }
}
