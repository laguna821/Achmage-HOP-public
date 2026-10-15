/**
 * '서식만 바꾸기': restyles the open document in place, with no AI and no text change. Each body
 * paragraph and table-cell paragraph gets a role from its own formatting (style-contract.ts) and
 * takes that role's look from the template. Character changes are merged into each run's own shape
 * (rhwp find-or-create), so colors, underlines and highlights stay, shared shapes elsewhere stay,
 * and a second application adds no shapes. Pictures, fields, headers and footers, page numbers
 * and their restart values are never touched; the whole text and control list are checked after.
 */
import type { WasmBridge } from '@/upstream/core';
import type { DocumentTemplate } from './document-templates';
import { classifyParagraphs, describeRoles, roleLook, type ParagraphFeatures, type ParagraphRole, type RoleLook } from './style-contract';

interface ParaNow { alignment?: string; lineSpacing?: number; lineSpacingType?: string }
export type RestyleTarget =
  | { kind: 'body'; section: number; paragraph: number; length: number; para: ParaNow; anchorsObjects: boolean }
  | { kind: 'cell'; section: number; paragraph: number; control: number; cell: number; cellParagraph: number; length: number; para: ParaNow };
export interface RestylePlan { targets: RestyleTarget[]; roles: ParagraphRole[]; kept: { frontMatter: number; layoutTables: number; nestedTables: number } }
export interface RestyleResult { paragraphs: number; summary: string; kept: RestylePlan['kept'] }

/** Controls that only set up the page or numbering: reformatting their paragraph moves nothing. */
const LAYOUT = new Set(['secd', 'cold', 'pgnp', 'nwno', 'pghd', 'head', 'foot']);
const MAX_TARGETS = 50_000;
const SAMPLES = 24;
type CharProps = ReturnType<WasmBridge['getCharPropertiesAt']>;
type Run = { startOffset: number; endOffset: number; charShapeId: number };
/** Engine calls the bridge does not wrap: run-level shape ids and the batch that defers pagination. */
interface EngineHandle { getTextFileUnicode(): string; getCharShapeRuns(s: number, p: number, start: number, end: number): string; setCharShapeRuns(s: number, p: number, start: number, end: number, runs: string): string; beginBatch(): string; endBatch(): string }
const paraNow = (p: ParaNow): ParaNow => ({ alignment: p.alignment, lineSpacing: p.lineSpacing, lineSpacingType: p.lineSpacingType });

const fail = (message: string): never => { throw new Error(message); };
function ok(raw: string): void { let parsed: { ok?: unknown }; try { parsed = JSON.parse(raw); } catch { return; } if (parsed.ok === false) fail('서식 적용이 거부되었습니다.'); }

/** Evenly spread offsets of visible characters (whitespace says nothing about a paragraph's look). */
function sampleOffsets(text: string): number[] {
  const visible = Array.from(text).flatMap((c, i) => /\s/u.test(c) ? [] : [i]);
  if (visible.length <= SAMPLES) return visible;
  return Array.from({ length: SAMPLES }, (_, k) => visible[Math.floor(k * visible.length / SAMPLES)]);
}
function featuresFrom(text: string, props: readonly CharProps[], extra: Partial<ParagraphFeatures>): ParagraphFeatures {
  const sizes = new Map<number, number>();
  for (const p of props) if (typeof p.fontSize === 'number') sizes.set(p.fontSize, (sizes.get(p.fontSize) ?? 0) + 1);
  const size = [...sizes].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? 1000;
  const families = new Map<string, number>();
  for (const p of props) { const family = p.fontFamilies?.[0] ?? p.fontFamily; if (family) families.set(family, (families.get(family) ?? 0) + 1); }
  const fontFamily = [...families].sort((a, b) => b[1] - a[1])[0]?.[0];
  return { text, fontSizePt: size / 100, bold: props.length > 0 && props.every(p => p.bold === true), ...(fontFamily ? { fontFamily } : {}), ...extra };
}

/**
 * Reads the document (no mutation) and assigns every body and table-cell paragraph a role.
 * Designed parts keep their look: everything before the first page-number restart in the first
 * section (cover, table of contents), one-row or one-column tables (title boxes, chapter bands),
 * tables nested in cells, text boxes, headers and footers, and blank lines.
 */
