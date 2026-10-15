import { describe, expect, it } from 'vitest';
import { applyHunks, diffText, MarkerMismatch } from './minimal-diff';

describe('minimal diff', () => {
  it('replaces only the changed word', () => {
    expect(diffText('위원회는 세 차례 회의를 거쳤다.', '위원회는 네 차례 회의를 거쳤다.')).toEqual([{ start: 5, end: 6, text: '네' }]);
  });
  it('keeps shared letters inside a changed word group', () => {
    const hunks = diffText('교양교육과정 개편', '교양교육 과정 개편');
    expect(hunks).toEqual([{ start: 4, end: 4, text: ' ' }]);
  });
  it('does not shred a rewrite into coincidental letters', () => {
    expect(diffText('검토 바랍니다', '확인 부탁드립니다')).toHaveLength(1);
  });
  it('handles paragraph breaks as their own pieces', () => {
    const before = '첫 문단\n둘째 문단\n셋째', after = '첫 문단\n셋째';
    expect(applyHunks(before, diffText(before, after))).toBe(after);
    expect(diffText(before, after)).toEqual([{ start: 5, end: 11, text: '' }]);
  });
  it('treats object markers as fixed anchors', () => {
    const before = '앞 문단\n⟦표1⟧\n뒤 문단입니다', after = '앞의 문단\n⟦표1⟧\n뒤 문단입니다!';
    const hunks = diffText(before, after);
    expect(applyHunks(before, hunks)).toBe(after);
    for (const h of hunks) expect(Array.from(before).slice(h.start, h.end).join('')).not.toContain('⟦');
    expect(() => diffText(before, '앞 문단\n뒤 문단')).toThrow(MarkerMismatch);
    expect(() => diffText('⟦표1⟧ ⟦그림1⟧', '⟦그림1⟧ ⟦표1⟧')).toThrow(MarkerMismatch);
  });
  it('round-trips arbitrary edits, including emoji and combining marks', () => {
    const samples = ['', 'a', '가나다', '한글 😀 이모지', 'é 결합', '줄\n바꿈\n\n빈 줄', '1,234원 2026. 10. 14.'];
    let seed = 7; const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (const before of samples) for (const after of samples) expect(applyHunks(before, diffText(before, after))).toBe(after);
    for (let round = 0; round < 200; round++) {
      const pool = ['가', '나', ' ', '\n', '다', 'x', '😀', '.'], make = () => Array.from({ length: rand(30) }, () => pool[rand(pool.length)]).join('');
      const before = make(), after = make();
      expect(applyHunks(before, diffText(before, after))).toBe(after);
    }
  });
  it('falls back to one replacement for a total rewrite of a long text', () => {
    const before = Array.from({ length: 3000 }, (_, i) => `단어${i}`).join(' '), after = Array.from({ length: 3000 }, (_, i) => `말${i}`).join(' ');
    const hunks = diffText(before, after);
    expect(applyHunks(before, hunks)).toBe(after);
  });
});
