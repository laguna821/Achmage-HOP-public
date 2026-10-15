/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { bodyDocument, fixtureBytes, historyHarness } from './test-support/history-harness';
import { roleTemplateFixture } from './document-template-fixture';
import { tidySelectedDraft } from './draft-tidy';
import type { OperationId } from './intent-router';

type Harness = ReturnType<typeof historyHarness>;
interface OperationCase<T> {
  /** Router operation(s) whose document change runs through this primitive. */
  ops: OperationId[];
  label: string;
  bytes: () => Uint8Array;
  prepare(h: Harness): void;
  /** What the request captured before the AI or local step; `undefined` when the primitive reads the live selection. */
  capture(h: Harness): T;
  apply(h: Harness, captured: T): Promise<unknown>;
  /** Whether a capture taken before the document changed must be refused. */
  fenced: boolean;
}
const len = (h: Harness, p: number) => h.native.getParagraphLength(0, p);
const plan = () => ({ schemaVersion: 2, operation: 'replace_paragraphs', styles: { body: { fontFamily: '함초롬바탕', fontSizePt: 11, bold: false, spacingPercent: 0 }, head: { fontFamily: '함초롬바탕', fontSizePt: 15, bold: true, spacingPercent: 0 } },
  blocks: [{ type: 'paragraph', runs: [{ text: '새 제목', style: 'head' }], paragraphFormat: { alignment: 'center', lineSpacingPercent: 160 } },
    { type: 'table', rows: [[{ runs: [{ text: '구분', style: 'head' }], paragraphFormat: { alignment: 'center', lineSpacingPercent: 160 } }, { runs: [{ text: '내용', style: 'head' }], paragraphFormat: { alignment: 'center', lineSpacingPercent: 160 } }], [{ runs: [{ text: '예산', style: 'body' }], paragraphFormat: { alignment: 'left', lineSpacingPercent: 160 } }, { runs: [{ text: '100', style: 'body' }], paragraphFormat: { alignment: 'right', lineSpacingPercent: 160 } }]] },
    { type: 'paragraph', runs: [{ text: '표 뒤 본문', style: 'body' }], paragraphFormat: { alignment: 'justify', lineSpacingPercent: 160 } }] });
const report = () => bodyDocument(['결과 보고', '1. 추진 배경', '개편은 학생 선택권을 넓히기 위해 추진되었으며 위원회는 개편안을 확정하였다.', '2. 향후 계획', '다음 학기부터 단계적으로 시행한다.']);

