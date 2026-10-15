/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { HwpDocument } from '../../vendor/rhwp-core/rhwp.js';
import { fillForm, hwpxFormPack, profileKeyFor } from './pack-form';
import { bytesBase64, loadPacks, parseTemplatePack, verifiedForm } from './template-pack';
import { initPinnedEngine } from './test-support/pinned-wasm';

initPinnedEngine();

/** An owned blank form with click-here fields named like the pack's field ids. */
function form(): Uint8Array {
  const d = new HwpDocument(readFileSync(new URL('./fixtures/owned-blank.hwpx', import.meta.url)));
  try {
    d.insertText(0, 0, 0, '신청자: ');
    d.insertClickHereField(0, 0, d.getParagraphLength(0, 0), '성명', '', 'applicant.name', true);
    d.splitParagraph(0, 0, d.getParagraphLength(0, 0)); d.insertText(0, 1, 0, '자문자: ');
    d.insertClickHereField(0, 1, d.getParagraphLength(0, 1), '자문자 성명', '', 'adviser.name', true);
    d.splitParagraph(0, 1, d.getParagraphLength(0, 1)); d.insertText(0, 2, 0, '이메일: ');
    d.insertClickHereField(0, 2, d.getParagraphLength(0, 2), '이메일', '', 'email', true);
    return d.exportHwpx();
  } finally { d.free(); }
}
const bytes = form();
const pack = parseTemplatePack({ kind: 'kordoc-template-pack', schemaVersion: 1, id: 'test.fixed', version: '1.0.0', name: '시험 신청서', markdownSkeleton: '',
  hallym: { familyId: 'staff.requests', recipe: { strategy: 'fixed', templateStatus: 'example', sections: [], fields: [
    { id: 'applicant.name', label: '신청자', required: true, type: 'text' }, { id: 'adviser.name', label: '자문자 성명', required: true, type: 'text' },
    { id: 'email', label: '이메일', required: false, type: 'text' }, { id: 'bank', label: '계좌', required: true, type: 'text' }] },
    templateBase64: bytesBase64(bytes), templateSha256: createHash('sha256').update(bytes).digest('hex') } });

// A local template-pack archive (not part of the repository): set HOP_TEMPLATE_PACKS to its path to run this test.
const localPacks = process.env.HOP_TEMPLATE_PACKS ?? '';
describe('fixed packs: blank form filled from the profile (T13)', () => {
  it.skipIf(!localPacks || !existsSync(localPacks))('fills nothing of mine into the local student and thesis forms, and only writer fields elsewhere', async () => {
    const { packs } = await loadPacks(new Uint8Array(readFileSync(localPacks)), 'templates.zip');
    const me = { name: '홍길동', department: '○○학과', phone: '033-000-0000', email: 'writer@example.com' };
    const filled = async (id: string) => (await fillForm(packs.find(p => p.id === id)!, me, b => new HwpDocument(b))).filled;
    expect(await filled('hallym-central.academic')).toEqual([]);
    expect(await filled('hallym-grad.thesis')).toEqual([]);
    expect(await filled('hallym-purchase.request')).toEqual(['신청 부서', '신청자']);
  }, 60_000);
  it('fills only the writer fields, leaves the others blank and reports fields the form lacks', async () => {
    const result = await fillForm(pack, { name: '홍길동', email: 'writer@example.com', phone: '' }, b => new HwpDocument(b));
    expect(result).toMatchObject({ filled: ['신청자', '이메일'], blank: ['자문자 성명'], unsupported: ['계좌'], failed: [], losses: 0 });
    const opened = new HwpDocument(result.bytes);
    try {
      expect(JSON.parse(opened.getFieldValueByName('applicant.name'))).toMatchObject({ value: '홍길동' });
      expect(JSON.parse(opened.getFieldValueByName('email'))).toMatchObject({ value: 'writer@example.com' });
    } finally { opened.free(); }
  });

  it('never guesses: an empty profile fills nothing', async () => {
    const result = await fillForm(pack, {}, b => new HwpDocument(b));
    expect(result.filled).toEqual([]); expect(result.blank).toEqual(['신청자', '자문자 성명', '이메일']);
  });
  // Gate C M2: on a form without its own applicant, a "소속"/"전화" field belongs to someone else (a student, a presenter).
  it('fills context-free contact fields only on forms whose applicant is the writer', () => {
    const withApplicant = new Set(['department', 'applicant.name', 'office.phone', 'email']), student = new Set(['department', 'student.name', 'phone']), thesis = new Set(['department', 'presenter.name']);
    expect(['department', 'applicant.name', 'office.phone', 'email'].map(id => profileKeyFor(id, withApplicant))).toEqual(['department', 'name', 'phone', 'email']);
    expect(['department', 'student.name', 'phone'].map(id => profileKeyFor(id, student))).toEqual([undefined, undefined, undefined]);
    expect(profileKeyFor('department', thesis)).toBeUndefined();
    expect(profileKeyFor('applicant.affiliation', new Set(['applicant.affiliation']))).toBe('department');
    expect(['adviser.name', 'responsible.name', 'lecturer.name'].map(id => profileKeyFor(id, withApplicant))).toEqual([undefined, undefined, undefined]);
  });

  it('refuses an HWPX without named click-here fields instead of making an empty form pack', async () => {
    const plain = new HwpDocument(readFileSync(new URL('./fixtures/owned-blank.hwpx', import.meta.url)));
    let bytes: Uint8Array; try { bytes = plain.exportHwpx(); } finally { plain.free(); }
    await expect(hwpxFormPack(bytes, '빈 문서.hwpx', b => new HwpDocument(b))).rejects.toThrow('누름틀');
  });

  it('imports an existing HWPX form as a fixed pack with its click-here fields', async () => {
    const imported = await hwpxFormPack(bytes, '교직원 신청서.hwpx', b => new HwpDocument(b));
    expect(imported).toMatchObject({ name: '교직원 신청서', strategy: 'fixed', status: 'example', family: 'imported.form' });
    expect(imported.fields.map(f => f.id)).toEqual(['applicant.name', 'adviser.name', 'email']);
    expect(await verifiedForm(imported)).toEqual(bytes);
  });
});
