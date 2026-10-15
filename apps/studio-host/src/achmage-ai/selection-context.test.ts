import { describe, expect, it } from 'vitest';
import { aiMenuEntryFor, classifySelection, translationInstruction, type SelectionKind } from './selection-context';

const paragraphs = ['첫 문단입니다', '둘째 문단', '셋째'];
const wasm = (texts = paragraphs, pageCount = 1) => ({
  pageCount, getSectionCount: () => 1, getParagraphCount: () => texts.length,
  getParagraphLength: (_s: number, p: number) => Array.from(texts[p]).length,
  getTextRange: (_s: number, p: number, a: number, n: number) => Array.from(texts[p]).slice(a, a + n).join(''),
});
const at = (paragraphIndex: number, charOffset: number, extra: Record<string, unknown> = {}) => ({ sectionIndex: 0, paragraphIndex, charOffset, ...extra });
const input = (selection: { start: ReturnType<typeof at>; end: ReturnType<typeof at> } | null, caret = at(0, 0)) => ({ getSelection: () => selection, getCursorPosition: () => caret });
const kind = (w: ReturnType<typeof wasm>, i: ReturnType<typeof input>) => classifySelection(w as never, i as never).kind;

describe('selection context for AI entries', () => {
  it.each<[string, ReturnType<typeof input>, SelectionKind]>([
    ['caret in body', input(null, at(1, 2)), 'caret-body'],
    ['collapsed selection', input({ start: at(1, 2), end: at(1, 2) }), 'caret-body'],
    ['caret in a table cell', input(null, at(0, 0, { parentParaIndex: 0, controlIndex: 0, cellIndex: 1 })), 'caret-cell'],
    ['part of one paragraph', input({ start: at(0, 2), end: at(0, 4) }), 'partial-paragraph'],
    ['reversed across paragraphs', input({ start: at(1, 2), end: at(0, 3) }), 'multi-paragraph'],
    ['whole paragraphs', input({ start: at(0, 0), end: at(1, 5) }), 'whole-paragraphs'],
    ['whole document (Ctrl+A)', input({ start: at(0, 0), end: at(2, 2) }), 'whole-document'],
    ['cell block', input({ start: at(0, 0, { parentParaIndex: 0, cellIndex: 0 }), end: at(0, 0, { parentParaIndex: 0, cellIndex: 3 }) }), 'cell-block'],
    ['text inside one cell', input({ start: at(0, 0, { parentParaIndex: 0, controlIndex: 0, cellIndex: 2, cellParaIndex: 0 }), end: at(0, 3, { parentParaIndex: 0, controlIndex: 0, cellIndex: 2, cellParaIndex: 0 }) }), 'cell-text'],
    ['body into a table', input({ start: at(0, 1), end: at(0, 0, { parentParaIndex: 0, cellIndex: 3 }) }), 'other-object'],
  ])('%s', (_name, i, expected) => expect(kind(wasm(), i)).toBe(expected));

  it('knows a blank or absent document and returns the selected text, bounded', () => {
    expect(kind(wasm(['']), input(null))).toBe('empty-document');
    expect(kind(wasm(paragraphs, 0), input(null))).toBe('no-document');
    expect(classifySelection(wasm() as never, input({ start: at(0, 2), end: at(1, 2) }) as never)).toEqual({ kind: 'multi-paragraph', paragraphs: 2, chars: 8, text: '문단입니다\n둘째' });
    const long = 'ㄱ'.repeat(9000);
    expect(classifySelection(wasm([long, '끝']) as never, input({ start: at(0, 0), end: at(1, 1) }) as never).chars).toBe(4000);
  });

  it('offers the right first menu row per context and explains what is not supported yet', () => {
    const entry = (k: SelectionKind) => aiMenuEntryFor({ kind: k, paragraphs: 0, chars: 0, text: '' });
    expect(entry('caret-body')).toEqual({ label: 'AI로 여기에 쓰기…', mode: 'caret' });
    expect(entry('empty-document')?.mode).toBe('caret');
    expect(entry('multi-paragraph')).toEqual({ label: 'AI로 선택 영역 편집…', mode: 'selection' });
    expect(entry('whole-document')?.label).toBe('AI로 문서 전체 편집…');
    expect(entry('cell-block')?.disabledReason).toContain('셀 하나');
    expect(entry('cell-text')).toEqual({ label: 'AI로 셀 글 편집…', mode: 'selection' });
    expect(entry('caret-cell')?.disabledReason).toContain('셀 안의 글을 선택');
    expect(entry('other-object')?.disabledReason).toContain('본문 문단만');
    expect(entry('no-document')).toBeNull();
  });

  it('translates Korean to English and anything else to Korean', () => {
    expect(translationInstruction('회의 결과를 정리합니다')).toContain('영어로');
    expect(translationInstruction('Meeting summary for HOP')).toContain('한국어로');
    expect(translationInstruction('HOP 2.0 release 노트')).toContain('영어로');
    expect(translationInstruction('Please review the 보고서 draft today')).toContain('한국어로');
  });
});
