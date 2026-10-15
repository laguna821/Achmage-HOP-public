import { manuscriptNodes, structureManuscript } from './manuscript';
import { outlineBlocks, type OutlineNode } from './outline-ast';
import { maskPersonal, type MaskedText } from './outbound-gate';
import type { WholeDocumentSection, WholeDocumentTable } from './whole-document-context';

/**
 * The open document as Kordoc Markdown blocks, read the way a pasted manuscript is (□ ○ 1. 가. items,
 * "제2장" chapters, a short first line as the title) except that every paragraph stays its own paragraph
 * and tables come from the document's own cells. No model is involved and nothing is retyped, so a long
 * document with many tables is typeset as written, within the bounds of whole-document-context.ts.
 */
export interface DocumentManuscript {
  /** One Markdown block per paragraph, heading, item or table, in document order. */
  blocks: string[];
  /** The same blocks before Markdown escaping, for a copy masked before it is sent anywhere. */
  nodes: OutlineNode[];
  /** Symbol-font characters (Private Use Area) the template fonts cannot draw, shown as 〓. */
  standIns: number;
  /** Merged cells, kept as text in their first cell. */
  mergedCells: number;
  /** Cells with several paragraphs, joined with spaces. */
  multiParagraphCells: number;
}

/** The Private Use Area is reserved by the engine and drawn only by the symbol font that put it there. */
const PRIVATE_USE = /[\uE000-\uF8FF]/gu;
const STAND_IN = '〓';
/** Placeholder lines for tables while the text is read as a manuscript; the area is free once symbols are replaced. */
const TABLE_MARK = '\uE000';
const TABLE_LINE = new RegExp(`^${TABLE_MARK}(\\d+)${TABLE_MARK}$`, 'u');

export function documentManuscript(sections: readonly WholeDocumentSection[]): DocumentManuscript {
  let standIns = 0, mergedCells = 0, multiParagraphCells = 0;
  const clean = (text: string) => text.replace(PRIVATE_USE, () => { standIns++; return STAND_IN; })
    .replace(/[\t\n\r\u000b\u000c]/g, ' ').replace(/[\u0000-\u0008\u000e-\u001f\u007f\ufffc]/g, '').trim();
  const tables: string[][][] = [], lines: string[] = [];
  const table = (t: WholeDocumentTable) => {
    const rows = Array.from({ length: t.rowCount }, () => Array<string>(t.colCount).fill(''));
    for (const cell of t.cells) {
      if (cell.rowSpan > 1 || cell.colSpan > 1) mergedCells++;
      const texts = cell.paragraphs.map(p => clean(p.text)).filter(Boolean);
      if (texts.length > 1) multiParagraphCells++;
      rows[cell.row][cell.col] = texts.join(' ');
    }
    lines.push(`${TABLE_MARK}${tables.length}${TABLE_MARK}`);
    tables.push(rows);
  };
  for (const section of sections) for (const p of section.paragraphs) {
    // A table anchored at the start of its paragraph comes before that paragraph's text.
    p.tables.filter(t => t.charOffset === 0).forEach(table);
    const text = clean(p.text);
    // A leading "#" or "|" is document text, not a heading or table row, when the paragraph is read as a manuscript.
    if (text) lines.push(text.replace(/^#/u, '\uE001').replace(/\|/gu, '\uE002'));
    p.tables.filter(t => t.charOffset !== 0).forEach(table);
  }
  // Blank lines keep every paragraph separate (a manuscript would join lines broken mid-sentence).
  const nodes: OutlineNode[] = manuscriptNodes(lines.join('\n\n')).map(n => {
    const mark = n.kind === 'paragraph' ? TABLE_LINE.exec(n.text) : null;
    return mark ? { kind: 'table', rows: tables[Number(mark[1])] } : n;
  });
  const structured = structureManuscript(nodes);
  return { blocks: renderBlocks(structured), nodes: structured, standIns, mergedCells, multiParagraphCells };
}

const renderBlocks = (nodes: readonly OutlineNode[]): string[] =>
  outlineBlocks(nodes, { literal: true }).map(block => block.replace(/\uE001/gu, '\\#').replace(/\uE002/gu, '\\|'));

/**
 * The blocks as a model sees them: personal identifiers are masked in the text itself, before Markdown escaping
 * could split them ("031)000-0000" escaped is "031\)000-0000", which no detector reads as a phone number). The block
 * numbers match `blocks`; the returned mask continues into the rest of the prompt.
 */
export function maskedDocumentBlocks(read: DocumentManuscript, base?: MaskedText): { blocks: string[]; mask: MaskedText } {
  let mask: MaskedText = base ?? { text: '', tokens: new Map(), kinds: [] };
  const hide = (value: string) => { mask = maskPersonal(value, mask); return mask.text; };
  const nodes = read.nodes.map((n): OutlineNode => n.kind === 'table' ? { ...n, rows: n.rows.map(row => row.map(hide)) }
    : n.kind === 'label' ? { ...n, label: hide(n.label), text: hide(n.text) } : { ...n, text: hide(n.text) });
  return { blocks: renderBlocks(nodes), mask };
}

/** The blocks as one Markdown document for the engine. */
export const documentMarkdown = (blocks: readonly string[]): string => blocks.join('\n\n').trim() + '\n';

/** What the user is told about a document typeset as written. */
export function documentManuscriptNotices(read: DocumentManuscript): string[] {
  return [
    ...(read.mergedCells ? [`병합된 표 칸 ${read.mergedCells}곳은 첫 칸에 내용을 두고 나머지 칸은 비웠습니다.`] : []),
    ...(read.multiParagraphCells ? [`여러 줄로 된 표 칸 ${read.multiParagraphCells}곳은 한 줄로 이었습니다.`] : []),
    ...(read.standIns ? [`기호 글꼴 문자 ${read.standIns}개는 서식 글꼴로 그릴 수 없어 〓로 표시했습니다.`] : []),
  ];
}
