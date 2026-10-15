"""Export the pinned rhwp commit into a build directory, optionally applying HOP's rhwp patch queue (B8).

The submodule itself is never modified: the pinned commit is read with `git archive`, extracted into a fresh
directory and the patches in hop/patches/rhwp/*.patch are applied there in file-name order. The export records
what it contains in HOP-EXPORT.json (commit, patches and their sha256) so a WASM built from it can be traced.

Excluded from the export: documentation, sample documents and PDFs (~4.6 GB, some paths longer than Windows
allows). A library build never reads them; test-only include_bytes! paths are not evaluated. Workspace members
(tools/, bindings/) and declared test targets stay, because cargo resolves them when it loads the manifest.

--lib-subset exports only what a path dependency needs to build the library (LIB_SUBSET): cargo ignores a
dependency's [workspace], [patch] and declared test/example targets, so the manifest stays byte-identical.
--commit overrides the commit pinned in PROVENANCE.json (used while moving to a new upstream version).
Usage: python scripts/achmage/export-rhwp-source.py --out DIR [--patches] [--lib-subset] [--commit SHA]
"""
import argparse
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile

HOP = Path(__file__).resolve().parents[2]  # repository root (scripts/achmage/..)
SUBMODULE = HOP / 'third_party' / 'rhwp'
PROVENANCE = HOP / 'apps' / 'studio-host' / 'vendor' / 'rhwp-core' / 'PROVENANCE.json'
PATCHES = HOP / 'patches' / 'rhwp'
EXCLUDED = ('mydocs', 'pdf', 'samples')
# The library and its build inputs: the manifest, build.rs (probes src/render_backend), src, the path-dependency
# crates, the one non-test file src includes from outside src, and the licences.
LIB_SUBSET = ('Cargo.toml', 'build.rs', 'src', 'crates', 'saved/blank2010.hwp', 'LICENSE', 'THIRD_PARTY_LICENSES.md')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def pinned_commit():
    return json.loads(PROVENANCE.read_text(encoding='utf-8'))['commit']


def export(out, commit, patches, lib_subset):
    """Writes the export into the empty directory `out` and returns its HOP-EXPORT.json record."""
    if out.exists() and any(out.iterdir()):
        raise SystemExit(f'output directory is not empty: {out}')
    if lib_subset:
        pathspecs = list(LIB_SUBSET)
    else:
        pathspecs = ['.', *(f':(exclude){name}' for name in EXCLUDED)]
    # Blobs exactly as stored (LF): a machine's core.autocrlf must not change the sources or the WASM built from them.
    archive = subprocess.run(['git', '-C', str(SUBMODULE), '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'archive', '--format=tar', commit, '--', *pathspecs],
                             check=True, capture_output=True).stdout
    out.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        tar.extractall(out, filter='data')
    applied = []
    if patches:
        for patch in sorted(PATCHES.glob('*.patch')):
            # git apply works outside a repository like patch(1); --check first so a failure leaves no half-applied file.
            for check in (True, False):
                subprocess.run(['git', '-c', 'core.autocrlf=false', 'apply', *(['--check'] if check else []), '--whitespace=nowarn', str(patch)],
                               cwd=out, check=True)
            applied.append({'file': patch.name, 'sha256': sha(patch.read_bytes())})
    record = {'source': 'https://github.com/edwardkim/rhwp', 'commit': commit}
    if lib_subset:
        record['subset'] = list(LIB_SUBSET)
    else:
        record['excluded'] = list(EXCLUDED)
    record['hopPatches'] = applied
    # newline='\n': the record is part of vendor/rhwp-native, compared byte for byte on every OS.
    (out / 'HOP-EXPORT.json').write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding='utf-8', newline='\n')
    return record


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--patches', action='store_true', help='apply hop/patches/rhwp/*.patch')
    parser.add_argument('--lib-subset', action='store_true', help='export only what a path dependency needs')
    parser.add_argument('--commit', help='rhwp commit to export (default: the one pinned in PROVENANCE.json)')
    args = parser.parse_args()
    out = args.out.resolve()
    record = export(out, args.commit or pinned_commit(), args.patches, args.lib_subset)
    print(json.dumps({'out': str(out), 'commit': record['commit'], 'hopPatches': [p['file'] for p in record['hopPatches']]}, ensure_ascii=False))


if __name__ == '__main__':
    main()
