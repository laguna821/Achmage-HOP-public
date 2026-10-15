import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { generateDocument } from '../engine.mjs';
import { charHeights, repairCover } from '../cover-repair.mjs';

const style = (size = 11) => ({ fontFamily: '함초롬바탕', fontSizePt: size, bold: false, spacingPercent: 0, alignment: 'left', lineSpacingPercent: 160 });
const template = () => ({ schemaVersion: 1, id: 'cover', name: '표지 시험', category: 'general', provenance: 'personal', description: '표지 시험',
  roles: { title: { ...style(20), bold: true, alignment: 'center' }, heading: { ...style(14), bold: true }, body: style(), tableHeader: { ...style(12), bold: true }, tableCell: style(10) },
  layout: { enginePreset: 'report', cover: true, toc: false, sampleMarkdown: '# 시험', paper: 'A4', orientation: 'portrait' } });
const LABELS = ['문서번호', '결재일자', '공개여부', '방침번호'];

test('generated cover has a single-period date and info box labels wide enough for one line', async () => {
  const r = await generateDocument(template(), '# 기본 보고서\n\n## 1. 개요\n\n본문입니다.');
  assert.ok(r.validation.ok);
  const zip = await JSZip.loadAsync(Buffer.from(r.hwpxBase64, 'base64'));
  const section = await zip.file('Contents/section0.xml').async('string'), heights = charHeights(await zip.file('Contents/header.xml').async('string'));
  assert.doesNotMatch(section, /<hp:t>\d{4}\.\s\d{1,2}\.(?:\s\d{1,2}\.)?\.<\/hp:t>/u);
  assert.match(section, /<hp:t>\d{4}\.\s\d{1,2}\.(?:\s\d{1,2}\.)?<\/hp:t>/u);
  for (const label of LABELS) {
    const at = section.indexOf(`<hp:t>${label}</hp:t>`);
    assert.ok(at > 0, label);
    const run = section.lastIndexOf('charPrIDRef="', at), id = /charPrIDRef="(\d+)"/u.exec(section.slice(run))[1];
    const width = Number(/<hp:cellSz width="(\d+)"/u.exec(section.slice(at))[1]);
    assert.ok(width >= 4 * heights.get(id) + 282, `${label}: ${width}`);
  }
  // The table keeps its declared width: label and value cells still add up.
  const table = section.slice(section.lastIndexOf('<hp:tbl', section.indexOf('문서번호')), section.indexOf('</hp:tbl>', section.indexOf('문서번호')));
  const total = Number(/<hp:sz width="(\d+)"/u.exec(table)[1]), widths = [...table.matchAll(/<hp:cellSz width="(\d+)"/gu)].map(m => Number(m[1]));
  assert.equal(widths[0] + widths[1], total);
});

test('repairCover leaves other XML untouched and never squeezes the value cell', () => {
  const plain = '<hs:sec xmlns:hs="s" xmlns:hp="p"><hp:p><hp:run charPrIDRef="1"><hp:t>2026. 10. 15.</hp:t></hp:run></hp:p></hs:sec>';
  assert.deepEqual(repairCover(plain, new Map()), { xml: plain, dates: 0, labels: 0 });
  const cell = (text, col, width) => `<hp:tc><hp:subList><hp:p><hp:run charPrIDRef="20"><hp:t>${text}</hp:t></hp:run></hp:p></hp:subList><hp:cellAddr colAddr="${col}" rowAddr="0"/><hp:cellSz width="${width}" height="1850"/><hp:cellMargin left="141" right="141" top="141" bottom="141"/></hp:tc>`;
  const narrow = `<hs:sec xmlns:hs="s" xmlns:hp="p"><hp:tbl><hp:tr>${cell('문서번호', 0, 4387)}${cell('', 1, 3000)}</hp:tr></hp:tbl></hs:sec>`;
  assert.equal(repairCover(narrow, new Map([['20', 1200]])).labels, 0);
  const doubled = '<hs:sec xmlns:hs="s" xmlns:hp="p"><hp:p><hp:run charPrIDRef="1"><hp:t>2026. 10. 15..</hp:t></hp:run></hp:p></hs:sec>';
  assert.match(repairCover(doubled, new Map()).xml, /<hp:t>2026\. 10\. 15\.<\/hp:t>/u);
});
