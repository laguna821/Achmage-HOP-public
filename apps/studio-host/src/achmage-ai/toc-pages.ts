/**
 * Table-of-contents page numbers. The contents block is the run of lines right after a contents
 * heading ("목차", "차례", "Contents"); each line names a heading that appears later in the document
 * (a body paragraph, or a cell of a one-row title band such as Kordoc's chapter bars). Its number is
 * the page number that heading is laid out on, after any page-number restart, so a cover and the
 * contents themselves are excluded as the document says. Only the page-number part of a line is
 * rewritten ("as written⇥page" with a right tab and dot leader); nothing else in the document changes.
 */
import type { WasmBridge } from '@/upstream/core';

export interface TocEntry { paragraph: number; title: string; target: number; /** The line as written, without its page-number part. */ head: string }
type Control = { ctrlId: string; list: number; para: number; controlIndex: number };
const fail = (message: string): never => { throw new Error(message); };

/**
 * A contents line as written, without its page-number part: everything from a tab, or a dot leader
 * followed by a number. A number after a plain space belongs to the title ("부록 1", "Phase 3").
 */
function tocHead(text: string): string {
  return text.replace(/\t.*$/su, '').replace(/\s*[.·…‥]{2,}\s*\d{1,4}\s*$/u, '').trimEnd();
}
/** The title a contents line names, compared with headings after whitespace is normalized. */
export function tocTitle(text: string): string {
  return tocHead(text).replace(/\s+/gu, ' ').trim();
}
const CONTENTS_HEADING = /^(?:목\s*차|차\s*례|(?:table\s+of\s+)?contents)$/iu;

/**
 * Cheap check for the right-click menu: a contents heading among the first paragraphs of a one-section
 * document. Reads at most `scan` short paragraphs, so opening the menu stays instant.
 */
export function hasContentsHeading(wasm: WasmBridge, scan = 120): boolean {
  try {
    if (wasm.pageCount === 0 || wasm.getSectionCount() !== 1) return false;
    const count = Math.min(wasm.getParagraphCount(0), scan);
    for (let p = 0; p < count; p++) {
      const n = wasm.getParagraphLength(0, p);
      if (n && n <= 40 && CONTENTS_HEADING.test(tocTitle(wasm.getTextRange(0, p, 0, n)))) return true;
    }
  } catch { /* no document, or the engine is busy: no menu item */ }
  return false;
}

/** Reads the first contents block (two or more consecutive lines) and the heading each line names. */
export function findToc(wasm: WasmBridge): TocEntry[] {
  if (wasm.pageCount === 0 || wasm.getSectionCount() !== 1) return [];
  const count = wasm.getParagraphCount(0);
  if (count > 20_000) return [];
  const controls = wasm.getControls() as Control[], texts: string[] = [], headings = new Map<string, number[]>();
  const note = (key: string, p: number) => { if (key && Array.from(key).length <= 80) headings.set(key, [...(headings.get(key) ?? []), p]); };
  for (let p = 0; p < count; p++) {
    const n = wasm.getParagraphLength(0, p), text = n ? wasm.getTextRange(0, p, 0, n) : '';
    texts.push(text); note(tocTitle(text), p);
    for (const table of controls.filter(c => c.list === 0 && c.para === p && c.ctrlId === 'tbl')) {
      const dims = wasm.getTableDimensions(0, p, table.controlIndex);
      if (dims.rowCount !== 1 || dims.cellCount > 4) continue;
      for (let cell = 0; cell < dims.cellCount; cell++) {
        const m = wasm.getCellParagraphLength(0, p, table.controlIndex, cell, 0);
        if (m) note(tocTitle(wasm.getTextInCell(0, p, table.controlIndex, cell, 0, 0, m)), p);
      }
    }
  }
  const plain = (p: number) => !controls.some(c => c.list === 0 && c.para === p && !['secd', 'cold'].includes(c.ctrlId));
  const laterHeading = (p: number, after: number) => (headings.get(tocTitle(texts[p])) ?? []).find(q => q > after);
  // The block must start right after a contents heading (blank lines between are allowed); lists of
  // agenda items or appendices elsewhere are never treated as contents.
  const afterContentsHeading = (p: number) => { let q = p - 1; while (q >= 0 && !texts[q].trim() && plain(q)) q--; return q >= 0 && CONTENTS_HEADING.test(tocTitle(texts[q])); };
  for (let start = 0; start < count; start++) {
    if (!plain(start) || !tocTitle(texts[start]) || !afterContentsHeading(start) || laterHeading(start, start) === undefined) continue;
    let end = start;
    while (end + 1 < count && plain(end + 1) && tocTitle(texts[end + 1]) && laterHeading(end + 1, end + 1) !== undefined) end++;
    // Each heading must lie after the whole block, so the block never points into itself.
    const entries = Array.from({ length: end - start + 1 }, (_, i) => start + i).flatMap(p => { const target = laterHeading(p, end); return target === undefined ? [] : [{ paragraph: p, title: tocTitle(texts[p]), target, head: tocHead(texts[p]) }]; });
    if (entries.length >= 2) return entries;
    start = end;
  }
  return [];
}

