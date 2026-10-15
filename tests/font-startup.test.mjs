import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import vm from 'node:vm';

const core = resolve(dirname(fileURLToPath(import.meta.url)), '../apps/studio-host/src/core');

// Execute the production TS modules. Only the OS/browser boundaries are replaced;
// this suite needs no upstream checkout, proprietary fonts or new dependencies.
async function moduleUnderTest(name, { invoke, localFonts, globals = {} } = {}) {
  const context = vm.createContext({ console, Date, Uint8Array, ArrayBuffer, ...globals });
  const modules = new Map();
  const mocks = new Map([
    ['@tauri-apps/api/core', { invoke }],
    [resolve(core, 'local-fonts.ts'), localFonts],
  ]);
  async function get(id) {
    if (modules.has(id)) return modules.get(id);
    const pending = (async () => {
      if (mocks.get(id)) {
        const exports = mocks.get(id);
        return new vm.SyntheticModule(Object.keys(exports), function () {
          for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
        }, { context, identifier: id });
      }
      const source = stripTypeScriptTypes(await readFile(id, 'utf8'), { mode: 'transform' });
      return new vm.SourceTextModule(source, { context, identifier: id });
    })();
    modules.set(id, pending);
    return pending;
  }
  const root = await get(resolve(core, name + '.ts'));
  await root.link((specifier, parent) => get(specifier.startsWith('.')
    ? resolve(dirname(parent.identifier), specifier + '.ts') : specifier));
  await root.evaluate();
  return root.namespace;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const entry = (family, path = '/fonts/' + family + '.ttf') => ({
  family, postScriptName: family + '-Regular', path,
  style: 'normal', weight: 400, sourceKind: 'file-backed', faceIndex: 0,
});
function browser() {
  const styles = [], faces = [];
  return {
    styles, faces,
    globals: {
      window: { __TAURI_INTERNALS__: {} },
      document: {
        fonts: { add() {}, delete() {}, check: () => false },
        head: { appendChild(node) { styles.push(node); } },
        createElement: () => ({ textContent: '' }),
      },
      FontFace: class {
        constructor(family) { this.family = family; faces.push(family); }
        async load() { return this; }
      },
    },
  };
}

test('home CSS registration is idempotent and does not start catalog or byte hydration', async () => {
  const env = browser();
  let calls = 0;
  const forbidden = () => { calls++; throw new Error('native startup work'); };
  const fonts = await moduleUnderTest('font-loader', {
    globals: env.globals,
    localFonts: { detectLocalFontEntries: forbidden, ensureLocalFontsAvailable: forbidden },
  });
  fonts.prepareFontStyles();
  fonts.prepareFontStyles();
  assert.equal(calls, 0);
  assert.equal(env.faces.length, 0);
  assert.equal(env.styles.length, 1);
  assert.match(env.styles[0].textContent, /@font-face/);
});

test('opening an empty document still waits for default native font preparation', async () => {
  const env = browser(), loading = deferred(), started = deferred();
  let requested, done = false;
  const fonts = await moduleUnderTest('font-loader', {
    globals: env.globals,
    localFonts: {
      detectLocalFontEntries: async () => [],
      ensureLocalFontsAvailable: families => {
        requested = [...families]; started.resolve(); return loading.promise;
      },
    },
  });
  fonts.prepareFontStyles();
  const pending = fonts.loadWebFonts([]).then(() => { done = true; });
  await started.promise;
  assert.equal(done, false);
  assert.deepEqual(requested.sort(), ['함초롬돋움', '함초롬바탕']);
  loading.resolve(new Set(requested));
  await pending;
  assert.equal(done, true);
  assert.equal(env.faces.length, 0, 'loaded native faces must not get substitute FontFaces');
});

test('unavailable native fonts still load bundled document fallbacks', async () => {
  const env = browser();
  const fonts = await moduleUnderTest('font-loader', {
    globals: env.globals,
    localFonts: {
      detectLocalFontEntries: async () => { throw new Error('catalog unavailable'); },
      ensureLocalFontsAvailable: async () => new Set(),
    },
  });
  fonts.prepareFontStyles();
  await fonts.loadWebFonts([]);
  assert.ok(env.faces.includes('함초롬바탕'));
  assert.ok(env.faces.includes('함초롬돋움'));
});

test('concurrent catalog consumers share one scan and read no font bytes', async () => {
  const scan = deferred(), calls = [];
  const fonts = await moduleUnderTest('desktop-local-fonts', {
    invoke: command => { calls.push(command); return scan.promise; },
  });
  const first = fonts.detectDesktopFontEntries(), second = fonts.detectDesktopFontEntries();
  assert.deepEqual(calls, ['list_local_fonts']);
  scan.resolve([entry('함초롬바탕')]);
  assert.equal((await first)[0].family, '함초롬바탕');
  assert.equal((await second)[0].family, '함초롬바탕');
  await fonts.detectDesktopFontEntries();
  assert.equal(calls.length, 1);
});

test('reset invalidates a pending scan without clearing the newer in-flight scan', async () => {
  const scans = [deferred(), deferred()];
  let calls = 0;
  const fonts = await moduleUnderTest('desktop-local-fonts', {
    invoke: () => scans[calls++].promise,
  });
  const old = fonts.detectDesktopFontEntries();
  fonts.resetDesktopFonts();
  const fresh = fonts.detectDesktopFontEntries();
  scans[0].resolve([entry('Old')]);
  assert.equal((await old).length, 0);
  const joined = fonts.detectDesktopFontEntries();
  assert.equal(calls, 2);
  scans[1].resolve([entry('Fresh')]);
  assert.equal((await fresh)[0].family, 'Fresh');
  assert.equal((await joined)[0].family, 'Fresh');
});

test('forced refresh cannot be overwritten by an older success or rejection', async () => {
  for (const failOld of [false, true]) {
    const scans = [deferred(), deferred()];
    let calls = 0;
    const fonts = await moduleUnderTest('desktop-local-fonts', {
      invoke: () => scans[calls++].promise,
    });
    const old = fonts.detectDesktopFontEntries();
    const fresh = fonts.detectDesktopFontEntries(true);
    scans[1].resolve([entry('Fresh')]);
    await fresh;
    if (failOld) scans[0].reject(new Error('obsolete scan'));
    else scans[0].resolve([entry('Old')]);
    assert.equal((await old)[0].family, 'Fresh');
    assert.equal(fonts.getDetectedDesktopFonts()[0], 'Fresh');
    assert.equal(fonts.getDesktopFontState().lastError, null);
  }
});

test('failed shared scan remains retryable instead of caching the rejected promise', async () => {
  let calls = 0;
  const scan = deferred();
  const fonts = await moduleUnderTest('desktop-local-fonts', {
    invoke: () => ++calls === 1 ? scan.promise : Promise.resolve([entry('Recovered')]),
  });
  const first = fonts.detectDesktopFontEntries(), second = fonts.detectDesktopFontEntries();
  const settled = Promise.allSettled([first, second]);
  scan.reject(new Error('scan failed'));
  assert.ok((await settled).every(result => result.status === 'rejected'));
  assert.equal(calls, 1);
  assert.equal((await fonts.detectDesktopFontEntries())[0].family, 'Recovered');
  assert.equal(calls, 2);
});

for (const binaryResponse of [false, true]) {
test(`document hydration reads requested files only (binary IPC: ${binaryResponse})`, async () => {
  const env = browser(), reads = [];
  const rows = [entry('함초롬바탕'), ...Array.from({ length: 154 }, (_, i) => entry('Extra-' + i))];
  const fonts = await moduleUnderTest('desktop-local-fonts', {
    globals: env.globals,
    invoke: async (command, args) => {
      if (command === 'list_local_fonts') return rows;
      reads.push(args.path);
      return binaryResponse ? new Uint8Array([0, 1, 2, 3]).buffer : [0, 1, 2, 3];
    },
  });
  const available = await fonts.ensureDesktopFontsAvailable(['함초롬바탕']);
  assert.ok(available.has('함초롬바탕'));
  assert.deepEqual(reads, ['/fonts/함초롬바탕.ttf']);
  assert.deepEqual(env.faces, ['함초롬바탕']);
});
}
