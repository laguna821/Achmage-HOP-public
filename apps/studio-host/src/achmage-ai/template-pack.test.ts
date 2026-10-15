/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { bytesBase64, loadPacks, packGroup, packTemplate, packTemplateId, parseTemplatePack, readZip, templateAsPack, verifiedForm } from './template-pack';
import { BUILTIN_DOCUMENT_TEMPLATES, parseDocumentTemplate } from './document-templates';
import { kordocAuthoringPrompt } from './kordoc-authoring';

const blank = new Uint8Array(readFileSync(new URL('./fixtures/owned-blank.hwpx', import.meta.url)));
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
function pack(extra: Record<string, unknown> = {}, recipe: Record<string, unknown> = {}) {
  return { kind: 'kordoc-template-pack', schemaVersion: 1, id: 'test.form', version: '1.0.0', name: '시험 신청서', markdownSkeleton: '# 시험 신청서', limitations: ['기관 접수 가능성은 확인되지 않았습니다.'],
    hallym: { familyId: 'staff.requests', recipe: { strategy: 'fixed', templateStatus: 'reference-reconstructed', fields: [{ id: 'applicant.name', label: '신청자', required: true, type: 'text' }], sections: [], ...recipe }, templateBase64: bytesBase64(blank), templateSha256: sha(blank) }, ...extra };
}
/** A stored-entry ZIP built here (deflate), the shape the local pack archive uses. */
function zip(files: Record<string, string>): Uint8Array {
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name), data = Buffer.from(content), packed = deflateRawSync(data);
    const head = Buffer.alloc(30); head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(8, 8); head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(nameBytes.length, 26);
    const dir = Buffer.alloc(46); dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(8, 10); dir.writeUInt32LE(packed.length, 20); dir.writeUInt32LE(data.length, 24); dir.writeUInt16LE(nameBytes.length, 28); dir.writeUInt32LE(offset, 42);
    local.push(head, nameBytes, packed); central.push(dir, nameBytes); offset += 30 + nameBytes.length + packed.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...local, cd, end]));
}

