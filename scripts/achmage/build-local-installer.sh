#!/usr/bin/env bash
# Builds the Achmage HOP installer on this Mac or Linux computer, the same way the "Achmage HOP Desktop"
# GitHub workflow does (no Hancom fonts; only the open-licence fonts upstream HOP ships are bundled), and
# copies the result to OUTPUT_DIR. Nothing is uploaded. On Linux it also makes an AppImage for this computer:
# an AppImage bundles LGPL system libraries (GTK, WebKitGTK), so share the .deb rather than the AppImage.
#
#   bash scripts/achmage/build-local-installer.sh ~/Downloads/achmage-hop-installers
#
# Needs: Node 24.19 (corepack/pnpm), Rust 1.93.1 (rustup), Python 3, and on Linux the WebKitGTK build packages:
#   Arch/CachyOS: sudo pacman -S --needed base-devel webkit2gtk-4.1 gtk3 libayatana-appindicator librsvg openssl patchelf fuse2 xdotool
#   Debian/Ubuntu: sudo apt install build-essential libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev patchelf libfuse2 libxdo-dev
set -euo pipefail

output="${1:?usage: bash scripts/achmage/build-local-installer.sh <output folder>}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

case "$(uname -s)" in
  Darwin) target="aarch64-apple-darwin"; bundles="app,dmg"; platform="macOS" ;;
  Linux) target="x86_64-unknown-linux-gnu"; bundles="deb,appimage"; platform="Linux" ;;
  *) echo "Mac·Linux용 스크립트입니다. Windows는 README의 「직접 빌드하기」 순서를 따르세요." >&2; exit 2 ;;
esac

node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$node_major" = 24 ] || { echo "Node 24가 필요합니다(지금: $(node -v 2>/dev/null || echo 없음))." >&2; exit 2; }
toolchain="$(node -p "require('./config/rhwp-upstream.json').rustToolchain")"
rustup toolchain install "$toolchain" --profile minimal --target "$target"
export RUSTUP_TOOLCHAIN="$toolchain"

git submodule update --init --depth 1
corepack enable
pnpm install --frozen-lockfile
pnpm --dir apps/kordoc-engine install --frozen-lockfile --ignore-workspace --no-optional --ignore-scripts
node scripts/achmage/prepare-kordoc-runtime.mjs
# PDF export builds the pinned rhwp commit with patches/rhwp applied (vendor/rhwp-native).
python3 scripts/achmage/sync-rhwp-native.py
node scripts/achmage/third-party-notices.mjs --target "$target"

(cd apps/desktop && pnpm tauri build --target "$target" --bundles "$bundles" \
  --config src-tauri/tauri.achmage.conf.json --config src-tauri/tauri.achmage.release.conf.json)

bundle_dir="apps/desktop/src-tauri/target/$target/release/bundle"
[ -d "$bundle_dir" ] || bundle_dir="target/$target/release/bundle"
mkdir -p "$output/$platform"
cp -f apps/desktop/src-tauri/resources/THIRD_PARTY_NOTICES.md "$output/$platform/"
find "$bundle_dir" -maxdepth 2 -type f \( -name '*.dmg' -o -name '*.deb' -o -name '*.AppImage' \) -exec cp -f {} "$output/$platform/" \;
if [ "$platform" = macOS ]; then
  app="$(find "$bundle_dir/macos" -maxdepth 1 -name '*.app' | head -1)"
  [ -n "$app" ] && ditto -c -k --keepParent "$app" "$output/$platform/Achmage.HOP-macos-arm64.app.zip"
fi
(cd "$output/$platform" && { command -v sha256sum >/dev/null && sha256sum ./* || shasum -a 256 ./*; } | grep -v SHA256SUMS > SHA256SUMS.txt)
echo "만든 파일:"; ls -la "$output/$platform"
