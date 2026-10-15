/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { bodyDocument, fixtureBytes, historyHarness } from './test-support/history-harness';

// Gate C H1/M1: contents page numbers only for templates with a contents page, and never at the cost of the result.
const generated = () => fixtureBytes('kordoc-meeting-toc.hwpx');
const lines = (h: ReturnType<typeof historyHarness>, from: number, to: number) => Array.from({ length: to - from }, (_, i) => h.native.getTextRange(0, from + i, 0, h.native.getParagraphLength(0, from + i)));

describe('whole-document replacement and contents page numbers', () => {
  it('leaves contents lines as generated when the template has no contents page', async () => {
    const h = historyHarness(bodyDocument(['기존 문서']));
    try {
      const result = await h.adapter.applyWholeDocument(h.adapter.identity(), generated(), { hideFirstPage: true });
      expect(result.toc).toBeUndefined(); expect(lines(h, 19, 21)).toEqual(['1. 개요', '2. 안건']);
    } finally { h.close(); }
  });

  it('fills the page numbers in the same Ctrl+Z step when the template has a contents page', async () => {
    const h = historyHarness(bodyDocument(['기존 문서'])), before = h.native.exportHwpx();
    try {
      const result = await h.adapter.applyWholeDocument(h.adapter.identity(), generated(), { hideFirstPage: true, toc: true });
      expect(result.toc?.entries).toBe(2); expect(lines(h, 19, 21)).toEqual(['1. 개요\t3', '2. 안건\t3']);
      expect(h.depth()).toBe(1); h.undo(); expect(h.native.exportHwpx()).toEqual(before);
    } finally { h.close(); }
  });

  it('keeps the generated document when only the page-number step fails, and says why', async () => {
    const h = historyHarness(bodyDocument(['기존 문서'])), before = h.native.exportHwpx();
    try {
      (h.native as unknown as { getPageInfo: () => string }).getPageInfo = () => { throw new Error('page info unavailable'); };
      const result = await h.adapter.applyWholeDocument(h.adapter.identity(), generated(), { hideFirstPage: true, toc: true });
      expect(result.toc).toBeUndefined(); expect(result.tocFailure).toBeTruthy();
      expect(lines(h, 19, 21)).toEqual(['1. 개요', '2. 안건']); expect(lines(h, 22, 23)).toEqual(['배포 엔진 시험 본문입니다.']);
      expect(h.depth()).toBe(1); h.undo(); expect(h.native.exportHwpx()).toEqual(before);
    } finally { h.close(); }
  });
});
