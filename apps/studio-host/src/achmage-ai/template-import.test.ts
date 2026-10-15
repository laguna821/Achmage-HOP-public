/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { HwpDocument } from '../../vendor/rhwp-core/rhwp.js';
import { initPinnedEngine } from './test-support/pinned-wasm';
import { importTemplateFile } from './template-import';
import { DocumentTemplateStore, parseDocumentTemplate } from './document-templates';

initPinnedEngine();
const fixture = (path: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${path}`, import.meta.url)));

describe('서식 추가하기 from a Hangul file', () => {
  it('reads body and table looks, paper and orientation from a real HWPX into a valid personal template', () => {
    const result = importTemplateFile(fixture('kordoc-report-cover.hwpx'), 'C:/문서/주간 보고.hwpx', bytes => new HwpDocument(bytes));
    const t = result.template;
    expect(parseDocumentTemplate(t)).toEqual(t);
    expect(t).toMatchObject({ name: '주간 보고 서식', provenance: 'personal', category: 'personal', layout: { enginePreset: 'report', cover: false, toc: false, paper: 'A4', orientation: 'portrait' } });
    expect(t.id).toMatch(/^custom-/u);
    expect(result.measured).toEqual(expect.arrayContaining(['body', 'tableHeader']));
    expect(result.paragraphs).toBeGreaterThan(3);
    for (const role of Object.values(t.roles)) {
      expect(role.fontFamily.length).toBeGreaterThan(0);
      expect(role.fontSizePt).toBeGreaterThanOrEqual(5);
    }
    // The new template can be stored as one of my templates.
    const storage = new Map<string, string>();
    const store = new DocumentTemplateStore({ getItem: k => storage.get(k) ?? null, setItem: (k, v) => { storage.set(k, v); }, removeItem: k => { storage.delete(k); } });
    expect(store.save(t).id).toBe(t.id);
    expect(store.list().some(x => x.id === t.id)).toBe(true);
  });

  it('refuses files that are not Hangul documents or cannot be opened, and frees what it opened', () => {
    expect(() => importTemplateFile(new Uint8Array([1, 2, 3]), '그림.png')).toThrow('.hwp');
    expect(() => importTemplateFile(new Uint8Array([1, 2, 3]), '깨진.hwp', () => { throw new Error('bad'); })).toThrow('열지 못했습니다');
    let freed = false;
    const empty = { getSectionCount: () => 1, getParagraphCount: () => 1, getParagraphLength: () => 0, getTextRange: () => '', getCharPropertiesAt: () => '{}', getParaPropertiesAt: () => '{}', getControls: () => '[]', getTableDimensions: () => '{}', getCellInfo: () => '{}', getCellParagraphCount: () => 0, getCellParagraphLength: () => 0, getTextInCell: () => '', getCellCharPropertiesAt: () => '{}', getCellParaPropertiesAt: () => '{}', getStyleAt: () => '{}', getPageDef: () => '{}', getFieldList: () => '[]', free: () => { freed = true; } };
    expect(() => importTemplateFile(new Uint8Array(), '빈 문서.hwpx', () => empty)).toThrow('본문 글자');
    expect(freed).toBe(true);
  });
});

describe('hiding built-in templates', () => {
  it('hides a built-in from the list and selection, and shows it again', () => {
    const storage = new Map<string, string>();
    const store = new DocumentTemplateStore({ getItem: k => storage.get(k) ?? null, setItem: (k, v) => { storage.set(k, v); }, removeItem: k => { storage.delete(k); } });
    const first = store.list()[0];
    store.select(first.id);
    store.hide(first.id);
    expect(store.list().some(t => t.id === first.id)).toBe(false);
    expect(store.listAll().some(t => t.id === first.id)).toBe(true);
    expect(store.selected()).toBeUndefined();
    expect(() => store.select(first.id)).toThrow();
    expect(() => store.hide('custom-x')).toThrow('기본 서식만');
    store.unhide();
    expect(store.list().some(t => t.id === first.id)).toBe(true);
    expect(store.hidden().size).toBe(0);
  });
});
