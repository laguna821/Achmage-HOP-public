/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { HwpDocument } from '../../vendor/rhwp-core/rhwp.js';
import { initPinnedEngine } from './test-support/pinned-wasm';

initPinnedEngine();
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));

/** An owned document with a bookmark, a click-here field (누름틀), a picture and a header. Memos cannot be created by the engine. */
function owned(): HwpDocument {
  const d = new HwpDocument(readFileSync(new URL('./fixtures/owned-blank.hwpx', import.meta.url)));
  d.insertText(0, 0, 0, '책갈피가 있는 문단입니다.');
  d.splitParagraph(0, 0, d.getParagraphLength(0, 0)); d.insertText(0, 1, 0, '이름: ');
  d.addBookmark(0, 0, 0, '시작');
  d.insertClickHereField(0, 1, d.getParagraphLength(0, 1), '이름을 입력', '작성자 칸', '작성자', true);
  d.insertPicture(0, 0, d.getParagraphLength(0, 0), '', PNG, 1000, 1000, 1, 1, 'png', '점');
  d.createHeaderFooter(0, true, 0); d.insertTextInHeaderFooter(0, true, 0, 0, 0, '머리말');
  return d;
}
const kinds = (d: HwpDocument) => (JSON.parse(d.getControls()) as { ctrlId: string }[]).map(c => c.ctrlId).sort();
const bookmarks = (d: HwpDocument) => (JSON.parse(d.getBookmarks()) as { name: string }[]).map(b => b.name);

describe('save preservation (T16): HWP save with the loss report, then reopen', () => {
  it('keeps the bookmark, the click-here field, the picture, the header and the text, and reports no loss', () => {
    const d = owned();
    try {
      const before = { kinds: kinds(d), bookmarks: bookmarks(d), text: d.getTextFileUnicode() };
      expect(before.bookmarks).toEqual(['시작']);
      const exported = d.exportHwpWithReport(), report = JSON.parse(exported.contentLoss()) as { count: number; losses: unknown[] };
      const bytes = exported.takeBytes(); exported.free();
      expect(report.count).toBe(0);
      const reopened = new HwpDocument(bytes);
      try {
        expect(kinds(reopened)).toEqual(before.kinds);
        expect(bookmarks(reopened)).toEqual(before.bookmarks);
        expect(reopened.getTextFileUnicode()).toBe(before.text);
        const field = JSON.parse(reopened.getFieldInfoAt(0, 1, reopened.getParagraphLength(0, 1))) as { inField?: boolean; name?: string };
        const anyField = Array.from({ length: reopened.getParagraphLength(0, 1) + 1 }, (_, o) => JSON.parse(reopened.getFieldInfoAt(0, 1, o)) as { inField?: boolean }).some(x => x.inField);
        expect(anyField || field.inField).toBe(true);
      } finally { reopened.free(); }
    } finally { d.free(); }
  });
});
