/**
 * Template data packs (schema v1, the `kordoc-template-pack` format the local Hallym pack uses).
 * A pack is data, never code: a Markdown skeleton and fields for report/minutes documents written
 * by the template engine, or a blank HWPX form whose click-here fields are filled ("fixed").
 * Packs stay on this computer (IndexedDB); nothing here is published or sent anywhere.
 * Nothing is called an official form: each pack says whether it is an example, a common draft,
 * or a reconstruction from an official source, and keeps its stated limitations.
 */
import { HALLYM_ILSONG_LOOK, standardLook, type TemplateLook } from './template-look';
import { BUILTIN_DOCUMENT_TEMPLATES, parseDocumentTemplate, type DocumentTemplate, type TemplateLayout } from './document-templates';

export type PackStatus = 'example' | 'common-draft' | 'reference-reconstructed';
export type PackStrategy = 'report' | 'minutes' | 'fixed';
export interface PackField { id: string; label: string; required: boolean; type: string }
export interface TemplatePack {
  id: string; version: string; name: string; status: PackStatus; strategy: PackStrategy; family: string;
  markdownSkeleton: string; fields: PackField[]; sections: string[]; limitations: string[];
  /** The blank HWPX form (fixed strategy), base64, and its SHA-256 as stated by the pack. */
  templateBase64?: string; templateSha256?: string;
  /** A personal template exported from this app (no form bytes). */
  hopTemplate?: unknown;
  /**
   * Optional HOP style block (`hop.look`, `hop.layout`, `hop.roles`): the measured look, the document
   * composition (engine preset, cover, contents, paper) and role styles. Without it they follow the strategy.
   */
  look?: TemplateLook; layout?: TemplateLayout; roles?: DocumentTemplate['roles'];
}
export const PACK_STATUS_LABELS: Record<PackStatus, string> = { 'example': '예시', 'common-draft': '공용 초안', 'reference-reconstructed': '공식 출처 재구성' };

const fail = (message: string): never => { throw new Error(message); };
const text = (v: unknown, max: number, label: string): string => typeof v === 'string' && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(v) ? v : fail(`${label} 값을 확인하세요.`);
const ID = /^[a-z0-9][a-z0-9._-]{0,79}$/u;
const isStatus = (status: unknown): status is PackStatus => typeof status === 'string' && Object.hasOwn(PACK_STATUS_LABELS, status);

/** A validated pack; unknown kinds, versions, strategies or oversized values fail. */
export function parseTemplatePack(value: unknown): TemplatePack {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== 'object' || v.kind !== 'kordoc-template-pack' || v.schemaVersion !== 1) fail('서식 팩(kordoc-template-pack v1)이 아닙니다.');
  const id = text(v!.id, 120, '팩 id').toLowerCase(), version = text(v!.version, 20, '팩 버전'), name = text(v!.name, 80, '팩 이름').trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,119}$/u.test(id) || !name) fail('팩 id나 이름을 확인하세요.');
  const hallym = (v!.hallym ?? {}) as Record<string, unknown>, recipe = (hallym.recipe ?? {}) as Record<string, unknown>, hop = v!.hop as Record<string, unknown> | undefined;
  const strategy = (recipe.strategy ?? (hop ? 'report' : undefined)) as PackStrategy;
  if (!['report', 'minutes', 'fixed'].includes(strategy)) fail('팩의 작성 방식(report·minutes·fixed)을 확인하세요.');
  const status = (recipe.templateStatus ?? 'example') as PackStatus;
  if (!isStatus(status)) fail('팩의 출처 구분을 확인하세요.');
  const family = text(hallym.familyId ?? recipe.id ?? id, 80, '팩 분류');
  if (!ID.test(family)) fail('팩 분류를 확인하세요.');
  const rawFields = Array.isArray(recipe.fields) ? recipe.fields : Array.isArray(v!.fields) ? v!.fields : [];
  if (rawFields.length > 80) fail('팩 칸이 너무 많습니다.');
  const fields = rawFields.map(f => { const x = f as Record<string, unknown>; return { id: text(x.id, 80, '칸 id'), label: text(x.label, 80, '칸 이름'), required: x.required === true, type: typeof x.type === 'string' ? x.type.slice(0, 20) : 'text' }; });
  const list = (raw: unknown, max: number, label: string) => (Array.isArray(raw) ? raw : []).slice(0, max).map(x => text(x, 300, label));
  const pack: TemplatePack = { id, version, name, status, strategy, family, markdownSkeleton: text(v!.markdownSkeleton ?? '', 200_000, 'Markdown 본보기'), fields, sections: list(recipe.sections, 60, '절'), limitations: list(v!.limitations, 20, '한계') };
  if (strategy === 'fixed') {
    pack.templateBase64 = text(hallym.templateBase64, 8_000_000, '빈 양식');
    pack.templateSha256 = text(hallym.templateSha256, 64, '빈 양식 SHA-256').toLowerCase();
    if (!/^[0-9a-f]{64}$/u.test(pack.templateSha256)) fail('빈 양식 SHA-256을 확인하세요.');
  }
  if (hop?.template !== undefined) pack.hopTemplate = hop.template;
  if (hop && (hop.look !== undefined || hop.layout !== undefined || hop.roles !== undefined)) {
    // Checked by the document-template parser itself, so a pack can only carry what the engine accepts.
    const layout = hop.layout === undefined ? undefined : { ...(hop.layout as Record<string, unknown>), sampleMarkdown: (hop.layout as { sampleMarkdown?: unknown }).sampleMarkdown || pack.markdownSkeleton || `# ${name}` };
    const probe = parseDocumentTemplate({ schemaVersion: 1, id: 'pack-style', name, category: 'education', provenance: 'sample', description: '',
      roles: hop.roles ?? rolesForLook(strategy), ...(layout ? { layout } : {}), ...(hop.look !== undefined ? { look: hop.look } : {}) });
    if (hop.look !== undefined) pack.look = probe.look;
    if (hop.layout !== undefined) pack.layout = probe.layout;
    if (hop.roles !== undefined) pack.roles = probe.roles;
  }
  return pack;
}

