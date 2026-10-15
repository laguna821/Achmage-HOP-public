/**
 * One role contract for every path that formats text: Kordoc generation, structured edits, the
 * inline draft tidy and the in-place restyle. Content decides a paragraph's role; the template
 * decides how that role looks. Template roles (title, heading, body, tableHeader, tableCell) come
 * from document-templates.ts; the finer paragraph roles below always resolve to one of them.
 */
import { TEMPLATE_ROLES, type DocumentTemplate, type TemplateRole, type TemplateStyle } from './document-templates';
import { hasListMarker, listMarkerDepth } from './outline-ast';

export type ParagraphRole = 'title'|'heading1'|'heading2'|'heading3'|'body'|'item'|'note'|'caption'|'tableHeader'|'tableCell';
export const PARAGRAPH_ROLE_LABELS: Record<ParagraphRole, string> = {
  title: '제목', heading1: '소제목 1', heading2: '소제목 2', heading3: '소제목 3', body: '본문', item: '항목', note: '주석', caption: '캡션', tableHeader: '표 머리글', tableCell: '표 본문',
};
/** The template role whose values a paragraph role takes. */
export const TEMPLATE_ROLE_OF: Record<ParagraphRole, TemplateRole> = {
  title: 'title', heading1: 'heading', heading2: 'heading', heading3: 'heading', body: 'body', item: 'body', note: 'body', caption: 'body', tableHeader: 'tableHeader', tableCell: 'tableCell',
};

export interface RunStyle { fontFamily: string; fontSizePt: number; bold: boolean; spacingPercent: number }
/** Character values of every template role: the `styles` block of structured plans and outline plans. */
export function contractStyles(template: Pick<DocumentTemplate, 'roles'>): Record<TemplateRole, RunStyle> {
  return Object.fromEntries(TEMPLATE_ROLES.map(role => {
    const s = template.roles[role];
    return [role, { fontFamily: s.fontFamily, fontSizePt: s.fontSizePt, bold: s.bold, spacingPercent: s.spacingPercent }];
  })) as Record<TemplateRole, RunStyle>;
}

/** Roles built from a document's own body font when no template is chosen (the inline draft tidy). */
export function documentBaseRoles(fontFamily: string, bodyPt: number): Pick<DocumentTemplate, 'roles'> {
  const style = (fontSizePt: number, bold: boolean, alignment: TemplateStyle['alignment'], lineSpacingPercent: number): TemplateStyle => ({ fontFamily, fontSizePt: Math.max(5, Math.min(72, fontSizePt)), bold, spacingPercent: 0, alignment, lineSpacingPercent });
  return { roles: { title: style(bodyPt + 5, true, 'center', 160), heading: style(bodyPt + 2, true, 'left', 160), body: style(bodyPt, false, 'justify', 160), tableHeader: style(bodyPt - 1, true, 'center', 130), tableCell: style(bodyPt - 1, false, 'left', 130) } };
}

/**
 * How a paragraph role looks. `bold`, `alignment` or `lineSpacingPercent` left undefined means
 * "keep what the paragraph has": body text keeps its own emphasis, table cells keep their alignment
 * (numbers stay right-aligned) and line spacing.
 */
export interface RoleLook { fontFamily: string; fontSizePt: number; spacingPercent: number; bold?: boolean; alignment?: TemplateStyle['alignment']; lineSpacingPercent?: number }
export function roleLook(template: Pick<DocumentTemplate, 'roles'>, role: ParagraphRole): RoleLook {
  const r = template.roles, body = r.body, heading = r.heading;
  const look = (s: TemplateStyle, extra: Partial<RoleLook> = {}): RoleLook => ({ fontFamily: s.fontFamily, fontSizePt: s.fontSizePt, spacingPercent: s.spacingPercent, bold: s.bold, alignment: s.alignment, lineSpacingPercent: s.lineSpacingPercent, ...extra });
  const smaller = (s: TemplateStyle, by: number) => Math.max(body.fontSizePt, s.fontSizePt - by);
  switch (role) {
    case 'title': return look(r.title);
    case 'heading1': return look(heading);
    case 'heading2': return look(heading, { fontSizePt: smaller(heading, 1) });
    case 'heading3': return look(heading, { fontSizePt: smaller(heading, 2) });
    case 'body': case 'item': return look(body, { bold: undefined });
    case 'note': return look(body, { bold: undefined, fontSizePt: Math.max(8, body.fontSizePt - 1), alignment: undefined });
    case 'caption': return look(body, { bold: undefined, fontSizePt: Math.max(8, body.fontSizePt - 1), alignment: 'center' });
    case 'tableHeader': return look(r.tableHeader, { lineSpacingPercent: undefined });
    case 'tableCell': return look(r.tableCell, { bold: undefined, alignment: undefined, lineSpacingPercent: undefined });
  }
}

/** What the restyle reads from one paragraph. Facts only; the classifier below assigns the role. */
export interface ParagraphFeatures {
  text: string;
  /** Dominant character size of the visible text. */
  fontSizePt: number;
  /** Every sampled visible character is bold. */
  bold: boolean;
  /** Dominant font family of the visible text, when known. */
  fontFamily?: string;
  alignment?: string;
  headType?: string;
  paraLevel?: number;
  styleName?: string;
  /** Inside a table cell; `header` for the first row of a table with more than one row. */
  cell?: { header: boolean };
}