export function planRestyle(wasm: WasmBridge): RestylePlan {
  if (wasm.pageCount === 0) fail('열린 문서가 없습니다.');
  const controls = wasm.getControls(), targets: RestyleTarget[] = [], features: ParagraphFeatures[] = [];
  // Only a restart within the first three pages marks a cover/contents; a later one (붙임, appendix) does not.
  const pageOf = (para: number) => { try { return (JSON.parse((wasm.borrowDocumentHandle() as unknown as { getCursorRect(s: number, p: number, o: number): string }).getCursorRect(0, para, 0)) as { pageIndex?: number }).pageIndex; } catch { return undefined; } };
  const restart = controls.find(c => c.list === 0 && c.ctrlId === 'nwno' && c.para > 0 && c.para < wasm.getParagraphCount(0) && (pageOf(c.para) ?? Infinity) <= 2);
  const kept = { frontMatter: restart?.para ?? 0, layoutTables: 0, nestedTables: controls.filter(c => c.ctrlId === 'tbl' && c.list !== 0).length };
  let global = 0;
  for (let s = 0, sections = wasm.getSectionCount(); s < sections; s++) {
    for (let p = 0, count = wasm.getParagraphCount(s); p < count; p++, global++) {
      if (s === 0 && p < kept.frontMatter) continue;
      const local = controls.filter(c => c.list === 0 && c.para === global);
      const length = wasm.getParagraphLength(s, p), text = length ? wasm.getTextRange(s, p, 0, length) : '';
      if (text.trim()) {
        const offsets = sampleOffsets(text), para = wasm.getParaPropertiesAt(s, p);
        let styleName: string | undefined;
        try { styleName = wasm.getStyleAt(s, p).name; } catch { styleName = undefined; }
        targets.push({ kind: 'body', section: s, paragraph: p, length, para: paraNow(para), anchorsObjects: local.some(c => !LAYOUT.has(c.ctrlId)) });
        features.push(featuresFrom(text, offsets.map(o => wasm.getCharPropertiesAt(s, p, o)), { alignment: para.alignment, headType: para.headType, paraLevel: para.paraLevel, styleName }));
      }
      for (const table of local.filter(c => c.ctrlId === 'tbl')) {
        const dims = wasm.getTableDimensions(s, p, table.controlIndex);
        if (dims.rowCount < 2 || dims.colCount < 2) { kept.layoutTables++; continue; }
        for (let cell = 0; cell < dims.cellCount; cell++) {
          const header = dims.rowCount > 1 && wasm.getCellInfo(s, p, table.controlIndex, cell).row === 0;
          for (let q = 0, n = wasm.getCellParagraphCount(s, p, table.controlIndex, cell); q < n; q++) {
            const args = [s, p, table.controlIndex, cell, q] as const;
            const cellLength = wasm.getCellParagraphLength(...args), cellText = cellLength ? wasm.getTextInCell(...args, 0, cellLength) : '';
            if (!cellText.trim()) continue;
            const cellOffsets = sampleOffsets(cellText);
            targets.push({ kind: 'cell', section: s, paragraph: p, control: table.controlIndex, cell, cellParagraph: q, length: cellLength, para: paraNow(wasm.getCellParaPropertiesAt(...args)) });
            features.push(featuresFrom(cellText, cellOffsets.map(o => wasm.getCellCharPropertiesAt(...args, o)), { cell: { header } }));
          }
        }
      }
      if (targets.length > MAX_TARGETS) fail(`문단이 ${MAX_TARGETS}개를 넘는 문서는 아직 한 번에 서식을 바꾸지 않습니다.`);
    }
  }
  return { targets, roles: classifyParagraphs(features, { allowTitle: kept.frontMatter === 0 }), kept };
}

function engine(wasm: WasmBridge): EngineHandle {
  const handle = wasm.borrowDocumentHandle() as unknown as Partial<EngineHandle> | null;
  const needed: (keyof EngineHandle)[] = ['getTextFileUnicode', 'getCharShapeRuns', 'setCharShapeRuns', 'beginBatch', 'endBatch'];
  if (!handle || needed.some(name => typeof handle[name] !== 'function')) fail('문서 엔진이 서식 바꾸기를 지원하지 않습니다.');
  return handle as EngineHandle;
}
function invariants(wasm: WasmBridge, handle: EngineHandle): string {
  const counts = Array.from({ length: wasm.getSectionCount() }, (_, s) => wasm.getParagraphCount(s));
  return JSON.stringify([handle.getTextFileUnicode(), wasm.getControls(), counts]);
}

