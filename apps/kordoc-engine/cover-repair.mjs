// Kordoc 4.21.31's government-style cover has two defects that Hancom Office 2024 and HOP both show
// in their printouts: the date ends with a doubled period ("2026. 10..") and the info box labels
// (문서번호, 결재일자, 공개여부, 방침번호) are 12 pt bold in a 4387-unit column, so each wraps to two lines.
// Both are repaired in the generated section XML; the table keeps its total width.
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

const LABELS = new Set(['문서번호', '결재일자', '공개여부', '방침번호']);
const DOUBLED_DATE = /^(\d{4}\.\s\d{1,2}\.(?:\s\d{1,2}\.)?)\.$/u;
// Room for one more character than the label, so Hancom's and HOP's metrics both keep it on one line.
const SLACK_CHARS = 0.5;

const elements = (node, local) => Array.from(node.getElementsByTagName('*')).filter(e => e.localName === local);
const text = cell => elements(cell, 't').map(t => t.textContent).join('');
const attrInt = (node, name) => Number.parseInt(node.getAttribute(name) ?? '', 10);

/** Character heights (HWPUNIT, 100 per pt) by charPr id, from header.xml. */
export function charHeights(headerXml) {
  const heights = new Map();
  for (const m of headerXml.matchAll(/<hh:charPr\b[^>]*\bid="(\d+)"[^>]*\bheight="(\d+)"/gu)) heights.set(m[1], Number(m[2]));
  return heights;
}

/** Returns the repaired section XML and what changed; untouched input when nothing matches. */
export function repairCover(sectionXml, heights) {
  const doc = new DOMParser().parseFromString(sectionXml, 'text/xml');
  let dates = 0, labels = 0;
  for (const t of elements(doc, 't')) {
    const m = DOUBLED_DATE.exec(t.textContent ?? '');
    if (m) { t.textContent = m[1]; dates++; }
  }
  for (const cell of elements(doc, 'tc')) {
    const label = text(cell);
    if (!LABELS.has(label)) continue;
    const addr = elements(cell, 'cellAddr')[0], size = elements(cell, 'cellSz')[0], margin = elements(cell, 'cellMargin')[0];
    if (!addr || !size || addr.getAttribute('colAddr') !== '0') continue;
    const value = Array.from(cell.parentNode.childNodes).find(n => n.localName === 'tc' && elements(n, 'cellAddr')[0]?.getAttribute('colAddr') === '1');
    const valueSize = value && elements(value, 'cellSz')[0];
    const run = elements(cell, 'run')[0], height = heights.get(run?.getAttribute('charPrIDRef') ?? '') ?? 1000;
    if (!valueSize) continue;
    const margins = (attrInt(margin, 'left') || 0) + (attrInt(margin, 'right') || 0);
    const needed = Math.ceil((Array.from(label).length + SLACK_CHARS) * height + margins);
    const width = attrInt(size, 'width'), other = attrInt(valueSize, 'width'), grow = needed - width;
    // Only widen, and never shrink the value cell below the label cell's new width.
    if (!(grow > 0) || !(other - grow >= needed)) continue;
    size.setAttribute('width', String(width + grow));
    valueSize.setAttribute('width', String(other - grow));
    // Cached line layout of the old width would keep the wrap until the editor reflows the cell.
    for (const n of [...elements(cell, 'linesegarray'), ...elements(value, 'linesegarray')]) n.parentNode.removeChild(n);
    labels++;
  }
  if (!dates && !labels) return { xml: sectionXml, dates, labels };
  return { xml: new XMLSerializer().serializeToString(doc), dates, labels };
}
