import { describe, expect, it } from 'vitest';
import { fillProfile, loadProfile, profilePromptLine, saveProfile, PROFILE_STORAGE_KEY } from './user-profile';

const storage = () => { const data = new Map<string, string>(); return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } }; };

describe('writer profile', () => {
  it('stores only known, non-empty fields locally and clears when empty', () => {
    const s = storage();
    saveProfile(s, { name: ' 홍길동 ', organization: '○○대학교', phone: '', styleNote: '공문체' });
    expect(JSON.parse(s.data.get(PROFILE_STORAGE_KEY)!)).toEqual({ name: '홍길동', organization: '○○대학교', styleNote: '공문체' });
    s.setItem(PROFILE_STORAGE_KEY, JSON.stringify({ name: '홍길동', token: 'secret', email: 5 }));
    expect(loadProfile(s)).toEqual({ name: '홍길동' });
    saveProfile(s, {}); expect(s.data.has(PROFILE_STORAGE_KEY)).toBe(false);
    s.setItem(PROFILE_STORAGE_KEY, '{broken'); expect(loadProfile(s)).toEqual({});
  });

  it('asks the AI for placeholders only, never the values', () => {
    const line = profilePromptLine({ name: '홍길동', phone: '010-1234-5678', styleNote: '간결하게' });
    expect(line).toContain('{{작성자}}'); expect(line).not.toContain('홍길동'); expect(line).not.toContain('010-1234-5678'); expect(line).toContain('간결하게');
  });

  it('fills placeholders locally, escapes inside JSON, and leaves empty fields visible', () => {
    const profile = { name: '홍길동', organization: '○○대 "미디어학부"' };
    expect(fillProfile('작성: {{작성자}} ({{ 소속 }}) 연락: {{연락처}}', profile)).toEqual({ text: '작성: 홍길동 (○○대 "미디어학부") 연락: 〔연락처〕', filled: 2, missing: ['연락처'] });
    const json = fillProfile('{"text":"{{소속}} {{작성자}}"}', profile, { json: true });
    expect(JSON.parse(json.text)).toEqual({ text: '○○대 "미디어학부" 홍길동' });
  });
});
