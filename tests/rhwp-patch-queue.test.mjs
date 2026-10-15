import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// HOP's rhwp patch queue reaches users through two builds: the vendored WASM (screen) and vendor/rhwp-native
// (desktop PDF export and Quick Look). Both must carry exactly the patches in patches/rhwp, or the PDF stops
// matching the screen. A full regeneration check runs in CI: scripts/achmage/sync-rhwp-native.py --check.
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFile(join(repoRoot, path));
const json = async (path) => JSON.parse(await readFile(join(repoRoot, path), 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function queue() {
  const names = (await readdir(join(repoRoot, 'patches/rhwp'))).filter((name) => name.endsWith('.patch')).sort();
  return Promise.all(names.map(async (file) => ({ file, sha256: sha256(await read(`patches/rhwp/${file}`)) })));
}

test('the WASM and the native library carry exactly the patch queue, on the pinned commit', async () => {
  const patches = await queue();
  const provenance = await json('apps/studio-host/vendor/rhwp-core/PROVENANCE.json');
  const native = await json('vendor/rhwp-native/HOP-EXPORT.json');
  assert.deepEqual(provenance.hopPatches, patches, 'rebuild the WASM (scripts/achmage/build-rhwp-wasm.ps1) and update PROVENANCE.json');
  assert.deepEqual(native.hopPatches, patches, 'run python scripts/achmage/sync-rhwp-native.py and commit vendor/rhwp-native');
  assert.equal(native.commit, provenance.commit);
});

function lockVersions(text) {
  const versions = new Map();
  for (const block of text.split('[[package]]').slice(1)) {
    const name = /^name = "([^"]+)"/m.exec(block)?.[1];
    const version = /^version = "([^"]+)"/m.exec(block)?.[1];
    if (!name || !version) continue;
    versions.set(name, [...(versions.get(name) ?? []), version]);
  }
  return versions;
}

// rhwp's direct dependencies that decide line breaks, widths and shaping. The WASM is built against rhwp's own
// Cargo.lock; the desktop and Quick Look resolve their own locks. Different versions could break lines differently.
const LAYOUT_CRATES = ['unicode-segmentation', 'unicode-properties', 'unicode-width', 'ttf-parser', 'rustybuzz'];

test('layout crates resolve to the same versions for the WASM and the native builds', async () => {
  const wasm = lockVersions(await readFile(join(repoRoot, 'third_party/rhwp/Cargo.lock'), 'utf8'));
  for (const lock of ['apps/desktop/src-tauri/Cargo.lock', 'apps/desktop/quicklook/rust/Cargo.lock']) {
    const native = lockVersions(await readFile(join(repoRoot, lock), 'utf8'));
    for (const name of LAYOUT_CRATES) {
      for (const version of native.get(name) ?? []) {
        assert.ok(wasm.get(name)?.includes(version), `${lock}: ${name} ${version} is not the WASM's ${wasm.get(name)}; run cargo update -p ${name} --precise`);
      }
    }
  }
});
