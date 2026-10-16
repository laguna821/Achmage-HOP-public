import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
const entry = { family: 'HY헤드라인M', postScriptName: 'HYHeadLineM',
  style: 'normal', sourceKind: 'file-backed', path: 'C:/fixtures/fonts/restricted-face.ttf' };

function environment(fail: 'read' | 'load' | 'add' | null = null) {
  const add = vi.fn(() => { if (fail === 'add') throw new Error('registration failed'); });
  const remove = vi.fn();
  Object.assign(globalThis, { window: { __TAURI_INTERNALS__: {} }, document: { fonts: { add, delete: remove } },
    FontFace: class {
      constructor(readonly family: string) {}
      async load() { if (fail === 'load') throw new Error('invalid font'); return this; }
    } });
  invoke.mockImplementation(async (name: string) => {
    if (name === 'list_local_fonts') return [entry];
    if (fail === 'read') throw new Error('read failed');
    return [0, 1, 2, 3];
  });
  return { add, remove };
}

describe('authorized local font lifecycle', () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });

  it('does not grant authoring permission from catalog discovery alone', async () => {
    environment();
    const fonts = await import('./desktop-local-fonts');
    const policy = await import('./font-authoring-policy');
    await fonts.detectDesktopFontEntries();
    expect(policy.isAuthoringBlockedFontFamily(entry.family)).toBe(true);
    expect(fonts.getDesktopFonts()).not.toContain(entry.family);
  });

  it('makes a user-installed, license-restricted family usable only after loading it from that installation', async () => {
    const {add}=environment();const system={...entry,family:'HY신명조',sourceKind:'system-installed',path:'/fixtures/fonts/restricted-face-2.ttf'};
    invoke.mockImplementation(async(name:string)=>name==='list_local_fonts'?[system]:[0,1,2,3]);
    const fonts=await import('./desktop-local-fonts');const policy=await import('./font-authoring-policy');
    await fonts.detectDesktopFontEntries();expect(policy.isAuthoringBlockedFontFamily(system.family)).toBe(true);
    expect(await fonts.ensureDesktopFontsAvailable([system.family])).toContain(system.family);expect(add).toHaveBeenCalledTimes(1);expect(policy.isAuthoringBlockedFontFamily(system.family)).toBe(false);
  });

  it('allows only the successfully registered family and revokes it on reset', async () => {
    const { add, remove } = environment();
    const fonts = await import('./desktop-local-fonts');
    const policy = await import('./font-authoring-policy');
    expect(await fonts.detectDesktopFonts()).toContain(entry.family);
    expect(add).toHaveBeenCalledTimes(1);
    expect(policy.sanitizeAuthoringFontFamily(entry.family)).toBe(entry.family);
    expect(policy.isAuthoringBlockedFontFamily('휴먼명조')).toBe(true);
    fonts.resetDesktopFonts();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(policy.isAuthoringBlockedFontFamily(entry.family)).toBe(true);
  });

  it.each(['read', 'load', 'add'] as const)('does not authorize after %s failure', async (failure) => {
    environment(failure);
    const fonts = await import('./desktop-local-fonts');
    const policy = await import('./font-authoring-policy');
    expect(await fonts.ensureDesktopFontsAvailable([entry.family])).not.toContain(entry.family);
    expect(policy.isAuthoringBlockedFontFamily(entry.family)).toBe(true);
  });

  it('revokes a removed font on refresh before returning the new list', async () => {
    environment();
    const fonts = await import('./desktop-local-fonts');
    const policy = await import('./font-authoring-policy');
    await fonts.detectDesktopFonts();
    invoke.mockResolvedValue([]);
    expect(await fonts.detectDesktopFonts({ force: true })).not.toContain(entry.family);
    expect(policy.isAuthoringBlockedFontFamily(entry.family)).toBe(true);
  });

  it('also revokes permission when the forced refresh fails', async () => {
    environment();
    const fonts = await import('./desktop-local-fonts');
    const policy = await import('./font-authoring-policy');
    await fonts.detectDesktopFonts();
    invoke.mockRejectedValue(new Error('catalog failed'));
    await expect(fonts.detectDesktopFonts({ force: true })).rejects.toThrow('catalog failed');
    expect(policy.isAuthoringBlockedFontFamily(entry.family)).toBe(true);
  });

  it('does not reauthorize a font whose pending read completes after reset', async () => {
    const { add } = environment();
    const fonts = await import('./desktop-local-fonts');
    const policy = await import('./font-authoring-policy');
    await fonts.detectDesktopFontEntries();
    let finish!: (bytes: number[]) => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    invoke.mockImplementation(() => new Promise<number[]>((resolve) => { finish = resolve; started(); }));
    const pending = fonts.ensureDesktopFontsAvailable([entry.family]);
    await began;
    fonts.resetDesktopFonts();
    finish([0, 1, 2, 3]);
    expect(await pending).not.toContain(entry.family);
    expect(add).not.toHaveBeenCalled();
    expect(policy.isAuthoringBlockedFontFamily(entry.family)).toBe(true);
  });

  it('does not repopulate a reset catalog with an old pending discovery', async () => {
    environment();
    const fonts = await import('./desktop-local-fonts');
    let finish!: (entries: typeof entry[]) => void;
    invoke.mockImplementation(() => new Promise<typeof entry[]>((resolve) => { finish = resolve; }));
    const pending = fonts.detectDesktopFontEntries();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    fonts.resetDesktopFonts();
    finish([entry]);
    expect(await pending).toEqual([]);
    expect(fonts.getDetectedDesktopFonts()).toEqual([]);
  });

  it('does not register an old FontFace load completion after reset', async () => {
    const { add } = environment();
    let finish!: () => void;
    Object.assign(globalThis, { FontFace: class {
      constructor(readonly family: string) {}
      load() { return new Promise((resolve) => { finish = () => resolve(this); }); }
    } });
    const fonts = await import('./desktop-local-fonts');
    const policy = await import('./font-authoring-policy');
    const pending = fonts.ensureDesktopFontsAvailable([entry.family]);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    fonts.resetDesktopFonts();
    finish();
    expect(await pending).not.toContain(entry.family);
    expect(add).not.toHaveBeenCalled();
    expect(policy.isAuthoringBlockedFontFamily(entry.family)).toBe(true);
  });
});
