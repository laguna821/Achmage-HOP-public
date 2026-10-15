# rhwp patch queue

Achmage HOP never edits `third_party/rhwp`. Its engine changes are a numbered queue of patches in `patches/rhwp/`, applied to exported copies of the pinned commit. Two builds use them:

- **Vendored WASM** (`apps/studio-host/vendor/rhwp-core/rhwp_bg.wasm`): the editor and the screen.
- **Native library** (`vendor/rhwp-native/`): PDF export and Quick Look, used by `apps/desktop/rhwp-adapter`. `python3 scripts/achmage/sync-rhwp-native.py` writes it from the rhwp submodule and the queue; a checkout that does not track it runs that before building.

Both must carry exactly the same patches, or the PDF and the screen break lines differently. `tests/rhwp-patch-queue.test.mjs` checks three things:

- the patch hashes against `PROVENANCE.json` `hopPatches`;
- the patch hashes against `vendor/rhwp-native/HOP-EXPORT.json`;
- the versions of the crates that affect layout, across `third_party/rhwp/Cargo.lock` and both desktop locks.

Where the native tree is tracked, CI regenerates it and compares (`python3 scripts/achmage/sync-rhwp-native.py --check`); elsewhere CI writes it before the native builds.

## Changing a patch

1. Edit the patch in a scratch git workbench outside any synced folder:
   1. Export with `scripts/achmage/export-rhwp-source.py`, without `--patches`.
   2. Run `git init` and commit the pristine export.
   3. Apply the queue one commit per patch.
   4. Edit, then regenerate the queue with `git format-patch`.
2. Build the WASM:
   1. `python scripts/achmage/export-rhwp-source.py --out <dir> --patches`
   2. `scripts/achmage/build-rhwp-wasm.ps1 -Source <dir> -Out <out>`
   3. Copy `rhwp_bg.wasm` into the vendor directory.
   4. Update `PROVENANCE.json`: `hopPatches` and `hopBuild`.
3. Regenerate the native tree with `python scripts/achmage/sync-rhwp-native.py`, and commit `vendor/rhwp-native` where it is tracked.
4. Verify:
   - `node --test tests/*.mjs`
   - Studio `vitest`
   - `DesktopTests`
   - `DesktopClippy` (Rust 1.93)

## Moving to a new upstream rhwp

`pnpm upstream:update` refuses while patches exist, because it would build an unpatched WASM. Instead:

1. Move the submodule to the new tag and update `config/rhwp-upstream.json`.
2. Rebase the queue in the workbench: export the new commit with `--commit <sha>`, then `git am` the old patches and fix conflicts.
3. Build the WASM from the patched export, and update `PROVENANCE.json` (`commit`, `hopPatches`, `hopBuild`).
4. Run `python scripts/achmage/sync-rhwp-native.py` to regenerate the native tree.
5. In `apps/desktop/src-tauri` and `apps/desktop/quicklook/rust`, run `cargo update -p rhwp`. Then align any layout crate the test reports with `cargo update -p <crate> --precise <version>`.
6. Run the same verification as above.
