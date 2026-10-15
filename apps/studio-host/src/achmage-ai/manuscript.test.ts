import { describe, expect, it } from 'vitest';
import { LOCAL_MANUSCRIPT_CHARS, REWRITE_REQUEST, manuscriptMarkdown, routerMessage, splitManuscript } from './manuscript';
import { resolveDocumentTemplate } from './document-intent';
import { classifyRequest, type RouteInput } from './request-route';
import { roleTemplateFixture } from './document-template-fixture';

/** 2026-10-15 user report: a 25-page (122,486-byte) paste with "아래 텍스트를 선택한 템플릿으로 만들어" failed with
 * "한 역할에 여러 글꼴이 지정되어 있습니다" because words inside the manuscript were read as style instructions. */
const section = (n: number) => [`${n}. 추진 배경`, `제목과 본문을 바탕 12pt, 돋움 10pt로 비교한 결과를 표로 정리하고 전체 내용을 요약했다. 문단 ${n}의 설명이 이어진다.`, '| 구분 | 내용 |', '| --- | --- |', `| 항목 ${n} | 값 ${n} |`].join('\n');
const manuscript = ['2026년 사업 추진 보고', '', ...Array.from({ length: 200 }, (_, i) => section(i + 1))].join('\n\n');

describe('pasted manuscript', () => {
  it('separates the instruction from a manuscript below, above or after a long first line', () => {
    expect(splitManuscript(`아래 텍스트를 선택한 템플릿으로 만들어\n\n${manuscript}`)).toMatchObject({ instruction: '아래 텍스트를 선택한 템플릿으로 만들어', manuscriptFirst: false });
    expect(splitManuscript(`아래 텍스트를 선택한 템플릿으로 만들어\n\n${manuscript}`).manuscript.startsWith('2026년 사업 추진 보고')).toBe(true);
    expect(splitManuscript(`${manuscript}\n\n위 내용을 보고서 서식으로 만들어줘`)).toMatchObject({ instruction: '위 내용을 보고서 서식으로 만들어줘', manuscriptFirst: true });
    expect(splitManuscript(`이걸로 문서 만들어\n${manuscript}`).instruction).toBe('이걸로 문서 만들어');
    // Short ordinary requests stay whole.
    expect(splitManuscript('본문은 신명조 11pt로 회의자료를 만들어보자')).toMatchObject({ instruction: '본문은 신명조 11pt로 회의자료를 만들어보자', manuscript: '' });
  });

  it('reads style wording only from the instruction, so manuscript words are not instructions', () => {
    const fonts = ['함초롬바탕', '함초롬돋움', '신명조', '바탕', '돋움'];
    const text = `아래 텍스트를 선택한 템플릿으로 만들어\n\n${manuscript}`;
    expect(new TextEncoder().encode(text).length).toBeGreaterThan(32768);
    const before = roleTemplateFixture(), resolved = resolveDocumentTemplate(before, text, fonts);
    expect(resolved.template.roles).toEqual(roleTemplateFixture().roles);
    // Wording in the instruction itself still applies.
    expect(resolveDocumentTemplate(roleTemplateFixture(), `아래 내용을 본문은 신명조 11pt로 만들어\n\n${manuscript}`, fonts).template.roles.body).toMatchObject({ fontFamily: '신명조', fontSizePt: 11 });
  });

  it('routes on the instruction, not on "표"·"요약"·"전체" inside the manuscript', () => {
    const base: RouteInput = { text: '', editMode: false, hasSelection: false, captured: false, whole: false, template: true, documentOpen: true, blankDocument: true };
    expect(classifyRequest({ ...base, text: `아래 텍스트를 선택한 템플릿으로 만들어\n\n${manuscript}` })).toMatchObject({ kind: 'compose', recompose: false });
  });

  it('gives the router the instruction and a short look at the manuscript only', () => {
    const message = routerMessage(`아래 텍스트를 선택한 템플릿으로 만들어\n\n${manuscript}`);
    expect(message.startsWith('아래 텍스트를 선택한 템플릿으로 만들어\n[함께 붙여 넣은 원고')).toBe(true);
    expect(Array.from(message).length).toBeLessThan(2000);
    expect(routerMessage('짧은 질문')).toBe('짧은 질문');
  });

  it('typesets a manuscript as written: title, chapter headings, real tables, every sentence kept', () => {
    const markdown = manuscriptMarkdown(manuscript);
    expect(markdown.startsWith('# 2026년 사업 추진 보고\n')).toBe(true);
    expect(markdown).toContain('## 추진 배경');
    expect(markdown).toContain('| 항목 200 | 값 200 |');
    for (let n = 1; n <= 200; n++) expect(markdown).toContain(`문단 ${n}의 설명이 이어진다.`);
    expect(Array.from(manuscript).length).toBeGreaterThan(LOCAL_MANUSCRIPT_CHARS);
  });

  it('leaves writing requests to the model', () => {
    for (const t of ['아래 내용을 바탕으로 보고서를 작성해줘', '아래 글을 요약해서 만들어', '아래 원고를 다듬어서 서식에 넣어']) expect(REWRITE_REQUEST.test(t), t).toBe(true);
    for (const t of ['아래 텍스트를 선택한 템플릿으로 만들어', '아래 내용을 바탕체로 만들어', '위 내용을 보고서 서식으로 만들어줘']) expect(REWRITE_REQUEST.test(t), t).toBe(false);
  });
});
