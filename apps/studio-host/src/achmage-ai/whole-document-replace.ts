import type { WasmBridge } from '@/upstream/core';

type Handle = NonNullable<ReturnType<WasmBridge['borrowDocumentHandle']>>;
interface Control { ctrlId: string; list: number; para: number; controlIndex: number }
/** The number a page-number restart starts from, read from the page the generated document lays it on. */
function restartValue(doc: Handle, para: number): number {
  const page = (JSON.parse(doc.getCursorRect(0, para, 0)) as { pageIndex?: unknown }).pageIndex;
  const value = typeof page === 'number' ? (JSON.parse(doc.getPageInfo(page)) as { pageNumber?: unknown }).pageNumber : undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) throw new InPlaceReplacementUnsupported('생성 문서의 쪽 번호 시작 값을 읽지 못했습니다.');
  return value;
}
export interface ReplacementCursor { sectionIndex: number; paragraphIndex: number; charOffset: number }
/** The open document cannot be replaced in place; the caller may open the result in a new window instead. */
export class InPlaceReplacementUnsupported extends Error {}
export interface WholeReplacement { paragraphs: number; pageNumbers: boolean; restarts: number; removedLayout: string[]; close(): void; execute(): ReplacementCursor }

const SECTION_HOLDER = new Set(['secd', 'cold', 'pgnp']);
/** Open-document controls that only carry page/section layout; the template replaces them and the result discloses it. */
const REPLACED_LAYOUT = new Set(['head', 'foot', 'pgnp', 'pghd', 'nwno']);
/** Kordoc 4.21.31 fixes its page number as BOTTOM_CENTER / DIGIT / sideChar "-" (gen-ids.ts) — HOP reproduces it as a centered footer. */
const PAGE_NUMBER_FOOTER = { template: 2, before: '- ', after: ' -' };
const unsupported = (message: string): never => { throw new InPlaceReplacementUnsupported(message); };
const ok = (raw: string, step: string): void => {
  let value: { ok?: boolean } | undefined;
  try { value = JSON.parse(raw); } catch { /* reported below */ }
  if (value?.ok !== true) throw Error('문서 교체 단계를 확인하지 못했습니다: ' + step);
};
const controls = (doc: Handle): Control[] => (JSON.parse(doc.getControls()) as Control[]).filter(c => c.list === 0);
const text = (doc: Handle, p: number): string => doc.getTextRange(0, p, 0, doc.getParagraphLength(0, p));

/**
 * Prepares replacing the whole single-section body of the open document with a generated HWPX.
 * The generated file is opened as a separate throwaway handle and normalized there only:
 * its section-holder controls are re-created on the open document by explicit, verified APIs
 * (page/section definition, page-number footer, page-number restarts) instead of being dropped.
 * Nothing touches the open document until execute(), which must run inside one snapshot command.
 */
