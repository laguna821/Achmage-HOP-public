param(
  # Directory holding the rhwp source to build (an exported pinned commit, optionally with HOP patches applied).
  [Parameter(Mandatory = $true)][string]$Source,
  # Output directory for the wasm-pack artifacts (rhwp_bg.wasm, rhwp.js, ...).
  [string]$Out,
  # Only type-check the library for wasm32 (the WASM-only renderer, e.g. web_canvas.rs), without building artifacts.
  [switch]$CheckOnly
)
if (-not $CheckOnly -and -not $Out) { throw '-Out is required unless -CheckOnly is given.' }
# Builds rhwp's web WASM with the pinned toolchain (Rust 1.93.1 GNU host + wasm32, wasm-pack 0.14.0).
# Paths are given through a temporary ASCII drive for the tools that still need one; host artifacts link with
# rust-lld (rustc-host-link-wrapper.rs). The drive is unmapped afterwards.
$ErrorActionPreference = 'Stop'
$userProfile = [Environment]::GetFolderPath('UserProfile')
$drive = @('P','O','N','M','L','K','J','I','H','G') | Where-Object { -not (Test-Path ($_ + ':\')) } | Select-Object -First 1
if (-not $drive) { throw 'No free drive letter for the ASCII alias.' }
$label = $drive + ':'
$wasmPack = Join-Path $env:LOCALAPPDATA 'hop-tools\wasm-pack-0.14.0\wasm-pack-v0.14.0-x86_64-pc-windows-msvc'
if (-not (Test-Path (Join-Path $wasmPack 'wasm-pack.exe'))) { throw 'wasm-pack 0.14.0 is missing under %LOCALAPPDATA%\hop-tools.' }
$relative = { param($path) $full = [IO.Path]::GetFullPath($path); if (-not $full.StartsWith($userProfile, [StringComparison]::OrdinalIgnoreCase)) { throw "Path must be under the user profile: $full" }; $label + $full.Substring($userProfile.Length) }
& subst $label $userProfile
if ($LASTEXITCODE -ne 0) { throw 'Could not create the ASCII alias drive.' }
try {
  $env:RUSTUP_HOME = $label + '\.rustup'
  $env:CARGO_HOME = $label + '\.cargo'
  $env:RUSTUP_TOOLCHAIN = '1.93.1-x86_64-pc-windows-gnu'
  # One target directory per exported source: extracted files keep the commit's old mtimes, so a shared directory
  # would let cargo treat a patched export as already built.
  $env:CARGO_TARGET_DIR = & $relative (Join-Path $env:LOCALAPPDATA ('hop-rhwp\target-' + (Split-Path $Source -Leaf)))
  $env:CARGO_BUILD_JOBS = '4'
  $env:TEMP = & $relative (Join-Path $env:LOCALAPPDATA 'hop-rhwp\tmp'); $env:TMP = $env:TEMP
  [void][IO.Directory]::CreateDirectory((Join-Path $env:LOCALAPPDATA 'hop-rhwp\tmp'))
  $env:PATH = $wasmPack + ';' + ($label + '\.cargo\bin') + ';' + $env:PATH
  # Build scripts and proc macros (the Windows GNU host) link with rust-lld, which opens any path; GNU ld cannot
  # open the non-ASCII paths rustc canonicalizes back to. See rustc-host-link-wrapper.rs.
  $toolchain = $label + '\.rustup\toolchains\1.93.1-x86_64-pc-windows-gnu'
  $hostLink = @('-C', 'link-self-contained=yes', '-C', 'linker-flavor=ld.lld', '-C', ('linker=' + $toolchain + '\lib\rustlib\x86_64-pc-windows-gnu\bin\rust-lld.exe'), '-L', 'native=C:/rtools43/x86_64-w64-mingw32.static.posix/lib')
  $wrapper = Join-Path $env:LOCALAPPDATA 'hop-tools\rustc-host-link-wrapper.exe'
  $wrapperSource = Join-Path $PSScriptRoot 'rustc-host-link-wrapper.rs'
  if (-not (Test-Path $wrapper) -or (Get-Item $wrapperSource).LastWriteTimeUtc -gt (Get-Item $wrapper).LastWriteTimeUtc) {
    [void][IO.Directory]::CreateDirectory((Split-Path $wrapper))
    & rustc $wrapperSource -O @hostLink -o $wrapper
    if ($LASTEXITCODE -ne 0) { throw 'Could not build the rustc host-link wrapper.' }
  }
  $env:RUSTC_WRAPPER = $wrapper
  $env:HOP_HOST_RUSTC_ARGS = $hostLink -join [char]0x1f
  # Panic locations embed dependency source paths; without a remap the alias drive letter would change the WASM.
  $env:CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS = '--remap-path-prefix=' + $label + '\.cargo\registry\src=/cargo/registry/src'
  Push-Location (& $relative $Source)
  try {
    if ($CheckOnly) {
      & cargo check --lib --release --target wasm32-unknown-unknown
      if ($LASTEXITCODE -ne 0) { throw "cargo check (wasm32) failed: $LASTEXITCODE" }
    } else {
      & wasm-pack build --target web --out-dir (& $relative $Out) --release
      if ($LASTEXITCODE -ne 0) { throw "wasm-pack failed: $LASTEXITCODE" }
    }
  }
  finally { Pop-Location }
} finally {
  & subst $label /D | Out-Null
}
if ($CheckOnly) { return }
Get-ChildItem -LiteralPath $Out | Select-Object Name, Length | Format-Table -AutoSize | Out-String | Write-Output
(Get-FileHash (Join-Path $Out 'rhwp_bg.wasm') -Algorithm SHA256).Hash.ToLower()
