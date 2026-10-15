/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { HwpDocument } from '../../vendor/rhwp-core/rhwp.js';
import { EventBus } from '@upstream/core/event-bus';
import { SnapshotCommand } from '@upstream/engine/command';
import { CommandHistory } from '@upstream/engine/history';
import type { WasmBridge } from '@/upstream/core';
import type { InputHandler } from '@/upstream/editor';
import type { CanvasView } from '@/upstream/view';
import { AiDocument } from './document';
import { roleTemplateFixture } from './document-template-fixture';
import { BUILTIN_DOCUMENT_TEMPLATES } from './document-templates';
import { planRestyle } from './restyle';
import { classifyParagraphs, roleLook, type ParagraphFeatures } from './style-contract';
import { initPinnedEngine } from './test-support/pinned-wasm';

initPinnedEngine();
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
const JSON_METHODS = new Set(['getControls', 'getCharPropertiesAt', 'getParaPropertiesAt', 'getTableDimensions', 'getCellInfo', 'getCellParaPropertiesAt', 'getCellCharPropertiesAt', 'getStyleAt']);

/** A user-made report: title, numbered headings, emphasized body, items, note, caption, a data table, a picture, a field and a header. */
function userReport(): Uint8Array {
  const doc = new HwpDocument(readFileSync(new URL('./fixtures/owned-blank.hwpx', import.meta.url)));
  const lines = ['교양교육 개편 결과 보고', '1. 추진 배경', '교양교육과정 개편은 학생 선택권을 넓히고 기초 역량을 강화하기 위해 추진되었으며 위원회는 세 차례 회의를 거쳐 개편안을 확정하였다.', '□ 개편안 확정', '○ 단과대학 의견 수렴', '※ 세부 일정은 추후 공지', '<표 1> 예산 현황', '', '그림과 필드가 함께 있는 문단으로 내용은 바뀌지 않아야 한다.', '2. 향후 계획', '다음 학기부터 개편 교과목을 개설하고 운영 결과를 점검한다.', '2026. 10. 14.'];
  lines.forEach((text, i) => { if (i) doc.splitParagraph(0, i - 1, doc.getParagraphLength(0, i - 1)); if (text) doc.insertText(0, i, 0, text); });
  const all = (p: number, props: object) => doc.applyCharFormat(0, p, 0, doc.getParagraphLength(0, p), JSON.stringify(props));
  all(0, { fontSize: 1600, bold: true }); doc.applyParaFormat(0, 0, JSON.stringify({ alignment: 'center' }));
  all(1, { fontSize: 1300, bold: true }); all(9, { fontSize: 1300, bold: true });
  doc.applyCharFormat(0, 2, 0, 4, JSON.stringify({ textColor: '#FF0000', underline: true }));
  doc.applyParaFormat(0, 11, JSON.stringify({ alignment: 'right' }));
  doc.insertPicture(0, 8, 0, '', PNG, 1000, 1000, 1, 1, 'png', '점');
  doc.insertClickHereField(0, 8, doc.getParagraphLength(0, 8), '입력', '', 'memo', true);
  doc.createHeaderFooter(0, true, 0); doc.insertTextInHeaderFooter(0, true, 0, 0, 0, '머리말 증인');
  const table = JSON.parse(doc.createTable(0, 7, 0, 3, 3)) as { controlIdx: number };
  ['구분', '예산', '비고', '인건비', '100', '', '운영비', '50', '추가'].forEach((text, cell) => { if (text) doc.insertTextInCell(0, 7, table.controlIdx, cell, 0, 0, text); });
  const bytes = doc.exportHwpx(); doc.free(); return bytes;
}

function harness(bytes: Uint8Array) {
  const native = new HwpDocument(bytes), history = new CommandHistory(), bus = new EventBus();
  let cursor = { sectionIndex: 0, paragraphIndex: 0, charOffset: 0 };
  const wasm = new Proxy({}, { get(_t, name: string) {
    if (name === 'pageCount') return native.pageCount();
    if (name === 'documentGeneration') return 1;
    if (name === 'getSourceFormat') return () => 'hwpx';
    if (name === 'borrowDocumentHandle') return () => native;
    if (['beginDeferredPagination', 'flushDeferredPagination', 'cancelDeferredPagination'].includes(name)) return undefined;
    const fn = (native as unknown as Record<string, unknown>)[name];
    return typeof fn === 'function' ? (...args: unknown[]) => { const v = (fn as (...a: unknown[]) => unknown).apply(native, args); return JSON_METHODS.has(name) ? JSON.parse(v as string) : v; } : fn;
  } }) as WasmBridge;
  const input = { getCursorPosition: () => cursor, getSelection: () => null, async executeDocumentAgentOperation(d: { operationType: string; operation: (w: WasmBridge) => typeof cursor }, render: () => Promise<void>) {
    const command = new SnapshotCommand(d.operationType, cursor, cursor, d.operation); cursor = history.execute(command, wasm);
    try { await render(); } catch (e) { const restored = history.rollbackUncommittedSnapshot(command.type, wasm); if (restored) cursor = restored; throw e; } bus.emit('document-mutated');
  } } as unknown as InputHandler;
  const view = { refreshDocumentAgentMutation: async () => undefined } as unknown as CanvasView;
  const adapter = new AiDocument(wasm, input, bus, view, () => true);
  return { native, wasm, history, adapter, undo: () => { const r = history.undo(wasm); if (r) cursor = r; }, close: () => { adapter.dispose(); history.clear(wasm); native.free(); } };
}
const char = (doc: HwpDocument, p: number, offset = 0) => JSON.parse(doc.getCharPropertiesAt(0, p, offset)) as { fontSize: number; bold: boolean; underline: boolean; textColor: string; fontFamilies: string[] };
const para = (doc: HwpDocument, p: number) => JSON.parse(doc.getParaPropertiesAt(0, p)) as { alignment: string; lineSpacing: number };