/** Applies the plan. The caller wraps this in one snapshot command, so a throw leaves nothing behind. */
export function executeRestyle(wasm: WasmBridge, plan: RestylePlan, template: Pick<DocumentTemplate, 'roles'>): RestyleResult {
  const handle = engine(wasm), before = invariants(wasm, handle), fontIds = new Map<string, number[]>();
  const ids = (family: string) => { let found = fontIds.get(family); if (!found) { found = Array.from({ length: 7 }, (_, lang) => wasm.findOrCreateFontIdForLang(lang, family)); fontIds.set(family, found); } return found; };
  const charMods = (look: RoleLook) => JSON.stringify({ fontIds: ids(look.fontFamily), fontSize: Math.round(look.fontSizePt * 100), spacings: Array(7).fill(look.spacingPercent), ...(look.bold === undefined ? {} : { bold: look.bold }) });
  /** Only what differs: a paragraph already in the template's alignment and spacing is not touched. */
  const paraMods = (look: RoleLook, role: ParagraphRole, now: ParaNow) => {
    const mods: Record<string, unknown> = {};
    // Centered or right-aligned text (dates, signatures, "끝.") was aligned on purpose; only the
    // title and captions take their template alignment regardless.
    const deliberate = now.alignment === 'center' || now.alignment === 'right';
    if (look.alignment && look.alignment !== now.alignment && (!deliberate || role === 'title' || role === 'caption')) mods.alignment = look.alignment;
    if (look.lineSpacingPercent && (now.lineSpacing !== look.lineSpacingPercent || now.lineSpacingType !== 'Percent')) { mods.lineSpacing = look.lineSpacingPercent; mods.lineSpacingType = 'Percent'; }
    return Object.keys(mods).length ? JSON.stringify(mods) : null;
  };
  // Body character formats: the first paragraph with a given (shape, role) pays for applyCharFormat,
  // which repaginates; every later one reuses the resulting shape id through setCharShapeRuns,
  // which waits for the single pagination at the end of the batch.
  const shapes = new Map<string, number>();
  const bodyChars = (section: number, paragraph: number, length: number, chars: string) => {
    const runs = JSON.parse(handle.getCharShapeRuns(section, paragraph, 0, length)) as Run[];
    const mapped = runs.map(r => shapes.get(r.charShapeId + '\u0000' + chars));
    if (mapped.every(id => id !== undefined)) {
      if (mapped.some((id, k) => id !== runs[k].charShapeId)) ok(handle.setCharShapeRuns(section, paragraph, 0, length, JSON.stringify(runs.map((r, k) => ({ ...r, charShapeId: mapped[k] })))));
      return;
    }
    ok(wasm.applyCharFormat(section, paragraph, 0, length, chars));
    const after = JSON.parse(handle.getCharShapeRuns(section, paragraph, 0, length)) as Run[];
    for (const r of runs) { const hit = after.find(a => a.startOffset <= r.startOffset && r.startOffset < a.endOffset); if (hit) shapes.set(r.charShapeId + '\u0000' + chars, hit.charShapeId); }
  };
  handle.beginBatch();
  try {
    plan.targets.forEach((target, i) => {
      const role = plan.roles[i], look = roleLook(template, role), chars = charMods(look), para = paraMods(look, role, target.para);
      if (target.kind === 'body') {
        if (target.length) bodyChars(target.section, target.paragraph, target.length, chars);
        // Alignment of a paragraph that anchors a table or picture would move the object.
        if (para && !target.anchorsObjects) ok(wasm.applyParaFormat(target.section, target.paragraph, para));
      } else {
        const args = [target.section, target.paragraph, target.control, target.cell, target.cellParagraph] as const;
        if (target.length) ok(wasm.applyCharFormatInCell(...args, 0, target.length, chars));
        if (para) ok(wasm.applyParaFormatInCell(...args, para));
      }
    });
  } finally { handle.endBatch(); }
  if (invariants(wasm, handle) !== before) fail('서식을 바꾸는 중 본문이나 개체가 달라져 취소했습니다.');
  return { paragraphs: plan.targets.length, summary: describeRoles(plan.roles), kept: plan.kept };
}
