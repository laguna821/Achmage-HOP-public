/// <reference types="node" />
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { HwpDocument } from '../../vendor/rhwp-core/rhwp.js';
import type { WasmBridge } from '@/upstream/core';
import { captureWholeDocumentContext, type WholeDocumentSection, type WholeDocumentTable } from './whole-document-context';
import { documentManuscript, documentManuscriptNotices, documentMarkdown } from './document-manuscript';
import { initPinnedEngine } from './test-support/pinned-wasm';
initPinnedEngine();

const paragraph = (index: number, text: string, tables: WholeDocumentTable[] = []) => ({ index, text, tables });
const grid = (rows: string[][]): WholeDocumentTable => ({ controlIndex: 0, charOffset: 0, rowCount: rows.length, colCount: rows[0].length,
  cells: rows.flatMap((row, r) => row.map((text, c) => ({ index: r * row.length + c, row: r, col: c, rowSpan: 1, colSpan: 1, paragraphs: [{ index: 0, text }] }))) });
const doc = (...paragraphs: ReturnType<typeof paragraph>[]): WholeDocumentSection[] => [{ index: 0, paragraphs }];

describe('the open document as Markdown blocks, typeset as written', () => {
  it('keeps every paragraph separate and reads items and chapters the way a manuscript is read', () => {
    const read = documentManuscript(doc(paragraph(0, '2026년 사업 계획'), paragraph(1, '1. 추진 배경'), paragraph(2, '지역 연계를 넓힌다'), paragraph(3, '이어지는 문장이 아닙니다')));
    expect(read.blocks).toEqual(['# 2026년 사업 계획', '## 추진 배경', '지역 연계를 넓힌다', '이어지는 문장이 아닙니다']);
  });
  it('escapes document text so Markdown never acts on it: dates, pipes, stars, ampersands, a leading #', () => {
    const texts = ['2024. 10. 15. 회의', 'A|B 비교', '*중요* 표시와 _밑줄_', '연구&개발 <초안>', '#해시태그 문단', '\\ 역슬래시'];
    const read = documentManuscript(doc(paragraph(0, '제목 문단입니다.'), ...texts.map((t, i) => paragraph(i + 1, t))));
    // Kordoc's Markdown parser reads each of these back as the text above (apps/kordoc-engine/test).
    expect(read.blocks).toEqual(['제목 문단입니다.', '2024\\. 10. 15. 회의', 'A\\|B 비교', '\\*중요\\* 표시와 \\_밑줄\\_', '연구&개발 \\<초안\\>', '\\#해시태그 문단', '\\\\ 역슬래시']);
  });
  it('turns the document tables into Markdown tables in place, with merged cells in their first cell and pipes kept in one cell', () => {
    const merged: WholeDocumentTable = { controlIndex: 0, charOffset: 0, rowCount: 2, colCount: 2, cells: [
      { index: 0, row: 0, col: 0, rowSpan: 1, colSpan: 2, paragraphs: [{ index: 0, text: '합친 머리|칸' }] },
      { index: 1, row: 1, col: 0, rowSpan: 1, colSpan: 1, paragraphs: [{ index: 0, text: '첫 줄' }, { index: 1, text: '둘째 줄' }] },
      { index: 2, row: 1, col: 1, rowSpan: 1, colSpan: 1, paragraphs: [{ index: 0, text: '' }] }] };
    const read = documentManuscript(doc(paragraph(0, '앞 문단입니다.'), paragraph(1, '', [merged]), paragraph(2, '뒤 문단입니다.')));
    expect(read.blocks).toEqual(['앞 문단입니다.', '| 합친 머리\\|칸 |  |\n| --- | --- |\n| 첫 줄 둘째 줄 |  |', '뒤 문단입니다.']);
    expect(documentManuscriptNotices(read)).toEqual(['병합된 표 칸 1곳은 첫 칸에 내용을 두고 나머지 칸은 비웠습니다.', '여러 줄로 된 표 칸 1곳은 한 줄로 이었습니다.']);
  });
  it('shows symbol-font characters the engine reserves as 〓 and says how many', () => {
    const read = documentManuscript(doc(paragraph(0, '체크\uF0FE 항목\uE000끝')));
    expect(read.blocks.join('')).not.toMatch(/[\uE000-\uF8FF]/u);
    expect(read.blocks.join('')).toContain('체크〓 항목〓끝');
    expect(documentManuscriptNotices(read)).toEqual(['기호 글꼴 문자 2개는 서식 글꼴로 그릴 수 없어 〓로 표시했습니다.']);
  });
  it('reads a long document with dozens of tables whole, no matter the length', () => {
    const paragraphs = Array.from({ length: 400 }, (_, i) => i % 10 === 5
      ? paragraph(i, '', [grid(Array.from({ length: 30 }, (_, r) => Array.from({ length: 9 }, (_, c) => `${i}-${r}-${c}`)))])
      : paragraph(i, `${i}번째 문단은 충분히 긴 본문 문장으로 이루어져 있습니다. `.repeat(8).trim()));
    const read = documentManuscript(doc(...paragraphs));
    expect(read.blocks.filter(b => b.startsWith('| '))).toHaveLength(40);
    expect(documentMarkdown(read.blocks).length).toBeGreaterThan(120_000);
    expect(documentMarkdown(read.blocks)).toContain('| 395-29-0 |');
  });
  it('reads an actual pinned-WASM document with a table, end to end and read only', () => {
    const native = new HwpDocument(readFileSync(new URL('./fixtures/owned-blank.hwpx', import.meta.url)));
    try {
      native.insertText(0, 0, 0, '보고서 제목'); native.splitParagraph(0, 0, 6);
      native.insertText(0, 1, 0, '본문 첫 문장입니다.'); native.splitParagraph(0, 1, 11);
      const created = JSON.parse(native.createTable(0, 2, 0, 2, 2));
      for (let c = 0; c < 4; c++) native.insertTextInCell(0, 2, created.controlIdx, c, 0, 0, ['항목', '값', 'A|B', '1,000'][c]);
      const json = new Set(['getControls', 'getControlTextPositions', 'getTableDimensions', 'getCellInfo']);
      const wasm = new Proxy({}, { get(_t, name: string) {
        if (name === 'pageCount') return native.pageCount();
        if (name === 'getFieldInfoAt') return (p: Parameters<WasmBridge['getFieldInfoAt']>[0]) => JSON.parse(p.parentParaIndex === undefined ? native.getFieldInfoAt(p.sectionIndex, p.paragraphIndex, p.charOffset) : native.getFieldInfoAtInCell(p.sectionIndex, p.parentParaIndex, p.controlIndex!, p.cellIndex!, p.cellParaIndex!, p.charOffset, false));
        const fn = (native as unknown as Record<string, Function>)[name];
        return typeof fn === 'function' ? (...args: unknown[]) => { const value = fn.apply(native, args); return json.has(name) ? JSON.parse(value) : value; } : fn;
      } }) as WasmBridge;
      const before = native.exportHwpx(), read = documentManuscript(captureWholeDocumentContext(wasm).sections);
      expect(read.blocks[0]).toBe('# 보고서 제목');
      expect(read.blocks).toContain('본문 첫 문장입니다.');
      expect(read.blocks).toContain('| 항목 | 값 |\n| --- | --- |\n| A\\|B | 1,000 |');
      expect(native.exportHwpx()).toEqual(before);
    } finally { native.free(); }
  });
});