export function base64Bytes(base64: string): Uint8Array { const raw = atob(base64); return Uint8Array.from(raw, c => c.charCodeAt(0)); }
export function bytesBase64(bytes: Uint8Array): string { let raw = ''; for (let i = 0; i < bytes.length; i += 0x8000) raw += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(raw); }
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
/** A fixed pack's form bytes, only when they match the hash the pack states. */
export async function verifiedForm(pack: TemplatePack): Promise<Uint8Array> {
  if (pack.strategy !== 'fixed' || !pack.templateBase64 || !pack.templateSha256) fail('빈 양식이 없는 팩입니다.');
  const bytes = base64Bytes(pack.templateBase64!);
  if (await sha256Hex(bytes) !== pack.templateSha256) fail(`'${pack.name}' 빈 양식의 해시가 맞지 않아 쓰지 않습니다.`);
  return bytes;
}

/** Stored ZIP entries (no encryption, deflate or store), read from the central directory. */
export async function readZip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), out = new Map<string, Uint8Array>();
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) fail('ZIP 파일이 아닙니다.');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  if (count > 500) fail('ZIP 항목이 너무 많습니다.');
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) fail('ZIP 목차를 읽지 못했습니다.');
    const flags = view.getUint16(p + 8, true), method = view.getUint16(p + 10, true), size = view.getUint32(p + 20, true), plain = view.getUint32(p + 24, true);
    const nameLength = view.getUint16(p + 28, true), extra = view.getUint16(p + 30, true), comment = view.getUint16(p + 32, true), local = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLength));
    if (flags & 1) fail('암호화된 ZIP은 읽지 않습니다.');
    if (plain > 16_000_000) fail('ZIP 항목이 너무 큽니다.');
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true), data = bytes.subarray(start, start + size);
    if (method === 0) out.set(name, data);
    else if (method === 8) out.set(name, await inflate(data, plain));
    else fail('지원하지 않는 ZIP 압축 방식입니다.');
    p += 46 + nameLength + extra + comment;
  }
  return out;
}

