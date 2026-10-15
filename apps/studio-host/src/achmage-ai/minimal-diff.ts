/**
 * Minimal edit script between the selected text and the AI's revision, so only changed spans are
 * replaced and everything else keeps its exact formatting (bold, colour, font, highlight). Words are
 * compared first, then characters inside each changed word group. Object markers (⟦표1⟧ …) are
 * atomic: they must survive unchanged and in order, which also splits the work into small pieces.
 */
export interface Hunk { start: number; end: number; text: string }

/** Marker shown to the model in place of an object (table, picture, field) inside the selection. */
export const OBJECT_MARKER = /⟦[^⟦⟧\n]{1,12}⟧/gu;
const TOKEN = /⟦[^⟦⟧\n]{1,12}⟧|\n|[\p{L}\p{M}\p{N}]+|[^\S\n]+|[^]/gu;
const MAX_EDITS = 1500;

function tokens(text: string): string[] { return text.match(TOKEN) ?? []; }
const scalars = (text: string) => Array.from(text).length;

/** Myers diff over two sequences; returns matched index pairs in order, or null past `limit` edits. */
function matches<T>(a: readonly T[], b: readonly T[], limit = MAX_EDITS): [number, number][] | null {
  const n = a.length, m = b.length, max = Math.min(n + m, limit), off = max + 1;
  const v = new Int32Array(2 * max + 3), trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1, y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x < n || y < m) continue;
      // Walk back through the saved frontiers, collecting the equal (diagonal) steps.
      const pairs: [number, number][] = [];
      let cx = n, cy = m;
      for (let dd = d; dd >= 0; dd--) {
        const pv = trace[dd], kk = cx - cy;
        const prevK = kk === -dd || (kk !== dd && pv[off + kk - 1] < pv[off + kk + 1]) ? kk + 1 : kk - 1;
        const px = dd === 0 ? 0 : pv[off + prevK], py = dd === 0 ? 0 : px - prevK;
        while (cx > px && cy > py) { pairs.push([cx - 1, cy - 1]); cx--; cy--; }
        cx = px; cy = py;
      }
      return pairs.reverse();
    }
  }
  return null;
}

/** Hunks between two sequences of string pieces, in piece indices of `a` mapped to scalar offsets. */
function hunksOf(a: readonly string[], b: readonly string[], base: number): Hunk[] | null {
  const pairs = matches(a, b);
  if (!pairs) return null;
  const out: Hunk[] = [], aOffsets: number[] = [];
  let at = base; for (const piece of a) { aOffsets.push(at); at += scalars(piece); } aOffsets.push(at);
  let i = 0, j = 0;
  for (const [x, y] of [...pairs, [a.length, b.length] as [number, number]]) {
    if (x > i || y > j) out.push({ start: aOffsets[i], end: aOffsets[x], text: b.slice(j, y).join('') });
    i = x + 1; j = y + 1;
  }
  return out;
}

/** Splits a word-level hunk into character-level hunks when that keeps a meaningful part of the old text. */
function refine(oldText: string, hunk: Hunk): Hunk[] {
  const a = Array.from(oldText), b = Array.from(hunk.text);
  if (!a.length || !b.length || a.length > 400 || b.length > 400) return [hunk];
  const inner = hunksOf(a, b, hunk.start);
  if (!inner) return [hunk];
  const kept = a.length - inner.reduce((n, h) => n + h.end - h.start, 0);
  // A few coincidental shared letters are not worth splitting the replacement into fragments.
  return kept >= Math.max(2, Math.ceil(a.length * 0.5)) ? inner : [hunk];
}

/** Word changes separated only by a space or a mark ("교양교육과정" → "교양교육 과정") are one change. */
function coalesce(hunks: readonly Hunk[], chars: readonly string[]): Hunk[] {
  const out: Hunk[] = [];
  for (const h of hunks) {
    const last = out.at(-1), gap = last ? chars.slice(last.end, h.start).join('') : '';
    if (last && gap.length <= 2 && !/[\p{L}\p{N}\n]/u.test(gap)) { last.end = h.end; last.text += gap + h.text; }
    else out.push({ ...h });
  }
  return out;
}

/** Lines as pieces, each paragraph break its own piece (the fallback when words differ too much). */
const lines = (text: string) => text.split(/(\n)/u).filter(Boolean);

/**
 * A change spanning several paragraphs is split paragraph by paragraph, so each new paragraph is
 * compared with (and later styled like) the paragraph it replaces; extra lines go with the last pair.
 */
function perLine(chars: readonly string[], hunk: Hunk): Hunk[] {
  const oldLines = chars.slice(hunk.start, hunk.end).join('').split('\n'), newLines = hunk.text.split('\n');
  if (oldLines.length < 2 && newLines.length < 2) return [hunk];
  const m = Math.min(oldLines.length, newLines.length) - 1, out: Hunk[] = [];
  let at = hunk.start;
  for (let t = 0; t <= m; t++) {
    const a = t === m ? oldLines.slice(t).join('\n') : oldLines[t], b = t === m ? newLines.slice(t).join('\n') : newLines[t];
    if (a !== b) out.push(...(hunksOf(tokens(a), tokens(b), at) ?? [{ start: at, end: at + scalars(a), text: b }]));
    at += scalars(a) + 1;
  }
  return out;
}

export class MarkerMismatch extends Error {}

/**
 * Edit script turning `before` into `after`, as non-overlapping hunks in scalar offsets of `before`.
 * Throws MarkerMismatch when an object marker was removed, added, altered or reordered.
 */
export function diffText(before: string, after: string): Hunk[] {
  const markers = (text: string) => text.match(OBJECT_MARKER) ?? [];
  const old = markers(before), next = markers(after);
  if (old.length !== next.length || old.some((m, i) => m !== next[i]) || new Set(old).size !== old.length) throw new MarkerMismatch('표·그림 같은 개체 표시(⟦…⟧)를 지우거나 옮길 수 없습니다.');
  // Between markers the pieces are independent, so each is diffed on its own.
  const split = (text: string) => text.split(OBJECT_MARKER);
  const a = split(before), b = split(after), out: Hunk[] = [];
  const chars = Array.from(before);
  let base = 0;
  a.forEach((piece, index) => {
    // Words first; a near-total rewrite falls back to whole paragraphs before one big replacement.
    const found = hunksOf(tokens(piece), tokens(b[index]), base) ?? hunksOf(lines(piece), lines(b[index]), base) ?? [{ start: base, end: base + scalars(piece), text: b[index] }];
    const coarse = coalesce(found, chars).flatMap(h => perLine(chars, h));
    for (const h of coarse) out.push(...refine(chars.slice(h.start, h.end).join(''), h));
    base += scalars(piece) + (index < old.length ? scalars(old[index]) : 0);
  });
  return out;
}

/** Applies hunks to text (for checking an edit script). */
export function applyHunks(before: string, hunks: readonly Hunk[]): string {
  const chars = Array.from(before);
  for (const h of [...hunks].sort((x, y) => y.start - x.start)) chars.splice(h.start, h.end - h.start, ...Array.from(h.text));
  return chars.join('');
}
