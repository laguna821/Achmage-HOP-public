import type { WasmBridge } from '@/upstream/core';
import type { InputHandler } from '@/upstream/editor';

/**
 * Where the caret or selection is, in the terms the AI entries need. Cheap enough for opening a
 * context menu: positions and the selected text only (bounded); no document capture or hashing.
 */
export type SelectionKind =
  | 'no-document' | 'empty-document' | 'caret-body' | 'caret-cell' | 'caret-other'
  | 'partial-paragraph' | 'multi-paragraph' | 'whole-paragraphs' | 'whole-document'
  | 'cell-text' | 'cell-block' | 'other-object';

export interface SelectionContext { kind: SelectionKind; paragraphs: number; chars: number; text: string }

type Position = ReturnType<InputHandler['getCursorPosition']>;
type Wasm = Pick<WasmBridge, 'pageCount' | 'getSectionCount' | 'getParagraphCount' | 'getParagraphLength' | 'getTextRange'>;
const MAX_TEXT = 4000;
const inCell = (p: Position) => p.parentParaIndex !== undefined || p.cellIndex !== undefined || !!p.cellPath?.length;
const attempt = <T>(read: () => T, fallback: T): T => { try { return read(); } catch { return fallback; } };

export function classifySelection(wasm: Wasm, input: Pick<InputHandler, 'getSelection' | 'getCursorPosition'> | undefined): SelectionContext {
  const none = (kind: SelectionKind): SelectionContext => ({ kind, paragraphs: 0, chars: 0, text: '' });
  if (wasm.pageCount === 0) return none('no-document');
  const selection = attempt(() => input?.getSelection() ?? null, null);
  const collapsed = !selection || selection.start.sectionIndex === selection.end.sectionIndex && selection.start.paragraphIndex === selection.end.paragraphIndex && selection.start.charOffset === selection.end.charOffset && !inCell(selection.start) && !inCell(selection.end);
  if (collapsed) {
    const caret = attempt(() => input?.getCursorPosition() ?? null, null);
    if (caret && inCell(caret)) return none('caret-cell');
    if (caret?.isTextBox) return none('caret-other');
    const blank = attempt(() => wasm.getSectionCount() === 1 && wasm.getParagraphCount(0) === 1 && wasm.getParagraphLength(0, 0) === 0, false);
    return none(blank ? 'empty-document' : 'caret-body');
  }
  const { start, end } = selection!;
  if (inCell(start) && inCell(end)) {
    const one = start.sectionIndex === end.sectionIndex && start.parentParaIndex === end.parentParaIndex && start.controlIndex === end.controlIndex && start.cellIndex === end.cellIndex && (start.cellPath?.length ?? 1) <= 1 && (end.cellPath?.length ?? 1) <= 1 && !start.isTextBox;
    return { ...none(one ? 'cell-text' : 'cell-block'), paragraphs: 1 };
  }
  if (inCell(start) || inCell(end) || start.isTextBox || end.isTextBox || start.sectionIndex !== end.sectionIndex) return { ...none('other-object'), paragraphs: 1 };
  const [a, b] = start.paragraphIndex < end.paragraphIndex || start.paragraphIndex === end.paragraphIndex && start.charOffset <= end.charOffset ? [start, end] : [end, start];
  const section = a.sectionIndex, length = (p: number) => attempt(() => wasm.getParagraphLength(section, p), 0);
  const parts: string[] = []; let budget = MAX_TEXT;
  for (let p = a.paragraphIndex; p <= b.paragraphIndex && budget > 0; p++) {
    const from = p === a.paragraphIndex ? a.charOffset : 0, to = Math.min(p === b.paragraphIndex ? b.charOffset : length(p), from + budget);
    const text = to > from ? attempt(() => wasm.getTextRange(section, p, from, to - from), '') : '';
    parts.push(text); budget -= Array.from(text).length;
  }
  const text = parts.join('\n'), paragraphs = b.paragraphIndex - a.paragraphIndex + 1, chars = Array.from(text).length;
  const fromStart = a.charOffset === 0, toEnd = b.charOffset >= length(b.paragraphIndex);
  const lastSection = attempt(() => wasm.getSectionCount(), 1) - 1, lastParagraph = attempt(() => wasm.getParagraphCount(section), 1) - 1;
  const kind: SelectionKind = fromStart && toEnd && section === 0 && lastSection === 0 && a.paragraphIndex === 0 && b.paragraphIndex === lastParagraph && lastParagraph > 0
    ? 'whole-document'
    : fromStart && toEnd ? 'whole-paragraphs' : paragraphs === 1 ? 'partial-paragraph' : 'multi-paragraph';
  return { kind, paragraphs, chars, text };
}

/** The AI row of the right-click menu for this context, or null when there is nothing to offer. */
export function aiMenuEntryFor(context: SelectionContext): { label: string; mode: 'selection' | 'caret'; disabledReason?: string } | null {
  switch (context.kind) {
    case 'no-document': return null;
    case 'empty-document': case 'caret-body': return { label: 'AI로 여기에 쓰기…', mode: 'caret' };
    case 'partial-paragraph': case 'multi-paragraph': case 'whole-paragraphs': return { label: 'AI로 선택 영역 편집…', mode: 'selection' };
    case 'whole-document': return { label: 'AI로 문서 전체 편집…', mode: 'selection' };
    case 'cell-text': return { label: 'AI로 셀 글 편집…', mode: 'selection' };
    case 'caret-cell': return { label: 'AI로 셀 글 편집…', mode: 'selection', disabledReason: '셀 안의 글을 선택하면 그 셀만 AI로 고칩니다.' };
    case 'cell-block': return { label: 'AI로 표 편집…', mode: 'selection', disabledReason: '여러 셀에 걸친 편집은 아직 지원하지 않습니다. 셀 하나 안의 글을 선택하세요.' };
    case 'caret-other': case 'other-object': return { label: 'AI로 편집…', mode: 'selection', disabledReason: '글상자·개체 안이나 표에 걸친 선택은 아직 지원하지 않습니다. 본문 문단만 선택하세요.' };
  }
}

/** Target language for the one-tap translate chip: Korean text goes to English, anything else to Korean. */
export function translationInstruction(text: string): string {
  // A Latin word spends several letters where Korean spends one or two syllables; weigh letters accordingly.
  const chars = Array.from(text), hangul = chars.filter(c => /\p{Script=Hangul}/u.test(c)).length, other = chars.filter(c => /\p{L}/u.test(c) && !/\p{Script=Hangul}/u.test(c)).length;
  return hangul && hangul / (hangul + other * 0.4) >= 0.3 ?'자연스러운 영어로 번역해줘. 고유명사와 숫자는 그대로 둬.' : '자연스러운 한국어로 번역해줘. 고유명사와 숫자는 그대로 둬.';
}
