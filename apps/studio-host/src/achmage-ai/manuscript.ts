import { hasListMarker, outlineToMarkdown, parseOutline, type OutlineNode } from './outline-ast';

/**
 * A chat message may carry a pasted manuscript: "아래 텍스트를 선택한 템플릿으로 만들어" followed by
 * 25 pages of text, or the text first and "위 내용을 보고서로" last. Only the instruction is read for
 * routing and for style wording (글꼴·pt·자간·제목/본문); the manuscript is document content, so
 * the words "제목", "바탕", "12pt" inside it are never taken as instructions.
 */
export interface SplitMessage { instruction: string; manuscript: string; manuscriptFirst: boolean }

/** "아래/다음 텍스트·내용·글·원고 …" (manuscript follows) and "위/앞 …" (manuscript precedes). */
const FOLLOWS = /(?:아래|다음|밑|이하)(?:의|에)?\s*(?:텍스트|내용|글|원고|자료|문서|본문|초안|문장|문단)/u;
const PRECEDES = /(?:위|앞|이상)(?:의|에)?\s*(?:텍스트|내용|글|원고|자료|문서|본문|초안|문장|문단)/u;
/** A message this long is a manuscript even without a pointing phrase; its first line is the instruction. */
const LONG_MESSAGE_CHARS = 4000;
const INSTRUCTION_MAX_CHARS = 1000;

const charCount = (text: string) => Array.from(text).length;

/** Above this many characters a manuscript put into a template is typeset locally instead of retyped by a model. */
export const LOCAL_MANUSCRIPT_CHARS = 8000;
/** The instruction asks for new or changed writing (not "put this text into the template"), so a model writes it. */
export const REWRITE_REQUEST = /(?:바탕으로|참고|토대로|기반으로|요약|다듬|고쳐|수정|윤문|교정|줄여|늘려|확장|보강|번역|새로\s*(?:써|작성)|다시\s*(?:써|작성)|작성해|써\s*(?:줘|주세요))/u;

export function splitManuscript(text: string): SplitMessage {
  const normalized = text.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const whole = { instruction: text, manuscript: '', manuscriptFirst: false };
  if (lines.length < 2) return whole;
  // Instruction first: the head up to the first blank line (or the first line), when it points below.
  const headEnd = lines.findIndex((line, index) => index > 0 && !line.trim());
  const firstBlock = lines.slice(0, headEnd > 0 ? headEnd : 1).join('\n');
  const head = charCount(firstBlock) <= INSTRUCTION_MAX_CHARS && FOLLOWS.test(firstBlock) ? firstBlock : FOLLOWS.test(lines[0]) ? lines[0] : '';
  if (head) {
    const manuscript = normalized.slice(head.length).replace(/^\n+/, '');
    if (manuscript.trim()) return { instruction: head.trim(), manuscript, manuscriptFirst: false };
  }
  // Instruction last: "…(원고)…\n\n위 내용을 보고서로 만들어".
  const last = lines[lines.length - 1].trim() ? lines.length - 1 : lines.length - 2;
  if (last > 0 && charCount(lines[last]) <= INSTRUCTION_MAX_CHARS && PRECEDES.test(lines[last])) {
    const manuscript = lines.slice(0, last).join('\n').replace(/\n+$/, '');
    if (manuscript.trim()) return { instruction: lines[last].trim(), manuscript, manuscriptFirst: true };
  }
  // A long paste without a pointing phrase: the first line is the instruction when it is short.
  if (charCount(normalized) > LONG_MESSAGE_CHARS && charCount(lines[0]) <= INSTRUCTION_MAX_CHARS) {
    const manuscript = lines.slice(1).join('\n').replace(/^\n+/, '');
    if (manuscript.trim()) return { instruction: lines[0].trim(), manuscript, manuscriptFirst: false };
  }
  return whole;
}

/** What the request router sees: the instruction and a short look at the pasted manuscript, never all of it. */
export function routerMessage(text: string, edge = 600): string {
  const { instruction, manuscript } = splitManuscript(text);
  if (!manuscript) {
    const chars = Array.from(text);
    return chars.length <= LONG_MESSAGE_CHARS ? text : `${chars.slice(0, 2 * edge).join('')}\n[…메시지 가운데 ${chars.length - 3 * edge}자 생략…]\n${chars.slice(-edge).join('')}`;
  }
  const chars = Array.from(manuscript);
  const preview = chars.length <= 2 * edge ? manuscript : `${chars.slice(0, edge).join('')}\n[…${chars.length - 2 * edge}자 생략…]\n${chars.slice(-edge).join('')}`;
  return `${instruction}\n[함께 붙여 넣은 원고 ${chars.length}자 — 앱이 원고 전체를 그대로 문서 작업에 씁니다]\n${preview}`;
}

/**
 * The pasted manuscript as Kordoc Markdown, read locally (□ ○ 1. 가. headings, "라벨: 내용", | or tab
 * tables, lines broken mid-sentence). Nothing is rewritten, so any length works. A short first line
 * that is not a sentence becomes the title, and a short top-level item that opens a section (followed
 * by text rather than a sibling item, e.g. "1. 추진 배경") becomes a chapter heading.
 */
export function manuscriptMarkdown(manuscript: string): string {
  const sentence = (text: string) => /[.!?。…]$|[다요음함임됨]\s*$/u.test(text);
  // A short heading line ("1. 추진 배경", "Ⅱ. 현황", "제2장 개요") is never the start of a sentence broken
  // across lines, so the next line does not continue it. Chapter wording without a list marker becomes ##.
  const lines = manuscript.replace(/\r\n?/g, '\n').split('\n').flatMap(line => {
    const trimmed = line.trim();
    if (charCount(trimmed) > 40 || sentence(trimmed)) return [line];
    if (/^(?:제\s*\d+\s*[장절편부]|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+\.)\s*\S/u.test(trimmed)) return [`## ${trimmed}`, ''];
    return hasListMarker(trimmed) ? [line, ''] : [line];
  });
  const nodes: OutlineNode[] = parseOutline(lines.join('\n'));
  const first = nodes[0];
  if (first && first.kind === 'paragraph' && !nodes.some(n => n.kind === 'heading' && n.level === 1)
    && charCount(first.text) <= 80 && !sentence(first.text)) {
    nodes[0] = { kind: 'heading', level: 1, text: first.text };
  }
  const titled = nodes.filter(n => n.kind === 'heading' && n.level === 1).length === 1;
  return outlineToMarkdown(nodes.map((n, index) => {
    const next = nodes[index + 1];
    const opensSection = n.kind === 'item' && n.level === 1 && charCount(n.text) <= 40 && !sentence(n.text)
      && !!next && !(next.kind === 'item' && next.level === 1);
    return opensSection ? { kind: 'heading', level: titled ? 2 : 1, text: n.text } : n;
  }));
}
