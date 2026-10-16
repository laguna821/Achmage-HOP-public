import { invoke } from '@tauri-apps/api/core';
import type {
  DetectLocalFontsOptions,
  GetLocalFontsOptions,
  LocalFontRecord,
  LocalFontSnapshot,
  LocalFontState,
} from '@/upstream/local-fonts';
import { REGISTERED_FONTS } from './font-catalog';
import {
  clearLoadedLocalAuthoringFamilies, filterAuthoringFontFamilies,
  isAuthoringBlockedFontFamily, isLoadedLocalAuthoringFamily,
  registerLoadedLocalAuthoringFamily,
} from './font-authoring-policy';

export interface LocalFontEntry {
  family: string;
  postScriptName: string;
  style: string;
  weight?: number;
  sourceKind: 'system-installed' | 'file-backed';
  path?: string | null;
  /** Face number inside a TTC/OTC collection. */
  faceIndex?: number;
}

let cachedFontEntries: LocalFontEntry[] | null = null;
let pendingFontEntries: Promise<LocalFontEntry[]> | null = null;
let detectedAt: string | null = null;
let lastError: string | null = null;
interface DesktopFontFaceState {
  pending: Promise<FontFace>;
  face?: FontFace;
}
const loadedFontFaces = new Map<string, DesktopFontFaceState>();
const fontBinaryCache = new Map<string, Promise<Uint8Array>>();
let fontGeneration = 0;

export function isDesktopTauriRuntime(): boolean {
  return typeof window !== 'undefined'
    && ('__TAURI_INTERNALS__' in window || window.location?.protocol === 'tauri:');
}

export async function loadStoredDesktopFonts(): Promise<LocalFontSnapshot | null> {
  return cachedFontEntries ? desktopSnapshot() : null;
}

export function clearStoredDesktopFonts(): void {
  resetDesktopFonts();
}

export async function detectDesktopFontEntries(force = false): Promise<LocalFontEntry[]> {
  if (cachedFontEntries && !force) return cachedFontEntries;
  if (force) {
    cachedFontEntries = null;
    clearLoadedDesktopFontFaces();
  }
  if (pendingFontEntries) return pendingFontEntries;
  const pending = readDesktopFontEntries(fontGeneration);
  pendingFontEntries = pending;
  try {
    return await pending;
  } finally {
    // A reset/refresh may already have started a newer scan.
    if (pendingFontEntries === pending) pendingFontEntries = null;
  }
}

