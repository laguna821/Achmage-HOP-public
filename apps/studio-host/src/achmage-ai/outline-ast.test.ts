import { describe, expect, it } from 'vitest';
import { looksLikeDraft, outlineToMarkdown, outlineToPlan, parseOutline, type OutlineNode } from './outline-ast';
import { parseStructuredPlan, structuredParagraphs } from './structured-edit';

const style = (fontSizePt: number, bold = false) => ({ fontFamily: '함초롬바탕', fontSizePt, bold, spacingPercent: 0 });
const STYLES = { title: style(16, true), heading: style(13, true), body: style(11), tableHeader: style(10, true), tableCell: style(10) };

describe('outline normalizer', () => {
  it.each<[string, string, OutlineNode[]]>([
    ['symbol draft', '□ 추진 배경\n○ 교양교육 개편\n- 세부 일정 확정\n· 담당 부서 협의', [
      { kind: 'item', level: 1, text: '추진 배경' }, { kind: 'item', level: 2, text: '교양교육 개편' }, { kind: 'item', level: 3, text: '세부 일정 확정' }, { kind: 'item', level: 4, text: '담당 부서 협의' }]],
    ['official numbering', '1. 개요\n가. 목적\n1) 세부\n가) 하위', [
      { kind: 'item', level: 1, text: '개요' }, { kind: 'item', level: 2, text: '목적' }, { kind: 'item', level: 3, text: '세부' }, { kind: 'item', level: 4, text: '하위' }]],
    ['markdown headings and nested list', '# 회의 결과\n## 안건\n- 첫째\n  - 하위', [
      { kind: 'heading', level: 1, text: '회의 결과' }, { kind: 'heading', level: 2, text: '안건' }, { kind: 'item', level: 1, text: '첫째' }, { kind: 'item', level: 2, text: '하위' }]],
    ['label lines', '일시: 2026. 10. 14.(수) 14:00\n장소: 본관 201호', [
      { kind: 'label', label: '일시', text: '2026. 10. 14.(수) 14:00' }, { kind: 'label', label: '장소', text: '본관 201호' }]],
    ['note', '※ 세부 일정은 추후 공지', [{ kind: 'note', text: '세부 일정은 추후 공지' }]],
    ['PDF line breaks joined', '줄바꿈 정렬을 확인하기 위한 긴 문장으로, 두 번째\n줄이 첫 줄의 시작 위치와 맞는지 비교합니다.\n새 문단입니다.', [
      { kind: 'paragraph', text: '줄바꿈 정렬을 확인하기 위한 긴 문장으로, 두 번째 줄이 첫 줄의 시작 위치와 맞는지 비교합니다.' }, { kind: 'paragraph', text: '새 문단입니다.' }]],
    ['wrapped item continues', '□ 교양교육 개편안을 확정하고 각 단과대학\n의견을 수렴함\n□ 다음 항목', [
      { kind: 'item', level: 1, text: '교양교육 개편안을 확정하고 각 단과대학 의견을 수렴함' }, { kind: 'item', level: 1, text: '다음 항목' }]],
    ['blank line separates paragraphs', '첫 문단 끝나지 않은\n\n둘째 문단', [{ kind: 'paragraph', text: '첫 문단 끝나지 않은' }, { kind: 'paragraph', text: '둘째 문단' }]],
    ['markdown table', '| 항목 | 금액 |\n|---|---:|\n| 인건비 | 100 |\n| 운영비 | 50 |', [{ kind: 'table', rows: [['항목', '금액'], ['인건비', '100'], ['운영비', '50']] }]],
    ['pipe table without separator and ragged rows', '구분 | 내용 | 비고\n1차 | 개편', [{ kind: 'table', rows: [['구분', '내용', '비고'], ['1차', '개편', '']] }]],
    ['tab table (copied from a spreadsheet)', '구분\t인원\n교수\t12\n학생\t40', [{ kind: 'table', rows: [['구분', '인원'], ['교수', '12'], ['학생', '40']] }]],
    ['a single tab line is text', '이름\t홍길동', [{ kind: 'paragraph', text: '이름\t홍길동' }]],
    ['URL is not a label', 'https://example.com/a', [{ kind: 'paragraph', text: 'https://example.com/a' }]],
    ['circled numbers', '① 첫째\n② 둘째', [{ kind: 'item', level: 1, text: '첫째' }, { kind: 'item', level: 1, text: '둘째' }]],
    ['mixed families compress to consecutive levels', '□ 상위\n- 하위', [{ kind: 'item', level: 1, text: '상위' }, { kind: 'item', level: 2, text: '하위' }]],
    ['indent deepens same marker', '- 상위\n  - 하위\n    - 더 하위', [{ kind: 'item', level: 1, text: '상위' }, { kind: 'item', level: 2, text: '하위' }, { kind: 'item', level: 3, text: '더 하위' }]],
    ['times are not labels', '10:30 회의 시작', [{ kind: 'paragraph', text: '10:30 회의 시작' }]],
    ['CRLF input', '□ 하나\r\n□ 둘', [{ kind: 'item', level: 1, text: '하나' }, { kind: 'item', level: 1, text: '둘' }]],
  ])('%s', (_name, input, expected) => expect(parseOutline(input)).toEqual(expected));

  it('tells drafts from plain prose', () => {
    expect(looksLikeDraft(parseOutline('□ 하나\n□ 둘'))).toBe(true);
    expect(looksLikeDraft(parseOutline('| a | b |\n| 1 | 2 |'))).toBe(true);
    expect(looksLikeDraft(parseOutline('일시: 오늘\n장소: 본관'))).toBe(true);
    expect(looksLikeDraft(parseOutline('그냥 한 문단입니다.'))).toBe(false);
    expect(looksLikeDraft(parseOutline('- 하나뿐인 항목'))).toBe(false);
  });

  it('writes Kordoc Markdown that reads back to the same outline', () => {
    const draft = '# 교양교육위원회 결과\n## 안건\n□ 개편안 확정\n○ 일정 협의\n일시: 2026. 10. 14.\n※ 추후 공지\n| 구분 | 인원 |\n|---|---|\n| 교수 | 12 |';
    const outline = parseOutline(draft), markdown = outlineToMarkdown(outline);
    expect(markdown).toContain('# 교양교육위원회 결과\n\n## 안건');
    expect(markdown).toContain('- 개편안 확정\n\n  - 일정 협의');
    expect(markdown).toContain('| 구분 | 인원 |\n| --- | --- |\n| 교수 | 12 |');
    expect(parseOutline(markdown).map(n => n.kind)).toEqual(outline.map(n => n.kind === 'label' ? 'item' : n.kind));
  });

  it('builds a valid structured plan with real tables and role styles', () => {
    const plan = parseStructuredPlan(outlineToPlan(parseOutline('# 결과 보고\n□ 첫째\n○ 둘째\n| 구분 | 인원 |\n| 교수 | 12 |'), STYLES));
    expect(plan.paragraphs.map(p => p.table ? 'table' : p.runs[0].text)).toEqual(['결과 보고', '□ 첫째', '  ○ 둘째', 'table']);
    expect(plan.paragraphs[0].runs[0]).toMatchObject({ fontSizePt: 16, bold: true }); expect(plan.paragraphs[0].paragraphFormat?.alignment).toBe('center');
    expect(plan.paragraphs[3].table?.[0][0].runs[0]).toMatchObject({ text: '구분', bold: true });
    expect(structuredParagraphs(plan)).toHaveLength(7);
  });
});
