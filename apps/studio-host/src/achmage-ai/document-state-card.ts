import { findToc } from './toc-pages';
import { calculatorChoices } from './calculators';
import type { WasmBridge } from '@/upstream/core';
import type { InputHandler } from '@/upstream/editor';

/**
 * Facts the request router may rely on: what is open, selected and possible. Read leniently (a
 * digest for understanding the request, never the data an edit is applied to) and bounded.
 */
export interface DocumentStateCard {
  open: boolean;
  blank: boolean;
  sections: number;
  paragraphs: number;
  /** Tables, pictures/shapes/fields, and page layout (header, footer, page numbers). */
  objects: { tables: number; other: number; layout: number };
  /** `calculations`: the local calculators that fit the selected text (금액 한글 병기, 공문 날짜 …). */
  selection: null | { paragraphs: number; chars: number; inTable: boolean; emptyCell?: boolean; preview: string; calculations: string[] };
  caret: null | { paragraphChars: number; preview: string };
  template: null | { id: string; name: string };
  /** Body text in reading order, tables as "[표 r×c] first row"; cut at the byte budget. */
  body: { text: string; truncated: boolean };
  /** Filled by the panel: the range the assistant last applied, and its last plain answer. */
  recentEdit: null | { paragraphs: number; preview: string };
  lastAnswer: null | string;
  /** Contents lines that name later headings (0 when the document has no contents block). */
  toc: number;
}

const LAYOUT = new Set(['secd', 'cold', 'pgnp', 'pghd', 'nwno', 'head', 'foot']);
const BODY_BUDGET = 12 * 1024, PREVIEW = 400;
type Position = NonNullable<ReturnType<InputHandler['getSelection']>>['start'];
const inBody = (p: Position) => p.parentParaIndex === undefined && p.cellIndex === undefined && !p.isTextBox && !p.cellPath?.length;
const clip = (text: string, max: number) => { const chars = Array.from(text); return chars.length > max ? chars.slice(0, max).join('') + '…' : text; };
const attempt = <T>(read: () => T, fallback: T): T => { try { return read(); } catch { return fallback; } };

type Wasm = Pick<WasmBridge, 'pageCount' | 'getSectionCount' | 'getParagraphCount' | 'getParagraphLength' | 'getTextRange' | 'getControls'> & Partial<Pick<WasmBridge, 'getTableDimensions' | 'getCellInfo' | 'getCellParagraphCount' | 'getCellParagraphLength' | 'getTextInCell'>>;

function tableDigest(wasm: Wasm, section: number, paragraph: number, controlIndex: number): string {
  return attempt(() => {
    const d = wasm.getTableDimensions!(section, paragraph, controlIndex), head: string[] = [];
    for (let cell = 0; cell < d.cellCount && head.length < d.colCount; cell++) {
      if (wasm.getCellInfo!(section, paragraph, controlIndex, cell).row !== 0) continue;
      const length = wasm.getCellParagraphCount!(section, paragraph, controlIndex, cell) > 0 ? wasm.getCellParagraphLength!(section, paragraph, controlIndex, cell, 0) : 0;
      head.push(length ? clip(wasm.getTextInCell!(section, paragraph, controlIndex, cell, 0, 0, length), 24) : '');
    }
    return `[표 ${d.rowCount}×${d.colCount}] ${head.join(' | ')}`;
  }, '[표]');
}

