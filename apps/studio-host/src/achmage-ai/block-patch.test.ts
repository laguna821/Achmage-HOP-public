import { describe, it, expect } from 'vitest';
import { applyBlockPatch, blockPatchSummary, numberedBlocks, parseBlockPatch } from './block-patch';

const blocks = ['# 제목', '첫 문단', '| a | b |\n| --- | --- |\n| 1 | 2 |', '  - 들여쓴 항목', '마지막 문단'];
const patch = (changes: unknown[]) => JSON.stringify({ schemaVersion: 1, kind: 'block_patch', changes });

describe('changed blocks only: the model never retypes the document', () => {
  it('numbers the blocks the model reads', () => {
    expect(numberedBlocks(['# 제목', '본문'])).toBe('[B1]\n# 제목\n\n[B2]\n본문');
  });
  it('replaces, deletes and inserts while every other block stays byte for byte', () => {
    const p = parseBlockPatch(patch([{ replace: 'B2', markdown: '고친 문단' }, { replace: 'B5', markdown: '' }, { insertAfter: 'B3', markdown: '표 다음 새 문단' }, { insertAfter: 'B0', markdown: '맨 앞' }]), blocks.length);
    expect(applyBlockPatch(blocks, p)).toBe('맨 앞\n\n# 제목\n\n고친 문단\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n표 다음 새 문단\n\n  - 들여쓴 항목\n');
    expect(blockPatchSummary(p, blocks.length)).toBe('문서 5블록 중 2블록을 고치고 2곳에 새 내용을 넣었습니다.');
  });
  it('replaces a range with new writing (a summary of several blocks) and inserts after the range', () => {
    const p = parseBlockPatch(patch([{ replace: 'B2-B4', markdown: '요약 문단' }, { insertAfter: 'B4', markdown: '덧붙임' }]), blocks.length);
    expect(applyBlockPatch(blocks, p)).toBe('# 제목\n\n요약 문단\n\n덧붙임\n\n마지막 문단\n');
  });
  it('leaves the document as read when nothing needs to change', () => {
    const p = parseBlockPatch(patch([]), blocks.length);
    expect(applyBlockPatch(blocks, p)).toBe(blocks.join('\n\n') + '\n');
    expect(blockPatchSummary(p, blocks.length)).toBe('바꿀 내용이 없다고 답했습니다.');
  });
  it('tolerates a code fence or a sentence around the JSON', () => {
    expect(parseBlockPatch('```json\n' + patch([{ replace: 'B1', markdown: '# 새 제목' }]) + '\n```', blocks.length).changes).toHaveLength(1);
    expect(parseBlockPatch('바꿀 블록입니다.\n' + patch([{ replace: 'B1', markdown: '# 새 제목' }]), blocks.length).changes).toHaveLength(1);
  });
  it.each([
    ['# 문서 전체를 다시 쓴 답', 'JSON'],
    [patch([{ replace: 'B9', markdown: 'x' }]), '없는 블록'],
    [patch([{ replace: 'B0', markdown: 'x' }]), '없는 블록'],
    [patch([{ replace: 'B4-B2', markdown: 'x' }]), '거꾸로'],
    [patch([{ replace: 'B1-B3', markdown: 'x' }, { replace: 'B3', markdown: 'y' }]), '겹칩니다'],
    [patch([{ replace: 'B1-B3', markdown: 'x' }, { insertAfter: 'B2', markdown: 'y' }]), '범위 안'],
    [patch([{ replace: 'B1', insertAfter: 'B1', markdown: 'x' }]), '형식'],
    [patch([{ replace: 'B1' }]), '형식'],
    [JSON.stringify({ kind: 'other', changes: [] }), '블록 변경 형식'],
  ])('refuses a reply it cannot apply exactly: %s', (reply, message) => {
    expect(() => parseBlockPatch(reply, blocks.length)).toThrow(message);
  });
});
