import { describe, expect, it, vi } from 'vitest';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
import { buildDesktopHostFontCatalog, createDesktopHostFontProvider } from './desktop-host-font-provider';
import type { LocalFontEntry } from './desktop-local-fonts';

const entry = (family: string, postScriptName: string, weight: number, sourceKind: LocalFontEntry['sourceKind'], path: string, extra: Partial<LocalFontEntry> = {}): LocalFontEntry =>
  ({ family, postScriptName, style: 'normal', weight, sourceKind, path, ...extra });
const ENTRIES = [
  entry('Hallym Gothic', 'Hallym-Regular', 400, 'system-installed', 'C:/Windows/Fonts/HallymGothic-Regular.ttf'),
  entry('한림고딕체', 'Hallym-Regular', 400, 'system-installed', 'C:/Windows/Fonts/HallymGothic-Regular.ttf'),
  entry('한림고딕체', 'Hallym-Regular', 400, 'file-backed', 'D:/assets/HallymGothic-Regular.ttf'),
  entry('Hallym Gothic', 'Hallym-Regular', 400, 'file-backed', 'D:/assets/HallymGothic-Regular.ttf'),
  entry('한림고딕체', 'Hallym-Bold', 700, 'system-installed', 'C:/Windows/Fonts/HallymGothic-Bold.ttf'),
  entry('휴먼엑스포', 'ExpoM-HM', 400, 'system-installed', 'C:/Windows/Fonts/HMFMMUEX.TTC', { faceIndex: 1 }),
  entry('Web Only', 'WebOnly', 400, 'system-installed', 'C:/Windows/Fonts/x.woff2'),
];

describe('desktop host font catalog', () => {
  it('merges localized families and duplicate copies into one face per PostScript name and style', () => {
    const { snapshot, sources } = buildDesktopHostFontCatalog(ENTRIES);
    const regular = snapshot.faces.find(face => face.postscriptName === 'Hallym-Regular')!;
    expect(snapshot.faces.filter(face => face.postscriptName === 'Hallym-Regular')).toHaveLength(1);
    expect(regular.family).toBe('한림고딕체');
    expect(regular.fullName).toBe('한림고딕체 Regular');
    expect(regular.aliases).toEqual(expect.arrayContaining(['한림고딕체', '한림고딕체 Regular', 'Hallym Gothic', 'Hallym Gothic Regular']));
    expect(sources.get(regular.id)?.path).toBe('D:/assets/HallymGothic-Regular.ttf');
    const bold = snapshot.faces.find(face => face.postscriptName === 'Hallym-Bold')!;
    expect(bold).toMatchObject({ style: 'Bold', weight: 700, fullName: '한림고딕체 Bold' });
    expect(sources.get(snapshot.faces.find(face => face.family === '휴먼엑스포')!.id)?.faceIndex).toBe(1);
    expect(snapshot.faces.some(face => face.family === 'Web Only')).toBe(false);
    expect(JSON.stringify(snapshot)).not.toMatch(/Windows|assets/);
  });

  it('reads bytes only for the current catalog revision and keeps the collection index', async () => {
    const read = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const provider = createDesktopHostFontProvider(async () => ENTRIES, read);
    const snapshot = await provider.getSnapshot(new AbortController().signal);
    const expo = snapshot.faces.find(face => face.family === '휴먼엑스포')!;
    const data = await provider.readFace(expo.id, snapshot.revision, new AbortController().signal);
    expect(read).toHaveBeenCalledWith('C:/Windows/Fonts/HMFMMUEX.TTC');
    expect(data.faceIndex).toBe(1);
    expect([...new Uint8Array(data.bytes)]).toEqual([1, 2, 3]);
    await expect(provider.readFace(expo.id, 'stale', new AbortController().signal)).rejects.toThrow();
    const changed = vi.fn();provider.subscribe(changed);provider.refresh();expect(changed).toHaveBeenCalledTimes(1);
  });
});