describe('style contract', () => {
  const f = (text: string, fontSizePt = 10, extra: Partial<ParagraphFeatures> = {}): ParagraphFeatures => ({ text, fontSizePt, bold: false, ...extra });
  it('reads roles from formatting relative to the body, never from what the words mean', () => {
    expect(classifyParagraphs([
      f('결과 보고', 16, { bold: true, alignment: 'center' }), f('1. 추진 배경', 13, { bold: true }), f('개편은 학생 선택권을 넓히기 위해 추진되었으며 위원회는 개편안을 확정하였다.'),
      f('□ 개편안 확정'), f('※ 추후 공지'), f('<표 1> 예산'), f('세부 사항', 11, { bold: true }), f('제2장 계획'), f('짧은 문장이다.', 10, { bold: true }),
      f('구분', 10, { cell: { header: true } }), f('인건비', 10, { cell: { header: false } }), f('합계', 10, { bold: true, cell: { header: false } }),
      f('개요', 10, { headType: 'Outline', paraLevel: 1 }), f('바탕', 10, { styleName: '개요 3' }),
    ])).toEqual(['title', 'heading1', 'body', 'item', 'note', 'caption', 'heading2', 'heading3', 'body', 'tableHeader', 'tableCell', 'tableHeader', 'heading2', 'heading3']);
  });
  it('derives every look from the template roles; body keeps its own emphasis', () => {
    const t = roleTemplateFixture();
    expect(roleLook(t, 'heading2')).toMatchObject({ fontSizePt: 15, bold: true });
    expect(roleLook(t, 'body').bold).toBeUndefined();
    expect(roleLook(t, 'tableCell')).toMatchObject({ alignment: undefined, lineSpacingPercent: undefined });
    expect(roleLook(t, 'caption')).toMatchObject({ fontSizePt: 14, alignment: 'center' });
  });
});

describe('restyle review regressions (bundle B)', () => {
  const f = (text: string, fontSizePt = 10, extra: Partial<ParagraphFeatures> = {}): ParagraphFeatures => ({ text, fontSizePt, bold: false, fontFamily: '신명조', ...extra });
  const longBody = '교양교육과정 개편은 학생 선택권을 넓히기 위해 추진되었으며 위원회는 개편안을 확정하였다.';
  it('reads common report lines the way people mean them (MED 3)', () => {
    expect(classifyParagraphs([
      f('Ⅰ. 개요', 13, { bold: true }), f(longBody), f('1. 사업 개요', 12, { bold: true }), f(longBody),
      f('○ 운영 개선', 11), f('○ 학생 참여 확대와 교과목 다양화가 필요함', 11), f(longBody),
      f('담당자: 홍길동', 10, { bold: true }), f('위원장', 12, { bold: true, alignment: 'right' }),
    ])).toEqual(['heading1', 'body', 'heading2', 'body', 'item', 'item', 'body', 'body', 'body']);
    // After a kept cover, the first centered large line is a chapter, not a second title.
    expect(classifyParagraphs([f('1. 추진 배경', 18, { bold: true, alignment: 'center' }), f(longBody)], { allowTitle: false })[0]).toBe('heading1');
  });
  it('tells headings by their font when size and weight match the body (MED 4)', () => {
    expect(classifyParagraphs([f('연구 방법', 10, { fontFamily: 'HY견고딕' }), f(longBody), f(longBody)])[0]).toBe('heading1');
  });
  it('applying a template whose headings match the body in size is still stable the second time (MED 4)', async () => {
    const h = harness(userReport()), template = BUILTIN_DOCUMENT_TEMPLATES.find(t => t.id === 'builtin-korean-communication')!;
    try {
      await h.adapter.applyRestyle(h.adapter.identity(), template);
      const once = h.native.exportHwpx();
      await h.adapter.applyRestyle(h.adapter.identity(), template);
      expect(h.native.exportHwpx()).toEqual(once);
    } finally { h.close(); }
  });
  it('does not treat a page-number restart deep in the document as a cover (MED 5)', () => {
    const native = new HwpDocument(userReport());
    try {
      for (let i = 0; i < 160; i++) { native.splitParagraph(0, 2, native.getParagraphLength(0, 2)); native.insertText(0, 3, 0, `본문 줄 ${i}`); }
      native.insertNewNumber(0, native.getParagraphCount(0) - 2, 0, 1);
      const h = harness(native.exportHwpx());
      try { expect(planRestyle(h.wasm).kept.frontMatter).toBe(0); } finally { h.close(); }
    } finally { native.free(); }
  });
});

