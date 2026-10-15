import { describe, expect, it } from 'vitest';
import { calculatorChoices, changeCell, changeSentence, fixWeekdays, koreanAmountWords, officialAmount, officialDate, officialPeriod, parseKoreanDate, relativePeriod, weekday, withCommas } from './calculators';

describe('deterministic calculators', () => {
  it('writes amounts the official way, every digit spoken', () => {
    expect(officialAmount(1234567890)).toBe('금1,234,567,890원(금일십이억삼천사백오십육만칠천팔백구십원)');
    expect(officialAmount('113,560원')).toBe('금113,560원(금일십일만삼천오백육십원)');
    expect(koreanAmountWords(10000)).toBe('일만');
    expect(koreanAmountWords(100000000)).toBe('일억');
    expect(koreanAmountWords(1000000000000)).toBe('일조');
    expect(koreanAmountWords(101001)).toBe('일십만일천일');
    expect(koreanAmountWords(0)).toBe('영');
    expect(() => koreanAmountWords('-5')).toThrow();
    expect(withCommas('0001234')).toBe('1,234');
    expect(withCommas(-9876543)).toBe('-9,876,543');
  });

  it('reads common date forms and writes them with the computed weekday', () => {
    const expected = { year: 2026, month: 1, day: 1 };
    for (const text of ['2026-01-01', '2026.1.1.', '2026. 1. 1.', '2026/01/01', '2026년 1월 1일', '20260101', '2026. 1. 1.(수)']) expect(parseKoreanDate(text), text).toEqual(expected);
    expect(officialDate(expected)).toBe('2026. 1. 1.(목)');
    expect(weekday({ year: 2026, month: 10, day: 14 })).toBe('수');
    expect(parseKoreanDate('10월 19일', { year: 2026, month: 10, day: 14 })).toEqual({ year: 2026, month: 10, day: 19 });
    expect(() => parseKoreanDate('2026-02-30')).toThrow('날짜');
    expect(officialDate(parseKoreanDate('2028-02-29'))).toBe('2028. 2. 29.(화)');
  });

  it('computes relative periods from a base day', () => {
    const base = { year: 2026, month: 10, day: 14 }; // a Wednesday
    expect(officialPeriod(relativePeriod('오늘', base))).toBe('2026. 10. 14.(수)');
    expect(officialPeriod(relativePeriod('다음 주', base))).toBe('2026. 10. 19.(월) ~ 2026. 10. 23.(금)');
    expect(officialPeriod(relativePeriod('이번 주', base))).toBe('2026. 10. 12.(월) ~ 2026. 10. 16.(금)');
    expect(officialPeriod(relativePeriod('다음 달', base))).toBe('2026. 11. 1.(일) ~ 2026. 11. 30.(월)');
    expect(officialPeriod(relativePeriod('다음 달', { year: 2026, month: 12, day: 3 }))).toBe('2027. 1. 1.(금) ~ 2027. 1. 31.(일)');
  });

  it('writes change sentences with the right particle, %p for percentages and △ in table cells', () => {
    expect(changeSentence(120, 150, '명')).toBe('120명→150명으로 30명(25.0%) 증가');
    expect(changeSentence(200, 150, '건')).toBe('200건→150건으로 50건(25.0%) 감소');
    expect(changeSentence(40, 35, '%')).toBe('40%→35%로 5%p 감소');
    expect(changeSentence(1200000, 1500000, '원')).toBe('1,200,000원→1,500,000원으로 300,000원(25.0%) 증가');
    expect(changeSentence(3, 3, '개')).toBe('3개→3개로 변동 없음');
    expect(changeSentence(0, 5)).toBe('0→5로 5 증가');
    expect(changeSentence(100, 150)).toBe('100→150으로 50(50.0%) 증가');
    expect(changeSentence(10, 7)).toBe('10→7로 3(30.0%) 감소');
    expect(changeSentence(2, 3.6)).toBe('2→3.6으로 1.6(80.0%) 증가');
    expect(changeCell(200, 150)).toBe('△50');
    expect(changeCell(120, 150)).toBe('30');
  });

  it('offers one-tap calculations only for what the selection actually is', () => {
    const base = { year: 2026, month: 10, day: 14 };
    expect(calculatorChoices('1234567890원', base)).toEqual([{ label: '금액 한글 병기', result: '금1,234,567,890원(금일십이억삼천사백오십육만칠천팔백구십원)' }, { label: '천 단위 쉼표', result: '1,234,567,890원' }]);
    expect(calculatorChoices('금113,560원', base).map(c => c.label)).toEqual(['금액 한글 병기']);
    expect(calculatorChoices('2026-01-01', base)).toEqual([{ label: '공문 날짜', result: '2026. 1. 1.(목)' }]);
    expect(calculatorChoices('2026. 1. 1.(목)', base)).toEqual([]);
    expect(calculatorChoices('120명 150명', base)).toEqual([{ label: '증감 문장', result: '120명→150명으로 30명(25.0%) 증가' }]);
    expect(calculatorChoices('회의 결과를 정리합니다', base)).toEqual([]);
    expect(calculatorChoices('3', base)).toEqual([]);
  });

  it('corrects wrong weekdays in written dates and reports each fix', () => {
    expect(fixWeekdays('시행: 2026. 1. 1.(수), 마감 2026. 10. 14.(수)')).toEqual({ text: '시행: 2026. 1. 1.(목), 마감 2026. 10. 14.(수)', fixes: ['2026. 1. 1.(수→목)'] });
    expect(fixWeekdays('2026. 2. 30.(월)')).toEqual({ text: '2026. 2. 30.(월)', fixes: [] });
  });
});