/** Deflate output is read in chunks and stops at the size the archive declares, never more. */
async function inflate(data: Uint8Array, declared: number): Promise<Uint8Array> {
  const reader = new Blob([data as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader(), out = new Uint8Array(declared);
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (length + value.length > declared) { await reader.cancel(); fail('ZIP 항목의 실제 크기가 선언과 다릅니다.'); }
    out.set(value, length); length += value.length;
  }
  if (length !== declared) fail('ZIP 항목의 실제 크기가 선언과 다릅니다.');
  return out;
}

export interface PackLoad { packs: TemplatePack[]; rejected: { name: string; reason: string }[] }
/** Every pack in a file (a ZIP of packs or one pack JSON); invalid rows are set aside with the reason. */
export async function loadPacks(bytes: Uint8Array, fileName: string): Promise<PackLoad> {
  const entries = /\.zip$/iu.test(fileName) ? await readZip(bytes) : new Map([[fileName, bytes]]);
  const packs: TemplatePack[] = [], rejected: PackLoad['rejected'] = [];
  for (const [name, data] of entries) {
    if (!/\.json$/iu.test(name)) continue;
    try {
      const pack = parseTemplatePack(JSON.parse(new TextDecoder().decode(data)));
      if (pack.strategy === 'fixed') await verifiedForm(pack);
      packs.push(pack);
    } catch (error) { rejected.push({ name, reason: error instanceof Error ? error.message : '읽지 못했습니다.' }); }
  }
  return { packs, rejected };
}

const FAMILY_LABELS: Record<string, string> = { pbl: 'PBL 교과목', teaching: '교수학습', research: '연구 행정', grad: '대학원', central: '학사·시설', glocal: '글로컬', purchase: '구매', faculty: '교원 인사', staff: '직원', meeting: '회의', report: '보고서', ai: 'AI 융합', rise: 'RISE', hss: '인문사회', irb: '연구윤리(IRB)', imported: '가져온 양식' };
export const PACK_GROUP_PREFIX = '로컬 서식 팩';
export function packGroup(pack: Pick<TemplatePack, 'family'>): string { const head = pack.family.split('.')[0]; return `${PACK_GROUP_PREFIX} · ${FAMILY_LABELS[head] ?? head}`; }

/** A pack's role styles are those of the built-in template with the same look, so restyling matches the preview. */
const rolesForLook = (strategy: PackStrategy) => structuredClone(BUILTIN_DOCUMENT_TEMPLATES.find(t => t.id === (strategy === 'minutes' ? 'builtin-hallym-ilsong' : 'builtin-report'))!.roles);

/** The pack runner's field tokens (HALLYM_FIELD_meeting_DOT_date) shown as the blanks people fill in. */
export function readableSkeleton(pack: Pick<TemplatePack, 'markdownSkeleton' | 'fields'>): string {
  return pack.markdownSkeleton.replace(/HALLYM_FIELD_([A-Za-z0-9_]+)/gu, (_, key: string) => { const id = key.replace(/_DOT_/gu, '.'), field = pack.fields.find(f => f.id === id); return `[작성 필요: ${field?.label ?? id}]`; }).trim();
}

/**
 * Template ids allow lowercase letters, digits and hyphens only. A pack id with other characters gets a
 * short hash of the original id, so "a.b" and "a_b" never become the same template.
 */
export function packTemplateId(pack: Pick<TemplatePack, 'id'>): string {
  const slug = pack.id.replace(/[^a-z0-9-]+/gu, '-');
  if (slug === pack.id) return `pack-${slug}`.slice(0, 100);
  let hash = 0x811c9dc5;
  for (const unit of pack.id) { hash ^= unit.codePointAt(0)!; hash = Math.imul(hash, 0x01000193) >>> 0; }
  const suffix = `-${hash.toString(16).padStart(8, '0')}`;
  return `pack-${slug}`.slice(0, 100 - suffix.length) + suffix;
}
/** A visible name within the 80-character template limit, the status label included. */
function packName(pack: TemplatePack, status: string): string {
  const tail = ` (${status})`, room = 80 - tail.length;
  const name = Array.from(pack.name).length > room ? Array.from(pack.name).slice(0, room - 1).join('') + '…' : pack.name;
  return name + tail;
}

/** The pack as a selectable document template (report/minutes write through the template engine). */
export function packTemplate(pack: TemplatePack): DocumentTemplate {
  const status = PACK_STATUS_LABELS[pack.status], notes = [status, ...pack.limitations].join(' · ');
  const fixed = pack.strategy === 'fixed';
  return {
    schemaVersion: 1, id: packTemplateId(pack), name: packName(pack, status), category: 'education', provenance: 'sample',
    description: `${fixed ? '빈 양식 채우기' : pack.strategy === 'minutes' ? '회의록 생성' : '보고서 생성'} · ${notes}`.slice(0, 1000),
    roles: pack.roles ? structuredClone(pack.roles) : rolesForLook(pack.strategy),
    layout: pack.layout ? structuredClone(pack.layout) : { enginePreset: pack.strategy === 'minutes' ? 'minutes' : 'report', cover: false, toc: false, paper: 'A4', orientation: 'portrait', sampleMarkdown: (readableSkeleton(pack) || `# ${pack.name}`).slice(0, 32_000) },
    ...(pack.look ? { look: structuredClone(pack.look) } : pack.layout ? {} : { look: pack.strategy === 'minutes' ? structuredClone(HALLYM_ILSONG_LOOK) : standardLook('report') }),
  };
}

/** Any document template written as a v1 data pack with its full style block (T13 criterion 2). */
export function templateAsPack(template: DocumentTemplate): Record<string, unknown> {
  const layout = template.layout, id = template.id.replace(/[^a-z0-9._-]+/gu, '-').replace(/^[^a-z0-9]+/u, '') || 'template';
  return { kind: 'kordoc-template-pack', schemaVersion: 1, id, version: '1.0.0', name: template.name, markdownSkeleton: layout?.sampleMarkdown ?? '', limitations: [],
    hallym: { familyId: 'hop.template', recipe: { strategy: layout?.enginePreset === 'minutes' ? 'minutes' : 'report', templateStatus: 'example', sections: [], fields: [] } },
    hop: { roles: template.roles, ...(layout ? { layout } : {}), ...(template.look ? { look: template.look } : {}) } };
}

/** Local IndexedDB storage of packs (this computer only). */
export class TemplatePackStore {
  private static readonly DB = 'achmage-template-packs';
  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(TemplatePackStore.DB, 1);
      request.onupgradeneeded = () => { request.result.createObjectStore('packs', { keyPath: 'id' }); };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error ?? new Error('서식 팩 저장소를 열지 못했습니다.'));
    });
  }
  private async run<T>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
    const db = await this.open();
    try {
      return await new Promise<T | undefined>((resolve, reject) => {
        const tx = db.transaction('packs', mode), request = body(tx.objectStore('packs'));
        tx.oncomplete = () => resolve(request ? request.result : undefined); tx.onerror = () => reject(tx.error ?? new Error('서식 팩 저장에 실패했습니다.'));
        // A quota or version abort ends the transaction without an error event on the request.
        tx.onabort = () => reject(tx.error ?? new Error('서식 팩 저장이 중단되었습니다. 디스크 공간을 확인하세요.'));
      });
    } finally { db.close(); }
  }
  async list(): Promise<PackLoad> {
    const rows = (await this.run<unknown[]>('readonly', store => store.getAll())) ?? [], packs: TemplatePack[] = [], rejected: PackLoad['rejected'] = [];
    // A stored row that no longer validates is set aside, never allowed to block other templates (F12).
    for (const row of rows) { try { const pack = parseStored(row); packTemplate(pack); packGroup(pack); packs.push(pack); } catch (error) { rejected.push({ name: String((row as { id?: unknown }).id ?? '?'), reason: error instanceof Error ? error.message : '읽지 못했습니다.' }); } }
    return { packs, rejected };
  }
  async put(packs: readonly TemplatePack[]): Promise<void> { await this.run('readwrite', store => { for (const pack of packs) store.put(pack); }); }
  async remove(id: string): Promise<void> { await this.run('readwrite', store => store.delete(id)); }
}
function parseStored(row: unknown): TemplatePack {
  const r = row as TemplatePack, strings = (v: unknown) => Array.isArray(v) && v.every(x => typeof x === 'string');
  if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !['report', 'minutes', 'fixed'].includes(r.strategy) || !isStatus(r.status)
    || (r.look !== undefined && typeof r.look !== 'object') || (r.layout !== undefined && typeof r.layout !== 'object') || (r.roles !== undefined && typeof r.roles !== 'object') || typeof r.name !== 'string' || typeof r.family !== 'string' || !ID.test(r.family)
    || typeof r.markdownSkeleton !== 'string' || !strings(r.sections) || !strings(r.limitations)
    || !Array.isArray(r.fields) || !r.fields.every(f => f && typeof f.id === 'string' && typeof f.label === 'string')) fail('저장된 서식 팩 형식이 바뀌었습니다.');
  return r;
}