function pageNumberOf(wasm: WasmBridge, paragraph: number): number {
  const handle = wasm.borrowDocumentHandle() as unknown as { getCursorRect(s: number, p: number, o: number): string; getPageInfo(page: number): string } | null;
  if (!handle) fail('문서 엔진이 없습니다.');
  const page = (JSON.parse(handle!.getCursorRect(0, paragraph, 0)) as { pageIndex?: unknown }).pageIndex;
  const number = typeof page === 'number' ? (JSON.parse(handle!.getPageInfo(page)) as { pageNumber?: unknown }).pageNumber : undefined;
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) fail('제목이 놓인 쪽 번호를 읽지 못했습니다.');
  return number as number;
}

/**
 * Writes the page numbers (inside the caller's snapshot command). Numbers can push a line onto the
 * next page, so pages are read again and rewritten until they settle, at most three passes.
 */
export function executeTocRefresh(wasm: WasmBridge, entries: readonly TocEntry[]): { entries: number; pages: number[] } {
  const count = wasm.getParagraphCount(0), before = Array.from({ length: count }, (_, p) => { const n = wasm.getParagraphLength(0, p); return n ? wasm.getTextRange(0, p, 0, n) : ''; });
  const handle = wasm.borrowDocumentHandle() as unknown as { getPageDef(s: number): string } | null;
  if (!handle) fail('문서 엔진이 없습니다.');
  const controls = JSON.stringify(wasm.getControls()), def = JSON.parse(handle!.getPageDef(0)) as { width: number; marginLeft: number; marginRight: number; marginGutter?: number };
  const body = def.width - def.marginLeft - def.marginRight - (def.marginGutter ?? 0);
  if (entries.some(e => !before[e.paragraph].startsWith(e.head))) fail('목차 줄을 확인하지 못했습니다.');
  let pages: number[] = [], settled = false;
  for (let pass = 0; pass < 3; pass++) {
    const next = entries.map(e => pageNumberOf(wasm, e.target));
    if (pass && next.every((n, i) => n === pages[i])) { settled = true; break; }
    pages = next;
    entries.forEach((e, i) => {
      // The title stays exactly as written (spacing, indentation); only the part after it changes.
      const n = wasm.getParagraphLength(0, e.paragraph), keep = Array.from(e.head).length, tail = `\t${pages[i]}`;
      if (wasm.getTextRange(0, e.paragraph, 0, n) !== e.head + tail) {
        if (n > keep) wasm.deleteText(0, e.paragraph, keep, n - keep);
        wasm.insertText(0, e.paragraph, keep, tail);
      }
      // A right tab with a dot leader at the right edge of the line (px from the engine → HWPUNIT, 75 per px).
      const para = wasm.getParaPropertiesAt(0, e.paragraph) as { marginLeft?: number; marginRight?: number; tabStops?: { position: number; type: number; fill: number }[] };
      const position = Math.round(body - ((para.marginLeft ?? 0) + (para.marginRight ?? 0)) * 75);
      if (!para.tabStops?.some(t => t.type === 1 && t.fill === 3 && Math.abs(t.position - position) <= 75)) wasm.applyParaFormat(0, e.paragraph, JSON.stringify({ tabStops: [{ position, type: 1, fill: 3 }] }));
    });
  }
  // Writing the numbers can move a heading to another page; after the last pass the numbers must hold.
  if (!settled && entries.some((e, i) => pageNumberOf(wasm, e.target) !== pages[i])) fail('목차 쪽 번호가 정해지지 않아 넣지 않았습니다.');
  // Only the contents lines changed: every other paragraph and every object is as it was.
  const lines = new Set(entries.map(e => e.paragraph));
  if (wasm.getParagraphCount(0) !== count || JSON.stringify(wasm.getControls()) !== controls) fail('목차를 채우는 중 문서 구성이 바뀌어 취소했습니다.');
  for (let p = 0; p < count; p++) if (!lines.has(p)) { const n = wasm.getParagraphLength(0, p); if ((n ? wasm.getTextRange(0, p, 0, n) : '') !== before[p]) fail('목차 밖의 글이 바뀌어 취소했습니다.'); }
  entries.forEach((e, i) => { const n = wasm.getParagraphLength(0, e.paragraph); if (wasm.getTextRange(0, e.paragraph, 0, n) !== `${e.head}\t${pages[i]}`) fail('목차 줄을 확인하지 못했습니다.'); });
  return { entries: entries.length, pages };
}
