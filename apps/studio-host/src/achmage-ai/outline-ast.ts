/**
 * Lenient drafts → one outline. People (and models) write structure many ways: Markdown, □ ○ - ·
 * drafts, 1. 가. 1) numbering, "라벨: 내용" lines, PDF text broken mid-sentence, pipe or tab tables.
 * This reads all of them into the same small tree, which then becomes Kordoc Markdown or a
 * structured edit plan. The syntax here is our own; nothing is copied from other products.
 */
export type OutlineNode =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'item'; level: number; text: string }
  | { kind: 'label'; label: string; text: string }
  | { kind: 'note'; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'table'; rows: string[][] };

/** Marker → nominal depth. Symbol drafts (□ ○ - ·) and official numbering (1. 가. 1) 가) …) share depths. */
const MARKERS: { pattern: RegExp; depth: number }[] = [
  { pattern: /^[□■ㅁ]\s*/u, depth: 1 },
  { pattern: /^[○◦●o]\s+/u, depth: 2 },
  { pattern: /^[-–−]\s+/u, depth: 3 },
  { pattern: /^[·•∙*+]\s+/u, depth: 4 },
  { pattern: /^\d{1,2}\.\s+/u, depth: 1 },
  { pattern: /^[가-하]\.\s+/u, depth: 2 },
  { pattern: /^\d{1,2}\)\s+/u, depth: 3 },
  { pattern: /^[가-하]\)\s+/u, depth: 4 },
  { pattern: /^\(\d{1,2}\)\s*/u, depth: 5 },
  { pattern: /^\([가-하]\)\s*/u, depth: 6 },
  { pattern: /^[①-⑳]\s*/u, depth: 7 },
];
const SENTENCE_END = /(?:[.!?。…:)\]」』"'”’]|[다요음함임됨것]\s*)$/u;
/** "라벨: 내용" — but never the colon of a URL scheme ("https://"). */
const LABEL = /^([가-힣A-Za-z][가-힣A-Za-z ·]{0,11})\s*[:：](?!\/\/)\s*(\S.*)$/u;

function marker(line: string): { depth: number; text: string } | null {
  for (const { pattern, depth } of MARKERS) {
    const m = pattern.exec(line);
    if (m && line.length > m[0].length) return { depth, text: line.slice(m[0].length).trim() };
  }
  return null;
}
/** The line starts with a list marker (□ ○ - ·, 1. 가. 1) …) followed by text. */
export const hasListMarker = (line: string): boolean => marker(line.trim()) !== null;
/** Which marker family a line uses (□ is 1, ○ is 2, 1. is 1, 가. is 2 …), or null. */
export const listMarkerDepth = (line: string): number | null => marker(line.trim())?.depth ?? null;
const indentOf = (raw: string) => { const m = /^[ \t]*/.exec(raw)![0]; return Array.from(m).reduce((n, c) => n + (c === '\t' ? 2 : 1), 0); };
const cells = (line: string) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
const isSeparator = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

export function parseOutline(input: string): OutlineNode[] {
  const lines = input.replace(/\r\n?/g, '\n').split('\n');
  const nodes: OutlineNode[] = [];
  let i = 0;
  const lastText = (): { text: string } | null => { const last = nodes[nodes.length - 1]; return last && (last.kind === 'paragraph' || last.kind === 'item' || last.kind === 'note') ? last : null; };
  while (i < lines.length) {
    const raw = lines[i], line = raw.trim();
    if (!line) { i++; nodes.push({ kind: 'paragraph', text: '' }); continue; }
    // Tables: a run of pipe rows, or of tab-separated rows with the same column count.
    if (line.includes('|') && cells(line).length >= 2) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { if (!isSeparator(lines[i])) rows.push(cells(lines[i])); i++; }
      if (rows.length >= 1) { const width = Math.max(...rows.map(r => r.length)); nodes.push({ kind: 'table', rows: rows.map(r => [...r, ...Array(width - r.length).fill('')]) }); continue; }
    }
    if (raw.includes('\t') && raw.trim().split('\t').length >= 2) {
      const width = raw.trim().split('\t').length, rows: string[][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].trim().split('\t').length === width) { rows.push(lines[i].trim().split('\t').map(c => c.trim())); i++; }
      if (rows.length >= 2) { nodes.push({ kind: 'table', rows }); continue; }
      i -= rows.length;
    }
    i++;
    const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
    if (heading) { nodes.push({ kind: 'heading', level: Math.min(heading[1].length, 3) as 1 | 2 | 3, text: heading[2].trim() }); continue; }
    if (/^※/u.test(line)) { nodes.push({ kind: 'note', text: line.replace(/^※\s*/u, '') }); continue; }
    const item = marker(line);
    if (item) { nodes.push({ kind: 'item', level: item.depth * 10 + indentOf(raw), text: item.text }); continue; }
    const label = LABEL.exec(line);
    if (label && !/^https?$/i.test(label[1].trim())) { nodes.push({ kind: 'label', label: label[1].trim(), text: label[2].trim() }); continue; }
    // A line broken in the middle of a sentence (PDF copy) continues the previous text.
    const previous = lastText();
    if (previous && previous.text && !SENTENCE_END.test(previous.text)) { previous.text += (/[A-Za-z0-9]$/.test(previous.text) && /^[A-Za-z0-9]/.test(line) ? ' ' : ' ') + line; continue; }
    nodes.push({ kind: 'paragraph', text: line });
  }
  // Depths (marker depth × 10 + indent) become consecutive levels 1, 2, 3 … in order of appearance.
  const used = [...new Set(nodes.flatMap(n => n.kind === 'item' ? [n.level] : []))].sort((a, b) => a - b);
  const result = nodes.map(n => n.kind === 'item' ? { ...n, level: used.indexOf(n.level) + 1 } : n);
  // Blank lines only separate; they are not content.
  return result.filter((n, index, all) => !(n.kind === 'paragraph' && !n.text && (index === 0 || index === all.length - 1 || all[index - 1].kind === 'paragraph' && !(all[index - 1] as { text: string }).text)))
    .filter(n => !(n.kind === 'paragraph' && !n.text));
}

