import { describe, it, expect } from 'vitest';
import { ResearchConnection } from './connection';
import { citation, type SearchResult } from './types';
const result: SearchResult = { records: [], warnings: [], provenance: [], cacheHit: false };
describe('Research connection', () => {
  it('only explicit sources, no implicit model send', async () => {
    const ops: string[] = [], values: unknown[] = [];
    const c = new ResearchConnection(async a => { ops.push(a.op); return a.op === 'start' ? { jobId: '1' } : { status: 'completed', result }; });
    await c.search('한글😀', ['crossref', 'crossref'], (_s, r) => values.push(r));
    expect(ops).toEqual(['start', 'poll']); expect(values).toEqual([result]);
  });
  it('drops completion after cancellation', async () => {
    let finish!: (v: unknown) => void; const values: unknown[] = [], ops: string[] = [];
    const c = new ResearchConnection(async a => { ops.push(a.op); if (a.op === 'start') return { jobId: '1' }; if (a.op === 'poll') return new Promise(r => { finish = r; }); return { ok: true }; });
    const run = c.search('test', ['crossref'], (_s, r) => values.push(r));
    for (let i = 0; i < 10 && !finish; i++) await Promise.resolve();
    await c.cancel(); finish({ status: 'completed', result }); await run;
    expect(values).toEqual([]); expect(ops).toContain('cancel');
  });
  it('cancels a job whose start acknowledgement arrives after disposal', async () => {
    let started!: (v: unknown) => void; const ops: string[] = [];
    const c = new ResearchConnection(async a => { ops.push(a.op); return a.op === 'start' ? new Promise(r => { started = r; }) : { ok: true }; });
    const run = c.search('test', ['crossref'], () => { throw Error('stale'); });
    for (let i = 0; i < 10 && !started; i++) await Promise.resolve();
    c.dispose(); started({ jobId: 'late' }); await run; expect(ops).toEqual(['start', 'cancel']);
  });
  it('reports per-source failure without suppressing another result', async () => {
    const values: unknown[] = [];
    const c = new ResearchConnection(async a => { if (a.op === 'start') return { jobId: a.request.sourceId }; if (a.op === 'poll') return a.jobId === 'crossref' ? { status: 'failed', message: 'HTTP 429' } : { status: 'completed', result }; return {}; });
    await c.search('test', ['crossref', 'europe-pmc'], (_s, r) => values.push(r)); expect(values).toHaveLength(2); expect(values.some(v => v instanceof Error)).toBe(true);
  });
  it('bounds query UTF-8 bytes and source fanout', async () => {
    const c = new ResearchConnection(async () => { throw Error('must not send'); });
    await expect(c.search('가'.repeat(1400), ['crossref'], () => {})).rejects.toThrow('4096');
    await expect(c.search('a', Array.from({ length: 9 }, (_, i) => String(i)), () => {})).rejects.toThrow('1–8');
  });
  it('carries provenance without claiming verified facts', () => {
    const text = citation({ sourceId: 'crossref', sourceName: 'Crossref', operator: 'Crossref', role: 'verify', title: '논문', url: 'https://doi.org/10.1/a', retrievedAt: '2026-10-14', identifiers: { doi: '10.1/a' }, authors: ['홍'], editorialStatus: 'unknown', caveats: [] });
    expect(text).toContain('https://doi.org/10.1/a'); expect(text).toContain('조회:'); expect(text).not.toContain('검증 완료');
  });
});