const CASES: OperationCase<any>[] = [
  { ops: ['insert_at_caret', 'insert_answer', 'edit_recent'], label: '커서 위치에 쓰기', bytes: () => bodyDocument(['첫 문단 가나다', '둘째 문단']), prepare: h => h.caret(1, 2),
    capture: h => h.adapter.captureInsertion(), apply: (h, c) => h.adapter.apply(c, '새 글\n두 줄'), fenced: true },
  { ops: ['edit_selection'], label: '선택 교체', bytes: () => bodyDocument(['첫 문단 가나다', '둘째 문단']), prepare: h => h.select(1, 0, 1, 2),
    capture: h => h.adapter.captureSelection(), apply: (h, c) => h.adapter.apply(c, '바뀐'), fenced: true },
  { ops: ['edit_selection', 'edit_whole_body'], label: '여러 문단 교체', bytes: () => bodyDocument(['첫 문단 가나다', '둘째 문단', '셋째 문단']), prepare: h => h.select(0, 2, 2, 3),
    capture: h => h.adapter.captureSelection(), apply: (h, c) => h.adapter.apply(c, '하나\n둘'), fenced: true },
  { ops: ['calculate_selection'], label: '계산 결과 넣기', bytes: () => bodyDocument(['합계 1200 + 300']), prepare: h => h.select(0, 3, 0, 13),
    capture: h => h.adapter.captureSelection(), apply: (h, c) => h.adapter.apply(c, '1500'), fenced: true },
  { ops: ['format_text'], label: '글자 서식', bytes: () => bodyDocument(['첫 문단 가나다', '둘째 문단']), prepare: h => h.select(1, 0, 1, 2),
    capture: () => undefined, apply: h => h.adapter.applyTextFormat({ bold: true }), fenced: false },
  { ops: ['format_selection'], label: '서식 작성(표 포함)', bytes: () => bodyDocument(['첫 문단', '둘째 문단']), prepare: h => h.select(0, 0, 1, len(h, 1)),
    capture: h => h.adapter.captureStructured(), apply: (h, c) => h.adapter.applyStructured(c, plan()), fenced: true },
  { ops: ['tidy_draft'], label: '초안 정리', bytes: () => bodyDocument(['1. 개요', '□ 첫 항목', '- 세부 내용', '구분 | 예산', '인건비 | 100']), prepare: h => h.select(0, 0, 4, len(h, 4)),
    capture: () => undefined, apply: h => tidySelectedDraft(h.adapter), fenced: false },
  { ops: ['restyle_document'], label: '서식만 바꾸기', bytes: report, prepare: () => {},
    capture: h => h.adapter.identity(), apply: (h, id) => h.adapter.applyRestyle(id, roleTemplateFixture()), fenced: true },
  { ops: ['refresh_toc'], label: '목차 새로 고침', bytes: () => fixtureBytes('kordoc-meeting-toc.hwpx'), prepare: () => {},
    capture: h => h.adapter.identity(), apply: (h, id) => h.adapter.applyTocRefresh(id), fenced: true },
  { ops: ['recompose_document'], label: '현재 창 전체 재구성', bytes: report, prepare: () => {},
    capture: h => h.adapter.identity(), apply: (h, id) => h.adapter.applyWholeDocument(id, fixtureBytes('kordoc-report-cover.hwpx'), { hideFirstPage: true }), fenced: true },
];

describe('one undo contract for every document-changing operation (T02)', () => {
  it('covers every operation the router can run against the open document', () => {
    const covered = new Set(CASES.flatMap(c => c.ops));
    // write_new_document opens a new window; answers and questions change nothing.
    for (const op of ['recompose_document', 'restyle_document', 'edit_selection', 'format_text', 'tidy_draft', 'calculate_selection', 'refresh_toc', 'format_selection', 'edit_whole_body', 'edit_recent', 'insert_at_caret', 'insert_answer'] as OperationId[]) expect(covered.has(op), op).toBe(true);
  });

  for (const c of CASES) {
    it(`${c.label}: history +1, one Ctrl+Z restores the exported bytes, Redo repeats the result`, async () => {
      const h = historyHarness(c.bytes());
      try {
        c.prepare(h);
        const before = h.native.exportHwpx(); expect(h.history.canUndo()).toBe(false);
        await c.apply(h, c.capture(h));
        const after = h.native.exportHwpx(); expect(after).not.toEqual(before); expect(h.depth()).toBe(1);
        h.undo(); expect(h.native.exportHwpx()).toEqual(before); expect(h.history.canUndo()).toBe(false);
        h.redo(); expect(h.native.exportHwpx()).toEqual(after);
      } finally { h.close(); }
    });

    it(`${c.label}: a failed apply leaves the original bytes and no history entry`, async () => {
      const h = historyHarness(c.bytes());
      try {
        c.prepare(h); const before = h.native.exportHwpx(), captured = c.capture(h);
        h.failRender();
        await expect(c.apply(h, captured)).rejects.toThrow();
        expect(h.native.exportHwpx()).toEqual(before); expect(h.history.canUndo()).toBe(false);
      } finally { h.close(); }
    });

    if (c.fenced) it(`${c.label}: a capture from before the document changed is refused without touching it`, async () => {
      const h = historyHarness(c.bytes());
      try {
        c.prepare(h); const before = h.native.exportHwpx(), captured = c.capture(h);
        h.reopen();
        await expect(c.apply(h, captured)).rejects.toThrow();
        expect(h.native.exportHwpx()).toEqual(before); expect(h.history.canUndo()).toBe(false);
      } finally { h.close(); }
    });
  }
});