/** A selection is worth normalizing when it has visible structure beyond plain paragraphs. */
export function looksLikeDraft(nodes: readonly OutlineNode[]): boolean {
  const items = nodes.filter(n => n.kind === 'item').length, labels = nodes.filter(n => n.kind === 'label').length;
  return nodes.some(n => n.kind === 'table' || n.kind === 'heading') || items >= 2 || labels >= 2;
}

/**
 * Text read from a document, not written as Markdown: every character Kordoc would act on is escaped, so
 * "2024. 10. 15." stays a date, "a|b" stays in one table cell and "*", "~~" or "[…](…)" stay as typed.
 * Measured on Kordoc 4.21.31: it removes these backslashes but keeps one before "&", and reads "&amp;" as
 * text, so "&" is left alone.
 */
export function literalMarkdown(text: string): string {
  return text.replace(/[\\`*_[\]<>~|]/g, '\\$&').replace(/^(\d+)([.)])/, '$1\\$2').replace(/^([#>+-])/, '\\$1');
}

/** Each node as one Kordoc Markdown block (# title, ## chapters, ### sections, nested lists, real tables). */
export function outlineBlocks(nodes: readonly OutlineNode[], options: { literal?: boolean } = {}): string[] {
  const t = options.literal ? literalMarkdown : (text: string) => text;
  const titleUsed = nodes.filter(n => n.kind === 'heading' && n.level === 1).length === 1;
  return nodes.map(n => {
    if (n.kind === 'heading') return `${'#'.repeat(titleUsed ? n.level : n.level + 1)} ${t(n.text)}`;
    if (n.kind === 'item') return `${'  '.repeat(n.level - 1)}- ${t(n.text)}`;
    if (n.kind === 'label') return `- ${t(n.label)}: ${t(n.text)}`;
    if (n.kind === 'note') return `※ ${t(n.text)}`;
    if (n.kind === 'paragraph') return t(n.text);
    const [head, ...body] = n.rows, row = (r: string[]) => `| ${r.map(t).join(' | ')} |`;
    return [row(head), `|${head.map(() => ' --- ').join('|')}|`, ...body.map(row)].join('\n');
  });
}

/** Kordoc Markdown: # title, ## chapters, ### sections, nested lists, real tables. */
export function outlineToMarkdown(nodes: readonly OutlineNode[], options: { literal?: boolean } = {}): string {
  return outlineBlocks(nodes, options).join('\n\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

export interface OutlineStyles { title: StyleSpec; heading: StyleSpec; body: StyleSpec; tableHeader: StyleSpec; tableCell: StyleSpec }
export interface StyleSpec { fontFamily: string; fontSizePt: number; bold: boolean; spacingPercent: number }
const ITEM_MARKERS = ['□', '○', '-', '·', '-', '·', '·'];

/**
 * A structured edit plan (schema v2) for the current document: headings and items become real
 * paragraphs with role styles, tables become real tables. Indentation is shown with the official
 * marker of each level until the style contract (T08) supplies paragraph indents.
 */
export function outlineToPlan(nodes: readonly OutlineNode[], styles: OutlineStyles, lineSpacingPercent = 160): unknown {
  const paragraph = (text: string, style: keyof OutlineStyles, alignment: 'left' | 'center' = 'left') => ({ type: 'paragraph', runs: [{ text, style }], paragraphFormat: { alignment, lineSpacingPercent } });
  const cell = (text: string, style: 'tableHeader' | 'tableCell') => ({ runs: [{ text: text || ' ', style }], paragraphFormat: { alignment: style === 'tableHeader' ? 'center' : 'left', lineSpacingPercent: 130 } });
  const blocks = nodes.map((n, index) => {
    if (n.kind === 'heading') return paragraph(n.text, n.level === 1 && index === 0 ? 'title' : 'heading', n.level === 1 && index === 0 ? 'center' : 'left');
    if (n.kind === 'item') return paragraph(`${'  '.repeat(n.level - 1)}${ITEM_MARKERS[Math.min(n.level, ITEM_MARKERS.length) - 1]} ${n.text}`, 'body');
    if (n.kind === 'label') return paragraph(`${n.label}: ${n.text}`, 'body');
    if (n.kind === 'note') return paragraph(`※ ${n.text}`, 'body');
    if (n.kind === 'paragraph') return paragraph(n.text, 'body');
    return { type: 'table', rows: n.rows.map((row, r) => row.map(text => cell(text, r === 0 ? 'tableHeader' : 'tableCell'))) };
  });
  return { schemaVersion: 2, operation: 'replace_paragraphs', styles, blocks };
}
