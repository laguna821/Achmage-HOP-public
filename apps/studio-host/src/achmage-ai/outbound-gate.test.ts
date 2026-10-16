import { describe, expect, it } from 'vitest';
import { maskNotice, maskPersonal, maskPersonalDeep, maskSafeEnd, restorePersonal } from './outbound-gate';
import { gateResearchAction } from '../achmage-research/types';

describe('outbound personal-data gate', () => {
  it.each([
    ['주민번호 900101-1234567 확인', 'rrn', '900101-1234567'],
    ['외국인 9001015234567', 'rrn', '9001015234567'],
    ['연락처 010-1234-5678', 'phone', '010-1234-5678'],
    ['휴대폰 01012345678로', 'phone', '01012345678'],
    ['대표 02-123-4567', 'phone', '02-123-4567'],
    ['지역 031 765 4321', 'phone', '031 765 4321'],
    ['국제 +82 10-9876-5432', 'phone', '+82 10-9876-5432'],
    ['메일 hong.gildong@example.ac.kr 로', 'email', 'hong.gildong@example.ac.kr'],
    ['카드 4111 1111 1111 1111 결제', 'card', '4111 1111 1111 1111'],
    ['계좌 110-123-456789 (신한)', 'account', '110-123-456789'],
    ['여권 M12345678 제출', 'passport', 'M12345678'],
  ])('masks %s', (text, kind, value) => {
    const masked = maskPersonal(text);
    expect(masked.text).not.toContain(value);
    expect(masked.text).toContain('〔개인정보1〕');
    expect(masked.kinds).toEqual([kind]);
    expect(restorePersonal(masked.text, masked)).toEqual({ text, unknown: [], missing: 0 });
  });

  it.each([
    '시행일 2026. 10. 14.(수)', '2026-10-14 회의', '문서번호 제2026-123호', '예산 금1,234,567,890원', '증가율 12.5%', '전화 1588-1234',
    '20261014', '학번 20231234', '사업비 3,500,000원', '쪽 12-3', '4111 1111 1111 1112', '버전 1.2.3', '1234-5678',
  ])('leaves content alone: %s', text => {
    const masked = maskPersonal(text);
    expect(masked.text).toBe(text); expect(masked.tokens.size).toBe(0); expect(maskNotice(masked)).toBe('');
  });

  it('reuses a token for the same value, restores every occurrence and reports dropped or invented tokens', () => {
    const masked = maskPersonal('담당 010-1234-5678, 문의 010-1234-5678, 메일 a@example.com');
    expect(masked.text).toBe('담당 〔개인정보2〕, 문의 〔개인정보2〕, 메일 〔개인정보1〕');
    expect(maskNotice(masked)).toBe('개인정보 2건(이메일·전화번호)을 가리고 보냈습니다. 결과에는 원래 값으로 되돌려 넣습니다.');
    expect(restorePersonal('연락: 〔개인정보2〕 / 〔개인정보2〕', masked)).toEqual({ text: '연락: 010-1234-5678 / 010-1234-5678', unknown: [], missing: 1 });
    expect(restorePersonal('〔개인정보7〕', masked).unknown).toEqual(['〔개인정보7〕']);
  });

  it('extends one request across several parts (prompt, document, conversation) with stable numbering', () => {
    const first = maskPersonal('본문 010-1111-2222'), second = maskPersonal('대화 010-1111-2222 그리고 x@example.org', first);
    expect(second.text).toBe('대화 〔개인정보1〕 그리고 〔개인정보2〕'); expect(second.tokens.size).toBe(2);
  });

  it('gates research searches and MCP arguments at the transport boundary', () => {
    expect(() => gateResearchAction({ op: 'start', request: { sourceId: 's', query: '홍길동 010-1234-5678 논문', limit: 10 } })).toThrow('검색어에 개인정보(전화번호)');
    expect(gateResearchAction({ op: 'start', request: { sourceId: 's', query: '2026 교양교육 보고서', limit: 10 } })).toMatchObject({ op: 'start' });
    const call = gateResearchAction({ op: 'mcp_call', sourceId: 'm', name: 'lookup', arguments: { contact: { phone: '010-1234-5678', mail: ['a@example.com'] }, page: 2 } });
    expect(call).toEqual({ op: 'mcp_call', sourceId: 'm', name: 'lookup', arguments: { contact: { phone: '〔개인정보1〕', mail: ['〔개인정보2〕'] }, page: 2 } });
    expect(maskPersonalDeep(['x@example.net', 'x@example.net']).value).toEqual(['〔개인정보1〕', '〔개인정보1〕']);
  });

  it('masks identifiers inside serialized text without swallowing escapes (review HIGH 2)', () => {
    const payload = JSON.stringify('담당자\nhong@example.com\t010-1234-5678'), masked = maskPersonal(payload);
    expect([...masked.tokens.values()]).toEqual(['hong@example.com', '010-1234-5678']);
    expect(masked.text).toBe(JSON.stringify('담당자\n〔개인정보1〕\t〔개인정보2〕'));
    expect(restorePersonal(masked.text, masked).text).toBe(payload);
  });
  it.each(['2024-0012-345', '2024-12-345678', '2024-001234-01', '사업자 123-45-67890'])('does not treat document or business numbers as accounts: %s', text => {
    expect(maskPersonal(text).tokens.size).toBe(0);
  });
  it.each(['(02)1234-5678', '010.1234.5678', '(031) 765-4321'])('masks phone formats with dots and parentheses: %s', text => {
    expect(maskPersonal(text).kinds).toEqual(['phone']);
  });
  it('never cuts text inside a run of non-space characters, so a split identifier cannot escape the masks', () => {
    const chars = Array.from('주민 900101-1234567 끝');
    expect(maskSafeEnd(chars, 9)).toBe(17);
    expect(maskPersonal(chars.slice(0, maskSafeEnd(chars, 9)).join('')).text).not.toContain('900101');
    expect(maskSafeEnd(chars, 17)).toBe(17);
    expect(maskSafeEnd(chars, 0)).toBe(0);
    expect(maskSafeEnd(chars, 100)).toBe(chars.length);
    expect(maskSafeEnd(Array.from('a'.repeat(200)), 10)).toBe(74);
    const spaced = Array.from('전화 010 1234 5678 끝');
    expect(maskSafeEnd(spaced, 7)).toBe(16);
  });
  it('restores tokens whose brackets the model rewrote', () => {
    const masked = maskPersonal('문의 a@example.com');
    expect(restorePersonal('문의: [개인정보1]', masked)).toEqual({ text: '문의: a@example.com', unknown: [], missing: 0 });
  });
});
