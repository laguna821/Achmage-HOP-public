/**
 * The writer's own details (name, organisation, contact) for author lines and cover fields. Kept
 * on this computer only: the AI writes placeholders such as {{작성자}}, and the app fills them in
 * just before the text reaches the document. Empty fields are never guessed.
 */
export const PROFILE_STORAGE_KEY = 'achmage.hop.profile.v1';
export const PROFILE_FIELDS = [
  { key: 'name', label: '작성자' }, { key: 'organization', label: '소속' }, { key: 'department', label: '부서' },
  { key: 'position', label: '직위' }, { key: 'phone', label: '연락처' }, { key: 'email', label: '이메일' },
] as const;
export type ProfileKey = typeof PROFILE_FIELDS[number]['key'];
export type UserProfile = Partial<Record<ProfileKey, string>> & { styleNote?: string };

interface StoragePort { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }

export function loadProfile(storage: StoragePort): UserProfile {
  try {
    const raw = storage.getItem(PROFILE_STORAGE_KEY); if (!raw || raw.length > 8192) return {};
    const value: unknown = JSON.parse(raw); if (!value || typeof value !== 'object') return {};
    const v = value as Record<string, unknown>, profile: UserProfile = {};
    for (const { key } of PROFILE_FIELDS) if (typeof v[key] === 'string' && v[key]) profile[key] = (v[key] as string).slice(0, 200);
    if (typeof v.styleNote === 'string' && v.styleNote) profile.styleNote = v.styleNote.slice(0, 1000);
    return profile;
  } catch { return {}; }
}
export function saveProfile(storage: StoragePort, profile: UserProfile): void {
  const clean: UserProfile = {};
  for (const { key } of PROFILE_FIELDS) { const value = profile[key]?.trim(); if (value) clean[key] = value.slice(0, 200); }
  if (profile.styleNote?.trim()) clean.styleNote = profile.styleNote.trim().slice(0, 1000);
  if (Object.keys(clean).length) storage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(clean)); else storage.removeItem(PROFILE_STORAGE_KEY);
}

/** The instruction added to writing requests: placeholders only, never the values. */
export function profilePromptLine(profile: UserProfile): string {
  const lines = [`작성자 본인의 정보가 필요하면 값 대신 자리표시자만 쓰세요: ${PROFILE_FIELDS.map(f => `{{${f.label}}}`).join(' ')}. 앱이 채웁니다. 다른 이름·연락처를 지어내지 마세요.`];
  // The style note is the writer's own preference about tone, not personal data.
  if (profile.styleNote) lines.push('작성자 문체 메모(참고): ' + JSON.stringify(profile.styleNote));
  return lines.join('\n');
}

/**
 * Replaces {{작성자}}-style placeholders with the profile. Inside JSON (structured edit plans) the
 * value is JSON-escaped. Empty fields stay as 〔작성자〕 and are reported, not invented.
 */
export function fillProfile(text: string, profile: UserProfile, options: { json?: boolean } = {}): { text: string; filled: number; missing: string[] } {
  let filled = 0; const missing = new Set<string>();
  const result = text.replace(/\{\{\s*(작성자|소속|부서|직위|연락처|이메일)\s*\}\}/gu, (_match, label: string) => {
    const key = PROFILE_FIELDS.find(f => f.label === label)!.key, value = profile[key];
    if (!value) { missing.add(label); return `〔${label}〕`; }
    filled++; return options.json ? JSON.stringify(value).slice(1, -1) : value;
  });
  return { text: result, filled, missing: [...missing] };
}
