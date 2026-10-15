/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { HwpDocument } from '../../vendor/rhwp-core/rhwp.js';
import type { WasmBridge } from '@/upstream/core';
import { executeTocRefresh, findToc, hasContentsHeading, tocTitle } from './toc-pages';
import { bodyDocument, historyHarness } from './test-support/history-harness';
import { initPinnedEngine } from './test-support/pinned-wasm';

initPinnedEngine();
const JSON_METHODS = new Set(['getControls', 'getParaPropertiesAt', 'getTableDimensions']);
function open() {
  const native = new HwpDocument(readFileSync(new URL('./fixtures/kordoc-meeting-toc.hwpx', import.meta.url)));
  const wasm = new Proxy({}, { get(_t, name: string) {
    if (name === 'pageCount') return native.pageCount();
    if (name === 'borrowDocumentHandle') return () => native;
    const fn = (native as unknown as Record<string, unknown>)[name];
    return typeof fn === 'function' ? (...args: unknown[]) => { const v = (fn as (...a: unknown[]) => unknown).apply(native, args); return JSON_METHODS.has(name) ? JSON.parse(v as string) : v; } : fn;
  } }) as WasmBridge;
  return { native, wasm, text: (p: number) => native.getTextRange(0, p, 0, native.getParagraphLength(0, p)) };
}

describe('table of contents page numbers (T15)', () => {
  it('reads a contents title without its tab or dot-leader page number, keeping numbers that belong to the title', () => {
    expect(tocTitle('1. 개요\t3')).toBe('1. 개요');
    expect(tocTitle('2. 추진 경과 ........ 12')).toBe('2. 추진 경과');
    expect(tocTitle('2026. 10. 14.')).toBe('2026. 10. 14.');
    // Gate C H1: a number after a plain space is part of the title, never a page number.
    expect(['부록 1', '붙임 2', '2026 추진 계획 2026', 'Phase 3', '제3장 결론 7'].map(tocTitle)).toEqual(['부록 1', '붙임 2', '2026 추진 계획 2026', 'Phase 3', '제3장 결론 7']);
  });

  // Gate C H1 reproductions on the real engine.
  const refreshed = (paragraphs: string[]) => {
    const h = historyHarness(bodyDocument(paragraphs));
    try {
      const entries = findToc(h.wasm);
      if (entries.length) executeTocRefresh(h.wasm, entries);
      return { entries, lines: paragraphs.map((_, p) => h.native.getTextRange(0, p, 0, h.native.getParagraphLength(0, p))) };
    } finally { h.close(); }
  };
  it('offers the right-click refresh only for a document with a contents heading near the start', () => {
    const d = open(); try { expect(hasContentsHeading(d.wasm)).toBe(true); } finally { d.native.free(); }
    for (const [lines, expected] of [[['보고서', '1. 개요', '본문'], false], [['표지', '차 례', '1. 개요'], true]] as const) {
      const h = historyHarness(bodyDocument([...lines]));
      try { expect(hasContentsHeading(h.wasm)).toBe(expected); } finally { h.close(); }
    }
  });
  it('keeps numbered titles such as "부록 1" whole and writes only the page part', () => {
    const r = refreshed(['목차', '부록 1', '부록 2', '본문', '부록 1', '첫 부록 내용', '부록 2', '둘째 부록 내용']);
    expect(r.entries.map(e => [e.title, e.target])).toEqual([['부록 1', 4], ['부록 2', 6]]);
    expect(r.lines.slice(1, 3)).toEqual(['부록 1\t1', '부록 2\t1']);
    expect(r.lines.slice(3)).toEqual(['본문', '부록 1', '첫 부록 내용', '부록 2', '둘째 부록 내용']);
  });
  it('never treats an agenda list without a contents heading as contents', () => {
    const r = refreshed(['회의 안건', '교과 개편', '예산 심의', '교과 개편', '논의 내용', '예산 심의', '논의 내용']);
    expect(r.entries).toEqual([]);
    expect(r.lines).toEqual(['회의 안건', '교과 개편', '예산 심의', '교과 개편', '논의 내용', '예산 심의', '논의 내용']);
  });
  it('ignores runs of numbered short lines elsewhere in the document', () => {
    const lines = ['보고서', ...Array.from({ length: 30 }, (_, i) => `본문 ${i + 1}`), ...Array.from({ length: 30 }, (_, i) => `본문 ${i + 1}`)];
    expect(refreshed(lines).entries).toEqual([]);
  });
  it('keeps the indentation and spacing a contents line was written with', () => {
    const r = refreshed(['차례', '  1.  개요', '본문', '1. 개요', '내용']);
    expect(r.entries.map(e => e.title)).toEqual([]);
    const s = refreshed(['차례', '  1. 개요', '  2. 결론', '1. 개요', '내용', '2. 결론', '내용']);
    expect(s.lines.slice(1, 3)).toEqual(['  1. 개요\t1', '  2. 결론\t1']);
  });

  it('finds the contents of a generated report and the chapter bars they name', () => {
    const d = open();
    try { expect(findToc(d.wasm)).toEqual([{ paragraph: 19, title: '1. 개요', target: 21, head: '1. 개요' }, { paragraph: 20, title: '2. 안건', target: 23, head: '2. 안건' }]); }
    finally { d.native.free(); }
  });

  it('fills the page numbers after the restart, keeps everything else, and settles', () => {
    const d = open();
    try {
      const others = Array.from({ length: d.native.getParagraphCount(0) }, (_, p) => d.text(p)), controls = d.native.getControls();
      const result = executeTocRefresh(d.wasm, findToc(d.wasm));
      expect(result.pages).toEqual([3, 3]);
      expect([d.text(19), d.text(20)]).toEqual(['1. 개요\t3', '2. 안건\t3']);
      expect(JSON.parse(d.native.getParaPropertiesAt(0, 19)).tabStops).toEqual([expect.objectContaining({ type: 1, fill: 3 })]);
      for (let p = 0; p < others.length; p++) if (p !== 19 && p !== 20) expect(d.text(p)).toBe(others[p]);
      expect(d.native.getControls()).toBe(controls);
      // Refreshing again finds the same lines (with their numbers) and changes nothing.
      const saved = d.native.exportHwpx();
      expect(findToc(d.wasm).map(e => e.paragraph)).toEqual([19, 20]);
      executeTocRefresh(d.wasm, findToc(d.wasm));
      expect(d.native.exportHwpx()).toEqual(saved);
    } finally { d.native.free(); }
  });

  it('follows a chapter that moves to a later page', () => {
    const d = open();
    try {
      // Push chapter 2 onto the next page with body text under chapter 1.
      for (let i = 0; i < 45; i++) { d.native.splitParagraph(0, 22, d.native.getParagraphLength(0, 22)); d.native.insertText(0, 23, 0, `본문 줄 ${i + 1}`); }
      const entries = findToc(d.wasm);
      expect(entries.map(e => e.title)).toEqual(['1. 개요', '2. 안건']);
      const result = executeTocRefresh(d.wasm, entries);
      expect(result.pages[0]).toBe(3);expect(result.pages[1]).toBeGreaterThan(3);
      expect(d.text(20)).toBe(`2. 안건\t${result.pages[1]}`);
    } finally { d.native.free(); }
  });
});