const CAPTION = /^[<〈《［\[(]?\s*(?:표|그림|사진|도표|도|Table|Figure|Fig\.)\s*[\d０-９]+(?:[-.]\d+)?/u;
const NOTE = /^(?:※|\*\s|주\s*\)|\(주\))/u;
const CHAPTER = /^(?:제\s*\d+\s*[장절편부]|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+\s*[.．]|[IVX]{1,4}\s*[.．])/u;
/** A sentence ends in punctuation or a predicate; a short noun ending in 요/음 ("개요", "사업 개요") is not one. */
const sentence = (text: string, visible: number) => /[.!?。]$/u.test(text) || /다$/u.test(text) || visible > 12 && /[요음함임됨]$/u.test(text);
const LABEL_LINE = /^[가-힣A-Za-z][가-힣A-Za-z ·]{0,11}\s*[:：](?!\/\/)\s*\S/u;
const OUTLINE_STYLE = /^(?:개요|outline|제목|heading)\s*(\d+)/iu;

function bodyFamilyOf(items: readonly ParagraphFeatures[], size: number): string | undefined {
  const weights = new Map<string, number>();
  for (const f of items) { const n = f.text.replace(/\s+/gu, '').length; if (!f.cell && f.fontFamily && f.fontSizePt === size && n >= 15) weights.set(f.fontFamily, (weights.get(f.fontFamily) ?? 0) + n); }
  return [...weights].sort((a, b) => b[1] - a[1])[0]?.[0];
}
function bodySizeOf(items: readonly ParagraphFeatures[]): number {
  const weights = new Map<number, number>();
  const add = (f: ParagraphFeatures, min: number) => { const n = f.text.replace(/\s+/gu, '').length; if (!f.cell && n >= min) weights.set(f.fontSizePt, (weights.get(f.fontSizePt) ?? 0) + n); };
  for (const f of items) add(f, 15);
  if (!weights.size) for (const f of items) add(f, 1);
  return [...weights].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? 10;
}

/**
 * Roles from formatting facts: outline levels and style names first, then size and weight relative
 * to the document's own body text, then list markers. Nothing here reads the meaning of the words.
 */
export function classifyParagraphs(items: readonly ParagraphFeatures[], options: { allowTitle?: boolean } = {}): ParagraphRole[] {
  const body = bodySizeOf(items), bodyFamily = bodyFamilyOf(items, body);
  // A document whose cover was kept already has its title there.
  const firstContent = options.allowTitle === false ? -1 : items.findIndex(f => !f.cell && f.text.trim());
  const roles: ParagraphRole[] = [];
  const headingLevel = new Map<number, number>();
  items.forEach((f, i) => {
    const text = f.text.trim(), visible = text.replace(/\s+/gu, '').length;
    if (f.cell) { roles.push(f.cell.header || f.bold ? 'tableHeader' : 'tableCell'); return; }
    if (!visible) { roles.push('body'); return; }
    if (visible <= 80 && CAPTION.test(text)) { roles.push('caption'); return; }
    if (NOTE.test(text)) { roles.push('note'); return; }
    const styleLevel = OUTLINE_STYLE.exec(f.styleName ?? '')?.[1];
    const outline = f.headType === 'Outline' ? (f.paraLevel ?? 0) + 1 : styleLevel ? Number(styleLevel) : 0;
    const short = visible <= 40 && !sentence(text, visible);
    if (i === firstContent && f.alignment === 'center' && visible <= 80 && !sentence(text, visible)) { roles.push('title'); return; }
    if (outline) { roles.push('heading1'); headingLevel.set(i, Math.min(3, outline)); return; }
    // "담당자: 홍길동" and right-aligned lines (signatures, dates) are never headings.
    const distinct = f.bold || f.fontSizePt >= body + 1 || !!(f.fontFamily && bodyFamily && f.fontFamily !== bodyFamily);
    if (short && !LABEL_LINE.test(text) && f.alignment !== 'right' && (distinct || CHAPTER.test(text))) { roles.push('heading1'); return; }
    roles.push(hasListMarker(text) || f.headType === 'Number' || f.headType === 'Bullet' ? 'item' : 'body');
  });
  // Lines of one list family that look alike are one role: if any of them is an item, all are.
  const family = (i: number) => { const depth = listMarkerDepth(items[i].text); return depth === null || items[i].cell ? null : `${depth}|${items[i].fontSizePt}|${items[i].bold}|${items[i].fontFamily ?? ''}`; };
  const itemFamilies = new Set(roles.flatMap((r, i) => r === 'item' || r === 'body' ? [family(i)] : []).filter(Boolean));
  roles.forEach((r, i) => { if (r === 'heading1' && !headingLevel.has(i) && itemFamilies.has(family(i))) roles[i] = 'item'; });
  // Headings without an outline level rank by size: the largest becomes level 1.
  const sizes = [...new Set(roles.flatMap((r, i) => r === 'heading1' && !headingLevel.has(i) ? [items[i].fontSizePt] : []))].sort((a, b) => b - a);
  return roles.map((r, i) => {
    if (r !== 'heading1') return r;
    const level = headingLevel.get(i) ?? Math.min(3, sizes.indexOf(items[i].fontSizePt) + 1);
    return (['heading1', 'heading2', 'heading3'] as const)[level - 1];
  });
}

/** "제목 1 · 소제목 4 · 본문 12 · 표 머리글 3" for the result message. */
export function describeRoles(roles: readonly ParagraphRole[]): string {
  const counts = new Map<string, number>();
  for (const r of roles) { const label = r.startsWith('heading') ? '소제목' : PARAGRAPH_ROLE_LABELS[r]; counts.set(label, (counts.get(label) ?? 0) + 1); }
  return [...counts].map(([label, n]) => `${label} ${n}`).join(' · ');
}
