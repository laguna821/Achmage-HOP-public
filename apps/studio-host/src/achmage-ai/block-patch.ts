/**
 * Edits of the open document without retyping it. The model reads the document as numbered Markdown
 * blocks ([B1] …) and answers only with the blocks it changes; the app rebuilds the document, leaving
 * every other block exactly as read. The answer grows with the edit, not with the document, so a long
 * document with many tables does not hit the model's output length; the model reads about 250,000 characters at most.
 */
export interface BlockChange { from: number; to: number; markdown: string; insert: boolean }
export interface BlockPatch { changes: BlockChange[] }

const fail = (message: string): never => { throw new Error(message); };
const MAX_CHANGES = 100_000;

/** The blocks as the model sees them. */
export function numberedBlocks(blocks: readonly string[]): string {
  return blocks.map((block, index) => `[B${index + 1}]\n${block}`).join('\n\n');
}

/** Instructions for the answer format; the document and the request follow them in the prompt. */
export const BLOCK_PATCH_FORMAT = [
  '문서 전체를 다시 쓰지 말고 바꿀 블록만 JSON 하나로 답하세요. 설명·코드블록 없이 JSON만 답하세요.',
  '형식: {"schemaVersion":1,"kind":"block_patch","changes":[{"replace":"B3","markdown":"…"},{"replace":"B10-B14","markdown":"…"},{"insertAfter":"B7","markdown":"…"}]}',
  'replace는 그 블록(또는 범위)을 markdown으로 바꾸고, markdown이 ""이면 지웁니다. insertAfter는 그 블록 뒤에 새 내용을 넣습니다(B0은 맨 앞). 바꾸는 범위는 서로 겹치지 않게 하세요.',
  'markdown은 Kordoc Markdown입니다(제목 #, 소제목 ##, 목록 -, 표는 Markdown 표, 블록 사이는 빈 줄). 바꾸지 않는 블록은 답에 넣지 마세요. 바꿀 것이 없으면 "changes":[]로 답하세요.',
].join('\n');

function blockNumber(value: string, count: number, allowZero: boolean): number {
  const match = /^B(\d{1,7})$/.exec(value.trim());
  const n = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(n) || n < (allowZero ? 0 : 1) || n > count) fail(`없는 블록 번호입니다: ${value}`);
  return n;
}

/** The model's JSON answer, checked against the block count. Code fences and text around the JSON are tolerated. */
export function parseBlockPatch(reply: string, count: number): BlockPatch {
  let text = reply.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '');
  if (!text.startsWith('{')) { const start = text.indexOf('{'), end = text.lastIndexOf('}'); if (start < 0 || end <= start) fail('AI가 바꿀 블록 목록(JSON)으로 답하지 않아 적용하지 않았습니다.'); text = text.slice(start, end + 1); }
  let value: unknown;
  try { value = JSON.parse(text); } catch { return fail('AI 응답의 블록 목록(JSON)을 읽지 못해 적용하지 않았습니다.'); }
  const root = value as { schemaVersion?: unknown; kind?: unknown; changes?: unknown };
  if (!root || typeof root !== 'object' || root.kind !== 'block_patch' || !Array.isArray(root.changes)) fail('AI 응답이 블록 변경 형식이 아니어서 적용하지 않았습니다.');
  const raw = root.changes as unknown[];
  if (raw.length > MAX_CHANGES) fail('바꿀 블록이 너무 많습니다.');
  const changes = raw.map(item => {
    const c = item as { replace?: unknown; insertAfter?: unknown; markdown?: unknown };
    if (!c || typeof c !== 'object' || typeof c.markdown !== 'string' || (typeof c.replace === 'string') === (typeof c.insertAfter === 'string')) fail('블록 변경 항목의 형식이 올바르지 않습니다.');
    if (typeof c.insertAfter === 'string') { const at = blockNumber(c.insertAfter, count, true); return { from: at, to: at, markdown: c.markdown as string, insert: true }; }
    const [first, last = first] = (c.replace as string).split('-');
    const from = blockNumber(first, count, false), to = blockNumber(last, count, false);
    if (to < from) fail(`블록 범위가 거꾸로입니다: ${c.replace as string}`);
    return { from, to, markdown: c.markdown as string, insert: false };
  });
  const replaced = changes.filter(c => !c.insert).sort((a, b) => a.from - b.from);
  for (let i = 1; i < replaced.length; i++) if (replaced[i].from <= replaced[i - 1].to) fail('바꾸는 블록 범위가 서로 겹칩니다.');
  // A new block after a block in the middle of a replaced range has no place in the result.
  for (const c of changes) if (c.insert && replaced.some(r => c.from >= r.from && c.from < r.to)) fail(`B${c.from} 뒤에 넣을 내용이 바꾸는 범위 안에 있습니다.`);
  return { changes };
}

/** The document after the patch: unchanged blocks byte for byte, changed ones as written. */
export function applyBlockPatch(blocks: readonly string[], patch: BlockPatch): string {
  const replaceAt = new Map(patch.changes.filter(c => !c.insert).map(c => [c.from, c]));
  const insertsAfter = new Map<number, string[]>();
  for (const c of patch.changes) if (c.insert) insertsAfter.set(c.from, [...(insertsAfter.get(c.from) ?? []), c.markdown]);
  const out: string[] = [...(insertsAfter.get(0) ?? [])];
  for (let n = 1; n <= blocks.length; n++) {
    const change = replaceAt.get(n);
    if (change) { out.push(change.markdown); out.push(...(insertsAfter.get(change.to) ?? [])); n = change.to; continue; }
    out.push(blocks[n - 1], ...(insertsAfter.get(n) ?? []));
  }
  // Only blank lines around a block go; a nested list item's leading spaces are its depth.
  return out.map(block => block.replace(/^(?:[ \t]*\n)+/u, '').replace(/\s+$/u, '')).filter(block => block.trim()).join('\n\n') + '\n';
}

/** A short line for the chat history instead of the JSON. */
export function blockPatchSummary(patch: BlockPatch, count: number): string {
  const changed = patch.changes.filter(c => !c.insert).reduce((n, c) => n + c.to - c.from + 1, 0), inserted = patch.changes.filter(c => c.insert).length;
  return patch.changes.length ? `문서 ${count}블록 중 ${changed}블록을 고치고 ${inserted}곳에 새 내용을 넣었습니다.` : '바꿀 내용이 없다고 답했습니다.';
}
