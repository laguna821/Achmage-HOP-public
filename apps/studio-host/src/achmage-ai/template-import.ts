/**
 * '서식 추가하기': a Hangul file (.hwp/.hwpx) becomes a personal document template, read locally with no
 * AI. Every body and table-cell paragraph gets a role from its own formatting (the same classifier as
 * '서식만 바꾸기'), and each role takes the dominant font, size, weight, letter spacing, alignment and
 * line spacing of its paragraphs. Paper and orientation come from the first section. A role the file
 * does not show (no table, no heading) is derived from its body text, never invented elsewhere.
 */
import { HwpDocument } from '@wasm/rhwp.js';
import { BUILTIN_DOCUMENT_TEMPLATES, parseDocumentTemplate, templateLayout, type DocumentTemplate, type TemplateLayout, type TemplateRole, type TemplateStyle } from './document-templates';
import { classifyParagraphs, type ParagraphFeatures, type ParagraphRole } from './style-contract';

export type TemplateSource = Pick<HwpDocument,
  'getSectionCount' | 'getParagraphCount' | 'getParagraphLength' | 'getTextRange' | 'getCharPropertiesAt' | 'getParaPropertiesAt'
  | 'getControls' | 'getTableDimensions' | 'getCellInfo' | 'getCellParagraphCount' | 'getCellParagraphLength' | 'getTextInCell'
  | 'getCellCharPropertiesAt' | 'getCellParaPropertiesAt' | 'getStyleAt' | 'getPageDef' | 'getFieldList' | 'free'>;

export interface ImportedTemplate {
  template: DocumentTemplate;
  /** Roles whose look was read from the file; the others follow its body text. */
  measured: TemplateRole[];
  paragraphs: number;
  /** Named click-here fields: such a file can also be kept as a blank form pack. */
  formFields: number;
}

interface CharProps { fontFamily?: string; fontFamilies?: string[]; fontSize?: number; bold?: boolean; spacings?: number[] }
interface ParaProps { alignment?: string; lineSpacing?: number; lineSpacingType?: string; headType?: string; paraLevel?: number }
interface Control { list?: number; para?: number; ctrlId?: string; controlIndex?: number }
interface Sample { features: ParagraphFeatures; chars: CharProps[]; para: ParaProps }

const MAX_PARAGRAPHS = 4000;
const SAMPLES = 12;
/** HWPUNIT sizes (7200 per inch) of the papers a template can name, short side first. */
const PAPERS: [TemplateLayout['paper'], number, number][] = [['A4', 59528, 84189], ['A3', 84189, 119055], ['B4', 72852, 103181], ['B5', 51591, 72852], ['Letter', 61200, 79200]];

const fail = (message: string): never => { throw new Error(message); };
function json<T>(raw: string, fallback: T): T { try { return JSON.parse(raw) as T; } catch { return fallback; } }
function sampleOffsets(text: string): number[] {
  const visible = Array.from(text).flatMap((c, i) => /\s/u.test(c) ? [] : [i]);
  if (visible.length <= SAMPLES) return visible;
  return Array.from({ length: SAMPLES }, (_, k) => visible[Math.floor(k * visible.length / SAMPLES)]);
}
function mode<T>(values: readonly T[]): T | undefined {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
}
function sample(text: string, chars: CharProps[], para: ParaProps, extra: Partial<ParagraphFeatures>): Sample {
  const size = mode(chars.flatMap(c => typeof c.fontSize === 'number' ? [c.fontSize] : [])) ?? 1000;
  const family = mode(chars.flatMap(c => { const f = c.fontFamilies?.[0] ?? c.fontFamily; return f ? [f] : []; }));
  const features: ParagraphFeatures = { text, fontSizePt: size / 100, bold: chars.length > 0 && chars.every(c => c.bold === true), ...(family ? { fontFamily: family } : {}), alignment: para.alignment, headType: para.headType, paraLevel: para.paraLevel, ...extra };
  return { features, chars, para };
}

