"""Keep vendor/rhwp-native equal to the pinned rhwp library with HOP's patch queue applied.

The desktop app and Quick Look build rhwp natively (PDF export, previews) through apps/desktop/rhwp-adapter,
which depends on vendor/rhwp-native. That tree is the --lib-subset export of the commit pinned in PROVENANCE.json
with hop/patches/rhwp/*.patch applied, so native output uses the same layout code as the vendored WASM.

  python scripts/achmage/sync-rhwp-native.py          rewrite vendor/rhwp-native (after changing patches)
  python scripts/achmage/sync-rhwp-native.py --check  exit 1 if the committed tree differs from a fresh export

Files are copied with fresh modification times, so cargo never keeps a stale build of a reverted patch.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import sys
import tempfile

HERE = Path(__file__).resolve().parent
HOP = HERE.parents[1]
TARGET = HOP / 'vendor' / 'rhwp-native'

spec = importlib.util.spec_from_file_location('export_rhwp_source', HERE / 'export-rhwp-source.py')
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)


def tree(root):
    """Relative path → sha256 of every file under root."""
    return {p.relative_to(root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(root.rglob('*')) if p.is_file()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true', help='compare only; do not write')
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='hop-rhwp-native-') as temp:
        fresh = Path(temp) / 'export'
        record = exporter.export(fresh, exporter.pinned_commit(), patches=True, lib_subset=True)
        expected = tree(fresh)
        if args.check:
            actual = tree(TARGET) if TARGET.is_dir() else {}
            missing = sorted(set(expected) - set(actual))
            extra = sorted(set(actual) - set(expected))
            changed = sorted(p for p in set(expected) & set(actual) if expected[p] != actual[p])
            if missing or extra or changed:
                print(json.dumps({'ok': False, 'missing': missing[:20], 'extra': extra[:20], 'changed': changed[:20],
                                  'hint': 'run python scripts/achmage/sync-rhwp-native.py and commit vendor/rhwp-native'},
                                 ensure_ascii=False, indent=2))
                sys.exit(1)
            print(json.dumps({'ok': True, 'files': len(expected), 'commit': record['commit'],
                              'hopPatches': [p['file'] for p in record['hopPatches']]}, ensure_ascii=False))
            return
        staged = TARGET.with_name(TARGET.name + '.new')
        retired = TARGET.with_name(TARGET.name + '.old')
        for leftover in (staged, retired):
            if leftover.exists():
                shutil.rmtree(leftover)
        # copyfile, not copy2: fresh mtimes so cargo rebuilds whatever changed.
        shutil.copytree(fresh, staged, copy_function=shutil.copyfile)
        if TARGET.exists():
            TARGET.rename(retired)
        staged.rename(TARGET)
        if retired.exists():
            shutil.rmtree(retired)
        print(json.dumps({'ok': True, 'written': str(TARGET), 'files': len(expected), 'commit': record['commit'],
                          'hopPatches': [p['file'] for p in record['hopPatches']]}, ensure_ascii=False))


if __name__ == '__main__':
    main()
