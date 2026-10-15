import { invoke } from '@tauri-apps/api/core';
import type { HostFontFace, HostFontProvider, HostFontSnapshot } from '@/upstream/core';
import type { LocalFontEntry } from './desktop-local-fonts';

/**
 * Supplies the desktop font catalog to rhwp's renderer (HostFontProvider). Without it the
 * studio's display substitution never sees installed fonts and puts Malgun Gothic first in
 * every Canvas font, so 한림고딕체·휴먼명조 documents were drawn and line-broken with other
 * faces (compared with Hancom 2024 printouts). Paths stay on this side: the snapshot
 * carries only opaque ids and names.
 */
const WEIGHT_NAMES: ReadonlyArray<readonly [number, string]> = [
  [100, 'Thin'], [200, 'ExtraLight'], [300, 'Light'], [400, 'Regular'], [500, 'Medium'],
  [600, 'SemiBold'], [700, 'Bold'], [800, 'ExtraBold'], [900, 'Black'],
];
const FONT_FILE = /\.(?:ttf|otf|ttc|otc)$/i;

function styleWord(weight: number, slant: HostFontFace['slant']): string {
  const name = WEIGHT_NAMES.reduce((best, entry) => Math.abs(entry[0] - weight) < Math.abs(best[0] - weight) ? entry : best)[1];
  return slant && slant !== 'normal' ? (name === 'Regular' ? 'Italic' : `${name} Italic`) : name;
}

function hash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16);
}

export interface DesktopHostFontCatalog {
  snapshot: HostFontSnapshot;
  /** Opaque id → readable source (path and collection index). */
  sources: Map<string, { path: string; faceIndex: number }>;
}

/** One face per PostScript name and style, merging localized family names; app-local copies win. */
export function buildDesktopHostFontCatalog(entries: readonly LocalFontEntry[]): DesktopHostFontCatalog {
  const groups = new Map<string, LocalFontEntry[]>();
  for (const entry of entries) {
    if (!entry.path || !FONT_FILE.test(entry.path) || !entry.family.trim()) continue;
    const slant = entry.style === 'italic' || entry.style === 'oblique' ? entry.style : 'normal';
    const key = [entry.postScriptName || entry.family, entry.weight ?? 400, slant].join('\u0000').toLocaleLowerCase('en-US');
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const faces: HostFontFace[] = [];
  const sources = new Map<string, { path: string; faceIndex: number }>();
  for (const group of groups.values()) {
    const source = group.find(entry => entry.sourceKind === 'file-backed') ?? group[0];
    const samePath = group.filter(entry => entry.path === source.path);
    // Prefer a Korean family name as the primary, as Hancom documents usually name it.
    const families = [...new Set(samePath.map(entry => entry.family.trim()))]
      .sort((a, b) => Number(/[가-힣]/.test(b)) - Number(/[가-힣]/.test(a)));
    const weight = source.weight ?? 400;
    const slant: HostFontFace['slant'] = source.style === 'italic' || source.style === 'oblique' ? source.style : 'normal';
    const style = styleWord(weight, slant);
    const id = `face-${faces.length}`;
    faces.push({
      id, family: families[0], fullName: `${families[0]} ${style}`, postscriptName: source.postScriptName || '',
      style, weight, slant,
      aliases: [...new Set(families.flatMap(family => [family, `${family} ${style}`]))].slice(0, 32),
    });
    sources.set(id, { path: source.path!, faceIndex: source.faceIndex ?? 0 });
  }
  const revision = hash(faces.map(face => [face.id, face.family, face.postscriptName, face.weight, face.slant, sources.get(face.id)?.path].join('|')).join('\n'));
  return { snapshot: { revision, faces }, sources };
}

export function createDesktopHostFontProvider(
  listEntries: () => Promise<readonly LocalFontEntry[]>,
  readBytes: (path: string) => Promise<Uint8Array> = async path => new Uint8Array(await invoke<ArrayBuffer | number[]>('read_local_font', { path })),
): HostFontProvider & { refresh(): void } {
  let catalog: DesktopHostFontCatalog | null = null;
  const listeners = new Set<() => void>();
  return {
    async getSnapshot(signal) {
      const entries = await listEntries();
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      catalog = buildDesktopHostFontCatalog(entries);
      return catalog.snapshot;
    },
    async readFace(id, revision, signal) {
      const source = catalog?.snapshot.revision === revision ? catalog.sources.get(id) : undefined;
      if (!source) throw new Error('Host font face is no longer in the catalog');
      const bytes = await readBytes(source.path);
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      return { bytes: bytes.slice().buffer as ArrayBuffer, faceIndex: source.faceIndex };
    },
    subscribe(onChange) {
      listeners.add(onChange);
      return () => { listeners.delete(onChange); };
    },
    /** Call after the desktop catalog changed (fonts added or removed). */
    refresh() {
      catalog = null;
      for (const listener of listeners) listener();
    },
  };
}