function readSamples(doc: TemplateSource): Sample[] {
  const controls = json<Control[]>(doc.getControls(), []), samples: Sample[] = [];
  let global = 0;
  for (let s = 0, sections = doc.getSectionCount(); s < sections; s++) {
    for (let p = 0, count = doc.getParagraphCount(s); p < count && samples.length < MAX_PARAGRAPHS; p++, global++) {
      const length = doc.getParagraphLength(s, p), text = length ? doc.getTextRange(s, p, 0, length) : '';
      if (text.trim()) {
        let styleName: string | undefined;
        try { styleName = json<{ name?: string }>(doc.getStyleAt(s, p), {}).name; } catch { styleName = undefined; }
        const chars = sampleOffsets(text).map(o => json<CharProps>(doc.getCharPropertiesAt(s, p, o), {}));
        samples.push(sample(text, chars, json<ParaProps>(doc.getParaPropertiesAt(s, p), {}), styleName ? { styleName } : {}));
      }
      for (const table of controls.filter(c => c.list === 0 && c.para === global && c.ctrlId === 'tbl' && typeof c.controlIndex === 'number')) {
        const ci = table.controlIndex!, dims = json<{ rowCount?: number; colCount?: number; cellCount?: number }>(doc.getTableDimensions(s, p, ci), {});
        // One-row or one-column tables are title boxes and bands, not data tables.
        if ((dims.rowCount ?? 0) < 2 || (dims.colCount ?? 0) < 2) continue;
        for (let cell = 0; cell < (dims.cellCount ?? 0) && samples.length < MAX_PARAGRAPHS; cell++) {
          const header = json<{ row?: number }>(doc.getCellInfo(s, p, ci, cell), {}).row === 0;
          for (let q = 0, n = doc.getCellParagraphCount(s, p, ci, cell); q < n; q++) {
            const cellLength = doc.getCellParagraphLength(s, p, ci, cell, q), cellText = cellLength ? doc.getTextInCell(s, p, ci, cell, q, 0, cellLength) : '';
            if (!cellText.trim()) continue;
            const chars = sampleOffsets(cellText).map(o => json<CharProps>(doc.getCellCharPropertiesAt(s, p, ci, cell, q, o), {}));
            samples.push(sample(cellText, chars, json<ParaProps>(doc.getCellParaPropertiesAt(s, p, ci, cell, q), {}), { cell: { header } }));
          }
        }
      }
    }
  }
  return samples;
}

