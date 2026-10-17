// Third-party notices for the Achmage HOP installers: every crate linked into the desktop app, the JavaScript
// packages of the editor bundle and the Kordoc engine, Node.js, rhwp, HOP, CMDS and the bundled fonts, with the
// license texts the packages ship (identical texts printed once).
//
//   node scripts/achmage/third-party-notices.mjs [--target <rust target triple>] [--out <file>]
//
// Writes apps/desktop/src-tauri/resources/THIRD_PARTY_NOTICES.md by default; the bundle installs it next to the app
// and the release workflow attaches it to the release. Run after `pnpm install`, the Kordoc engine install and
// scripts/achmage/sync-rhwp-native.py (cargo metadata reads vendor/rhwp-native).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const out = path.resolve(option('--out') ?? path.join(root, 'apps/desktop/src-tauri/resources/THIRD_PARTY_NOTICES.md'));
const LICENSE_FILE = /^(licen[cs]e|copying|notice|copyright|unlicense)([-._].*)?$/i;

const texts = new Map(); // sha256 -> {text, users:Set}
function addText(file, owner) {
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim();
  if (!text) return null;
  const key = crypto.createHash('sha256').update(text).digest('hex');
  if (!texts.has(key)) texts.set(key, {text, users: new Set()});
  texts.get(key).users.add(owner);
  return key;
}
function licenseTexts(dir, owner, nested = []) {
  if (!dir || !fs.existsSync(dir)) return [];
  const keys = fs.readdirSync(dir).sort()
    .filter((name) => LICENSE_FILE.test(name) && fs.statSync(path.join(dir, name)).isFile())
    .map((name) => addText(path.join(dir, name), owner));
  // Some packages carry the licences of code they adapted in a folder of their own (kordoc: THIRD_PARTY/).
  const wanted = new Set(nested.map((n) => n.toLowerCase()));
  for (const sub of fs.readdirSync(dir).filter((n) => wanted.has(n.toLowerCase())).sort()) {
    const folder = path.join(dir, sub);
    if (!fs.statSync(folder).isDirectory()) continue;
    for (const name of fs.readdirSync(folder).sort()) if ((LICENSE_FILE.test(name) || /\.(txt|md|license)$/i.test(name)) && fs.statSync(path.join(folder, name)).isFile()) keys.push(addText(path.join(folder, name), `${owner} (${sub}/${name})`));
  }
  return [...new Set(keys.filter(Boolean))];
}
const refs = (keys) => keys.length ? keys.map((k) => `[${k.slice(0, 8)}](#license-${k.slice(0, 8)})`).join(' ') : '(no license file in the package)';

function rustTarget() {
  const given = option('--target') ?? process.env.HOP_NOTICES_TARGET;
  if (given) return given;
  const rustc = spawnSync('rustc', ['-vV'], {encoding: 'utf8'});
  const host = /host: (\S+)/.exec(rustc.stdout ?? '')?.[1];
  if (!host) throw Error('Cannot determine the Rust target (pass --target).');
  return host;
}

function rustCrates() {
  const manifest = path.join(root, 'apps/desktop/src-tauri/Cargo.toml');
  const meta = spawnSync('cargo', ['metadata', '--format-version', '1', '--locked', '--manifest-path', manifest, '--filter-platform', rustTarget()],
    {encoding: 'utf8', maxBuffer: 256 * 1024 * 1024});
  if (meta.status !== 0) throw Error('cargo metadata failed: ' + meta.stderr);
  const data = JSON.parse(meta.stdout);
  const packages = new Map(data.packages.map((p) => [p.id, p]));
  const nodes = new Map(data.resolve.nodes.map((n) => [n.id, n]));
  // Crates compiled into the shipped binary: the normal (not build or dev) dependency closure of the app.
  const seen = new Set([data.resolve.root]);
  const queue = [data.resolve.root];
  while (queue.length) {
    for (const dep of nodes.get(queue.shift())?.deps ?? []) {
      if (!dep.dep_kinds.some((k) => k.kind === null) || seen.has(dep.pkg)) continue;
      seen.add(dep.pkg); queue.push(dep.pkg);
    }
  }
  // Registry and git crates, plus path crates that come from another project (rhwp's patched svg2pdf); this
  // repository's own crates and rhwp itself (listed separately) are left out.
  const relative = (p) => path.relative(root, path.dirname(p.manifest_path)).split(path.sep).join('/');
  const borrowed = (p) => p.source === null && relative(p).startsWith('third_party/') && !p.name.startsWith('rhwp');
  return [...seen].map((id) => packages.get(id)).filter((p) => p.source !== null || borrowed(p))
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
    .map((p) => ({name: p.name, version: p.version, license: p.license ?? (p.license_file ? 'see file' : 'unknown'),
      source: [p.authors?.join(', '), p.repository, borrowed(p) ? `patched copy in this repository's rhwp submodule (${relative(p)})` : null].filter(Boolean).join(' — ') || p.source,
      keys: licenseTexts(path.dirname(p.manifest_path), `${p.name} ${p.version}`)}));
}

