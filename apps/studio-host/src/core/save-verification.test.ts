/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { HwpDocument } from '../../vendor/rhwp-core/rhwp.js';
import { bodyDocument, fixtureBytes, historyHarness } from '../achmage-ai/test-support/history-harness';
import { documentShape, reopensAsSameDocument, type ReopenableDocument } from './save-verification';
import { textFormatMods } from '../achmage-ai/text-format';

// HWPX save gate on the pinned engine: real documents must pass, a damaged file must not.
const samples: [string, () => Uint8Array][] = [
  ['blank form', () => fixtureBytes('owned-blank.hwpx')],
  ['report with cover', () => fixtureBytes('kordoc-report-cover.hwpx')],
  ['meeting with contents', () => fixtureBytes('kordoc-meeting-toc.hwpx')],
  ['typed body', () => bodyDocument(['첫 문단 😀', '둘째 문단', '셋째 문단'])],
];

describe('HWPX save reopen check', () => {
  it.each(samples)('passes the engine\'s own HWPX export of a %s', (_name, bytes) => {
    const doc = new HwpDocument(bytes());
    try {
      const exported = doc.exportHwpxWithReport();
      try { expect(reopensAsSameDocument(doc as unknown as ReopenableDocument, exported.takeBytes())).toBe(true); } finally { exported.free(); }
    } finally { doc.free(); }
  });

  it('passes after an edit that adds a table, and the shape sees the table', () => {
    const h = historyHarness(bodyDocument(['표 앞', '표 뒤']));
    try {
      h.native.createTable(0, 1, 0, 2, 2);
      const exported = h.native.exportHwpxWithReport();
      try { expect(reopensAsSameDocument(h.native as unknown as ReopenableDocument, exported.takeBytes())).toBe(true); } finally { exported.free(); }
      expect(documentShape(h.native as unknown as ReopenableDocument)).toContain('tbl');
    } finally { h.close(); }
  });

  it('refuses bytes whose text is the same but whose font names differ (Hancom would open them substituted)', () => {
    const doc = new HwpDocument(bodyDocument(['같은 본문'])), other = new HwpDocument(bodyDocument(['같은 본문']));
    try {
      const ids = (family: string) => Array.from({ length: 7 }, (_, lang) => other.findOrCreateFontIdForLang(lang, family));
      other.applyCharFormat(0, 0, 0, 2, textFormatMods({ fontFamily: '한림고딕체' }, ids));
      const exported = other.exportHwpxWithReport(), bytes = exported.takeBytes(); exported.free();
      expect(documentShape(other as unknown as ReopenableDocument)).toContain('한림고딕체');
      expect(reopensAsSameDocument(doc as unknown as ReopenableDocument, bytes)).toBe(false);
      expect(reopensAsSameDocument(other as unknown as ReopenableDocument, bytes)).toBe(true);
    } finally { doc.free(); other.free(); }
  });

  it('refuses bytes that are damaged or are another document', () => {
    const doc = new HwpDocument(bodyDocument(['원래 문서']));
    try {
      const exported = doc.exportHwpxWithReport(), bytes = exported.takeBytes(); exported.free();
      expect(reopensAsSameDocument(doc as unknown as ReopenableDocument, bytes.slice(0, bytes.length >> 1))).toBe(false);
      expect(reopensAsSameDocument(doc as unknown as ReopenableDocument, bodyDocument(['다른 문서']))).toBe(false);
    } finally { doc.free(); }
  });
});