const fontName = (name: string | undefined) => name?.replace(/["'<>;,`\\]/gu, '').trim().slice(0, 80) || undefined;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
function alignment(value: string | undefined): TemplateStyle['alignment'] | undefined {
  if (value === 'left' || value === 'center' || value === 'right' || value === 'justify') return value;
  return value === 'distribute' || value === 'split' ? 'justify' : undefined;
}
/** The look shared by a role's paragraphs: each property is its most common value. */
function lookOf(samples: readonly Sample[], fallback: TemplateStyle): TemplateStyle {
  const chars = samples.flatMap(s => s.chars);
  const size = mode(chars.flatMap(c => typeof c.fontSize === 'number' && c.fontSize > 0 ? [c.fontSize] : []));
  const family = fontName(mode(chars.flatMap(c => { const f = c.fontFamilies?.[0] ?? c.fontFamily; return f ? [f] : []; })));
  const spacing = mode(chars.flatMap(c => typeof c.spacings?.[0] === 'number' ? [c.spacings[0]] : []));
  const align = mode(samples.flatMap(s => { const a = alignment(s.para.alignment); return a ? [a] : []; }));
  const line = mode(samples.flatMap(s => s.para.lineSpacingType === 'Percent' && typeof s.para.lineSpacing === 'number' ? [s.para.lineSpacing] : []));
  const bold = samples.filter(s => s.features.bold).length * 2 > samples.length;
  return {
    fontFamily: family ?? fallback.fontFamily,
    fontSizePt: size === undefined ? fallback.fontSizePt : clamp(Math.round(size) / 100, 5, 72),
    bold,
    spacingPercent: spacing === undefined ? fallback.spacingPercent : clamp(Math.round(spacing), -50, 50),
    alignment: align ?? fallback.alignment,
    lineSpacingPercent: line === undefined ? fallback.lineSpacingPercent : clamp(Math.round(line), 50, 500),
  };
}
function paperOf(doc: TemplateSource): Pick<TemplateLayout, 'paper' | 'orientation'> {
  const page = json<{ width?: number; height?: number; landscape?: boolean }>(doc.getPageDef(0), {});
  const short = Math.min(page.width ?? 0, page.height ?? 0), long = Math.max(page.width ?? 0, page.height ?? 0);
  const paper = short > 0 ? [...PAPERS].sort((a, b) => Math.abs(a[1] - short) + Math.abs(a[2] - long) - Math.abs(b[1] - short) - Math.abs(b[2] - long))[0][0] : 'A4';
  return { paper, orientation: page.landscape === true || (page.width ?? 0) > (page.height ?? 0) ? 'landscape' : 'portrait' };
}

/** Reads the open source document; `fileName` names the new template. Nothing in the source changes. */
export function templateFromDocument(doc: TemplateSource, fileName: string): ImportedTemplate {
  const samples = readSamples(doc);
  if (!samples.some(s => !s.features.cell)) fail('문서에서 본문 글자를 찾지 못해 서식을 만들 수 없습니다.');
  const roles = classifyParagraphs(samples.map(s => s.features));
  const group = (wanted: readonly ParagraphRole[]) => {
    for (const role of wanted) { const members = samples.filter((_, i) => roles[i] === role); if (members.length) return members; }
    return [];
  };
  const base = BUILTIN_DOCUMENT_TEMPLATES.find(t => t.id === 'builtin-report') ?? BUILTIN_DOCUMENT_TEMPLATES[0];
  const bodySamples = group(['body', 'item', 'note']);
  const body = lookOf(bodySamples.length ? bodySamples : samples.filter(s => !s.features.cell), base.roles.body);
  const derived: Record<TemplateRole, TemplateStyle> = {
    title: { ...body, fontSizePt: Math.min(72, body.fontSizePt + 8), bold: true, alignment: 'center' },
    heading: { ...body, fontSizePt: Math.min(72, body.fontSizePt + 2), bold: true, alignment: 'left' },
    body,
    tableCell: { ...body, fontSizePt: Math.max(5, body.fontSizePt - 1), alignment: 'center', lineSpacingPercent: 130 },
    tableHeader: { ...body, fontSizePt: Math.max(5, body.fontSizePt - 1), bold: true, alignment: 'center', lineSpacingPercent: 130 },
  };
  const measured: TemplateRole[] = ['body'];
  const read = (role: TemplateRole, wanted: readonly ParagraphRole[]) => {
    const members = group(wanted);
    if (members.length) { derived[role] = lookOf(members, derived[role]); measured.push(role); }
  };
  read('title', ['title']);
  read('heading', ['heading1', 'heading2', 'heading3']);
  read('tableCell', ['tableCell']);
  if (!measured.includes('tableCell')) derived.tableHeader = { ...derived.tableHeader, fontFamily: derived.tableCell.fontFamily };
  read('tableHeader', ['tableHeader']);
  if (measured.includes('tableCell') && !measured.includes('tableHeader')) derived.tableHeader = { ...derived.tableCell, bold: true, alignment: 'center' };
  const stem = fileName.replace(/^.*[\\/]/u, '').replace(/\.(?:hwpx?|HWPX?)$/u, '').trim() || '가져온 문서';
  let name = '';
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(stem)) { if (name.length + segment.length > 75) break; name += segment; }
  const layout: TemplateLayout = { ...templateLayout(base), enginePreset: 'report', cover: false, toc: false, ...paperOf(doc) };
  delete layout.agency; delete layout.agencyRoleOverrides;
  const template = parseDocumentTemplate({
    schemaVersion: 1, id: 'custom-' + crypto.randomUUID(), name: `${name} 서식`, category: 'personal', provenance: 'personal',
    description: `'${fileName.replace(/^.*[\\/]/u, '').slice(0, 200)}'의 글꼴·크기·정렬·줄간격으로 만든 서식입니다. 표지·표 모양·머리말 같은 디자인은 가져오지 않습니다.`,
    roles: derived, layout,
  });
  const fields = json<unknown[]>(doc.getFieldList(), []);
  return { template, measured, paragraphs: samples.length, formFields: Array.isArray(fields) ? fields.length : 0 };
}

/** Opens the file in a throwaway engine instance, reads it and frees it. */
export function importTemplateFile(bytes: Uint8Array, fileName: string, open: (bytes: Uint8Array) => TemplateSource = b => new HwpDocument(b)): ImportedTemplate {
  if (!/\.hwpx?$/iu.test(fileName)) fail('한글 문서(.hwp, .hwpx)만 서식으로 가져올 수 있습니다.');
  let doc: TemplateSource;
  try { doc = open(bytes); } catch { return fail('이 한글 문서를 열지 못했습니다. 암호가 걸렸거나 손상된 문서는 서식으로 가져올 수 없습니다.'); }
  try { return templateFromDocument(doc, fileName); } finally { doc.free(); }
}