function packageDir(from, name) {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate);
    if (path.dirname(dir) === dir) return null;
  }
}

function npmClosure(base, names) {
  const result = new Map();
  const queue = names.map((name) => [base, name]);
  while (queue.length) {
    const [from, name] = queue.shift();
    const dir = packageDir(from, name);
    if (!dir) continue; // optional or platform-specific packages that are not installed are not shipped
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const key = `${pkg.name}@${pkg.version}`;
    if (result.has(key)) continue;
    const license = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? (pkg.licenses ?? []).map((l) => l.type ?? l).join(' OR ') ?? 'unknown';
    const author = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name;
    result.set(key, {name: pkg.name, version: pkg.version, license: license || 'unknown', source: author ?? '', keys: licenseTexts(dir, key, ['THIRD_PARTY', 'third_party', 'LICENSES', 'licenses'])});
    for (const dep of Object.keys(pkg.dependencies ?? {})) queue.push([dir, dep]);
  }
  return [...result.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const table = (rows) => ['| Package | Version | License | Source / author | License text |', '|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.name} | ${r.version} | ${String(r.license).replace(/\|/g, '/')} | ${String(r.source ?? '').replace(/\|/g, '/')} | ${refs(r.keys)} |`)].join('\n');

const crates = rustCrates();
const studioRoots = [...Object.keys(readJson('apps/studio-host/package.json').dependencies ?? {})];
const rhwpStudio = path.join(root, 'third_party/rhwp/rhwp-studio/package.json');
const studio = npmClosure(path.join(root, 'apps/studio-host'), studioRoots);
const rhwpStudioPackages = fs.existsSync(rhwpStudio)
  ? npmClosure(path.dirname(rhwpStudio), Object.keys(JSON.parse(fs.readFileSync(rhwpStudio, 'utf8')).dependencies ?? {}))
  : [];
const kordoc = npmClosure(path.join(root, 'apps/kordoc-engine'), Object.keys(readJson('apps/kordoc-engine/package.json').dependencies ?? {}));
const own = [
  ['Achmage HOP and HOP', licenseTexts(root, 'Achmage HOP / HOP')],
  ['rhwp (HWP engine, with its own third-party list)', licenseTexts(path.join(root, 'vendor/rhwp-native'), 'rhwp')],
  ['CMDS Achmage (panel styles, research source adapters)', licenseTexts(path.join(root, 'apps/studio-host/src/achmage-ai'), 'CMDS Achmage')],
];
const rhwpThirdParty = path.join(root, 'vendor/rhwp-native/THIRD_PARTY_LICENSES.md');
const node = fs.readFileSync(path.join(root, 'licenses/Node.js-v24.19.0-LICENSE.txt'), 'utf8').replace(/\r\n/g, '\n').trim();
const fonts = fs.readFileSync(path.join(root, 'assets/fonts/FONTS.md'), 'utf8').replace(/\r\n/g, '\n');
const fontKeys = ['OFL-1.1.txt', 'GUST-Font-License.txt'].map((name) => addText(path.join(root, 'licenses', name), 'Bundled fonts (assets/fonts)'));
// webview2-com-sys links Microsoft's WebView2 loader (WebView2LoaderStatic.lib) from the WebView2 SDK, whose
// license the crate does not carry.
for (const row of crates.filter((r) => r.name === 'webview2-com-sys')) {
  row.keys.push(addText(path.join(root, 'licenses', 'Microsoft-WebView2-SDK-LICENSE.txt'), `${row.name} ${row.version} (Microsoft WebView2 loader)`));
}
// pako's zlib port carries the zlib copyright in lib/zlib/README rather than in a license file.
for (const row of [...studio, ...rhwpStudioPackages, ...kordoc].filter((r) => r.name === 'pako')) {
  const readme = path.join(root, 'apps/kordoc-engine/node_modules/pako/lib/zlib/README');
  if (row.version === '1.0.11' && fs.existsSync(readme)) row.keys.push(addText(readme, `${row.name} ${row.version} (zlib port)`));
}
// Packages whose distribution carries no license file: the standard text of their declared license, with the
// authors and repository from their metadata in the tables above.
for (const row of [...crates, ...studio, ...rhwpStudioPackages, ...kordoc].filter((r) => !r.keys.length)) {
  const ids = String(row.license).split(/\s+(?:OR|AND|WITH)\s+|[()/]/).map((s) => s.trim()).filter(Boolean);
  row.keys = ids.filter((id) => ['MIT', 'Apache-2.0', 'BSD-3-Clause', 'MPL-2.0'].includes(id))
    .map((id) => addText(path.join(root, 'licenses', `${id}.txt`), `${row.name} ${row.version} (standard text)`));
}

const body = [
  '# Achmage HOP — third-party notices',
  '',
  `Generated by \`scripts/achmage/third-party-notices.mjs\` for \`${rustTarget()}\`. Achmage HOP is licensed under the MIT License (its \`LICENSE\` file, also reproduced below). It includes the software listed here; each keeps its own license.`,
  '',
  '## Achmage HOP, HOP, rhwp, CMDS',
  '',
  ...own.map(([name, keys]) => `- ${name}: ${refs(keys)}`),
  fs.existsSync(rhwpThirdParty) ? '- rhwp\'s own third-party list follows the license texts at the end of this file.' : '',
  '',
  '## Node.js (fallback runtime of the Kordoc document engine)',
  '',
  'Node.js v24 is installed with the app as `runtime/node`; its license (below, at the end) also covers the components Node.js bundles. The Kordoc WebView worker also contains an EventEmitter adapted from Node.js `lib/events.js` under this license.',
  '',
  'Source code of the MPL-2.0 packages listed below is available from their registries under the same name and version; a patched copy marked as such is in the rhwp repository at the path given.',
  '',
  `## Rust crates linked into the app (${crates.length})`,
  '',
  table(crates),
  '',
  `## JavaScript packages in the editor (${studio.length + rhwpStudioPackages.length})`,
  '',
  table([...studio, ...rhwpStudioPackages]),
  '',
  `## Kordoc document engine packages (${kordoc.length})`,
  '',
  table(kordoc),
  '',
  '## Bundled fonts',
  '',
  fonts.replace(/^# .*\n/, '').replace(/^#+ /gm, '#### ').replace(/\[([^\]]*)\]\(\.\.\/\.\.\/licenses\/[^)]*\)/g, '$1').trim(),
  '',
  `Font license texts: ${refs(fontKeys)}`,
  '',
  '## License texts',
  '',
  ...[...texts.entries()].flatMap(([key, {text, users}]) => [
    `### <a id="license-${key.slice(0, 8)}"></a>License text ${key.slice(0, 8)}`,
    '',
    `Used by: ${[...users].sort().join(', ')}`,
    '',
    '```text', text.replace(/```/g, "'''"), '```', '']),
  '### Node.js',
  '',
  '```text', node.replace(/```/g, "'''"), '```',
  '',
  ...(fs.existsSync(rhwpThirdParty) ? ['### rhwp third-party licenses', '', fs.readFileSync(rhwpThirdParty, 'utf8').replace(/\r\n/g, '\n').replace(/^(#+) /gm, '###$1 ').trim(), ''] : []),
].join('\n');

fs.mkdirSync(path.dirname(out), {recursive: true});
fs.writeFileSync(out, body + '\n');
console.log(JSON.stringify({out: path.relative(root, out), crates: crates.length, studio: studio.length + rhwpStudioPackages.length, kordoc: kordoc.length,
  licenseTexts: texts.size, withoutLicenseFile: [...crates, ...studio, ...rhwpStudioPackages, ...kordoc].filter((r) => !r.keys.length).map((r) => `${r.name}@${r.version}`)}));
