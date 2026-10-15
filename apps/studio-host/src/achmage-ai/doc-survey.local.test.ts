/// <reference types="node" />
// B10: how the AI operations meet this user's own documents. Runs only when HOP_DOC_SURVEY names a file
// listing document paths; reads them (never writes), and stores aggregate counts only — no file names,
// no text — in HOP_DOC_SURVEY_OUT. Skipped in normal test runs.
import { describe, expect, it } from 'vitest';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { historyHarness } from './test-support/history-harness';
import { planRestyle } from './restyle';
import { findToc } from './toc-pages';
import { reopensAsSameDocument, type ReopenableDocument } from '../core/save-verification';

const list = process.env.HOP_DOC_SURVEY, out = process.env.HOP_DOC_SURVEY_OUT;

function sample(paths: string[], perKind: number): string[] {
  // Deterministic spread: every n-th file of each kind, so repeated runs see the same documents.
  const pick = (kind: string) => { const all = paths.filter(p => p.toLowerCase().endsWith(kind)); const step = Math.max(1, Math.floor(all.length / perKind)); return all.filter((_, i) => i % step === 0).slice(0, perKind); };
  return [...pick('.hwp'), ...pick('.hwpx')];
}

describe.skipIf(!list || !out)('B10 survey of the user\'s own documents (aggregate only)', () => {
  it('collects refusal reasons and save-check results', () => {
    const paths = sample(readFileSync(list!, 'utf8').split(/\r?\n/u).filter(Boolean), 100);
    const counts: Record<string, number> = {}, bump = (key: string) => { counts[key] = (counts[key] ?? 0) + 1; };
    const restyleShare: number[] = [], millis: number[] = [];
    for (const path of paths) {
      const kind = path.toLowerCase().endsWith('.hwpx') ? 'hwpx' : 'hwp';
      bump(`${kind}:sampled`);
      let bytes: Uint8Array;
      try { if (statSync(path).size > 20 * 1024 * 1024) { bump(`${kind}:skipped-over-20MB`); continue; } bytes = new Uint8Array(readFileSync(path)); }
      catch { bump(`${kind}:unreadable`); continue; }
      const started = performance.now();
      let h: ReturnType<typeof historyHarness>;
      try { h = historyHarness(bytes); } catch { bump(`${kind}:engine-cannot-open`); continue; }
      try {
        bump(`${kind}:opened`);
        const sections = h.native.getSectionCount();
        if (sections !== 1) bump(`${kind}:whole-replace:multi-section`);
        else {
          const anchor = (JSON.parse(h.native.getControls()) as { ctrlId: string; list: number; para: number }[]).filter(c => c.list === 0 && c.para === 0 && (c.ctrlId === 'secd' || c.ctrlId === 'cold')).map(c => c.ctrlId).sort().join();
          bump(anchor === 'cold,secd' ? `${kind}:whole-replace:eligible` : `${kind}:whole-replace:first-paragraph-anchor`);
        }
        try {
          const plan = planRestyle(h.wasm), total = h.native.getParagraphCount(0);
          bump(plan.targets.length ? `${kind}:restyle:has-targets` : `${kind}:restyle:no-targets`);
          if (total) restyleShare.push(plan.targets.length / total);
        } catch { bump(`${kind}:restyle:plan-error`); }
        try { bump(findToc(h.wasm).length ? `${kind}:toc:found` : `${kind}:toc:none`); } catch { bump(`${kind}:toc:error`); }
        for (const format of ['hwp', 'hwpx'] as const) {
          try {
            const exported = format === 'hwpx' ? h.native.exportHwpxWithReport() : h.native.exportHwpWithReport();
            try {
              const report = JSON.parse(exported.contentLoss()) as { losses?: unknown[] };
              bump(`${kind}->${format}:losses:${report.losses?.length ? 'some' : 'none'}`);
              if (format === 'hwpx') bump(`${kind}->hwpx:reopen:${reopensAsSameDocument(h.native as unknown as ReopenableDocument, exported.takeBytes()) ? 'same' : 'different'}`);
            } finally { exported.free(); }
          } catch { bump(`${kind}->${format}:export-error`); }
        }
      } finally { h.close(); }
      millis.push(performance.now() - started);
    }
    const sorted = [...restyleShare].sort((a, b) => a - b), median = (xs: number[]) => xs.length ? xs[Math.floor(xs.length / 2)] : null;
    writeFileSync(out!, JSON.stringify({ documents: paths.length, counts, restyleTargetShareMedian: median(sorted), perDocumentMsMedian: median([...millis].sort((a, b) => a - b)) }, null, 2));
    expect(paths.length).toBeGreaterThan(0);
  }, 1_800_000);
});
