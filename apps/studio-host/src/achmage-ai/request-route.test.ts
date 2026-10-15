import { describe, expect, it } from 'vitest';
import { asksForWholeDocumentRecomposition } from './document-intent';
import { classifyRequest, describeRoute, type RouteInput } from './request-route';

const base: RouteInput = { text: '', editMode: false, hasSelection: false, captured: false, whole: false, template: true, documentOpen: true, blankDocument: false };
const route = (text: string, extra: Partial<RouteInput> = {}) => classifyRequest({ ...base, ...extra, text });

describe('request route (what a chat message will change)', () => {
  it('sends the reported whole-document rewrite to the template engine, not to paragraph editing', () => {
    // 2026-10-14 user report: this went to structured editing and failed on the table/field objects.
    const reported = '지금 바꾼 서식에 맞춰서 제목이랑 목차 등등 다 생기게 몇장짜리로 표랑 섞어서 문서 전체를 다시써서 길게 뻥튀기해줘';
    expect(asksForWholeDocumentRecomposition(reported)).toBe(true);
    expect(route(reported)).toEqual({ kind: 'compose', placement: 'current', recompose: true, fallbackTemplate: false });
    expect(describeRoute(route(reported), reported, '한림대 일송')).toBe("현재 문서 전체를 '한림대 일송' 서식으로 다시 구성합니다 · Ctrl+Z로 되돌리기");
    for (const t of ['문서 전체를 선택한 서식으로 다시 써봐', '현재 문서 전체를 목차랑 표지 있게 새 양식으로 늘려줘', '본문 전체를 서식대로 정리해 주세요'])
      expect(route(t).kind, t).toBe('compose');
  });

  it('asks for a template instead of guessing one, unless the inline Ctrl+A whole request carries the default', () => {
    const t = '문서 전체를 새 서식으로 다시 구성해줘';
    expect(route(t, { template: false })).toEqual({ kind: 'needs-template' });
    expect(route(t, { template: false, whole: true })).toMatchObject({ kind: 'compose', recompose: true, fallbackTemplate: true });
  });

  it('keeps reviews, questions and partial scopes away from whole-document rewriting', () => {
    for (const t of ['문서 전체 서식 좀 봐줘', '문서 전체 서식을 검토해줘', '문서 전체 서식 어때?', '문서 전체에 양식을 적용하는 방법 알려줘', '현재 문서 전체 중 제목만 서식을 바꿔줘', '문서 전체를 새 서식으로 만들지 말아줘', '문서 전체 양식을 바꿨어'])
      expect(route(t).kind, t).not.toBe('compose');
    expect(route('문서 전체 서식 좀 봐줘').kind).toBe('chat');
  });

  it('edits the selection when one is selected, and needs structure only for style or table wording', () => {
    expect(route('더 간결하게 고쳐줘', { hasSelection: true, template: false })).toEqual({ kind: 'selection-edit', usesSelection: true });
    expect(route('글꼴을 신명조 11pt로 바꿔줘', { hasSelection: true, template: false })).toEqual({ kind: 'structured', usesSelection: true });
    expect(route('공문 어투로 다듬어줘', { captured: true, template: false })).toEqual({ kind: 'selection-edit', usesSelection: true });
    expect(route('문서 전체를 새 서식으로 다시 구성해줘', { captured: true })).toEqual({ kind: 'selection-edit', usesSelection: true });
  });

  it('writes at the caret, opens a new document, or just chats', () => {
    expect(route('3줄 새 글을 써줘', { template: false })).toEqual({ kind: 'insert' });
    expect(route('회의 자료 만들어 줘')).toEqual({ kind: 'compose', placement: 'new', recompose: false, fallbackTemplate: false });
    expect(route('회의 자료 만들어 줘', { blankDocument: true })).toMatchObject({ kind: 'compose', placement: 'current' });
    expect(route('오늘 날씨가 어때?', { template: false })).toEqual({ kind: 'chat' });
    expect(describeRoute({ kind: 'chat' }, '')).toBe('대화로 답합니다 · 문서는 바뀌지 않습니다');
    expect(route('소제목을 추가해', { template: false })).toEqual({ kind: 'structured', usesSelection: false });
  });
});