export function prepareWholeDocumentReplacement(wasm: WasmBridge, bytes: Uint8Array, options: { hideFirstPage: boolean }): WholeReplacement {
  const target = wasm.borrowDocumentHandle(); if (!target) throw Error('문서를 먼저 여세요.');
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 32 * 1024 * 1024) throw Error('생성 문서는 32MiB 이내여야 합니다.');
  if (target.getSectionCount() !== 1) unsupported('여러 구역으로 나뉜 문서는 현재 창에서 통째로 바꾸지 않습니다.');
  const anchor = controls(target).filter(c => c.para === 0 && (c.ctrlId === 'secd' || c.ctrlId === 'cold')).map(c => c.ctrlId).sort().join();
  if (anchor !== 'cold,secd') unsupported('이 문서의 첫 문단 구역 구성이 달라 현재 창에서 통째로 바꾸지 않습니다.');
  const Constructor = target.constructor as new (bytes: Uint8Array) => Handle;
  const source = new Constructor(bytes.slice());
  try {
    if (source.getSectionCount() !== 1) unsupported('생성 문서가 한 구역이 아닙니다.');
    const all = controls(source), first = all.filter(c => c.para === 0);
    if (!first.some(c => c.ctrlId === 'secd')) unsupported('생성 문서의 구역 정의를 찾지 못했습니다.');
    const pageNumbers = first.some(c => c.ctrlId === 'pgnp');
    const restarts = all.filter(c => c.ctrlId === 'nwno').map(c => ({ ...c, pos: (JSON.parse(source.getControlTextPositions(0, c.para)) as number[])[c.controlIndex], start: restartValue(source, c.para) }));
    if (restarts.some(r => r.pos !== 0)) unsupported('문단 중간의 쪽 번호 재시작은 옮기지 않습니다.');
    const pageDef = source.getPageDef(0), sectionDef = source.getSectionDef(0), borderFill = source.getPageBorderFill(0);
    // Read before the throwaway copy loses its column control; the open document keeps its own cold and takes these values.
    const columns = JSON.parse(source.getColumnDef(0)) as { columnCount: number; columnType: number; sameWidth: boolean; spacing: number };
    // Throwaway-copy normalization, highest control index first so indices stay valid.
    for (const c of [...restarts, ...first.filter(c => SECTION_HOLDER.has(c.ctrlId))].sort((a, b) => b.para - a.para || b.controlIndex - a.controlIndex)) ok(source.deleteControlAt(0, c.para, c.controlIndex), '생성 문서 정리');
    // The first paragraph also carries the section boundary flag; Enter at offset 0 moves its content into an importable paragraph.
    ok(source.splitParagraph(0, 0, 0), '생성 문서 첫 문단 분리');
    if (controls(source).some(c => c.para === 0) || source.getParagraphLength(0, 0) !== 0) unsupported('생성 문서 첫 문단을 현재 창으로 옮길 수 있게 나누지 못했습니다.');
    const count = source.getParagraphCount(0), imported = count - 1;
    const request = { sourceSection: 0, sourceStart: 1, sourceEnd: count, targetSection: 0, insertBefore: 1, count: 1 };
    const verifyImport = (raw: string) => {
      const inserted = (JSON.parse(raw) as { operationResult?: { action?: string; result?: { inserted?: { start: number; end: number } } } }).operationResult;
      if (inserted?.action !== 'import_paragraph_block' || inserted.result?.inserted?.start !== 1 || inserted.result.inserted.end - 1 !== imported) throw Error('생성 본문 가져오기 범위가 일치하지 않습니다.');
    };
    try { verifyImport(target.importParagraphBlock(source, JSON.stringify({ request, dryRun: true }))); }
    catch (error) { unsupported('생성 문서에 현재 창으로 옮길 수 없는 개체가 있습니다: ' + (error instanceof Error ? error.message : String(error))); }
    const expected = Array.from({ length: imported }, (_, i) => text(source, i + 1));
    // Every paragraph, not only the first: a header started on page 2 lives in a later paragraph.
    const removedLayout = [...new Set(controls(target).filter(c => REPLACED_LAYOUT.has(c.ctrlId)).map(c => c.ctrlId))];
    return { paragraphs: imported, pageNumbers, restarts: restarts.length, removedLayout, close: () => source.free(), execute: () => {
      // 1) Clear the open document down to its section anchor (paragraph 0 with secd/cold).
      for (let p = target.getParagraphCount(0) - 1; p >= 1; p--) ok(target.deleteParagraph(0, p), '기존 본문 삭제');
      for (const c of controls(target).filter(c => c.para === 0 && !['secd', 'cold'].includes(c.ctrlId)).sort((a, b) => b.controlIndex - a.controlIndex)) ok(target.deleteControlAt(0, 0, c.controlIndex), '기존 첫 문단 개체 삭제');
      const anchorLength = target.getParagraphLength(0, 0);
      if (anchorLength) ok(target.deleteText(0, 0, 0, anchorLength), '기존 첫 문단 글 삭제');
      if (target.getParagraphCount(0) !== 1 || target.getParagraphLength(0, 0) !== 0 || controls(target).map(c => c.ctrlId).sort().join() !== 'cold,secd') throw Error('기존 본문을 비우지 못했습니다.');
      // 2) Import the generated body after the anchor, then fold its first paragraph into the anchor.
      verifyImport(target.importParagraphBlock(source, JSON.stringify({ request })));
      const shape = (JSON.parse(target.getParaPropertiesAt(0, 1)) as { paraShapeId?: number }).paraShapeId;
      if (!Number.isInteger(shape)) throw Error('생성 문서의 첫 문단 모양을 확인하지 못했습니다.');
      ok(target.mergeParagraph(0, 1), '첫 문단 합치기'); ok(target.setParaShapeId(0, 0, shape!), '첫 문단 모양 적용');
      // 3) Re-create the section-holder layout with explicit APIs.
      ok(target.setPageDef(0, pageDef), '용지 설정'); ok(target.setSectionDef(0, sectionDef), '구역 설정');
      ok(target.setColumnDef(0, columns.columnCount, columns.columnType, columns.sameWidth ? 1 : 0, columns.spacing), '단 설정');
      if (JSON.stringify(JSON.parse(target.getColumnDef(0))) !== JSON.stringify(columns)) throw Error('바뀐 문서의 단 설정이 생성 문서와 다릅니다.');
      ok(target.setPageBorderFill(0, borderFill), '쪽 테두리·배경');
      if (pageNumbers) {
        ok(target.applyHfTemplate(0, false, 0, PAGE_NUMBER_FOOTER.template), '쪽 번호 꼬리말');
        ok(target.insertTextInHeaderFooter(0, false, 0, 0, 0, PAGE_NUMBER_FOOTER.before), '쪽 번호 앞 문자');
        const footer = JSON.parse(target.getHeaderFooter(0, false, 0)) as { text?: string };
        ok(target.insertTextInHeaderFooter(0, false, 0, 0, Array.from(footer.text ?? '').length, PAGE_NUMBER_FOOTER.after), '쪽 번호 뒤 문자');
        if (options.hideFirstPage) ok(target.setPageHideEx(JSON.stringify({ sec: 0, para: 0, hideFooter: true, hidePageNum: true })), '표지 쪽 번호 감추기');
      }
      // Source paragraph i (after the split) lands at target i - 1 once paragraph 1 is folded into the anchor.
      // The generated document's own restart value (review F8: it used to be forced to 1).
      for (const r of restarts) ok(target.insertNewNumber(0, r.para, 0, r.start), '쪽 번호 다시 시작');
      // 4) Read back every paragraph before the snapshot command commits.
      if (target.getParagraphCount(0) !== imported) throw Error('바뀐 문서의 문단 수가 생성 문서와 다릅니다.');
      expected.forEach((value, p) => { if (text(target, p) !== value) throw Error('바뀐 문서의 본문이 생성 문서와 다릅니다.'); });
      // Same optional hook WasmBridge uses after a load: new paragraphs get editor stable IDs.
      (target as unknown as { ensureParagraphStableIds?: () => void }).ensureParagraphStableIds?.();
      return { sectionIndex: 0, paragraphIndex: 0, charOffset: 0 };
    } };
  } catch (error) { source.free(); throw error; }
}