describe('in-place restyle (real WASM, no AI)', () => {
  it('restyles roles, keeps text, objects, header and emphasis, and undoes in one step', async () => {
    const h = harness(userReport());
    try {
      const before = h.native.exportHwpx(), controls = h.native.getControls(), text = h.native.getTextFileUnicode();
      const result = await h.adapter.applyRestyle(h.adapter.identity(), roleTemplateFixture());
      expect(result.summary).toContain('제목 1');
      expect(h.native.getTextFileUnicode()).toBe(text);
      expect(h.native.getControls()).toBe(controls);
      expect(char(h.native, 0)).toMatchObject({ fontSize: 2000, bold: true }); expect(para(h.native, 0).alignment).toBe('center');
      expect(char(h.native, 1)).toMatchObject({ fontSize: 1600, bold: true }); expect(para(h.native, 1).alignment).toBe('left');
      expect(char(h.native, 2, 0)).toMatchObject({ fontSize: 1500, underline: true, textColor: '#ff0000' });
      expect(char(h.native, 2, 10)).toMatchObject({ fontSize: 1500, underline: false });
      expect(para(h.native, 2)).toMatchObject({ alignment: 'justify', lineSpacing: 160 });
      expect(char(h.native, 3).fontSize).toBe(1500); expect(char(h.native, 5).fontSize).toBe(1400);
      expect(char(h.native, 6).fontSize).toBe(1400); expect(para(h.native, 6).alignment).toBe('center');
      expect(char(h.native, 12).fontSize).toBe(1500); expect(para(h.native, 12).alignment).toBe('right');
      const tbl = (JSON.parse(controls) as { ctrlId: string; para: number; controlIndex: number }[]).find(c => c.ctrlId === 'tbl' && c.para === 7)!.controlIndex;
      const cell = (n: number) => JSON.parse(h.native.getCellCharPropertiesAt(0, 7, tbl, n, 0, 0)) as { fontSize: number; bold: boolean };
      expect(cell(0)).toMatchObject({ fontSize: 1500, bold: true }); expect(cell(3)).toMatchObject({ fontSize: 1500, bold: false });
      expect(JSON.parse(h.native.getCellParaPropertiesAt(0, 7, tbl, 0, 0)).alignment).toBe('center');
      const saved = h.native.exportHwpx(), reopened = new HwpDocument(saved);
      try { expect(reopened.getTextFileUnicode()).toBe(text); expect(char(reopened, 1)).toMatchObject({ fontSize: 1600, bold: true }); } finally { reopened.free(); }
      // A second application finds nothing to change: same bytes, so no new character or paragraph shapes.
      await h.adapter.applyRestyle(h.adapter.identity(), roleTemplateFixture());
      expect(h.native.exportHwpx()).toEqual(saved);
      h.undo(); h.undo();
      expect(h.native.exportHwpx()).toEqual(before);
    } finally { h.close(); }
  });

  it('leaves the cover, table of contents and design boxes of a generated report alone', () => {
    const h = harness(readFileSync(new URL('./fixtures/kordoc-report-cover.hwpx', import.meta.url)));
    try {
      const plan = planRestyle(h.wasm);
      expect(plan.kept).toEqual({ frontMatter: 17, layoutTables: 2, nestedTables: 0 });
      expect(plan.targets.map(t => t.paragraph)).toEqual([19]);
      expect(plan.roles).toEqual(['body']);
    } finally { h.close(); }
  });

  it('refuses a stale request without touching the document', async () => {
    const h = harness(userReport());
    try {
      const identity = h.adapter.identity(), before = h.native.exportHwpx();
      h.native.insertText(0, 2, 0, '가');
      await expect(h.adapter.applyRestyle(identity, roleTemplateFixture())).rejects.toThrow('문서가 바뀌어');
      h.native.deleteText(0, 2, 0, 1);
      expect(h.history.canUndo()).toBe(false);
      expect(h.native.exportHwpx().length).toBe(before.length);
    } finally { h.close(); }
  });
});
