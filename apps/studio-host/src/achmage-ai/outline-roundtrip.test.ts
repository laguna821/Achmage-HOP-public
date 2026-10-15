/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { HwpDocument } from '../../vendor/rhwp-core/rhwp.js';
import type { WasmBridge } from '@/upstream/core';
import type { RhwpDocumentStateV1 } from '@upstream/document-agent/types';
import { OUTLINE_DRAFTS } from './fixtures/outline-drafts';
import { looksLikeDraft, outlineToMarkdown, outlineToPlan, parseOutline, type OutlineNode } from './outline-ast';
import { captureStructuredRange, executeStructuredPlan, parseStructuredPlan } from './structured-edit';
import { contractStyles, documentBaseRoles } from './style-contract';
import { initPinnedEngine } from './test-support/pinned-wasm';

initPinnedEngine();
const JSON_METHODS = new Set(['getControls', 'getControlTextPositions', 'getCharPropertiesAt', 'getParaPropertiesAt', 'createTable', 'getTableDimensions', 'getCellParaPropertiesAt', 'getCellCharPropertiesAt', 'getTableProperties', 'getCellOwnProperties', 'getPictureProperties']);
const STYLES = contractStyles(documentBaseRoles('함초롬바탕', 11));

function blank() {
  const native = new HwpDocument(readFileSync(new URL('./fixtures/owned-blank.hwpx', import.meta.url)));
  const wasm = new Proxy({}, { get(_t, name: string) {
    if (name === 'pageCount') return native.pageCount();
    if (name === 'borrowDocumentHandle') return () => native;
    if (['beginDeferredPagination', 'flushDeferredPagination', 'cancelDeferredPagination'].includes(name)) return undefined;
    const fn = (native as unknown as Record<string, unknown>)[name];
    return typeof fn === 'function' ? (...args: unknown[]) => { const v = (fn as (...a: unknown[]) => unknown).apply(native, args); return JSON_METHODS.has(name) ? JSON.parse(v as string) : v; } : fn;
  } }) as WasmBridge;
  return { native, wasm };
}
/** What a reopened document holds: body paragraph texts in order, and each table's cell texts by row. */
function readBack(doc: HwpDocument): (string | string[][])[] {
  const controls = JSON.parse(doc.getControls()) as { ctrlId: string; list: number; para: number; controlIndex: number }[];
  const out: (string | string[][])[] = [];
  for (let p = 0; p < doc.getParagraphCount(0); p++) {
    const table = controls.find(c => c.list === 0 && c.para === p && c.ctrlId === 'tbl');
    if (table) {
      const dims = JSON.parse(doc.getTableDimensions(0, p, table.controlIndex)) as { rowCount: number; colCount: number };
      out.push(Array.from({ length: dims.rowCount }, (_, r) => Array.from({ length: dims.colCount }, (_, c) => { const cell = r * dims.colCount + c, n = doc.getCellParagraphLength(0, p, table.controlIndex, cell, 0); return n ? doc.getTextInCell(0, p, table.controlIndex, cell, 0, 0, n) : ''; })));
    } else out.push(doc.getTextRange(0, p, 0, doc.getParagraphLength(0, p)));
  }
  return out;
}
const kinds = (nodes: readonly OutlineNode[]) => nodes.map(n => n.kind === 'label' ? 'item' : n.kind);

describe('outline normalizer on 32 owned drafts (T09)', () => {
  it('has at least 30 drafts and reads each one deterministically', () => {
    expect(OUTLINE_DRAFTS.length).toBeGreaterThanOrEqual(30);
    for (const d of OUTLINE_DRAFTS) expect(parseOutline(d.text)).toEqual(parseOutline(d.text));
  });

  it.each(OUTLINE_DRAFTS.map(d => [d.name, d.text] as const))('%s: Markdown round-trips to the same outline shape', (_name, text) => {
    const outline = parseOutline(text), markdown = outlineToMarkdown(outline), again = parseOutline(markdown);
    expect(kinds(again)).toEqual(kinds(outline));
    expect(outlineToMarkdown(again)).toBe(outlineToMarkdown(parseOutline(outlineToMarkdown(again))));
    // Text never disappears: every word of the draft is still there.
    const words = (s: string) => s.match(/[\p{L}\p{N}]+/gu) ?? [];
    expect(new Set(words(markdown))).toEqual(new Set(words(text.replace(/^\s*(?:#{1,6}|[□■ㅁ○◦●o\-–−·•∙*+※]|\d{1,2}[.)]|[가-하][.)]|\([\d가-하]{1,2}\)|[①-⑳])\s*/gmu, ''))));
  });

  it.each(OUTLINE_DRAFTS.filter(d => looksLikeDraft(parseOutline(d.text))).map(d => [d.name, d.text] as const))('%s: applied as real paragraphs and tables, saved and reopened intact', (_name, text) => {
    const { native, wasm } = blank();
    try {
      const plan = parseStructuredPlan(outlineToPlan(parseOutline(text), STYLES));
      const capture = captureStructuredRange(wasm, {} as RhwpDocumentStateV1, '', { section: 0, startParagraph: 0, paragraphCount: 1 });
      executeStructuredPlan(wasm, capture, plan);
      const expected = plan.paragraphs.map(p => p.table ? p.table.map(row => row.map(cell => cell.runs.map(r => r.text).join('').replace(/^ $/u, ''))) : p.runs.map(r => r.text).join(''));
      const reopened = new HwpDocument(native.exportHwpx());
      try { expect(readBack(reopened).map(x => typeof x === 'string' ? x : x.map(r => r.map(c => c.trim())))).toEqual(expected); } finally { reopened.free(); }
    } finally { native.free(); }
  });
});