async function readDesktopFontEntries(generation: number): Promise<LocalFontEntry[]> {
  try {
    const entries = await invoke<LocalFontEntry[]>('list_local_fonts');
    if (generation !== fontGeneration) return cachedFontEntries ?? [];
    cachedFontEntries = normalizeFontEntries(entries);
    detectedAt = new Date().toISOString();
    lastError = null;
    return cachedFontEntries;
  } catch (error) {
    if (generation !== fontGeneration) return cachedFontEntries ?? [];
    lastError = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

export async function detectDesktopFonts(options: DetectLocalFontsOptions = {}): Promise<string[]> {
  await detectDesktopFontEntries(options.force);
  await ensureDesktopFontsAvailable();
  return getDesktopFonts(options);
}

export function getDesktopFontRecords(options: GetLocalFontsOptions = {}): LocalFontRecord[] {
  const records = (cachedFontEntries ?? []).map(toLocalFontRecord);
  if (options.includeRegistered) return records;
  return records.filter((record) => isLoadedLocalAuthoringFamily(record.family)
    || !record.aliases.some((name) => REGISTERED_FONTS.has(name)));
}

export function getDesktopFonts(options: GetLocalFontsOptions = {}): string[] {
  return uniqueAuthoringFamilies(getDesktopFontRecords(options).map((record) => record.displayName));
}

export function getDetectedDesktopFonts(): string[] {
  return uniqueFamilies((cachedFontEntries ?? []).map((entry) => entry.family));
}

export function resolveDesktopFont(fontName: string): LocalFontRecord | null {
  const normalized = normalizeFontName(fontName);
  const entries = cachedFontEntries ?? [];
  const postscriptMatch = entries.find((entry) => normalizeFontName(entry.postScriptName) === normalized);
  if (postscriptMatch) return toLocalFontRecord(postscriptMatch);

  const familyMatches = entries.filter((entry) => normalizeFontName(entry.family) === normalized);
  if (familyMatches.length === 1) return toLocalFontRecord(familyMatches[0]);
  const regularMatch = familyMatches.find((entry) => /^(normal|regular|roman|book)$/i.test(entry.style));
  if (regularMatch) return toLocalFontRecord(regularMatch);
  const fullName = familyMatches.length ? undefined : fullNameEntry(entries, fontName);
  return fullName ? toLocalFontRecord(fullName) : null;
}

// Hancom documents often name a face by family + style ("한림고딕체 Regular", "나눔고딕 Bold").
const STYLE_SUFFIXES: ReadonlyArray<readonly [RegExp, number]> = [
  [/\s+(?:regular|book|roman|normal)$/i, 400], [/\s+medium$/i, 500], [/\s+(?:semibold|demibold)$/i, 600],
  [/\s+bold$/i, 700], [/\s+(?:extrabold|ultrabold|heavy)$/i, 800], [/\s+black$/i, 900],
  [/\s+light$/i, 300], [/\s+(?:extralight|ultralight)$/i, 200], [/\s+thin$/i, 100],
];

/** The upright face a "family style" full name refers to, preferring one whose bytes can be read. */
export function fullNameEntry(entries: readonly LocalFontEntry[], fontName: string): LocalFontEntry | undefined {
  const normalized = normalizeFontName(fontName);
  for (const [suffix, weight] of STYLE_SUFFIXES) {
    if (!suffix.test(normalized)) continue;
    const family = normalized.replace(suffix, '');
    const faces = entries.filter((entry) => normalizeFontName(entry.family) === family && !/italic|oblique/i.test(entry.style));
    const exact = faces.filter((entry) => (entry.weight ?? 400) === weight);
    const pool = exact.length ? exact : weight === 400 ? faces.filter((entry) => entry.weight === undefined) : [];
    return pool.find((entry) => entry.sourceKind === 'file-backed' && entry.path) ?? pool.find((entry) => entry.path) ?? pool[0];
  }
  return undefined;
}

export async function loadDesktopFontBytesFor(
  fontNames: readonly string[],
): Promise<Map<string, ArrayBuffer>> {
  const loaded = await Promise.all(fontNames.map(async (fontName) => {
    const record = resolveDesktopFont(fontName);
    if (!record) return null;
    const bytes = await loadDesktopFontBytes(record.postscriptName || record.family);
    return bytes ? ([localFontFaceKey(record), bytes] as const) : null;
  }));
  return new Map(loaded.filter((entry): entry is readonly [string, ArrayBuffer] => entry !== null));
}

export async function loadDesktopFontBytes(fontName: string): Promise<ArrayBuffer | null> {
  const record = resolveDesktopFont(fontName);
  if (!record) return null;
  const entry = (cachedFontEntries ?? []).find(
    (candidate) => normalizeFontName(candidate.postScriptName) === normalizeFontName(record.postscriptName),
  );
  if (!entry?.path) return null;
  return (await readDesktopFontBytes(entry.path)).slice().buffer as ArrayBuffer;
}

export function getDesktopFontState(): LocalFontState {
  return {
    supported: true,
    method: 'local-font-access',
    loaded: cachedFontEntries !== null,
    stored: cachedFontEntries !== null,
    source: cachedFontEntries ? 'local-font-access' : null,
    complete: cachedFontEntries !== null,
    storage: 'none',
    count: cachedFontEntries?.length ?? 0,
    checkedFamilies: [],
    probedFamilies: [],
    unresolvedFamilies: [],
    detectedAt,
    lastError,
  };
}

export function resetDesktopFonts(): void {
  cachedFontEntries = null;
  detectedAt = null;
  lastError = null;
  clearLoadedDesktopFontFaces();
}

function clearLoadedDesktopFontFaces(): void {
  fontGeneration += 1;
  pendingFontEntries = null;
  clearLoadedLocalAuthoringFamilies();
  if (typeof document !== 'undefined' && document.fonts) {
    for (const state of loadedFontFaces.values()) {
      if (state.face) document.fonts.delete?.(state.face);
    }
  }
  loadedFontFaces.clear();
  fontBinaryCache.clear();
}

export async function ensureDesktopFontsAvailable(
  targetFamilies?: Iterable<string>,
): Promise<Set<string>> {
  const entries = await detectDesktopFontEntries();
  const generation = fontGeneration;
  const available = new Set(entries
    .filter((entry) => entry.sourceKind === 'system-installed')
    .filter((entry) => !isAuthoringBlockedFontFamily(entry.family))
    .map((entry) => entry.family));
  if (!supportsBinaryFontLoading()) return available;

  const requested = resolveRequestedFamilies(entries, targetFamilies);
  const groups = groupEntriesByPath(entries.filter((entry) =>
    (entry.sourceKind === 'file-backed' || isAuthoringBlockedFontFamily(entry.family))
      && Boolean(entry.path) && requested.has(entry.family),
  ));
  await Promise.all([...groups].map(async ([path, pathEntries]) => {
    if (pathEntries.every((entry) => loadedFontFaces.get(fontEntryKey(entry))?.face)) {
      for (const entry of pathEntries) available.add(entry.family);
      return;
    }
    let fontBytes: Uint8Array;
    try {
      fontBytes = await readDesktopFontBytes(path);
    } catch {
      return;
    }
    if (generation !== fontGeneration) return;
    for (const entry of pathEntries) {
      try {
        if (!await ensureDesktopFontFace(entry, fontBytes)) continue;
      } catch {
        continue;
      }
      if (generation !== fontGeneration) return;
      if (!isAuthoringBlockedFontFamily(entry.family)) available.add(entry.family);
    }
  }));
  // A full name the catalog has no family for is loaded from its face's file under that exact name,
  // so the editor draws "한림고딕체 Regular" with the installed 한림고딕체 instead of a fallback.
  const fullNames = [...requested]
    .filter((name) => !entries.some((entry) => entry.family === name))
    .map((name) => [name, fullNameEntry(entries, name)] as const)
    .filter((pair): pair is readonly [string, LocalFontEntry] => !!pair[1]);
  await Promise.all(fullNames.map(async ([name, entry]) => {
    try {
      // File-backed faces load from their bytes; a face only installed in Windows is referenced by local().
      const loaded = entry.sourceKind === 'file-backed' && entry.path
        ? await ensureDesktopFontFace({ ...entry, family: name }, await readDesktopFontBytes(entry.path))
        : await ensureDesktopFontFace({ ...entry, family: name }, `local("${entry.postScriptName.replace(/["\\]/g, '')}")`);
      if (generation !== fontGeneration) return;
      if (loaded && !isAuthoringBlockedFontFamily(name)) available.add(name);
    } catch {
      // An unreadable face keeps the CSS fallback, as for any missing font.
    }
  }));
  return generation === fontGeneration ? available : new Set();
}

async function readDesktopFontBytes(path: string): Promise<Uint8Array> {
  let pending = fontBinaryCache.get(path);
  if (!pending) {
    pending = (async () => {
      // The desktop command answers with raw bytes (an ArrayBuffer), not a JSON number array.
      return new Uint8Array(await invoke<ArrayBuffer | number[]>('read_local_font', { path }));
    })();
    fontBinaryCache.set(path, pending);
    void pending.then(
      () => { if (fontBinaryCache.get(path) === pending) fontBinaryCache.delete(path); },
      () => { if (fontBinaryCache.get(path) === pending) fontBinaryCache.delete(path); },
    );
  }
  return pending;
}

async function ensureDesktopFontFace(entry: LocalFontEntry, bytes: Uint8Array | string): Promise<boolean> {
  const key = fontEntryKey(entry);
  let state = loadedFontFaces.get(key);
  if (!state) {
    state = { pending: loadDesktopFontFace(entry, bytes) };
    loadedFontFaces.set(key, state);
  }
  let face: FontFace;
  try {
    face = await state.pending;
  } catch (error) {
    if (loadedFontFaces.get(key) === state) loadedFontFaces.delete(key);
    throw error;
  }
  if (loadedFontFaces.get(key) !== state) return false;
  if (!state.face) {
    document.fonts.add(face);
    state.face = face;
    registerLoadedLocalAuthoringFamily(entry.family);
  }
  return true;
}

async function loadDesktopFontFace(entry: LocalFontEntry, source: Uint8Array | string): Promise<FontFace> {
  const descriptors: FontFaceDescriptors = { style: entry.style || 'normal' };
  if (entry.weight) descriptors.weight = String(entry.weight);
  const face = new FontFace(entry.family, typeof source === 'string' ? source : source.slice(), descriptors);
  return face.load();
}

function normalizeFontEntries(entries: LocalFontEntry[]): LocalFontEntry[] {
  const byKey = new Map<string, LocalFontEntry>();
  for (const entry of entries) {
    const family = entry.family.trim();
    if (!family) continue;
    const normalized: LocalFontEntry = {
      family,
      postScriptName: entry.postScriptName?.trim() || family,
      style: entry.style?.trim() || 'normal',
      weight: entry.weight,
      sourceKind: entry.sourceKind ?? 'system-installed',
      path: entry.path ?? null,
      faceIndex: entry.faceIndex ?? 0,
    };
    byKey.set(fontEntryKey(normalized), normalized);
  }
  return [...byKey.values()].sort((left, right) =>
    left.family.localeCompare(right.family, 'ko')
    || left.style.localeCompare(right.style, 'en')
    || left.postScriptName.localeCompare(right.postScriptName, 'en'),
  );
}

function toLocalFontRecord(entry: LocalFontEntry): LocalFontRecord {
  return {
    family: entry.family,
    fullName: entry.postScriptName || entry.family,
    postscriptName: entry.postScriptName,
    style: entry.style,
    displayName: entry.family,
    aliases: Array.from(new Set([entry.family, entry.postScriptName].filter(Boolean))),
  };
}

function desktopSnapshot(): LocalFontSnapshot {
  return {
    version: 2,
    detectedAt: detectedAt ?? new Date().toISOString(),
    families: getDetectedDesktopFonts(),
    fontRecords: getDesktopFontRecords({ includeRegistered: true }),
    source: 'local-font-access',
  };
}

function resolveRequestedFamilies(entries: LocalFontEntry[], targetFamilies?: Iterable<string>): Set<string> {
  const families = targetFamilies ? Array.from(targetFamilies) : entries.map((entry) => entry.family);
  // Try authorized file-backed bytes before applying the authoring policy.
  return new Set(families.map((family) => family.trim()).filter(Boolean));
}

function groupEntriesByPath(entries: LocalFontEntry[]): Map<string, LocalFontEntry[]> {
  const grouped = new Map<string, LocalFontEntry[]>();
  for (const entry of entries) {
    if (!entry.path) continue;
    grouped.set(entry.path, [...(grouped.get(entry.path) ?? []), entry]);
  }
  return grouped;
}

function fontEntryKey(entry: LocalFontEntry): string {
  return [entry.family, entry.postScriptName, entry.style, entry.weight ?? '', entry.path ?? ''].join('\u0000');
}

function localFontFaceKey(record: Pick<LocalFontRecord, 'family' | 'fullName' | 'postscriptName'>): string {
  return normalizeFontName(record.postscriptName || record.fullName || record.family);
}

function uniqueAuthoringFamilies(families: Iterable<string>): string[] {
  return uniqueFamilies(filterAuthoringFontFamilies(families));
}

function uniqueFamilies(families: Iterable<string>): string[] {
  return Array.from(new Set(families)).sort((left, right) => left.localeCompare(right, 'ko'));
}

function normalizeFontName(value: string): string {
  return value.normalize('NFC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');
}

function supportsBinaryFontLoading(): boolean {
  return typeof document !== 'undefined' && !!document.fonts && typeof FontFace === 'function';
}
