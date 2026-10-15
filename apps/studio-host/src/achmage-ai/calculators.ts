/**
 * Numbers in official documents are computed, never written by the model: amounts in Korean
 * words, dates with their weekday, change sentences. Pure functions; the AI only writes prose.
 */
const DIGITS = ['', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'];
const SMALL_UNITS = ['', '십', '백', '천'];
const GROUP_UNITS = ['', '만', '억', '조', '경'];
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

/** 1,234,567,890 — thousands separators for a whole number given as digits or a number. */
export function withCommas(value: number | bigint | string): string {
  const raw = typeof value === 'string' ? value.replace(/[,\s]/g, '') : String(value);
  if (!/^-?\d+$/.test(raw)) throw Error('정수만 콤마로 나눌 수 있습니다.');
  const negative = raw.startsWith('-'), digits = raw.replace('-', '').replace(/^0+(?=\d)/, '');
  return (negative ? '-' : '') + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Official reading where every digit is spoken (일십, 일백) so the amount cannot be altered. */
export function koreanAmountWords(value: number | bigint | string): string {
  const digits = String(value).replace(/[,\s원]/g, '').replace(/^금/, '');
  if (!/^\d+$/.test(digits)) throw Error('금액은 0 이상의 정수여야 합니다.');
  const trimmed = digits.replace(/^0+(?=\d)/, '');
  if (trimmed === '0') return '영';
  if (trimmed.length > 20) throw Error('금액이 너무 큽니다.');
  const groups: string[] = [];
  for (let end = trimmed.length; end > 0; end -= 4) groups.unshift(trimmed.slice(Math.max(0, end - 4), end));
  return groups.map((group, index) => {
    const unit = GROUP_UNITS[groups.length - 1 - index];
    const words = group.padStart(4, '0').split('').map((d, i) => d === '0' ? '' : DIGITS[Number(d)] + SMALL_UNITS[3 - i]).join('');
    return words ? words + unit : '';
  }).join('');
}

/** 금1,234,567,890원(금일십이억삼천사백오십육만칠천팔백구십원) */
export function officialAmount(value: number | bigint | string): string {
  const digits = String(value).replace(/[,\s원]/g, '').replace(/^금/, '');
  return `금${withCommas(digits)}원(금${koreanAmountWords(digits)}원)`;
}

export interface CalendarDate { year: number; month: number; day: number }

/** Reads 2026-01-01, 2026.1.1., 2026/01/01, 2026년 1월 1일, 20260101, or "1월 1일" (year from base). */
export function parseKoreanDate(text: string, base: CalendarDate = today()): CalendarDate {
  const t = text.trim();
  const full = /^(\d{4})\s*(?:[-./]|년)\s*(\d{1,2})\s*(?:[-./]|월)\s*(\d{1,2})\s*(?:일|\.)?\s*(?:\([월화수목금토일]\))?$/u.exec(t)
    ?? /^(\d{4})(\d{2})(\d{2})$/.exec(t);
  const short = full ? null : /^(\d{1,2})\s*(?:[./]|월)\s*(\d{1,2})\s*(?:일|\.)?$/u.exec(t);
  const date = full ? { year: Number(full[1]), month: Number(full[2]), day: Number(full[3]) } : short ? { year: base.year, month: Number(short[1]), day: Number(short[2]) } : null;
  if (!date || !validDate(date)) throw Error('날짜로 읽을 수 없습니다: ' + text);
  return date;
}

function validDate(d: CalendarDate): boolean {
  if (d.month < 1 || d.month > 12 || d.day < 1) return false;
  return d.day <= new Date(Date.UTC(d.year, d.month, 0)).getUTCDate();
}
export function weekday(d: CalendarDate): string { return WEEKDAYS[new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay()]; }

/** 2026. 1. 1.(목) — the official date form with its computed weekday. */
export function officialDate(d: CalendarDate, withWeekday = true): string {
  return `${d.year}. ${d.month}. ${d.day}.${withWeekday ? `(${weekday(d)})` : ''}`;
}

export function today(now = new Date()): CalendarDate { return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() }; }
function addDays(d: CalendarDate, days: number): CalendarDate {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + days));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

/** Periods relative to a base day: 오늘, 내일, 이번 주, 다음 주 (월–금), 이번 달, 다음 달. */
export function relativePeriod(kind: '오늘' | '내일' | '이번 주' | '다음 주' | '이번 달' | '다음 달', base: CalendarDate = today()): { start: CalendarDate; end: CalendarDate } {
  if (kind === '오늘') return { start: base, end: base };
  if (kind === '내일') { const d = addDays(base, 1); return { start: d, end: d }; }
  if (kind === '이번 주' || kind === '다음 주') {
    const offset = (new Date(Date.UTC(base.year, base.month - 1, base.day)).getUTCDay() + 6) % 7; // Monday = 0
    const monday = addDays(base, -offset + (kind === '다음 주' ? 7 : 0));
    return { start: monday, end: addDays(monday, 4) };
  }
  const first = kind === '이번 달' ? { year: base.year, month: base.month, day: 1 } : base.month === 12 ? { year: base.year + 1, month: 1, day: 1 } : { year: base.year, month: base.month + 1, day: 1 };
  return { start: first, end: { ...first, day: new Date(Date.UTC(first.year, first.month, 0)).getUTCDate() } };
}

