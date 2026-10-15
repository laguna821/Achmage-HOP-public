"""A git workbench for editing HOP's rhwp patch queue (docs/rhwp-patch-queue.md).

  init   --dir D   export the pinned commit (with samples/, for rhwp's own tests), commit it as the base, then
                   apply each patches/rhwp/*.patch as its own commit. Patches stack: edit them here, not by hand.
  export --dir D   write the commits after the base back to patches/rhwp (git format-patch), replacing the queue.

Commit subjects become patch names: subject `hop-auto-tab-left` -> `0002-hop-auto-tab-left.patch`.
The workbench lives outside the repository and any synced folder (default %LOCALAPPDATA%/hop-rhwp/workbench) and never touches the submodule.
"""
import argparse
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile

HOP = Path(__file__).resolve().parents[2]
SUBMODULE = HOP / 'third_party' / 'rhwp'
PROVENANCE = HOP / 'apps' / 'studio-host' / 'vendor' / 'rhwp-core' / 'PROVENANCE.json'
PATCHES = HOP / 'patches' / 'rhwp'
GIT = ['git', '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-c', 'user.name=hop-workbench', '-c', 'user.email=hop@localhost']


def git(cwd, *args, capture=False):
    result = subprocess.run([*GIT, *args], cwd=cwd, check=True, capture_output=capture)
    return result.stdout.decode('utf-8') if capture else None


def init(directory, commit):
    if directory.exists() and any(directory.iterdir()):
        raise SystemExit(f'workbench is not empty: {directory}')
    archive = subprocess.run([*GIT, '-C', str(SUBMODULE), 'archive', '--format=tar', commit, '--', '.', ':(exclude)mydocs', ':(exclude)pdf'],
                             check=True, capture_output=True).stdout
    directory.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        tar.extractall(directory, filter='data')
    git(directory, 'init', '-q')
    git(directory, 'config', 'core.autocrlf', 'false')
    git(directory, 'add', '-A')
    git(directory, 'commit', '-q', '-m', f'rhwp {commit}')
    git(directory, 'tag', 'hop-base')
    for patch in sorted(PATCHES.glob('*.patch')):
        git(directory, 'apply', '--whitespace=nowarn', str(patch))
        git(directory, 'add', '-A')
        subject = patch.stem.split('-', 1)[1]
        git(directory, 'commit', '-q', '-m', subject)
    print(json.dumps({'workbench': str(directory), 'base': commit, 'patches': [p.name for p in sorted(PATCHES.glob('*.patch'))]}, ensure_ascii=False))


def export(directory):
    staged = PATCHES.with_name('rhwp.new')
    if staged.exists():
        shutil.rmtree(staged)
    staged.mkdir()
    git(directory, 'format-patch', '-q', '--no-stat', '--no-signature', '--zero-commit', '--full-index', '-o', str(staged), 'hop-base..HEAD')
    for old in PATCHES.glob('*.patch'):
        old.unlink()
    for new in sorted(staged.glob('*.patch')):
        new.replace(PATCHES / new.name)
    staged.rmdir()
    print(json.dumps({'patches': sorted(p.name for p in PATCHES.glob('*.patch'))}, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['init', 'export'])
    parser.add_argument('--dir', type=Path, default=Path(os.environ.get('LOCALAPPDATA', '.')) / 'hop-rhwp' / 'workbench')
    parser.add_argument('--commit', help='base commit (default: PROVENANCE.json)')
    args = parser.parse_args()
    if args.action == 'init':
        init(args.dir.resolve(), args.commit or json.loads(PROVENANCE.read_text(encoding='utf-8'))['commit'])
    else:
        export(args.dir.resolve())


if __name__ == '__main__':
    main()