describe('template data packs (T13)', () => {
  it('validates a pack and its blank form against the stated hash', async () => {
    const parsed = parseTemplatePack(pack());
    expect(parsed).toMatchObject({ id: 'test.form', strategy: 'fixed', status: 'reference-reconstructed', family: 'staff.requests', fields: [{ id: 'applicant.name', label: '신청자', required: true }] });
    expect(await verifiedForm(parsed)).toEqual(blank);
    await expect(verifiedForm(parseTemplatePack(pack({}, {}) && { ...pack(), hallym: { ...pack().hallym, templateSha256: '0'.repeat(64) } }))).rejects.toThrow('해시');
    expect(() => parseTemplatePack({ ...pack(), kind: 'other' })).toThrow('서식 팩');
    expect(() => parseTemplatePack(pack({}, { strategy: 'script' }))).toThrow('작성 방식');
  });

  it('never calls a pack an official form and groups packs by family', () => {
    const fixed = packTemplate(parseTemplatePack(pack())), minutes = packTemplate(parseTemplatePack(pack({ id: 'meeting.media' }, { strategy: 'minutes', templateStatus: 'common-draft' })));
    for (const t of [fixed, minutes]) expect(`${t.name} ${t.description}`).not.toMatch(/공식 양식(?! 아님)/u);
    expect(fixed.description).toContain('빈 양식 채우기'); expect(minutes.layout).toMatchObject({ enginePreset: 'minutes', sampleMarkdown: '# 시험 신청서' });
    expect(packTemplate(parseTemplatePack(pack({ markdownSkeleton: '| 신청자 | HALLYM_FIELD_applicant_DOT_name |' }))).layout?.sampleMarkdown).toBe('| 신청자 | [작성 필요: 신청자] |');
    expect(minutes.id).toMatch(/^pack-meeting-media-[0-9a-f]{8}$/u);expect(parseDocumentTemplate(minutes).id).toBe(minutes.id);
    // Gate C L2/L3: ids that differ only in punctuation stay distinct; a long name keeps the 80-character limit.
    const ids = ['a.b', 'a_b', 'a-b'].map(id => packTemplateId({ id }));expect(new Set(ids).size).toBe(3);expect(ids[2]).toBe('pack-a-b');
    const long = packTemplate(parseTemplatePack(pack({ name: '가'.repeat(80) }, { strategy: 'minutes', templateStatus: 'common-draft' })));
    expect(Array.from(long.name).length).toBeLessThanOrEqual(80);expect(long.name.endsWith('(공용 초안)')).toBe(true);expect(() => parseDocumentTemplate(long)).not.toThrow();
    // Gate C L1: a prototype key is not a source status.
    expect(() => parseTemplatePack(pack({}, { templateStatus: 'constructor' }))).toThrow('출처 구분');
    // Gate C M7: a pack's role styles follow its look, as the built-in template with that look does.
    expect(minutes.roles.body.fontFamily).toBe('한림고딕체 Regular');expect(fixed.roles.title.fontFamily).toBe('HY헤드라인M');expect(parseDocumentTemplate(fixed).layout?.sampleMarkdown).toBe('# 시험 신청서'); expect(packGroup({ family: 'grad.thesis' })).toBe('로컬 서식 팩 · 대학원');
  });

  it('reads a ZIP of packs and sets an invalid row aside instead of failing the rest (F12)', async () => {
    const archive = zip({ 'good.kordoc-template.json': JSON.stringify(pack()), 'bad.kordoc-template.json': '{"kind":"kordoc-template-pack","schemaVersion":2}', 'readme.txt': 'x' });
    expect([...(await readZip(archive)).keys()]).toEqual(['good.kordoc-template.json', 'bad.kordoc-template.json', 'readme.txt']);
    const loaded = await loadPacks(archive, 'packs.zip');
    expect(loaded.packs.map(p => p.id)).toEqual(['test.form']);
    expect(loaded.rejected).toEqual([{ name: 'bad.kordoc-template.json', reason: expect.stringContaining('서식 팩') }]);
  });

  it('carries look, layout and role styles; all 14 built-in looks and 9 presets survive as packs unchanged (T13 1·2)', () => {
    expect(BUILTIN_DOCUMENT_TEMPLATES).toHaveLength(14);
    expect(new Set(BUILTIN_DOCUMENT_TEMPLATES.map(t => t.layout?.enginePreset)).size).toBe(9);
    for (const builtin of BUILTIN_DOCUMENT_TEMPLATES) {
      const back = packTemplate(parseTemplatePack(JSON.parse(JSON.stringify(templateAsPack(builtin)))));
      expect(back.roles, builtin.id).toEqual(builtin.roles);
      expect(back.layout, builtin.id).toEqual(builtin.layout);
      expect(back.look, builtin.id).toEqual(builtin.look);
      // The generation prompt's style data (what the engine and preview use) is the same apart from the name.
      const style = (t: typeof builtin) => kordocAuthoringPrompt('보고서 써줘', { ...t, name: 'same' }).split('\n').find(l => l.startsWith('선택 템플릿'));
      expect(style(back), builtin.id).toBe(style(builtin));
      expect(() => parseDocumentTemplate(back)).not.toThrow();
    }
    // A style block the engine would reject is refused, not stored.
    expect(() => parseTemplatePack({ ...templateAsPack(BUILTIN_DOCUMENT_TEMPLATES[0]), hop: { layout: { enginePreset: 'press', cover: true, toc: true, paper: 'A4', orientation: 'portrait' } } })).toThrow();
  });

  it('reads a personal template exported as a pack file back as that template', () => {
    const template = { schemaVersion: 1, id: 'custom-abc', name: '내 보고서', provenance: 'personal' };
    const parsed = parseTemplatePack({ kind: 'kordoc-template-pack', schemaVersion: 1, id: 'custom-abc', version: '1.0.0', name: '내 보고서', markdownSkeleton: '# 내 보고서', limitations: [], hop: { template } });
    expect(parsed).toMatchObject({ strategy: 'report', status: 'example', hopTemplate: template });
  });

  // The local pack archive is not part of the repository; this runs only on a computer that has it.
  const local = process.env.HOP_TEMPLATE_PACKS ?? '';
  it.skipIf(!local || !existsSync(local))('loads all 34 local packs with their form hashes verified', async () => {
    const loaded = await loadPacks(new Uint8Array(readFileSync(local)), 'templates.zip');
    expect(loaded.rejected).toEqual([]);
    expect(loaded.packs).toHaveLength(34);
    expect(loaded.packs.filter(p => p.strategy === 'fixed')).toHaveLength(9);
    for (const p of loaded.packs) expect(packTemplate(p).name).not.toMatch(/공식 양식(?! 아님)/u);
  }, 60_000);
});
