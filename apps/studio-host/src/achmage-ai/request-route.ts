import type { TextFormat } from './text-format';
import { asksForDocumentWriting, asksForEditing, asksForWholeDocumentRecomposition, mentionsWholeDocument, shouldUseStructuredEdit } from './document-intent';
import { splitManuscript } from './manuscript';

/**
 * One owner for "what will this message do?". The panel sends through the route and shows the same
 * route as a hint before sending, so the user sees whether the document, the selection, the caret
 * or only the chat is affected. Routing is local and deterministic; it never authorizes more than
 * the route says (a whole-document rewrite is one Ctrl+Z).
 */
export interface RouteInput {
  text: string;
  /** "선택 영역 편집" toggle in the panel. */
  editMode: boolean;
  /** A non-empty selection exists in the document. */
  hasSelection: boolean;
  /** The inline popover already captured the selection. */
  captured: boolean;
  /** Inline Ctrl+A request for the whole document. */
  whole: boolean;
  /** A document template (서식) is selected. */
  template: boolean;
  documentOpen: boolean;
  blankDocument: boolean;
}

export type Route =
  | { kind: 'compose'; placement: 'current' | 'new'; recompose: boolean; fallbackTemplate: boolean }
  | { kind: 'needs-template' }
  | { kind: 'structured'; usesSelection: boolean; scope?: 'whole' | 'insertion' | 'recent' }
  | { kind: 'insert-answer' }
  | { kind: 'selection-edit'; usesSelection: boolean }
  | { kind: 'insert' }
  | { kind: 'restyle' }
  | { kind: 'tidy-draft' }
  | { kind: 'calculate'; calc?: string }
  | { kind: 'toc' }
  | { kind: 'text-format'; format?: TextFormat }
  | { kind: 'chat' };

/** Style/table wording that a plain text replacement cannot honour. */
export function needsStructure(text: string): boolean {
  return /(?:글꼴|폰트|자간|줄\s*간격|정렬|굵게|굵기|글자\s*크기|테이블|(?:^|\s)표(?:를|로|도|와|랑|\s|$)|\d+(?:\.\d+)?\s*pt)/iu.test(text);
}

export function classifyRequest(input: RouteInput): Route {
  // Only the instruction is read: words inside a pasted manuscript ("표", "요약", "전체") are content.
  const { instruction: text, manuscript } = splitManuscript(input.text);
  // "아래 텍스트를 선택한 템플릿으로 만들어" + a pasted manuscript: a new document in the chosen template.
  if (manuscript.trim() && input.template && !input.captured && !input.editMode && !input.whole
    && /(?:만들|적용|입혀|넣어|변환|옮겨|조판|서식|양식|템플릿|작성|써)/u.test(text)) {
    return { kind: 'compose', placement: input.documentOpen && input.blankDocument ? 'current' : 'new', recompose: false, fallbackTemplate: false };
  }
  const recompose = !input.captured && (input.whole || !input.editMode && asksForWholeDocumentRecomposition(text));
  const usesSelection = input.captured || (!recompose && input.hasSelection && (input.editMode || asksForEditing(text)));
  if (recompose && !input.template && !input.whole) return { kind: 'needs-template' };
  const template = input.template || recompose;
  if (template && !usesSelection && (recompose || !input.editMode && asksForDocumentWriting(text) && !input.hasSelection)) {
    return { kind: 'compose', placement: input.documentOpen && (recompose || input.blankDocument) ? 'current' : 'new', recompose, fallbackTemplate: recompose && !input.template };
  }
  if ((!usesSelection || needsStructure(text)) && (shouldUseStructuredEdit(text) || input.template && (usesSelection || asksForDocumentWriting(text) || asksForEditing(text)))) {
    return { kind: 'structured', usesSelection };
  }
  if (usesSelection || input.editMode || asksForEditing(text)) return { kind: 'selection-edit', usesSelection };
  if (asksForDocumentWriting(text)) return { kind: 'insert' };
  return { kind: 'chat' };
}

/** The pre-send hint: what the message will change, in the user's terms. */
export function describeRoute(route: Route, text: string, templateName?: string): string {
  const undo = ' · Ctrl+Z로 되돌리기';
  switch (route.kind) {
    case 'compose':
      if (route.recompose) return `현재 문서 전체를 '${templateName ?? '보고서'}' 서식으로 다시 구성합니다${undo}`;
      return `템플릿: ${templateName ?? ''}${route.placement === 'current' ? ' · 이 빈 문서에 작성' : ' · 새 문서로 작성'}`;
    case 'needs-template': return '문서 전체를 다시 구성하려면 먼저 문서 서식을 선택하세요.';
    case 'structured':
      if (route.usesSelection) return `선택한 문단을 서식까지 함께 고칩니다${undo}`;
      if (mentionsWholeDocument(text)) return `문서 본문 전체를 고칩니다${undo}`;
      return `현재 커서에 작성합니다${undo}`;
    case 'selection-edit': return route.usesSelection ? `선택한 부분을 고칩니다${undo}` : `커서가 있는 문단을 고칩니다${undo}`;
    case 'insert': return `현재 커서에 작성합니다${undo}`;
    case 'insert-answer': return `직전 답변을 커서 위치에 넣습니다${undo}`;
    case 'restyle': return `내용은 그대로 두고 '${templateName ?? '선택한'}' 서식만 적용합니다${undo}`;
    case 'text-format': return `선택한 글자의 서식만 바꿉니다${undo}`;
    case 'tidy-draft': return `선택한 초안을 항목·표로 정리합니다(AI 없이)${undo}`;
    case 'calculate': return `선택한 숫자·날짜를 계산해 바꿉니다(AI 없이)${undo}`;
    case 'toc': return `목차 쪽 번호를 지금 쪽에 맞게 채웁니다(AI 없이)${undo}`;
    case 'chat': return '대화로 답합니다 · 문서는 바뀌지 않습니다';
  }
}