export function buildDocumentStateCard(wasm: Wasm, input: Pick<InputHandler, 'getSelection' | 'getCursorPosition'> | undefined, template: { id: string; name: string } | null): DocumentStateCard {
  const card: DocumentStateCard = { open: wasm.pageCount > 0, blank: false, sections: 0, paragraphs: 0, objects: { tables: 0, other: 0, layout: 0 }, selection: null, caret: null, template, body: { text: '', truncated: false }, recentEdit: null, lastAnswer: null, toc: 0 };
  if (!card.open) return card;
  const controls = attempt(() => wasm.getControls(), []);
  const tablesByParagraph = new Map<number, number[]>();
  for (const c of controls) {
    if (c.ctrlId === 'tbl') { card.objects.tables++; if (c.list === 0) tablesByParagraph.set(c.para, [...(tablesByParagraph.get(c.para) ?? []), c.controlIndex]); }
    else if (LAYOUT.has(c.ctrlId)) { if (c.ctrlId !== 'secd' && c.ctrlId !== 'cold') card.objects.layout++; }
    else card.objects.other++;
  }
  card.sections = attempt(() => wasm.getSectionCount(), 0);
  const lines: string[] = []; let bytes = 0, global = 0;
  const encoder = new TextEncoder();
  const push = (line: string) => { if (card.body.truncated) return; const size = encoder.encode(line).length + 1; if (bytes + size > BODY_BUDGET) { card.body.truncated = true; return; } bytes += size; lines.push(line); };
  for (let s = 0; s < card.sections; s++) {
    const count = attempt(() => wasm.getParagraphCount(s), 0);
    for (let p = 0; p < count; p++, global++) {
      card.paragraphs++;
      const length = attempt(() => wasm.getParagraphLength(s, p), 0);
      const text = length ? attempt(() => wasm.getTextRange(s, p, 0, length), '') : '';
      if (text.trim()) push(text);
      for (const controlIndex of tablesByParagraph.get(global) ?? []) push(tableDigest(wasm, s, p, controlIndex));
    }
  }
  card.body.text = lines.join('\n');
  card.toc = wasm.getTableDimensions && wasm.getCellParagraphLength && wasm.getTextInCell ? attempt(() => findToc(wasm as unknown as WasmBridge).length, 0) : 0;
  card.blank = card.paragraphs === 1 && !card.body.text && card.objects.tables === 0 && card.objects.other === 0;
  const selection = attempt(() => input?.getSelection() ?? null, null);
  if (selection) {
    const [a, b] = selection.start.sectionIndex < selection.end.sectionIndex || selection.start.sectionIndex === selection.end.sectionIndex && (selection.start.paragraphIndex < selection.end.paragraphIndex || selection.start.paragraphIndex === selection.end.paragraphIndex && selection.start.charOffset <= selection.end.charOffset) ? [selection.start, selection.end] : [selection.end, selection.start];
    const sameCell = a.parentParaIndex !== undefined && a.cellIndex !== undefined && a.cellParaIndex !== undefined && b.cellParaIndex !== undefined && a.parentParaIndex === b.parentParaIndex && a.controlIndex === b.controlIndex && a.cellIndex === b.cellIndex && (a.cellPath?.length ?? 1) <= 1 && a.sectionIndex === b.sectionIndex;
    if (sameCell && wasm.getTextInCell && wasm.getCellParagraphLength) {
      const parts: string[] = [], [x, y] = a.cellParaIndex! < b.cellParaIndex! || a.cellParaIndex === b.cellParaIndex && a.charOffset <= b.charOffset ? [a, b] : [b, a];
      for (let p = x.cellParaIndex!; p <= y.cellParaIndex!; p++) {
        const length = attempt(() => wasm.getCellParagraphLength!(a.sectionIndex, a.parentParaIndex!, a.controlIndex!, a.cellIndex!, p), 0);
        const start = p === x.cellParaIndex ? x.charOffset : 0, end = p === y.cellParaIndex ? y.charOffset : length;
        parts.push(end > start ? attempt(() => wasm.getTextInCell!(a.sectionIndex, a.parentParaIndex!, a.controlIndex!, a.cellIndex!, p, start, end - start), '') : '');
      }
      const text = parts.join('\n');
      card.selection = { paragraphs: parts.length, chars: Array.from(text).length, inTable: true, ...(x.cellParaIndex === y.cellParaIndex && x.charOffset === 0 && y.charOffset === 0 && attempt(() => wasm.getCellParagraphLength!(a.sectionIndex,a.parentParaIndex!,a.controlIndex!,a.cellIndex!,x.cellParaIndex!), -1) === 0 ? {emptyCell:true} : {}), preview: clip(text, PREVIEW), calculations: calculatorChoices(text).map(c => c.label) };
    } else if (!inBody(a) || !inBody(b)) card.selection = { paragraphs: 1, chars: 0, inTable: true, preview: '', calculations: [] };
    else if (a.sectionIndex === b.sectionIndex) {
      const parts: string[] = [];
      for (let p = a.paragraphIndex; p <= b.paragraphIndex; p++) {
        const length = attempt(() => wasm.getParagraphLength(a.sectionIndex, p), 0);
        const start = p === a.paragraphIndex ? a.charOffset : 0, end = p === b.paragraphIndex ? b.charOffset : length;
        parts.push(end > start ? attempt(() => wasm.getTextRange(a.sectionIndex, p, start, end - start), '') : '');
      }
      const text = parts.join('\n');
      if (text) card.selection = { paragraphs: parts.length, chars: Array.from(text).length, inTable: false, preview: clip(text, PREVIEW), calculations: calculatorChoices(text).map(c => c.label) };
    }
  }
  const caret = attempt(() => input?.getCursorPosition() ?? null, null);
  if (caret && inBody(caret)) {
    const length = attempt(() => wasm.getParagraphLength(caret.sectionIndex, caret.paragraphIndex), 0);
    card.caret = { paragraphChars: length, preview: length ? clip(attempt(() => wasm.getTextRange(caret.sectionIndex, caret.paragraphIndex, 0, length), ''), 160) : '' };
  }
  // An empty, flat table-cell paragraph is an explicit insertion target, even without text to drag.
  if (!selection && caret && caret.parentParaIndex !== undefined && caret.controlIndex !== undefined && caret.cellIndex !== undefined && caret.cellParaIndex !== undefined && !caret.isTextBox && (caret.cellPath?.length ?? 1) <= 1 && wasm.getCellParagraphLength) {
    const length = attempt(() => wasm.getCellParagraphLength!(caret.sectionIndex, caret.parentParaIndex!, caret.controlIndex!, caret.cellIndex!, caret.cellParaIndex!), -1);
    if (length === 0) card.selection = { paragraphs: 1, chars: 0, inTable: true, emptyCell: true, preview: '', calculations: [] };
  }
  return card;
}

/** Only section/column definitions: paragraph-level structured editing can preserve the document. */
export function structuredEditable(card: DocumentStateCard): boolean {
  return card.open && card.sections === 1 && card.objects.tables === 0 && card.objects.other === 0 && card.objects.layout === 0;
}
