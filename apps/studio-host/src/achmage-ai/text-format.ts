/**
 * Character formatting for exactly the selected characters ("이 부분 굵게", "글꼴 바꿔"): the model
 * only names the values; the app validates them and applies them to the selection, never to whole
 * paragraphs, and never changes the text.
 */
export interface TextFormat { bold?: boolean; italic?: boolean; underline?: boolean; strikethrough?: boolean; color?: string; highlight?: string; fontFamily?: string; fontSizePt?: number }

const COLOR = /^#[0-9A-Fa-f]{6}$/u;
const fail = (message: string): never => { throw new Error(message); };

/** A validated copy; unknown keys or out-of-range values fail, an empty format fails. */
export function parseTextFormat(value: unknown): TextFormat {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('바꿀 글자 서식을 읽지 못했습니다.');
  const out: TextFormat = {}, v = value as Record<string, unknown>;
  for (const [key, raw] of Object.entries(v)) {
    if (raw === undefined) continue;
    switch (key) {
      case 'bold': case 'italic': case 'underline': case 'strikethrough':
        if (typeof raw !== 'boolean') fail('글자 서식 값을 확인하세요.'); out[key] = raw as boolean; break;
      case 'color':
        if (typeof raw !== 'string' || !COLOR.test(raw)) fail('글자색은 #RRGGBB 형식이어야 합니다.'); out.color = (raw as string).toUpperCase(); break;
      case 'highlight':
        // rhwp takes a colour only; "no shading" cannot be written back yet.
        if (typeof raw !== 'string' || !COLOR.test(raw)) fail('형광펜은 색(#RRGGBB)으로만 지정할 수 있습니다. 형광펜 지우기는 아직 지원하지 않습니다.'); out.highlight = (raw as string).toUpperCase(); break;
      case 'fontFamily': {
        const family = typeof raw === 'string' ? raw.replace(/\s+/gu, ' ').trim() : '';
        if (!family || family.length > 80 || /[\u0000-\u001f<>"';,\\]/u.test(family)) fail('글꼴 이름을 확인하세요.'); out.fontFamily = family; break;
      }
      case 'fontSizePt':
        if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 4 || raw > 200) fail('글자 크기는 4–200pt여야 합니다.'); out.fontSizePt = Math.round((raw as number) * 10) / 10; break;
      default: fail(`지원하지 않는 글자 서식입니다: ${key}`);
    }
  }
  if (!Object.keys(out).length) fail('바꿀 글자 서식이 없습니다.');
  return out;
}

/** rhwp character-shape modification JSON. `fontIds` resolves a family to its id per language. */
export function textFormatMods(format: TextFormat, fontIds: (family: string) => number[]): string {
  const mods: Record<string, unknown> = {};
  for (const key of ['bold', 'italic', 'underline', 'strikethrough'] as const) if (format[key] !== undefined) mods[key] = format[key];
  if (format.color) mods.textColor = format.color;
  if (format.highlight) mods.shadeColor = format.highlight;
  if (format.fontFamily) mods.fontIds = fontIds(format.fontFamily);
  if (format.fontSizePt !== undefined) mods.fontSize = Math.round(format.fontSizePt * 100);
  return JSON.stringify(mods);
}

/** "굵게 · 맑은 고딕 · 12pt" for the result message. */
export function describeTextFormat(format: TextFormat): string {
  const on = (flag: boolean | undefined, yes: string, no: string) => flag === undefined ? '' : flag ? yes : no;
  return [on(format.bold, '굵게', '굵게 해제'), on(format.italic, '기울임', '기울임 해제'), on(format.underline, '밑줄', '밑줄 해제'), on(format.strikethrough, '취소선', '취소선 해제'),
    format.color ? `글자색 ${format.color}` : '', format.highlight ? `형광펜 ${format.highlight}` : '',
    format.fontFamily ?? '', format.fontSizePt !== undefined ? `${format.fontSizePt}pt` : ''].filter(Boolean).join(' · ');
}