/** "2026. 10. 19.(월) ~ 2026. 10. 23.(금)" */
export function officialPeriod(range: { start: CalendarDate; end: CalendarDate }): string {
  return range.start.year === range.end.year && range.start.month === range.end.month && range.start.day === range.end.day
    ? officialDate(range.start) : `${officialDate(range.start)} ~ ${officialDate(range.end)}`;
}

const round = (n: number, places = 1) => { const f = 10 ** places; return Math.round(n * f) / f; };
const number = (n: number) => { const [whole, fraction] = String(Math.abs(n)).split('.'); return (n < 0 ? '-' : '') + withCommas(whole) + (fraction ? '.' + fraction : ''); };

/**
 * "120→150명으로 30명(25.0%) 증가" / "40%→35%로 5.0%p 감소". A decrease is marked with △ in tables;
 * the sentence says 증가/감소 in words. Percentages report the point difference (%p), not a rate.
 */
export function changeSentence(before: number, after: number, unit = ''): string {
  if (!Number.isFinite(before) || !Number.isFinite(after)) throw Error('비교할 두 수가 필요합니다.');
  const diff = Math.round((after - before) * 1e10) / 1e10, word = diff > 0 ? '증가' : diff < 0 ? '감소' : '변동 없음';
  const head = `${number(before)}${unit}→${number(after)}${unit}${directionParticle(after, unit)}`;
  if (diff === 0) return `${head} ${word}`;
  if (unit === '%') return `${head} ${number(round(Math.abs(diff)))}%p ${word}`;
  if (before === 0) return `${head} ${number(Math.abs(diff))}${unit} ${word}`;
  return `${head} ${number(Math.abs(diff))}${unit}(${round(Math.abs(diff) / Math.abs(before) * 100).toFixed(1)}%) ${word}`;
}
/** Table cell form of a change: 30 / △5 (a decrease is marked with △, never with a minus sign). */
export function changeCell(before: number, after: number): string {
  const diff = Math.round((after - before) * 1e10) / 1e10; return diff < 0 ? '△' + number(Math.abs(diff)) : number(diff);
}
function hasBatchim(word: string): boolean {
  const last = word.charCodeAt(word.length - 1);
  return last >= 0xac00 && last <= 0xd7a3 && (last - 0xac00) % 28 !== 0 && (last - 0xac00) % 28 !== 8; // ㄹ takes 로
}

/** 로/으로 after "150명", "35%", or a bare number read aloud (150 → 백오십 → 으로; 7 → 칠 → 로). */
function directionParticle(value: number, unit: string): string {
  if (unit) return /[가-힣]$/u.test(unit) && hasBatchim(unit) ? '으로' : '로';
  const text = String(Math.abs(value)), fraction = text.split('.')[1];
  const lastReading = fraction ? DIGITS[Number(fraction[fraction.length - 1])] || '영' : spokenTail(Math.trunc(Math.abs(value)));
  return hasBatchim(lastReading) ? '으로' : '로';
}
function spokenTail(n: number): string {
  if (n === 0) return '영';
  if (n % 10) return DIGITS[n % 10];
  const words = koreanAmountWords(n); return words[words.length - 1];
}

/** Official dates whose written weekday is wrong ("2026. 1. 1.(수)") get the computed weekday. */
export function fixWeekdays(text: string): { text: string; fixes: string[] } {
  const fixes: string[] = [];
  const result = text.replace(/(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.\s*\(([월화수목금토일])\)/gu, (match, y: string, m: string, d: string, written: string) => {
    const date = { year: Number(y), month: Number(m), day: Number(d) };
    if (!validDate(date)) return match;
    const actual = weekday(date);
    if (actual === written) return match;
    fixes.push(`${y}. ${m}. ${d}.(${written}→${actual})`);
    return match.slice(0, match.lastIndexOf('(')) + `(${actual})`;
  });
  return { text: result, fixes };
}

export interface CalculatorChoice { label: string; result: string }
/**
 * One-tap calculations for a selection: an amount, a date, or a pair of numbers. Computed here,
 * applied as one Ctrl+Z step; the model is not involved.
 */
export function calculatorChoices(selected: string, base: CalendarDate = today()): CalculatorChoice[] {
  const text = selected.trim(), choices: CalculatorChoice[] = [];
  if (!text || text.length > 200) return choices;
  const amount = /^(?:금\s*)?([\d,]+)\s*원?$/u.exec(text);
  if (amount && /\d{2,}/.test(amount[1].replace(/,/g, '')) && /^\d{1,3}(?:,\d{3})*$|^\d+$/.test(amount[1])) {
    choices.push({ label: '금액 한글 병기', result: officialAmount(amount[1]) });
    if (!amount[1].includes(',') && amount[1].length > 3) choices.push({ label: '천 단위 쉼표', result: withCommas(amount[1]) + (text.endsWith('원') ? '원' : '') });
  }
  try { const date = parseKoreanDate(text, base); const formatted = officialDate(date); if (formatted !== text) choices.push({ label: '공문 날짜', result: formatted }); } catch { /* not a date */ }
  const numbers = [...text.matchAll(/(-?[\d,]+(?:\.\d+)?)\s*(%|[가-힣]{1,2})?/gu)].filter(m => /\d/.test(m[1]));
  if (numbers.length === 2 && (numbers[0][2] ?? '') === (numbers[1][2] ?? '') && !/^\d{4}[-.]/.test(text)) {
    const [a, b] = numbers.map(m => Number(m[1].replace(/,/g, '')));
    if (Number.isFinite(a) && Number.isFinite(b)) choices.push({ label: '증감 문장', result: changeSentence(a, b, numbers[0][2] ?? '') });
  }
  return choices;
}
