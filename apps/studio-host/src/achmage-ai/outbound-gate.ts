/**
 * Personal identifiers never leave the computer: every prompt is masked with numbered tokens
 * before it is sent, and the reply is restored locally before it is shown or applied. Detection
 * is conservative for document numbers, dates and amounts (they are content, not identifiers).
 */
export type PersonalKind = 'rrn' | 'phone' | 'email' | 'card' | 'account' | 'passport';
export const PERSONAL_LABELS: Record<PersonalKind, string> = { rrn: '주민·외국인등록번호', phone: '전화번호', email: '이메일', card: '카드번호', account: '계좌번호', passport: '여권번호' };

export interface MaskedText { text: string; tokens: Map<string, string>; kinds: PersonalKind[] }
const TOKEN = (n: number) => `〔개인정보${n}〕`;
/** Models sometimes rewrite the brackets ([개인정보1]); those are still our tokens. */
const TOKEN_PATTERN = /[〔\[]개인정보(\d+)[〕\]]/gu;

const digits = (s: string) => s.replace(/\D/g, '');
function rrnValid(value: string): boolean {
  const d = digits(value); if (d.length !== 13) return false;
  const month = Number(d.slice(2, 4)), day = Number(d.slice(4, 6)), gender = Number(d[6]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || gender < 1 || gender > 8) return false;
  // Registrations since late 2020 no longer carry a check digit; a plausible date and gender digit is enough.
  return true;
}
function luhn(value: string): boolean {
  const d = digits(value); if (d.length < 13 || d.length > 19) return false;
  let sum = 0; for (let i = 0; i < d.length; i++) { let n = Number(d[d.length - 1 - i]); if (i % 2) { n *= 2; if (n > 9) n -= 9; } sum += n; }
  return sum % 10 === 0;
}

interface Detector { kind: PersonalKind; pattern: RegExp; accept?: (match: string) => boolean }
const NOT_DIGIT_BEFORE = '(?<![\\d-])', NOT_DIGIT_AFTER = '(?![\\d-])';
const DETECTORS: Detector[] = [
  { kind: 'email', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu },
  { kind: 'rrn', pattern: new RegExp(`${NOT_DIGIT_BEFORE}\\d{6}\\s?-?\\s?[1-8]\\d{6}${NOT_DIGIT_AFTER}`, 'gu'), accept: rrnValid },
  { kind: 'card', pattern: new RegExp(`${NOT_DIGIT_BEFORE}(?:\\d{4}[ -]\\d{4}[ -]\\d{4}[ -]\\d{2,4}|\\d{15,16})${NOT_DIGIT_AFTER}`, 'gu'), accept: luhn },
  // Korean numbering: mobile 01x, Seoul 02, area 0[3-6][1-5], 070; "+82" drops the leading 0.
  { kind: 'phone', pattern: new RegExp(`(?:\\+82[ .-]?(?:1[016789]|2|[3-6][1-5]|70)|${NOT_DIGIT_BEFORE}\\(?(?:01[016789]|02|0[3-6][1-5]|070)\\)?)[ .-]?\\d{3,4}[ .-]?\\d{4}${NOT_DIGIT_AFTER}`, 'gu') },
  // Bank accounts: three or four hyphenated digit groups, 10–14 digits. Not a year-led document or
  // project number (2024-0012-345) and not a business registration number (123-45-67890, public).
  { kind: 'account', pattern: new RegExp(`${NOT_DIGIT_BEFORE}\\d{2,6}-\\d{2,6}-\\d{2,7}(?:-\\d{1,3})?${NOT_DIGIT_AFTER}`, 'gu'), accept: m => { const d = digits(m); return d.length >= 10 && d.length <= 14 && !/^(19|20)\d{2}-/.test(m) && !/^\d{3}-\d{2}-\d{5}$/.test(m); } },
  { kind: 'passport', pattern: /(?<![A-Za-z0-9])[MSROD]\d{8}(?![A-Za-z0-9])|(?<![A-Za-z0-9])[MSROD]\d{3}[A-Z]\d{4}(?![A-Za-z0-9])/gu },
];

/** Masks identifiers; the same value always gets the same token within one request.
 * Escape sequences of serialized text (\n, \t, \uXXXX) are boundaries: an identifier never
 * swallows the letter of an escape (the "n" of \n before an email address). */
export function maskPersonal(text: string, base?: MaskedText): MaskedText {
  let masked: MaskedText = { text: '', tokens: new Map(base?.tokens), kinds: [...(base?.kinds ?? [])] };
  const parts = text.split(/(\\(?:u[0-9a-fA-F]{4}|.))/su);
  for (const [index, part] of parts.entries()) {
    if (index % 2 === 1 || !part) { masked.text += part; continue; }
    const next = maskPlain(part, masked); masked = { text: masked.text + next.text, tokens: next.tokens, kinds: next.kinds };
  }
  return masked;
}
function maskPlain(text: string, base?: MaskedText): MaskedText {
  const tokens = new Map(base?.tokens), byValue = new Map([...tokens].map(([token, value]) => [value, token]));
  const kinds = new Set<PersonalKind>(base?.kinds);
  let result = text;
  for (const detector of DETECTORS) {
    result = result.replace(detector.pattern, match => {
      if (detector.accept && !detector.accept(match)) return match;
      let token = byValue.get(match);
      if (!token) { token = TOKEN(tokens.size + 1); tokens.set(token, match); byValue.set(match, token); }
      kinds.add(detector.kind);
      return token;
    });
  }
  return { text: result, tokens, kinds: [...kinds] };
}

export interface Restored { text: string; unknown: string[]; missing: number }
/** Puts the original values back. Tokens the request never sent cannot be restored and are reported. */
export function restorePersonal(reply: string, masked: Pick<MaskedText, 'tokens'>): Restored {
  const unknown: string[] = [], seen = new Set<string>();
  const text = reply.replace(TOKEN_PATTERN, token => {
    const canonical = TOKEN(Number(token.replace(/\D/g, ''))), value = masked.tokens.get(canonical);
    if (value === undefined) { unknown.push(token); return token; }
    seen.add(canonical); return value;
  });
  return { text, unknown, missing: [...masked.tokens.keys()].filter(token => !seen.has(token)).length };
}

/** Masks every string inside a JSON-like value (MCP tool arguments) with one shared numbering. */
export function maskPersonalDeep<T>(value: T, masked: MaskedText = { text: '', tokens: new Map(), kinds: [] }): { value: T; masked: MaskedText } {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') { const next = maskPersonal(v, masked); masked.tokens = next.tokens; masked.kinds = next.kinds; return next.text; }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([key, item]) => [key, walk(item)]));
    return v;
  };
  return { value: walk(value) as T, masked };
}

/** One line for the panel, e.g. "개인정보 2건(전화번호·이메일)을 가리고 보냈습니다." */
export function maskNotice(masked: MaskedText): string {
  if (!masked.tokens.size) return '';
  return `개인정보 ${masked.tokens.size}건(${masked.kinds.map(kind => PERSONAL_LABELS[kind]).join('·')})을 가리고 보냈습니다. 결과에는 원래 값으로 되돌려 넣습니다.`;
}
