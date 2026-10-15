/**
 * Fixed-strategy packs: the pack's blank HWPX form (hash-verified) is filled in a throwaway engine
 * instance and opened in a new window. Only fields that plainly mean "the writer" take profile
 * values; everything else stays blank for the user, and a field the form does not have is reported
 * as unsupported instead of being guessed.
 */
import { invoke } from '@tauri-apps/api/core';
import { HwpDocument } from '@wasm/rhwp.js';
import { verifiedForm, bytesBase64, parseTemplatePack, sha256Hex, type TemplatePack } from './template-pack';
import type { ProfileKey, UserProfile } from './user-profile';

/** Fields that are the applicant by name: the person filling the form in. */
const APPLICANT_FIELDS: Readonly<Record<string, ProfileKey>> = {
  'applicant.name': 'name', 'applicant.department': 'department', 'applicant.affiliation': 'department', 'applicant.phone': 'phone', 'applicant.contact': 'phone', 'applicant.email': 'email',
};
/** Contact fields without an owner in their name ("소속", "연락처"): the writer's only on a form whose applicant is its writer. */
const CONTEXT_FIELDS: Readonly<Record<string, ProfileKey>> = { 'department': 'department', 'contact': 'phone', 'phone': 'phone', 'office.phone': 'phone', 'email': 'email' };
/**
 * Which profile value a form field takes, if any. A form names its writer with `applicant.name`; without it
 * (a student's return form, a thesis evaluation, an imported form) no context-free field is guessed to be mine.
 */
export function profileKeyFor(fieldId: string, formFieldIds: ReadonlySet<string>): ProfileKey | undefined {
  return APPLICANT_FIELDS[fieldId] ?? (formFieldIds.has('applicant.name') ? CONTEXT_FIELDS[fieldId] : undefined);
}
export interface FilledForm { bytes: Uint8Array; filled: string[]; blank: string[]; unsupported: string[]; failed: string[]; losses: number }

type FormDocument = Pick<HwpDocument, 'getFieldList' | 'setFieldValueByName' | 'exportHwpxWithReport' | 'free'>;
export async function fillForm(pack: TemplatePack, profile: UserProfile, open: (bytes: Uint8Array) => FormDocument = bytes => new HwpDocument(bytes)): Promise<FilledForm> {
  const doc = open(await verifiedForm(pack)), filled: string[] = [], blank: string[] = [], unsupported: string[] = [], failed: string[] = [];
  try {
    const names = new Set((JSON.parse(doc.getFieldList()) as { name?: unknown }[]).map(f => f.name).filter((n): n is string => typeof n === 'string'));
    const ids = new Set(pack.fields.map(f => f.id));
    for (const field of pack.fields) {
      if (!names.has(field.id)) { unsupported.push(field.label); continue; }
      const key = profileKeyFor(field.id, ids), value = key ? profile[key]?.trim() : '';
      if (!value) { blank.push(field.label); continue; }
      const result = JSON.parse(doc.setFieldValueByName(field.id, value)) as { ok?: boolean };
      (result.ok === false ? failed : filled).push(field.label);
    }
    // The filled form is exported with the engine's content-loss report, like every save (T16).
    const exported = doc.exportHwpxWithReport();
    try {
      const report = JSON.parse(exported.contentLoss()) as { losses?: unknown[] };
      return { bytes: exported.takeBytes(), filled, blank, unsupported, failed, losses: Array.isArray(report.losses) ? report.losses.length : 0 };
    } finally { exported.free(); }
  } finally { doc.free(); }
}

/** Opens the filled form in a new HOP window through the same native path as generated documents. */
export async function openFilledForm(pack: TemplatePack, profile: UserProfile): Promise<Omit<FilledForm, 'bytes'>> {
  const { bytes, ...summary } = await fillForm(pack, profile), sha256 = await sha256Hex(bytes);
  const prepared = await invoke<{ artifactId: string; sha256: string }>('achmage_kordoc_prepare_generated', { hwpxBase64: bytesBase64(bytes), sha256, displayName: pack.name });
  if (prepared.sha256 !== sha256 || !prepared.artifactId) throw new Error('양식 파일의 무결성을 확인하지 못했습니다.');
  await invoke('achmage_kordoc_open_generated', { artifactId: prepared.artifactId });
  return summary;
}

/** An existing HWPX form as a fixed pack: its click-here fields become the pack's fields. HWP stays read-only input. */
export async function hwpxFormPack(bytes: Uint8Array, fileName: string, open: (bytes: Uint8Array) => Pick<HwpDocument, 'getFieldList' | 'free'> = b => new HwpDocument(b)): Promise<TemplatePack> {
  const doc = open(bytes);
  try {
    // Field names longer than a pack id allows cannot be filled by name; they stay in the form untouched.
    const fields = (JSON.parse(doc.getFieldList()) as { name?: unknown; guide?: unknown; fieldType?: unknown }[])
      .filter((f): f is { name: string; guide?: unknown; fieldType?: unknown } => f.fieldType === 'clickhere' && typeof f.name === 'string' && !!f.name.trim() && f.name.length <= 80).slice(0, 80);
    if (!fields.length) throw new Error('이 HWPX에는 이름이 붙은 누름틀이 없어 양식으로 가져올 수 없습니다.');
    const sha256 = await sha256Hex(bytes), name = fileName.replace(/\.hwpx$/iu, '').trim().slice(0, 80) || '가져온 양식';
    return parseTemplatePack({ kind: 'kordoc-template-pack', schemaVersion: 1, id: `imported.${sha256.slice(0, 16)}`, version: '1.0.0', name, markdownSkeleton: '',
      limitations: ['사용자가 가져온 HWPX 양식입니다. 기관 접수 가능성은 확인되지 않았습니다.'],
      hallym: { familyId: 'imported.form', recipe: { strategy: 'fixed', templateStatus: 'example', sections: [], fields: fields.map(f => ({ id: f.name, label: typeof f.guide === 'string' && f.guide.trim() ? f.guide.trim().slice(0, 80) : f.name, required: false, type: 'text' })) },
        templateBase64: bytesBase64(bytes), templateSha256: sha256 } });
  } finally { doc.free(); }
}
