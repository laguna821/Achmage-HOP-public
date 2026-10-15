// HanMark template looks for the Kordoc engine.
// Ported from HanMark 2.7.0 (Achmage, commit 3db078d7): src/io/documentStyle.ts,
// gongmunStyle.ts, gongmunOutline.ts, hwpxFinish.ts and hwpxPostProcess.ts.
// A "look" keeps Kordoc's own layout for a document type and adds only what the
// institution form or the document style changes; it never flattens every paragraph
// to one role style.
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { measureTextWidth, simulateWrap, normalizeGongmunPreset } from 'kordoc';

const fail = (m) => { throw Error(m); };
const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
function cleanText(value, max = 80) {
 if (typeof value !== 'string') return undefined;
 const cleaned = Array.from(value, c => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c)).join('').replace(/\s+/gu, ' ').trim().slice(0, max);
 return cleaned && !/[<>"';,\\]/u.test(cleaned) ? cleaned : undefined;
}
function bounded(value, min, max, integer = false) {
 if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) return undefined;
 return integer ? Math.round(value) : Math.round(value * 100) / 100;
}
const color = (v) => (typeof v === 'string' && /^#[0-9A-F]{6}$/iu.test(v.trim()) ? v.trim().toUpperCase() : undefined);
const oneOf = (v, allowed) => (typeof v === 'string' && allowed.includes(v) ? v : undefined);
const bool = (v) => (typeof v === 'boolean' ? v : undefined);
function compact(value) { for (const k of Object.keys(value)) if (value[k] === undefined) delete value[k]; return Object.keys(value).length ? value : undefined; }
function onlyKeys(value, keys, label) { if (!isRecord(value) || Object.keys(value).some(k => !keys.includes(k))) fail(label + ' 서식 값을 확인하세요.'); return value; }

// ---------------------------------------------------------------- look schema
export const GONGMUN_PRESETS = ['official', 'report', 'plan', 'notice', 'minutes', 'gaejosik', 'press', 'ministry', 'bangchim'];
const ROLE_KEYS = ['body', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'quote', 'code', 'list'];
const ALIGNMENTS = ['LEFT', 'CENTER', 'RIGHT', 'JUSTIFY', 'DISTRIBUTE', 'DISTRIBUTE_SPACE'];
const MARKER_KEYS = ['legal1', 'legal2', 'legal3', 'legal4', 'legal5', 'legal6', 'legal7', 'box0', 'box1', 'box2', 'box3'];
export const NUMBERED_PAREN = '{n})';

function normalizeCharacter(input) {
 if (input === undefined) return undefined;
 const c = onlyKeys(input, ['fontFamily', 'latinFontFamily', 'fontSizePt', 'bold', 'italic', 'underline', 'color', 'widthPercent', 'letterSpacingPercent'], '글자');
 return compact({ fontFamily: cleanText(c.fontFamily), latinFontFamily: cleanText(c.latinFontFamily), fontSizePt: bounded(c.fontSizePt, 4, 100), bold: bool(c.bold), italic: bool(c.italic), underline: bool(c.underline), color: color(c.color), widthPercent: bounded(c.widthPercent, 50, 200, true), letterSpacingPercent: bounded(c.letterSpacingPercent, -50, 50, true) });
}
function normalizeParagraph(input) {
 if (input === undefined) return undefined;
 const p = onlyKeys(input, ['alignment', 'lineSpacingPercent', 'firstLineIndentHu', 'marginLeftHu', 'marginRightHu', 'spaceBeforeHu', 'spaceAfterHu', 'keepWithNext'], '문단');
 return compact({ alignment: oneOf(p.alignment, ALIGNMENTS), lineSpacingPercent: bounded(p.lineSpacingPercent, 70, 400, true), firstLineIndentHu: bounded(p.firstLineIndentHu, -100000, 100000, true), marginLeftHu: bounded(p.marginLeftHu, 0, 100000, true), marginRightHu: bounded(p.marginRightHu, 0, 100000, true), spaceBeforeHu: bounded(p.spaceBeforeHu, 0, 100000, true), spaceAfterHu: bounded(p.spaceAfterHu, 0, 100000, true), keepWithNext: bool(p.keepWithNext) });
}
function normalizePage(input) {
 if (input === undefined) return undefined;
 const p = onlyKeys(input, ['widthHu', 'heightHu', 'landscape', 'gutterType', 'margins'], '쪽');
 const m = onlyKeys(p.margins, ['top', 'bottom', 'left', 'right', 'header', 'footer', 'gutter'], '쪽 여백');
 const page = { widthHu: bounded(p.widthHu, 10000, 200000, true), heightHu: bounded(p.heightHu, 10000, 200000, true), landscape: oneOf(p.landscape, ['WIDELY', 'NARROWLY']), gutterType: oneOf(p.gutterType, ['LEFT_ONLY', 'LEFT_RIGHT', 'TOP_BOTTOM']), margins: {} };
 for (const k of ['top', 'bottom', 'left', 'right', 'header', 'footer', 'gutter']) page.margins[k] = bounded(m[k], 0, 100000, true);
 if (!page.widthHu || !page.heightHu || ['top', 'bottom', 'left', 'right'].some(k => page.margins[k] === undefined) || page.margins.left + page.margins.right >= page.widthHu || page.margins.top + page.margins.bottom >= page.heightHu) fail('쪽 크기와 여백을 확인하세요.');
 compact(page.margins); if (!page.landscape) delete page.landscape; if (!page.gutterType) delete page.gutterType;
 return page;
}
function normalizeProfile(input) {
 if (input === undefined) return undefined;
 const p = onlyKeys(input, ['roles', 'page'], '문서 스타일');
 const rolesIn = onlyKeys(p.roles, ROLE_KEYS, '문서 스타일 역할'), roles = {};
 for (const role of ROLE_KEYS) {
  if (rolesIn[role] === undefined) continue;
  const r = onlyKeys(rolesIn[role], ['styleName', 'character', 'paragraph'], '문서 스타일 역할');
  const value = compact({ styleName: cleanText(r.styleName), character: normalizeCharacter(r.character), paragraph: normalizeParagraph(r.paragraph) });
  if (value) roles[role] = value;
 }
 if (!Object.keys(roles).length) fail('문서 스타일에 역할 서식이 없습니다.');
 return compact({ roles, page: normalizePage(p.page) });
}
function normalizeOptions(input) {
 const o = onlyKeys(input ?? {}, ['bodyFont', 'bodyPt', 'lineSpacing', 'numbering', 'bullet2', 'h2Marker', 'bandColor', 'bandTextColor', 'fonts', 'levels', 'margins', 'pageNumbers', 'endMark', 'suppressSingle', 'autoFit', 'centerTitle'], '공문 서식');
 const fonts = o.fonts === undefined ? undefined : onlyKeys(o.fonts, ['body', 'heading', 'ref', 'table'], '공문 글꼴');
 let levels;
 if (o.levels !== undefined) {
  levels = {};
  for (const [key, raw] of Object.entries(onlyKeys(o.levels, ['0', '1', '2', '3'], '항목 단계'))) { const l = onlyKeys(raw, ['font', 'pt', 'bold'], '항목 단계'); const v = compact({ font: cleanText(l.font, 40), pt: bounded(l.pt, 6, 60), bold: bool(l.bold) }); if (v) levels[key] = v; }
 }
 let margins;
 if (o.margins !== undefined) { const m = onlyKeys(o.margins, ['top', 'bottom', 'left', 'right'], '용지 여백'); margins = { top: bounded(m.top, 5, 60), bottom: bounded(m.bottom, 5, 60), left: bounded(m.left, 5, 60), right: bounded(m.right, 5, 60) }; if (Object.values(margins).some(v => v === undefined)) fail('용지 여백을 확인하세요.'); }
 return compact({ bodyFont: oneOf(o.bodyFont, ['myeongjo', 'gothic']), bodyPt: bounded(o.bodyPt, 8, 24), lineSpacing: bounded(o.lineSpacing, 100, 250, true), numbering: oneOf(o.numbering, ['standard', 'report', 'gaejosik']), bullet2: oneOf(o.bullet2, ['ㅇ', '○', '◦', '❍']), h2Marker: oneOf(o.h2Marker, ['band', 'roman', 'box', 'number', 'none', 'square']), bandColor: color(o.bandColor), bandTextColor: color(o.bandTextColor), fonts: fonts && compact({ body: cleanText(fonts.body, 40), heading: cleanText(fonts.heading, 40), ref: cleanText(fonts.ref, 40), table: cleanText(fonts.table, 40) }), levels: levels && compact(levels), margins, pageNumbers: bool(o.pageNumbers), endMark: bool(o.endMark), suppressSingle: bool(o.suppressSingle), autoFit: bool(o.autoFit), centerTitle: bool(o.centerTitle) }) ?? {};
}
function normalizeFinish(input) {
 if (input === undefined) return undefined;
 const f = onlyKeys(input, ['markers', 'tableHeader', 'title', 'chapter', 'cover'], '기관 서식 마감');
 let markers;
 if (f.markers !== undefined) { markers = {}; for (const [k, v] of Object.entries(onlyKeys(f.markers, MARKER_KEYS, '항목 부호'))) { if (typeof v !== 'string' || !v || v.length > 4 || /[<>&"\s]/u.test(v)) fail('항목 부호를 확인하세요.'); markers[k] = v; } }
 const th = f.tableHeader === undefined ? undefined : onlyKeys(f.tableHeader, ['fill', 'textColor'], '표 머리행');
 const title = f.title === undefined ? undefined : onlyKeys(f.title, ['pt', 'bold', 'font'], '제목');
 const chapter = f.chapter === undefined ? undefined : onlyKeys(f.chapter, ['pt', 'bold', 'blankLineBefore'], '장 제목');
 const cover = f.cover === undefined ? undefined : onlyKeys(f.cover, ['removeInfoBox', 'removeBodyTitle', 'barColors', 'linePt', 'lineBold'], '표지');
 if (th && (!color(th.fill) || !color(th.textColor))) fail('표 머리행 색을 확인하세요.');
 if (cover?.barColors !== undefined && (!Array.isArray(cover.barColors) || cover.barColors.length !== 2 || cover.barColors.some(c => !color(c)))) fail('표지 선 색을 확인하세요.');
 return compact({
  markers: markers && compact(markers),
  tableHeader: th && { fill: color(th.fill), textColor: color(th.textColor) },
  title: title && compact({ pt: bounded(title.pt, 6, 60), bold: bool(title.bold), font: oneOf(title.font, ['body']) }),
  chapter: chapter && compact({ pt: bounded(chapter.pt, 6, 60), bold: bool(chapter.bold), blankLineBefore: bool(chapter.blankLineBefore) }),
  cover: cover && compact({ removeInfoBox: bool(cover.removeInfoBox), removeBodyTitle: bool(cover.removeBodyTitle), barColors: cover.barColors?.map(color), linePt: bounded(cover.linePt, 6, 60), lineBold: bool(cover.lineBold) })
 });
}
/** Validated copy of a template look; unknown keys fail. */
export function normalizeLook(value) {
 const look = onlyKeys(value, ['kind', 'profile', 'preset', 'options', 'finish', 'outline', 'coverDate', 'quietEngineNotes'], '템플릿');
 if (look.kind === 'document') {
  onlyKeys(look, ['kind', 'profile'], '문서 스타일');
  return compact({ kind: 'document', profile: normalizeProfile(look.profile) });
 }
 if (look.kind !== 'gongmun') fail('템플릿 서식 종류를 확인하세요.');
 const preset = oneOf(look.preset, GONGMUN_PRESETS) ?? fail('공문 종류를 확인하세요.');
 const outline = look.outline === undefined ? undefined : onlyKeys(look.outline, ['nestChapterLists', 'boldSubHeadings'], '개요');
 const quiet = look.quietEngineNotes === undefined ? undefined : (Array.isArray(look.quietEngineNotes) && look.quietEngineNotes.length <= 8 ? look.quietEngineNotes.map(n => (typeof n === 'string' && n.length <= 80 ? n : fail('엔진 안내 목록을 확인하세요.'))) : fail('엔진 안내 목록을 확인하세요.'));
 return compact({ kind: 'gongmun', preset, options: normalizeOptions(look.options), finish: normalizeFinish(look.finish), outline: outline && compact({ nestChapterLists: bool(outline.nestChapterLists), boldSubHeadings: bool(outline.boldSubHeadings) }), coverDate: oneOf(look.coverDate, ['month', 'day']), quietEngineNotes: quiet });
}
/** Font families a look declares (for disclosure; Kordoc preset fonts are reported from the result). */
export function lookDeclaredFonts(look) {
 const found = new Set();
 const visit = (v, key) => { if (typeof v === 'string' && ['fontFamily', 'latinFontFamily', 'font', 'body', 'heading', 'ref', 'table'].includes(key)) found.add(v); else if (isRecord(v)) for (const [k, x] of Object.entries(v)) if (k !== 'finish') visit(x, k); };
 visit(look.kind === 'document' ? look.profile ?? {} : { fonts: look.options?.fonts ?? {}, levels: look.options?.levels ?? {} }, '');
 return [...found].map(canonicalFace).sort();
}

// ---------------------------------------------------------------- shared XML helpers
const SCRIPT_KEYS = ['hangul', 'latin', 'hanja', 'japanese', 'other', 'symbol', 'user'];
const SCRIPT_LANGUAGE = { hangul: 'HANGUL', latin: 'LATIN', hanja: 'HANJA', japanese: 'JAPANESE', other: 'OTHER', symbol: 'SYMBOL', user: 'USER' };
const HH_NS = 'http://www.hancom.co.kr/hwpml/2011/head';
const localName = (n) => n.localName || n.nodeName.split(':').pop();
const elements = (root, name) => Array.from(root.getElementsByTagName('*')).filter(e => localName(e) === name);
const direct = (root, name) => Array.from(root.childNodes ?? []).filter(n => n.nodeType === 1 && (!name || localName(n) === name));
const first = (root, name) => elements(root, name)[0];
function parse(xml, label) {
 if (/<!DOCTYPE|<!ENTITY/i.test(xml)) fail('XML 선언은 지원하지 않습니다.');
 return new DOMParser({ onError: (level, message) => { if (level !== 'warning') fail(label + ' XML을 읽지 못했습니다: ' + message); } }).parseFromString(xml.replace(/^﻿/u, ''), 'text/xml');
}
const serialize = (doc) => new XMLSerializer().serializeToString(doc);
/** HanMark writes 신명조 as Hancom's face name and fixes a common spacing typo. */
export function canonicalFace(family) {
 const normalized = family.replace(/\s+/g, ' ').trim();
 if (normalized === '신명조') return '한양신명조';
 if (normalized === '맑은고딕') return '맑은 고딕';
 return normalized;
}

// ---------------------------------------------------------------- document styles (documentStyle.ts)
function configuredFontfaces(header) {
 const groups = elements(header, 'fontface');
 return SCRIPT_KEYS.flatMap(script => { const group = groups.find(g => (g.getAttribute('lang') ?? '').toUpperCase() === SCRIPT_LANGUAGE[script]); return group ? [{ script, group }] : []; });
}
function clonedFont(header, template, id, family) {
 const font = template ? template.cloneNode(true) : header.createElementNS(HH_NS, 'hh:font');
 font.setAttribute('id', String(id)); font.setAttribute('face', family); font.setAttribute('type', 'TTF'); font.setAttribute('isEmbedded', '0'); font.removeAttribute('embeddedBinaryItemIDRef');
 return font;
}
/** One shared font id in every script table, so Hancom's style dialog sees one font (not "?"). */
function ensureUnifiedFont(header, rawFamily) {
 const family = canonicalFace(rawFamily), configured = configuredFontfaces(header);
 if (!configured.length) fail('글꼴 표가 없습니다.');
 const key = family.toLocaleLowerCase();
 const common = configured.map(({ group }) => new Set(direct(group, 'font').filter(f => (f.getAttribute('face') ?? '').trim().toLocaleLowerCase() === key).map(f => f.getAttribute('id'))))
  .reduce((ids, current, index) => (index === 0 ? [...current] : ids.filter(id => current.has(id))), []);
 if (common.length) return common.sort((a, b) => Number(a) - Number(b))[0];
 const commonId = Math.max(-1, ...configured.flatMap(({ group }) => direct(group, 'font').map(f => Number(f.getAttribute('id'))).filter(Number.isFinite))) + 1;
 const familyTemplate = configured.flatMap(({ group }) => direct(group, 'font')).find(f => (f.getAttribute('face') ?? '').trim().toLocaleLowerCase() === key);
 for (const { group } of configured) {
  let fonts = direct(group, 'font');
  let next = Math.max(-1, ...fonts.map(f => Number(f.getAttribute('id'))).filter(Number.isFinite)) + 1;
  while (next < commonId) { const filler = fonts[0] ?? familyTemplate; group.appendChild(clonedFont(header, filler, next, filler?.getAttribute('face') || '함초롬바탕')); fonts = direct(group, 'font'); next++; }
  group.appendChild(clonedFont(header, familyTemplate ?? fonts[0], commonId, family));
  group.setAttribute('fontCnt', String(direct(group, 'font').length));
 }
 return String(commonId);
}
function setFlag(doc, el, name, enabled) {
 if (enabled === undefined) return;
 for (const c of direct(el, name)) el.removeChild(c);
 el.removeAttribute(name);
 if (!enabled) return;
 el.setAttribute(name, '1'); el.appendChild(doc.createElementNS(HH_NS, 'hh:' + name));
}
function setUnderline(doc, el, enabled) {
 if (enabled === undefined) return;
 for (const c of direct(el, 'underline')) el.removeChild(c);
 if (!enabled) return;
 const u = doc.createElementNS(HH_NS, 'hh:underline'); u.setAttribute('type', 'BOTTOM'); u.setAttribute('shape', 'SOLID'); u.setAttribute('color', el.getAttribute('textColor') || '#000000'); el.appendChild(u);
}
function applyCharacter(header, charPr, style, forced) {
 if (!charPr || !style) return;
 if (style.fontSizePt !== undefined) charPr.setAttribute('height', String(Math.round(style.fontSizePt * 100)));
 if (style.color) charPr.setAttribute('textColor', style.color);
 const fontRef = first(charPr, 'fontRef');
 if (fontRef && style.fontFamily) {
  const main = ensureUnifiedFont(header, style.fontFamily), latinFamily = style.latinFontFamily || style.fontFamily;
  const latin = canonicalFace(latinFamily).toLocaleLowerCase() === canonicalFace(style.fontFamily).toLocaleLowerCase() ? main : ensureUnifiedFont(header, latinFamily);
  for (const s of SCRIPT_KEYS) fontRef.setAttribute(s, s === 'latin' || s === 'other' ? latin : main);
 }
 const ratio = first(charPr, 'ratio'); if (ratio && style.widthPercent !== undefined) for (const s of SCRIPT_KEYS) ratio.setAttribute(s, String(style.widthPercent));
 const spacing = first(charPr, 'spacing'); if (spacing && style.letterSpacingPercent !== undefined) for (const s of SCRIPT_KEYS) spacing.setAttribute(s, String(style.letterSpacingPercent));
 setFlag(header, charPr, 'bold', forced?.bold ?? style.bold);
 setFlag(header, charPr, 'italic', forced?.italic ?? style.italic);
 setUnderline(header, charPr, style.underline);
}
function setMargin(margin, name, value) { if (!margin || value === undefined) return; const c = direct(margin, name)[0]; if (c) c.setAttribute('value', String(Math.round(value))); }
function applyParagraph(paraPr, style) {
 if (!paraPr || !style) return;
 const align = first(paraPr, 'align'); if (align && style.alignment) align.setAttribute('horizontal', style.alignment);
 // Kordoc writes the line spacing twice (hp:switch case/default); both must change.
 if (style.lineSpacingPercent !== undefined) for (const l of elements(paraPr, 'lineSpacing')) { l.setAttribute('type', 'PERCENT'); l.setAttribute('value', String(style.lineSpacingPercent)); }
 for (const margin of elements(paraPr, 'margin')) {
  setMargin(margin, 'intent', style.firstLineIndentHu); setMargin(margin, 'left', style.marginLeftHu); setMargin(margin, 'right', style.marginRightHu);
  setMargin(margin, 'prev', style.spaceBeforeHu); setMargin(margin, 'next', style.spaceAfterHu);
 }
 const brk = first(paraPr, 'breakSetting'); if (brk && style.keepWithNext !== undefined) brk.setAttribute('keepWithNext', style.keepWithNext ? '1' : '0');
}
function applyPage(section, page) {
 if (!page) return;
 const pagePr = first(section, 'pagePr'), margin = pagePr ? first(pagePr, 'margin') : undefined;
 if (!pagePr || !margin) return;
 pagePr.setAttribute('width', String(page.widthHu)); pagePr.setAttribute('height', String(page.heightHu));
 if (page.landscape) pagePr.setAttribute('landscape', page.landscape);
 if (page.gutterType) pagePr.setAttribute('gutterType', page.gutterType);
 for (const k of ['top', 'bottom', 'left', 'right', 'header', 'footer', 'gutter']) if (page.margins[k] !== undefined) margin.setAttribute(k, String(page.margins[k]));
}
const nextNumericId = (items) => Math.max(-1, ...items.map(i => Number(i.getAttribute('id'))).filter(Number.isFinite)) + 1;
/** Kordoc draws h5/h6 like h4; a token on those lines lets them get their own style (markExtendedHeadings). */
export function markExtendedHeadings(markdown, profile) {
 if (!profile?.roles.h5 && !profile?.roles.h6) return { markdown, markers: [] };
 let nonce = 'HOP_EXTENDED_HEADING'; while (markdown.includes(nonce)) nonce += '_';
 const markers = []; let fence = null;
 const lines = markdown.split(/\r?\n/).map(line => {
  const f = /^\s*(`{3,}|~{3,})/.exec(line);
  if (f) { if (!fence) fence = f[1][0]; else if (fence === f[1][0]) fence = null; return line; }
  if (fence) return line;
  const m = /^(\s{0,3})(#{5,6})([ \t]+)(.*)$/.exec(line);
  if (!m || !profile.roles['h' + m[2].length]) return line;
  const token = `${nonce}_${m[2].length}_${markers.length}`;
  markers.push({ token, level: m[2].length });
  return `${m[1]}${m[2]}${m[3]}${token}${m[4]}`;
 });
 return { markdown: lines.join('\n'), markers };
}
function ancestor(el, name) { let n = el; while (n) { if (n.nodeType === 1 && localName(n) === name) return n; n = n.parentNode; } return undefined; }
/** Applies a HanMark document style to Kordoc's stable role ids (charPr 0-3 body, 4 code, 5-8 h1-h4, 10 quote; paraPr 0 body, 1-4 h1-h4, 5 code, 6 quote, 7 list). */
export function applyDocumentStyleXml(headerXml, sectionXml, profile, markers = []) {
 const header = parse(headerXml, 'header'), section = parse(sectionXml, 'section');
 const charPrs = new Map(elements(header, 'charPr').map(e => [Number(e.getAttribute('id')), e]));
 const paraPrs = new Map(elements(header, 'paraPr').map(e => [Number(e.getAttribute('id')), e]));
 if (![0, 1, 2, 3, 5, 6, 7, 8].every(id => charPrs.has(id)) || ![0, 1, 2, 3, 4].every(id => paraPrs.has(id))) fail('문서 엔진의 기본 스타일 번호가 달라 문서 스타일을 적용하지 못했습니다.');
 const body = profile.roles.body;
 if (body) {
  applyCharacter(header, charPrs.get(0), body.character);
  applyCharacter(header, charPrs.get(1), body.character, { bold: true, italic: body.character?.italic });
  applyCharacter(header, charPrs.get(2), body.character, { bold: body.character?.bold, italic: true });
  applyCharacter(header, charPrs.get(3), body.character, { bold: true, italic: true });
  applyParagraph(paraPrs.get(0), body.paragraph);
 }
 for (const [role, charId, paraId] of [['h1', 5, 1], ['h2', 6, 2], ['h3', 7, 3], ['h4', 8, 4], ['code', 4, 5], ['quote', 10, 6], ['list', 0, 7]]) {
  const style = profile.roles[role]; if (!style) continue;
  if (role !== 'list') applyCharacter(header, charPrs.get(charId), style.character);
  applyParagraph(paraPrs.get(paraId), style.paragraph);
 }
 // h5/h6: own charPr/paraPr cloned from h4.
 const charProps = first(header, 'charProperties'), paraProps = first(header, 'paraProperties'), extended = new Map();
 let charId = nextNumericId([...charPrs.values()]), paraId = nextNumericId([...paraPrs.values()]);
 for (const level of [5, 6]) {
  const style = profile.roles['h' + level]; if (!style) continue;
  const c = charPrs.get(8).cloneNode(true); c.setAttribute('id', String(charId)); applyCharacter(header, c, style.character); charProps.appendChild(c);
  const p = paraPrs.get(4).cloneNode(true); p.setAttribute('id', String(paraId)); const h = first(p, 'heading'); if (h) { h.setAttribute('type', 'OUTLINE'); h.setAttribute('level', String(level - 1)); }
  applyParagraph(p, style.paragraph); paraProps.appendChild(p);
  extended.set(level, { charId, paraId, styleId: level }); charId++; paraId++;
 }
 charProps.setAttribute('itemCnt', String(direct(charProps, 'charPr').length)); paraProps.setAttribute('itemCnt', String(direct(paraProps, 'paraPr').length));
 const texts = elements(section, 't');
 for (const marker of markers) {
  const matches = texts.filter(t => (t.textContent || '').includes(marker.token));
  const resource = extended.get(marker.level);
  if (matches.length !== 1 || !resource) fail('제목 ' + marker.level + ' 위치를 확인하지 못했습니다.');
  matches[0].textContent = (matches[0].textContent || '').replace(marker.token, '');
  const p = ancestor(matches[0], 'p'); if (!p) fail('제목 문단을 찾지 못했습니다.');
  p.setAttribute('paraPrIDRef', String(resource.paraId)); p.setAttribute('styleIDRef', String(resource.styleId));
  for (const r of elements(p, 'run')) r.setAttribute('charPrIDRef', String(resource.charId));
 }
 // Named styles (바탕글, 제목 1-6) so Hancom's F6 shows the template's style names.
 const styles = first(header, 'styles');
 if (styles) {
  const existing = new Map(direct(styles, 'style').map(s => [s.getAttribute('id'), s]));
  const named = (id, name, engName, paraRef, charRef) => {
   let s = existing.get(String(id)); if (!s) { s = header.createElementNS(HH_NS, 'hh:style'); styles.appendChild(s); }
   for (const [k, v] of [['id', String(id)], ['type', 'PARA'], ['name', name], ['engName', engName], ['paraPrIDRef', String(paraRef)], ['charPrIDRef', String(charRef)], ['nextStyleIDRef', '0'], ['langID', '1042'], ['lockForm', '0']]) s.setAttribute(k, v);
   s.removeAttribute('langIDRef');
  };
  if (body) named(0, body.styleName || '바탕글', 'Normal', 0, 0);
  for (let level = 1; level <= 6; level++) {
   const style = profile.roles['h' + level]; if (!style) continue;
   const res = level <= 4 ? { charId: 4 + level, paraId: level } : extended.get(level); if (!res) continue;
   named(level, style.styleName || `제목 ${level}`, `Heading ${level}`, res.paraId, res.charId);
  }
  styles.setAttribute('itemCnt', String(direct(styles, 'style').length));
  for (const p of elements(section, 'p')) { const id = Number(p.getAttribute('paraPrIDRef')); if (id >= 1 && id <= 4 && profile.roles['h' + id]) p.setAttribute('styleIDRef', String(id)); }
 }
 applyPage(section, profile.page);
 return { header: serialize(header), section: serialize(section) };
}

// ---------------------------------------------------------------- official documents (gongmunStyle.ts)
/** A date as official documents write it: "2026. 9." or "2026. 9. 29.". */
export function officialDate(day, format = 'day') { const month = `${day.getFullYear()}. ${day.getMonth() + 1}.`; return format === 'month' ? month : `${month} ${day.getDate()}.`; }
/**
 * Kordoc options for a look: Kordoc's preset defaults < the look's options < the template's
 * cover/toc choice. Per-type frame (HanMark R-025): draft letters get their head/foot tables,
 * notices 15 pt/160 % and a closing date, minutes 14 pt/130 %, plans a cover.
 */
export function resolveGongmunOptions(look, layout, today = new Date()) {
 const preset = look.preset, options = { ...structuredClone(look.options ?? {}), preset };
 options.cover = layout.cover; if (layout.toc) options.toc = true;
 let closing;
 switch (preset) {
  case 'official': options.docHead = {}; options.docFoot = {}; break;
  case 'notice': options.bodyPt ??= 15; options.lineSpacing ??= 160; delete options.cover; closing = { date: officialDate(today) }; break;
  case 'minutes': options.bodyPt ??= 14; options.lineSpacing ??= 130; break;
  default: break;
 }
 if (options.cover && preset !== 'press') {
  const format = look.coverDate ?? (preset === 'report' || preset === 'plan' ? 'month' : undefined);
  if (format) options.cover = { date: officialDate(today, format) };
 }
 return { options, closing };
}

// ---------------------------------------------------------------- heading outline (gongmunOutline.ts)
const PRESET_NUMBERING = { official: 'standard', report: 'report', plan: 'report', notice: 'standard', minutes: 'standard', gaejosik: 'gaejosik', press: 'report', ministry: 'report', bangchim: 'report' };
const BOX_MARKER_RE = /^([□■❑❏ㅁ○ㅇ◦●❍◎\-–―—ㅡ‣▪▫ㆍ·•∙])\s+/u;
const LEADING_MARKER_RE = /^(?:※|＊|\*(?=\s)|[□■❑❏ㅁ○ㅇ◦●❍◎\-–―—ㅡ‣▪▫ㆍ·•∙]\s|(?:\d{1,2}\.|[가-힣]\.|\d{1,2}\)|[가-힣]\)|\(\d{1,2}\)|\([가-힣]\)|[①-⑳]|[㉮-㉻])\s)/u;
const HEADING_NUMBER_RE = /^(?:[□■❑❏ㅁ○ㅇ◦●❍◎\-–―—ㅡ‣▪▫ㆍ·•∙]|\d{1,2}\.|[가-힣]\.|\d{1,2}\)|[가-힣]\)|\(\d{1,2}\)|\([가-힣]\)|[①-⑳]|[㉮-㉻])\s+/u;
const ATTACH_RE = /^붙\s*임(?:\s|:|$)/u, SOURCE_RE = /^(?:출처|자료|근거|참고)\s*[:：]/u;
const FENCE_RE = /^\s*(`{3,}|~{3,})/, HEADING_RE = /^(\s{0,3})(#{1,6})(?:([ \t]+)(.*?))?[ \t]*$/, LIST_ITEM_RE = /^\s*(?:[-*+]|\d{1,9}[.)])[ \t]+(.*)$/, RULE_RE = /^\s{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const MAX_LEVEL = 6, KEY_LENGTH = 24, MIN_KEY_LENGTH = 2;
/** Letters and digits only, so quotes, spaces and inline marks do not matter. */
export const paragraphSignature = (text) => text.normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
function scanLines(markdown) {
 const lines = markdown.split(/\r?\n/), headings = [], bodyTexts = []; let fence = null;
 lines.forEach((line, index) => {
  const f = FENCE_RE.exec(line);
  if (f) { if (!fence) fence = f[1][0]; else if (fence === f[1][0]) fence = null; return; }
  if (fence) return;
  const h = HEADING_RE.exec(line);
  if (h) { headings.push({ index, level: h[2].length, indent: h[1], gap: h[3] ?? ' ', text: h[4] ?? '' }); return; }
  const trimmed = line.trim(); if (!trimmed || trimmed.startsWith('>') || trimmed.startsWith('|')) return;
  const item = LIST_ITEM_RE.exec(line); bodyTexts.push((item ? item[1] : trimmed).trim());
 });
 return { lines, headings, bodyTexts };
}
const usesLegalNumbering = (markdown, preset, numbering) => (numbering ?? PRESET_NUMBERING[preset]) === 'standard' && !scanLines(markdown).bodyTexts.some(t => BOX_MARKER_RE.test(t));
const visibleText = (md) => md.replace(/!\[\[[^\]]*\]\]/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[\^[^\]]+\]/g, '').replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<[^>]+>/g, '');
const startsBlock = (line) => { const t = line.trim(); return LIST_ITEM_RE.test(line) || RULE_RE.test(line) || /^[>|<]/.test(t) || /^\[\^[^\]]+\]:/.test(t); };
function isPlainParagraph(text) { const lead = text.replace(/^[\s　]+/u, ''); if (!lead || LEADING_MARKER_RE.test(lead) || ATTACH_RE.test(lead) || SOURCE_RE.test(lead)) return false; return paragraphSignature(visibleText(lead)).length >= MIN_KEY_LENGTH; }
function paragraphHints(lines, levels, titleIndex) {
 const hints = []; let fence = null, formula = false, depth = -1;
 lines.forEach((line, index) => {
  const f = FENCE_RE.exec(line);
  if (fence || f) { if (f) { if (!fence) fence = f[1][0]; else if (fence === f[1][0]) fence = null; } return; }
  const trimmed = line.trim();
  if (formula || trimmed.startsWith('$$')) { const marks = (trimmed.match(/\$\$/g) ?? []).length; if (formula ? marks > 0 : marks === 1) formula = !formula; return; }
  const level = levels.get(index);
  if (level !== undefined) { if (index !== titleIndex) depth = level <= 2 ? 0 : Math.min(level - 3, 7); return; }
  if (!trimmed || startsBlock(line) || !isPlainParagraph(trimmed)) return;
  hints.push({ key: paragraphSignature(visibleText(trimmed)).slice(0, KEY_LENGTH), depth: depth >= 0 ? depth + 1 : 0 });
 });
 return hints;
}
const LINK_RE = /\[((?:\\.|[^\]\\])*)\]\(([^)]*)\)/g, ESCAPE_RE = /\\([\\`*_{}[\]()#+\-.!|<>~$])/g;
/** Words of inline Markdown as a frame prints them. */
export function plainInline(text) {
 const literals = [];
 const out = text.replace(ESCAPE_RE, (_a, c) => { literals.push(c); return `${literals.length - 1}`; })
  .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/`([^`]*)`/g, '$1')
  .replace(/(\*\*\*|___)(.+?)\1/g, '$2').replace(/(\*\*|__)(.+?)\1/g, '$2').replace(/(^|[^\w*])\*(?=\S)([^*]+?)\*(?!\w)/g, '$1$2').replace(/(^|[^\w_])_(?=\S)([^_]+?)_(?!\w)/g, '$1$2').replace(/~~(.+?)~~/g, '$1');
 return out.replace(/(\d+)/g, (_a, i) => literals[Number(i)] ?? '');
}
function boldInline(text) {
 if (/[*_]/.test(text.replace(LINK_RE, (_a, w) => w))) return text;
 const bold = (s) => { const w = s.trim(); return w ? s.replace(w, `**${w}**`) : s; };
 let out = '', last = 0;
 for (const m of text.matchAll(LINK_RE)) { out += bold(text.slice(last, m.index)) + `[**${m[1]}**](${m[2]})`; last = m.index + m[0].length; }
 return (out + bold(text.slice(last))).trim();
}
function drawnInFrame(level, legal, o) {
 if (o.preset === 'ministry') return true;
 if (level > 2 || legal) return false;
 if (o.preset === 'gaejosik') return true;
 return (o.preset === 'report' || o.preset === 'plan' || o.preset === 'bangchim') && (o.h2Marker ?? 'band') === 'band';
}
function firstQuoteRun(lines, levels) {
 let i = lines.findIndex((_l, p) => levels.get(p) === 1); i = i < 0 ? 0 : i + 1;
 while (i < lines.length && !lines[i].trim()) i++;
 return i < lines.length && /^\s*>/.test(lines[i]) ? i : -1;
}
function plainSummary(lines, levels) {
 let i = firstQuoteRun(lines, levels), changed = false; if (i < 0) return false;
 for (; i < lines.length && /^\s*>/.test(lines[i]); i++) { const q = /^(\s*>\s?)(.*)$/.exec(lines[i]); if (!q) break; const plain = q[1] + plainInline(q[2]); if (plain !== lines[i]) { lines[i] = plain; changed = true; } }
 return changed;
}
function splitQuotes(lines, keep) {
 const out = []; let fence = null, i = 0;
 while (i < lines.length) {
  const line = lines[i], f = FENCE_RE.exec(line);
  if (fence || f) { if (f) { if (!fence) fence = f[1][0]; else if (fence === f[1][0]) fence = null; } out.push(line); i++; continue; }
  if (!/^\s*>/.test(line)) { out.push(line); i++; continue; }
  const start = i, run = []; while (i < lines.length && /^\s*>/.test(lines[i])) run.push(lines[i++]);
  if (start === keep) { out.push(...run); continue; }
  run.map(q => /^(\s*>\s?)(.*)$/.exec(q)).filter(m => m && m[2].trim()).map(m => m[1] + m[2].replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s+/, ''))
   .forEach((note, p) => { if (p > 0) out.push('>'); out.push(note); });
 }
 return out;
}
function nestChapterLists(lines, levels, titleIndex) {
 let fence = null, under = false, changed = false;
 lines.forEach((line, index) => {
  const f = FENCE_RE.exec(line);
  if (fence || f) { if (f) { if (!fence) fence = f[1][0]; else if (fence === f[1][0]) fence = null; } return; }
  const level = levels.get(index);
  if (level !== undefined) { if (index !== titleIndex) under = level <= 2; return; }
  if (under && LIST_ITEM_RE.test(line)) { lines[index] = '  ' + line; changed = true; }
 });
 return changed;
}
/** Rewrites heading markers so Kordoc draws a consistent outline (HanMark R-024). */
export function prepareGongmunMarkdown(markdown, o) {
 const { lines, headings } = scanLines(markdown), legal = usesLegalNumbering(markdown, o.preset, o.numbering);
 const levels = new Map(headings.map(h => [h.index, h.level]));
 const h1 = headings.filter(h => h.level === 1), titleIsLeadingH1 = h1.length === 1 && headings[0]?.level === 1;
 if (h1.length > 1 || (h1.length === 1 && !titleIsLeadingH1)) for (const h of headings) levels.set(h.index, Math.min(h.level + 1, MAX_LEVEL));
 const titleIndex = titleIsLeadingH1 ? headings[0].index : -1;
 const body = headings.filter(h => h.index !== titleIndex);
 const hasChapters = body.some(h => (levels.get(h.index) ?? 0) <= 2);
 const subLevels = [...new Set(body.map(h => levels.get(h.index) ?? 0).filter(l => l > 2))].sort((a, b) => a - b);
 const firstSub = legal && hasChapters ? 4 : 3, rank = new Map(subLevels.map((l, p) => [l, Math.min(firstSub + p, MAX_LEVEL)]));
 for (const h of body) { const l = levels.get(h.index) ?? h.level; if (l > 2) levels.set(h.index, rank.get(l) ?? l); }
 const dropNumbers = o.preset === 'gaejosik' || o.boldSubHeadings === true, output = [...lines];
 for (const h of headings) {
  const level = levels.get(h.index) ?? h.level, sub = level > 2 && h.index !== titleIndex;
  const stripped = dropNumbers && sub ? h.text.replace(HEADING_NUMBER_RE, '') : h.text;
  let text = stripped.trim() ? stripped : h.text;
  if (h.index === titleIndex || drawnInFrame(level, legal, o)) text = plainInline(text);
  else if (o.boldSubHeadings && sub && text.trim()) text = boldInline(text);
  if (level === h.level && text === h.text) continue;
  output[h.index] = `${h.indent}${'#'.repeat(level)}${h.gap}${text}`;
 }
 const summaryBox = !legal && (o.preset === 'report' || o.preset === 'plan');
 if (summaryBox) plainSummary(output, levels);
 if (o.nestChapterLists) nestChapterLists(output, levels, titleIndex);
 const paragraphs = legal ? paragraphHints(output, levels, titleIndex) : [];
 const noted = o.preset !== 'ministry' && o.preset !== 'press' ? splitQuotes(output, summaryBox ? firstQuoteRun(output, levels) : -1) : output;
 const joined = noted.join('\n');
 const closing = [o.closing?.date, o.closing?.sender && `**${o.closing.sender}**`].filter(l => l?.trim()).map(l => `<right>${l.trim()}</right>`);
 const text = closing.length ? `${joined.replace(/\s+$/u, '')}\n\n${closing.join('\n\n')}\n` : joined;
 // Chapter titles in document order (for HOP's own contents page of report/plan).
 const chapters = body.filter(h => (levels.get(h.index) ?? 0) === 2).map(h => plainInline(h.text.replace(HEADING_NUMBER_RE, '')).trim()).filter(Boolean);
 return { markdown: text, paragraphs, chapters, legal };
}

// ---------------------------------------------------------------- finishing (hwpxFinish.ts)
const MARKER_CLASSES = [['legal1', /^[가-힣]\.$/u], ['legal2', /^\d{1,2}\)$/u], ['legal3', /^[가-힣]\)$/u], ['legal4', /^\(\d{1,2}\)$/u], ['legal5', /^\([가-힣]\)$/u], ['legal6', /^[①-⑳]$/u], ['legal7', /^[㉮-㉻]$/u], ['box0', /^□$/u], ['box1', /^[○ㅇ]$/u], ['box2', /^-$/u], ['box3', /^ㆍ$/u]];
const COVER_INFO_LABELS = ['문서번호', '결재일자', '공개여부', '방침번호'], COVER_BAR_COLOR = '#1F2FD6';
const MARKER_RUN = /(<hp:p\b[^>]*>)<hp:run charPrIDRef="(\d+)"><hp:t>([^<]{1,6})<hp:tab width="(\d+)"([^>]*)\/><\/hp:t><\/hp:run>/g;
const MARKER_START = new RegExp(`^${MARKER_RUN.source}`);
export function markerClass(marker) { for (const [name, p] of MARKER_CLASSES) if (p.test(marker)) return name; return null; }
const STYLE_LISTS = { charPr: 'charProperties', borderFill: 'borderFills', paraPr: 'paraProperties' };
class HeaderStyles {
 constructor(xml) { this.xml = xml; this.clones = new Map(); }
 element(kind, id) { return new RegExp(`<hh:${kind} id="${id}"[\\s\\S]*?<\\/hh:${kind}>`).exec(this.xml)?.[0] ?? null; }
 nextId(kind) { let max = -1; for (const m of this.xml.matchAll(new RegExp(`<hh:${kind} id="(\\d+)"`, 'g'))) max = Math.max(max, Number(m[1])); return max + 1; }
 append(kind, el) {
  const list = STYLE_LISTS[kind], close = `</hh:${list}>`, at = this.xml.indexOf(close); if (at < 0) fail('HWPX 머리 스타일 목록이 없습니다.');
  this.xml = `${this.xml.slice(0, at)}${el}${this.xml.slice(at)}`;
  this.xml = this.xml.replace(new RegExp(`(<hh:${list} itemCnt=")(\\d+)(")`), (_a, a, n, b) => `${a}${Number(n) + 1}${b}`);
 }
 height(id) { return Number(/\bheight="(\d+)"/.exec(this.element('charPr', id) ?? '')?.[1] ?? 1000); }
 fontRef(id) { return /<hh:fontRef\b[^>]*\/>/.exec(this.element('charPr', id) ?? '')?.[0] ?? null; }
 charMetrics(id) {
  const el = this.element('charPr', id) ?? '', fontId = /<hh:fontRef hangul="(\d+)"/.exec(el)?.[1] ?? '0', hangul = /<hh:fontface lang="HANGUL"[\s\S]*?<\/hh:fontface>/.exec(this.xml)?.[0] ?? '';
  return { height: Number(/\bheight="(\d+)"/.exec(el)?.[1] ?? 1000), ratio: Number(/<hh:ratio hangul="(\d+)"/.exec(el)?.[1] ?? 100), spacing: Number(/<hh:spacing hangul="(-?\d+)"/.exec(el)?.[1] ?? 0), face: new RegExp(`<hh:font id="${fontId}" face="([^"]*)"`).exec(hangul)?.[1] ?? '' };
 }
 paraMetrics(id) { const el = this.element('paraPr', id) ?? '', v = (n) => Number(new RegExp(`<hc:${n} value="(-?\\d+)"`).exec(el)?.[1] ?? 0); return { left: v('left'), right: v('right'), prev: v('prev'), next: v('next'), lineSpacing: this.lineSpacing(id) }; }
 /** A fontRef pointing every script at an existing face, or null when a script table lacks it. */
 fontRefByFace(face) {
  const ids = {};
  for (const [, lang, body] of this.xml.matchAll(/<hh:fontface lang="(\w+)"[^>]*>([\s\S]*?)<\/hh:fontface>/g)) {
   const id = new RegExp(`<hh:font id="(\\d+)" face="${face}"`).exec(body)?.[1]; if (id === undefined) return null;
   ids[lang.toLowerCase()] = id;
  }
  const order = ['hangul', 'latin', 'hanja', 'japanese', 'other', 'symbol', 'user'];
  return order.every(k => ids[k] !== undefined) ? `<hh:fontRef ${order.map(k => `${k}="${ids[k]}"`).join(' ')}/>` : null;
 }
 indent(id) { return Number(/<hc:intent value="(-?\d+)"/.exec(this.element('paraPr', id) ?? '')?.[1] ?? 0); }
 lineSpacing(id) { const v = /<hh:lineSpacing type="PERCENT" value="(\d+)"/.exec(this.element('paraPr', id) ?? '')?.[1]; return v ? Number(v) : 160; }
 isFlushJustified(id) { const el = this.element('paraPr', id); if (!el || !/<hh:align horizontal="JUSTIFY"/.test(el)) return false; const m = [...el.matchAll(/<hc:(?:left|intent) value="(-?\d+)"/g)]; return m.length > 0 && m.every(x => x[1] === '0'); }
 charPr(id, change) {
  const key = `c:${id}:${JSON.stringify(change)}`; if (this.clones.has(key)) return String(this.clones.get(key));
  const source = this.element('charPr', id); if (!source) return id;
  const newId = this.nextId('charPr'); let el = source.replace(/^<hh:charPr id="\d+"/, `<hh:charPr id="${newId}"`);
  if (change.pt !== undefined) el = el.replace(/\bheight="\d+"/, `height="${Math.round(change.pt * 100)}"`);
  if (change.color) el = el.replace(/\btextColor="[^"]*"/, `textColor="${change.color}"`);
  if (change.fontRef) el = el.replace(/<hh:fontRef\b[^>]*\/>/, change.fontRef);
  if (change.ratio !== undefined) el = el.replace(/<hh:ratio\b[^>]*\/>/, tag => tag.replace(/="\d+"/g, `="${change.ratio}"`));
  if (change.bold !== undefined) { el = el.replace(/<hh:bold\/>/g, '').replace(/\sbold="[01]"/, ''); if (change.bold) el = el.replace(/^(<hh:charPr\b[^>]*?)>/, '$1 bold="1">').replace(/<\/hh:charPr>$/, '<hh:bold/></hh:charPr>'); }
  this.append('charPr', el); this.clones.set(key, newId); return String(newId);
 }
 borderFill(id, fill) {
  const key = `b:${id}:${fill}`; if (this.clones.has(key)) return String(this.clones.get(key));
  const source = this.element('borderFill', id); if (!source) return id;
  const newId = this.nextId('borderFill'); let el = source.replace(/^<hh:borderFill id="\d+"/, `<hh:borderFill id="${newId}"`);
  el = /faceColor="[^"]*"/.test(el) ? el.replace(/faceColor="[^"]*"/, `faceColor="${fill}"`) : el.replace(/<\/hh:borderFill>$/, `<hc:fillBrush><hc:winBrush faceColor="${fill}" hatchColor="#000000" alpha="0"/></hc:fillBrush></hh:borderFill>`);
  this.append('borderFill', el); this.clones.set(key, newId); return String(newId);
 }
 paraPr(id, change) {
  const key = `p:${id}:${JSON.stringify(change)}`; if (this.clones.has(key)) return String(this.clones.get(key));
  const source = this.element('paraPr', id); if (!source) return id;
  const newId = this.nextId('paraPr'); let el = source.replace(/^<hh:paraPr id="\d+"/, `<hh:paraPr id="${newId}"`);
  if (change.left !== undefined) el = el.replace(/(<hc:left value=")-?\d+(")/g, `$1${change.left}$2`);
  if (change.prev !== undefined) el = el.replace(/(<hc:prev value=")-?\d+(")/g, `$1${change.prev}$2`);
  this.append('paraPr', el); this.clones.set(key, newId); return String(newId);
 }
 borderFillIdsWithColor(c) { const ids = new Set(); for (const m of this.xml.matchAll(/<hh:borderFill id="(\d+)"[\s\S]*?<\/hh:borderFill>/g)) if (m[0].toUpperCase().includes(`FACECOLOR="${c.toUpperCase()}"`)) ids.add(m[1]); return ids; }
}
function topLevelParagraphs(section) {
 const found = []; let depth = 0, start = -1;
 for (const tag of section.matchAll(/<hp:p\b[^>]*?(\/?)>|<\/hp:p>/g)) {
  const at = tag.index ?? 0;
  if (tag[0] === '</hp:p>') { depth--; if (depth === 0 && start >= 0) found.push({ start, end: at + tag[0].length }); }
  else if (!tag[1]) { if (depth === 0) start = at; depth++; }
 }
 return found;
}
function paragraphText(xml) { const own = xml.replace(/<hp:subList\b[\s\S]*?<\/hp:subList>/g, ''); let t = ''; for (const m of own.matchAll(/<hp:t\b[^>]*>([\s\S]*?)<\/hp:t>/g)) t += m[1].replace(/<[^>]*>/g, '').replace(/&#?\w+;/g, ' '); return t; }
function alignParagraphs(section, styles, hints, missed) {
 if (!hints?.some(h => h.depth > 0)) return section;
 const candidates = topLevelParagraphs(section).filter(({ start, end }) => {
  const xml = section.slice(start, end), open = /^<hp:p\b[^>]*>/.exec(xml)?.[0] ?? '';
  if (!/\bstyleIDRef="0"/.test(open) || MARKER_START.test(xml) || /<hp:(?:tbl|pic|equation)\b/.test(xml)) return false;
  const shape = /\bparaPrIDRef="(\d+)"/.exec(open)?.[1]; return !!shape && styles.isFlushJustified(shape);
 });
 const edits = []; let next = 0;
 for (const hint of hints) {
  for (let i = next; i < candidates.length; i++) {
   const { start, end } = candidates[i], xml = section.slice(start, end);
   if (!paragraphSignature(paragraphText(xml)).startsWith(hint.key)) continue;
   next = i + 1;
   if (hint.depth > 0) {
    const open = /^<hp:p\b[^>]*>/.exec(xml)?.[0] ?? '', shape = /\bparaPrIDRef="(\d+)"/.exec(open)?.[1] ?? '', run = /<hp:run charPrIDRef="(\d+)"/.exec(xml)?.[1];
    const pt = (run ? styles.height(run) : 1000) / 100, left = hint.depth * 2 * Math.round(pt * 50);
    edits.push({ start, open, replacement: open.replace(/\bparaPrIDRef="\d+"/, `paraPrIDRef="${styles.paraPr(shape, { left })}"`) });
   }
   break;
  }
 }
 if (!edits.length) { missed.push('paragraphs'); return section; }
 let out = '', cursor = 0; for (const e of edits) { out += section.slice(cursor, e.start) + e.replacement; cursor = e.start + e.open.length; }
 return out + section.slice(cursor);
}
function spaceClosing(section, styles, closing, missed) {
 if (!closing?.key) return section;
 const ps = topLevelParagraphs(section);
 for (let i = ps.length - 1; i >= 0; i--) {
  const { start, end } = ps[i], xml = section.slice(start, end);
  if (!paragraphSignature(paragraphText(xml)).startsWith(closing.key)) continue;
  const open = /^<hp:p\b[^>]*>/.exec(xml)?.[0] ?? '', shape = /\bparaPrIDRef="(\d+)"/.exec(open)?.[1], run = /<hp:run charPrIDRef="(\d+)"/.exec(xml)?.[1];
  if (!shape || !run) break;
  const prev = Math.round((styles.height(run) * styles.lineSpacing(shape)) / 100);
  return section.slice(0, start) + open.replace(/\bparaPrIDRef="\d+"/, `paraPrIDRef="${styles.paraPr(shape, { prev })}"`) + section.slice(start + open.length);
 }
 missed.push('closing'); return section;
}
const METRIC_FACES = new Set(['한컴돋움', 'HY견고딕', '휴먼명조', 'HY헤드라인M', '굴림체', '굴림', '맑은 고딕', '함초롬돋움']);
const FIXED_PITCH_FACES = /^(?:굴림체|돋움체|바탕체|궁서체)$/u, GOTHIC_FACES = /^(?:한컴돋움|맑은 고딕|HY견고딕|HY헤드라인M|HY중고딕|한양중고딕|나눔고딕|나눔스퀘어|돋움|굴림)$/u;
const FRAME_TABLE_IDS = { from: 9200000, to: 9400000 }, SIZED_CELL = /^<hp:tc name="__kordoc_summary"/, CONDENSED_RATIOS = [95, 90, 85], FIT_SAFETY = 0.98, PAD_CAP = 3000;
const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const faceClass = (face) => { const n = face.trim(); if (METRIC_FACES.has(n)) return `font:${n}`; if (FIXED_PITCH_FACES.test(n)) return 'fixedPitch'; return GOTHIC_FACES.test(n) ? 'gothic' : 'hcr'; };
function printedText(p) { let t = ''; for (const m of p.matchAll(/<hp:t\b[^>]*>([\s\S]*?)<\/hp:t>/g)) t += m[1].replace(/<[^>]*>/g, '').replace(/&(?:#(\d+)|#x([0-9a-f]+)|(\w+));/gi, (e, d, h, n) => (d || h ? String.fromCodePoint(d ? Number(d) : parseInt(h, 16)) : XML_ENTITIES[n] ?? e)); return t; }
const isFrameTable = (t) => { const id = Number(/^<hp:tbl id="(\d+)"/.exec(t)?.[1]); return id >= FRAME_TABLE_IDS.from && id < FRAME_TABLE_IDS.to; };
const tableRows = (t) => [...t.matchAll(/<hp:tr>([\s\S]*?)<\/hp:tr>/g)].map(r => [...r[1].matchAll(/<hp:tc\b[\s\S]*?<\/hp:tc>/g)].map(c => c[0]));
const cellWidth = (c) => Number(/<hp:cellSz width="(\d+)"/.exec(c)?.[1] ?? 0);
const withCellSize = (c, s) => c.replace(/<hp:cellSz width="(\d+)" height="(\d+)"/, (_a, w, h) => `<hp:cellSz width="${s.width ?? w}" height="${s.height ?? h}"`);
const cellMargins = (c, tm) => (/\bhasMargin="1"/.test(c) ? /<hp:cellMargin left="(\d+)" right="(\d+)" top="(\d+)" bottom="(\d+)"/.exec(c)?.slice(1).map(Number) : undefined) ?? tm;
function lineShape(p, styles, margins) {
 const runs = [...p.matchAll(/<hp:run charPrIDRef="(\d+)"/g)].map(m => m[1]); if (!runs.length) return null;
 const shape = styles.paraMetrics(/paraPrIDRef="(\d+)"/.exec(p)?.[1] ?? '0');
 return { text: printedText(p), runs, main: styles.charMetrics(runs[runs.length - 1]), room: (w) => w - margins[0] - margins[1] - shape.left - shape.right, lineHeight: Math.round((Math.max(...runs.map(id => styles.height(id))) * shape.lineSpacing) / 100), around: shape.prev + shape.next };
}
function wrapLines(text, width, m, ratio) { if (!text.trim()) return 1; if (width <= 0) return Number.POSITIVE_INFINITY; return simulateWrap(text, width, width, m.height, ratio, 'keep', { faceClass: faceClass(m.face), spacingPct: m.spacing }).lines; }
const paragraphsOf = (c) => c.match(/<hp:p\b[^>]*>[\s\S]*?<\/hp:p>/g) ?? [];
function widenLabels(table, styles, margins) {
 const rows = tableRows(table); if (rows.length < 2 || rows.some(c => c.length !== 2)) return table;
 const lw = cellWidth(rows[0][0]), vw = cellWidth(rows[0][1]); if (rows.some(([l, v]) => cellWidth(l) !== lw || cellWidth(v) !== vw)) return table;
 let need = lw;
 for (const [label] of rows) for (const p of paragraphsOf(label)) {
  const line = lineShape(p, styles, cellMargins(label, margins)); if (!line || wrapLines(line.text, line.room(lw), line.main, line.main.ratio) <= 1) continue;
  const text = measureTextWidth(line.text, line.main.height, line.main.ratio, { faceClass: faceClass(line.main.face), spacingPct: line.main.spacing });
  need = Math.max(need, Math.ceil((lw - line.room(lw) + text / FIT_SAFETY) / 100) * 100);
 }
 const narrower = vw - (need - lw); if (need <= lw || narrower <= 0) return table;
 const keep = rows.every(([, v]) => paragraphsOf(v).every(p => { const line = lineShape(p, styles, cellMargins(v, margins)); return !line || wrapLines(line.text, line.room(narrower), line.main, line.main.ratio) <= wrapLines(line.text, line.room(vw), line.main, line.main.ratio); }));
 if (!keep) return table;
 return table.replace(/<hp:tr>([\s\S]*?)<\/hp:tr>/g, (_r, inner) => { const [l, v] = [...inner.matchAll(/<hp:tc\b[\s\S]*?<\/hp:tc>/g)].map(c => c[0]); return `<hp:tr>${withCellSize(l, { width: need })}${withCellSize(v, { width: narrower })}</hp:tr>`; });
}
function fitCell(cell, styles, tm, height) {
 const width = cellWidth(cell), margins = cellMargins(cell, tm);
 const ps = paragraphsOf(cell).map(p => {
  const line = lineShape(p, styles, margins); if (!line) return { line, lines: 0, ratio: undefined };
  const room = line.room(width), lines = wrapLines(line.text, room, line.main, line.main.ratio);
  const ratio = lines > 1 ? CONDENSED_RATIOS.find(c => c < line.main.ratio && wrapLines(line.text, room * FIT_SAFETY, line.main, c) === 1) : undefined;
  return { line, lines: Number.isFinite(lines) ? lines : 1, ratio };
 });
 const measure = (condense) => { let needed = margins[2] + margins[3], oneLine = needed, wrapped = false; for (const { line, lines, ratio } of ps) { if (!line) continue; const n = condense && ratio !== undefined ? 1 : lines; if (n > 1) wrapped = true; needed += line.around + n * line.lineHeight; oneLine += line.around + line.lineHeight; } return { needed, oneLine, wrapped }; };
 const natural = measure(false);
 if (natural.needed <= height || ps.every(i => i.ratio === undefined)) return { cell, ...natural };
 let i = 0;
 const fitted = cell.replace(/<hp:p\b[^>]*>[\s\S]*?<\/hp:p>/g, p => { const ratio = ps[i++]?.ratio; return ratio === undefined ? p : p.replace(/<hp:run charPrIDRef="(\d+)"/g, (_r, id) => `<hp:run charPrIDRef="${styles.charPr(id, { ratio })}"`); });
 return { cell: fitted, ...measure(true) };
}
function rowsUnderSpans(table) { const s = new Set(); for (const c of table.matchAll(/<hp:cellAddr colAddr="\d+" rowAddr="(\d+)"\/><hp:cellSpan colSpan="\d+" rowSpan="(\d+)"\/>/g)) { const [r, span] = [Number(c[1]), Number(c[2])]; for (let o = 0; o < span && span > 1; o++) s.add(r + o); } return s; }
/** Kordoc sizes its frames for one line; a long title or value is condensed (to 85 %) or its row grows (R-027). */
function fitFrames(section, styles) {
 return section.replace(/<hp:tbl\b[\s\S]*?<\/hp:tbl>/g, (source) => {
  if (!isFrameTable(source) || source.indexOf('<hp:tbl', 1) >= 0) return source;
  const inMargin = /<hp:inMargin left="(\d+)" right="(\d+)" top="(\d+)" bottom="(\d+)"/.exec(source), margins = inMargin ? inMargin.slice(1).map(Number) : [141, 141, 141, 141];
  const table = widenLabels(source, styles, margins), spanned = rowsUnderSpans(table);
  let grown = 0, index = -1;
  const rows = table.replace(/<hp:tr>([\s\S]*?)<\/hp:tr>/g, (row, inner) => {
   index++; if (spanned.has(index)) return row;
   const cells = [...inner.matchAll(/<hp:tc\b[\s\S]*?<\/hp:tc>/g)].map(m => m[0]);
   const current = Math.max(0, ...cells.map(c => Number(/<hp:cellSz width="\d+" height="(\d+)"/.exec(c)?.[1] ?? 0))); let height = current;
   const fitted = cells.map(c => { if (SIZED_CELL.test(c)) return c; const f = fitCell(c, styles, margins, current); if (f.wrapped && f.needed > current) height = Math.max(height, f.needed + Math.min(Math.max(current - f.oneLine, 0), PAD_CAP)); return f.cell; });
   grown += height - current;
   return `<hp:tr>${(height > current ? fitted.map(c => withCellSize(c, { height })) : fitted).join('')}</hp:tr>`;
  });
  if (!grown) return rows;
  return rows.replace(/(<hp:sz width="\d+" widthRelTo="\w+" height=")(\d+)(")/, (_s, a, h, b) => `${a}${Number(h) + grown}${b}`);
 });
}
/**
 * Advance widths (em) of redrawn marker glyphs as Hancom 2024 prints them, measured on its printouts
 * (11 pt). 한림고딕체 has no U+2022, and Hancom 2024 prints • in 함초롬바탕.
 */
const MARKER_ADVANCE_EM = {
 '한림고딕체 Regular': { '•': 0.4, '-': 0.438, '·': 0.524 },
 '한림고딕체': { '•': 0.4, '-': 0.438, '·': 0.524 },
 '함초롬바탕': { '•': 0.4 }
};
/** Glyphs a face lacks and the face they appear in on Hancom 2024 printouts (• in 한림고딕체 → 함초롬바탕). */
const MARKER_GLYPH_FALLBACK = {
 '한림고딕체 Regular': { '•': '함초롬바탕' },
 '한림고딕체': { '•': '함초롬바탕' }
};
function markerAdvance(text, metrics) {
 const table = MARKER_ADVANCE_EM[metrics.face];
 let width = 0;
 for (const ch of text) {
  const em = table?.[ch];
  width += em !== undefined ? em * metrics.height * metrics.ratio / 100 : measureTextWidth(ch, metrics.height, metrics.ratio, { faceClass: faceClass(metrics.face), spacingPct: metrics.spacing });
 }
 return width;
}
function redrawMarkers(section, styles, markers, missed) {
 if (!markers || !Object.keys(markers).length) return section;
 let counter = 0, changed = 0, out = '', cursor = 0;
 for (const open of section.matchAll(/<hp:p\b[^>]*>/g)) {
  const start = open.index ?? 0; if (start < cursor) continue;
  if (/\bstyleIDRef="2"/.test(open[0])) counter = 0;
  MARKER_RUN.lastIndex = start; const run = MARKER_RUN.exec(section);
  if (!run || run.index !== start) continue;
  const kind = markerClass(run[3]), target = kind ? markers[kind] : undefined; if (target === undefined) continue;
  const replacement = target === NUMBERED_PAREN ? `${++counter})` : target, height = styles.height(run[2]);
  // Hancom places the text after marker+tab at the hanging indent (autoTabLeft) and saves the tab as the
  // remaining distance; editors that replay the saved width (rhwp) need that same value.
  const hang = -styles.indent(/\bparaPrIDRef="(\d+)"/.exec(run[1])?.[1] ?? '0');
  const width = (t) => measureTextWidth(t, height, 100);
  const tab = hang > 0
   ? Math.max(0, Math.round(hang - markerAdvance(replacement, styles.charMetrics(run[2]))))
   : Math.max(0, Math.round(Number(run[4]) + width(run[3]) - width(replacement)));
  // A marker the run's face has no glyph for is drawn in the face Hancom falls back to, so every editor shows the same bullet.
  const fallback = [...replacement].map(ch => MARKER_GLYPH_FALLBACK[styles.charMetrics(run[2]).face]?.[ch]).find(Boolean);
  const fallbackRef = fallback ? styles.fontRefByFace(fallback) : null;
  const charId = fallbackRef ? styles.charPr(run[2], { fontRef: fallbackRef }) : run[2];
  out += section.slice(cursor, start) + `${run[1]}<hp:run charPrIDRef="${charId}"><hp:t>${replacement}<hp:tab width="${tab}"${run[5]}/></hp:t></hp:run>`;
  cursor = start + run[0].length; changed++;
 }
 if (!changed) missed.push('markers');
 return out + section.slice(cursor);
}
function recolorTableHeaders(section, styles, header, missed) {
 if (!header) return section;
 let changed = 0;
 const result = section.replace(/<hp:tc\b([^>]*\bheader="1"[^>]*)>([\s\S]*?)<\/hp:tc>/g, (cell, attrs, inner) => {
  if (inner.includes('<hp:tc')) return cell;
  const fill = /borderFillIDRef="(\d+)"/.exec(attrs)?.[1]; if (!fill) return cell;
  changed++;
  return `<hp:tc${attrs.replace(/borderFillIDRef="\d+"/, `borderFillIDRef="${styles.borderFill(fill, header.fill)}"`)}>${inner.replace(/<hp:run charPrIDRef="(\d+)">/g, (_r, id) => `<hp:run charPrIDRef="${styles.charPr(id, { color: header.textColor, bold: true })}">`)}</hp:tc>`;
 });
 if (!changed) missed.push('tableHeader');
 return result;
}
function bodyFontRef(section, styles) {
 // matchAll starts at the shared regex's lastIndex, which redrawMarkers leaves at its last match.
 MARKER_RUN.lastIndex = 0;
 for (const run of section.matchAll(MARKER_RUN)) { const after = section.slice((run.index ?? 0) + run[0].length), id = /^<hp:run charPrIDRef="(\d+)">/.exec(after)?.[1]; if (id) return styles.fontRef(id); }
 return null;
}
function restyleTitle(section, styles, title, missed) {
 if (!title) return section;
 const open = /<hp:p\b[^>]*\bstyleIDRef="1"[^>]*>/.exec(section); if (!open) { missed.push('title'); return section; }
 const start = open.index, end = section.indexOf('</hp:p>', start), p = section.slice(start, end), fontRef = title.font === 'body' ? bodyFontRef(section, styles) : null;
 const restyled = p.replace(/<hp:run charPrIDRef="(\d+)">(?=(?:(?!<\/hp:run>)[\s\S])*<hp:t>[^<])/g, (_r, id) => `<hp:run charPrIDRef="${styles.charPr(id, { pt: title.pt, bold: title.bold, fontRef })}">`);
 return section.slice(0, start) + restyled + section.slice(end);
}
function restyleChapters(section, styles, chapter, missed) {
 if (!chapter) return section;
 let changed = 0;
 const result = section.replace(/(<hp:p\b[^>]*\bstyleIDRef="2"[^>]*>)((?:(?!<\/hp:p>)[\s\S])*?)(<\/hp:p>)/g, (all, open, inner, close) => {
  if (inner.includes('<hp:tbl')) return all;
  changed++;
  let shaped = open; const shape = /\bparaPrIDRef="(\d+)"/.exec(open)?.[1], firstRun = /<hp:run charPrIDRef="(\d+)"/.exec(inner)?.[1];
  if (chapter.blankLineBefore && changed > 1 && shape && firstRun) shaped = open.replace(/\bparaPrIDRef="\d+"/, `paraPrIDRef="${styles.paraPr(shape, { prev: Math.round((styles.height(firstRun) * styles.lineSpacing(shape)) / 100) })}"`);
  const runs = chapter.pt === undefined && chapter.bold === undefined ? inner : inner.replace(/<hp:run charPrIDRef="(\d+)">/g, (_r, id) => `<hp:run charPrIDRef="${styles.charPr(id, { pt: chapter.pt, bold: chapter.bold })}">`);
  return `${shaped}${runs}${close}`;
 });
 if (!changed) missed.push('chapter');
 return result;
}
function finishCover(section, styles, cover, missed) {
 if (!cover) return section;
 const bodyStart = section.search(/<hp:p\b[^>]*\bpageBreak="1"/); if (bodyStart < 0) { missed.push('cover'); return section; }
 let region = section.slice(0, bodyStart), rest = section.slice(bodyStart);
 const barFills = styles.borderFillIdsWithColor(COVER_BAR_COLOR);
 if (![...barFills].some(id => region.includes(`borderFillIDRef="${id}"`))) { missed.push('cover'); return section; }
 if (cover.removeInfoBox) {
  const box = /<hp:tbl\b[\s\S]*?<\/hp:tbl>/.exec(region);
  if (box && COVER_INFO_LABELS.every(l => box[0].includes(`<hp:t>${l}</hp:t>`))) region = region.slice(0, box.index) + region.slice(box.index + box[0].length); else missed.push('cover.removeInfoBox');
 }
 if (cover.barColors) {
  let bar = 0;
  region = region.replace(/<hp:tc\b([^>]*)borderFillIDRef="(\d+)"/g, (cell, attrs, id) => { if (!barFills.has(id) || bar > 1) return cell; const c = cover.barColors[bar] ?? COVER_BAR_COLOR; bar++; return `<hp:tc${attrs}borderFillIDRef="${styles.borderFill(id, c)}"`; });
  if (!bar) missed.push('cover.barColors');
 }
 if (cover.linePt !== undefined || cover.lineBold !== undefined) {
  const frameEnd = region.lastIndexOf('</hp:tbl>');
  if (frameEnd < 0) missed.push('cover.lines');
  else region = region.slice(0, frameEnd) + region.slice(frameEnd).replace(/(<hp:p\b[^>]*>)<hp:run charPrIDRef="(\d+)">(<hp:t>[^<]+<\/hp:t>)/g, (_a, open, id, text) => `${open}<hp:run charPrIDRef="${styles.charPr(id, { pt: cover.linePt, bold: cover.lineBold })}">${text}`);
 }
 if (cover.removeBodyTitle) {
  const end = rest.indexOf('</hp:p>'), box = /<hp:tbl\b[\s\S]*?<\/hp:tbl>/.exec(rest);
  if (box && box.index < end && box[0].includes('name="__kordoc_h1"')) rest = rest.slice(0, box.index) + rest.slice(box.index + box[0].length); else missed.push('cover.removeBodyTitle');
 }
 return region + rest;
}
/** Applies an institution style's finishing and the general frame fitting to one section. */
export function finishGongmunXml(sectionXml, headerXml, spec) {
 const styles = new HeaderStyles(headerXml), missed = [];
 let s = sectionXml;
 s = alignParagraphs(s, styles, spec.paragraphs, missed);
 s = spaceClosing(s, styles, spec.closing, missed);
 s = redrawMarkers(s, styles, spec.markers, missed);
 s = recolorTableHeaders(s, styles, spec.tableHeader, missed);
 s = restyleTitle(s, styles, spec.title, missed);
 s = restyleChapters(s, styles, spec.chapter, missed);
 s = finishCover(s, styles, spec.cover, missed);
 if (spec.fitFrames) s = fitFrames(s, styles);
 return { section: s, header: styles.xml, missed };
}

// ---------------------------------------------------------------- HOP contents page (report/plan)
const ROMAN = ['Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ', 'Ⅵ', 'Ⅶ', 'Ⅷ', 'Ⅸ', 'Ⅹ', 'Ⅺ', 'Ⅻ'];
const escapeXml = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/**
 * Kordoc draws no contents page for report and plan; HOP inserts one after the cover (or
 * before the first chapter) in the document's own body typeface. Page numbers are not
 * written: the engine has no field that would keep them correct after editing.
 */
export function insertContentsPage(sectionXml, headerXml, chapters, { afterCover, marker = 'roman' }) {
 const styles = new HeaderStyles(headerXml), ps = topLevelParagraphs(sectionXml);
 if (!chapters.length) fail('목차를 만들려면 장 제목이 필요합니다.');
 const plain = ps.map(p => sectionXml.slice(p.start, p.end)).find(xml => {
  const open = /^<hp:p\b[^>]*>/.exec(xml)?.[0] ?? '';
  return /\bstyleIDRef="0"/.test(open) && !/<hp:(?:tbl|pic|ctrl)\b/.test(xml) && !MARKER_START.test(xml) && paragraphText(xml).trim().length > 1;
 });
 const baseChar = (plain && /<hp:run charPrIDRef="(\d+)"/.exec(plain)?.[1]) ?? '0', basePara = (plain && /\bparaPrIDRef="(\d+)"/.exec(plain)?.[1]) ?? '0';
 const pt = styles.height(baseChar) / 100, headChar = styles.charPr(baseChar, { pt: Math.round((pt + 4) * 2) / 2, bold: true }), entryPara = styles.paraPr(basePara, { prev: Math.round(pt * 40) });
 const signature = paragraphSignature(chapters[0]);
 const at = afterCover ? ps.find(p => /^<hp:p\b[^>]*\bpageBreak="1"/.test(sectionXml.slice(p.start, p.end))) : ps.find(p => paragraphSignature(paragraphText(sectionXml.slice(p.start, p.end))).includes(signature));
 if (!at) fail('목차를 넣을 본문 위치를 찾지 못했습니다.');
 const label = (i) => (marker === 'number' ? `${i + 1}. ` : marker === 'none' || marker === 'box' ? '' : `${ROMAN[i] ?? i + 1}. `);
 const para = (id, paraId, charId, text, pageBreak) => `<hp:p id="${id}" paraPrIDRef="${paraId}" styleIDRef="0" pageBreak="${pageBreak ? 1 : 0}" columnBreak="0" merged="0"><hp:run charPrIDRef="${charId}"><hp:t>${escapeXml(text)}</hp:t></hp:run></hp:p>`;
 const toc = [para(910000, basePara, headChar, '목  차', afterCover), ...chapters.map((c, i) => para(910001 + i, entryPara, baseChar, label(i) + c, false))].join('');
 let target = sectionXml.slice(at.start, at.end);
 if (!afterCover) target = target.replace(/^<hp:p\b[^>]*>/, open => (/\bpageBreak="/.test(open) ? open.replace(/\bpageBreak="\d"/, 'pageBreak="1"') : open.replace(/>$/, ' pageBreak="1">')));
 return { section: sectionXml.slice(0, at.start) + toc + target + sectionXml.slice(at.end), header: styles.xml };
}

// ---------------------------------------------------------------- package corrections (hwpxPostProcess.ts)
/** Long tables keep their marked header row on every page. */
export function repeatTableHeaderRows(xml) {
 let out = '', cursor = 0, changed = 0;
 for (const m of xml.matchAll(/<hp:tbl\s[^>]*>/g)) {
  const start = m.index ?? 0; if (start < cursor || !/\brepeatHeader="0"/.test(m[0])) continue;
  const bodyStart = start + m[0].length, rowEnd = xml.indexOf('</hp:tr>', bodyStart), nested = xml.indexOf('<hp:tbl', bodyStart);
  const row = xml.slice(bodyStart, rowEnd === -1 ? bodyStart : nested !== -1 && nested < rowEnd ? nested : rowEnd);
  if (!/<hp:tc\s[^>]*\bheader="1"/.test(row)) continue;
  out += xml.slice(cursor, start) + m[0].replace('repeatHeader="0"', 'repeatHeader="1"'); cursor = bodyStart; changed++;
 }
 return { xml: out + xml.slice(cursor), changed };
}
/** Footnote bodies get the leading number control Hancom draws ("1) …") when Kordoc left it out. */
export function addFootnoteAutoNumbers(xml) {
 let added = 0;
 const out = xml.replace(/<hp:footNote\s[^>]*>[\s\S]*?<\/hp:footNote>/g, (note) => {
  if (/<hp:autoNum\b[^>]*\bnumType="FOOTNOTE"/.test(note)) return note;
  const number = note.match(/^<hp:footNote\s[^>]*\bnumber="(\d+)"/)?.[1], p = note.match(/(<hp:subList\b[^>]*>\s*<hp:p\b[^>]*>)/);
  if (!number || !p || p.index === undefined) return note;
  const at = p.index + p[0].length, charPr = note.slice(at).match(/<hp:run\s[^>]*\bcharPrIDRef="(\d+)"/)?.[1] ?? '0';
  added++;
  return note.slice(0, at) + `<hp:run charPrIDRef="${charPr}"><hp:ctrl><hp:autoNum num="${number}" numType="FOOTNOTE"><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/></hp:autoNum></hp:ctrl><hp:t> </hp:t></hp:run>` + note.slice(at);
 });
 return { xml: out, added };
}
export { normalizeGongmunPreset };
