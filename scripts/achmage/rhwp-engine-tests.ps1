param(
  # rhwp source tree to test: the patch workbench (scripts/achmage/rhwp-workbench.py) or a full export.
  [Parameter(Mandatory = $true)][string]$Source,
  # cargo test filter, e.g. 'renderer::' or 'typeset::'. Empty runs every library test.
  [string]$Filter = 'renderer::',
  # Extra cargo test arguments, e.g. '--test','issue_2070' for an integration target.
  [string[]]$CargoArgs = @('-p', 'rhwp', '--lib')
)
# Runs rhwp's own tests on a patched tree with the pinned toolchain (Rust 1.93.1 GNU), the same way
# build-rhwp-wasm.ps1 builds the WASM: a temporary ASCII drive, host artifacts linked with rust-lld.
$ErrorActionPreference = 'Stop'
$userProfile = [Environment]::GetFolderPath('UserProfile')
$drive = @('P','O','N','M','L','K','J','I','H','G') | Where-Object { -not (Test-Path ($_ + ':\')) } | Select-Object -First 1
if (-not $drive) { throw 'No free drive letter for the ASCII alias.' }
$label = $drive + ':'
$relative = { param($path) $full = [IO.Path]::GetFullPath($path); if (-not $full.StartsWith($userProfile, [StringComparison]::OrdinalIgnoreCase)) { throw "Path must be under the user profile: $full" }; $label + $full.Substring($userProfile.Length) }
& subst $label $userProfile
if ($LASTEXITCODE -ne 0) { throw 'Could not create the ASCII alias drive.' }
try {
  $env:RUSTUP_HOME = $label + '\.rustup'
  $env:CARGO_HOME = $label + '\.cargo'
  $env:RUSTUP_TOOLCHAIN = '1.93.1-x86_64-pc-windows-gnu'
  $env:CARGO_TARGET_DIR = & $relative (Join-Path $env:LOCALAPPDATA ('hop-rhwp\test-target-' + (Split-Path $Source -Leaf)))
  $env:CARGO_BUILD_JOBS = '4'
  $env:TEMP = & $relative (Join-Path $env:LOCALAPPDATA 'hop-rhwp\tmp'); $env:TMP = $env:TEMP
  [void][IO.Directory]::CreateDirectory((Join-Path $env:LOCALAPPDATA 'hop-rhwp\tmp'))
  # dlltool (raw-dylib imports of windows-sys/getrandom on the GNU host) comes from Rtools, as for the desktop build.
  $env:PATH = ($label + '\.cargo\bin') + ';C:/rtools43/x86_64-w64-mingw32.static.posix/bin;' + $env:PATH
  # Everything here is a host artifact (no --target), so the wrapper links all of it with rust-lld.
  $toolchain = $label + '\.rustup\toolchains\1.93.1-x86_64-pc-windows-gnu'
  $hostLink = @('-C', 'link-self-contained=yes', '-C', 'linker-flavor=ld.lld', '-C', ('linker=' + $toolchain + '\lib\rustlib\x86_64-pc-windows-gnu\bin\rust-lld.exe'), '-L', 'native=C:/rtools43/x86_64-w64-mingw32.static.posix/lib')
  $wrapper = Join-Path $env:LOCALAPPDATA 'hop-tools\rustc-host-link-wrapper.exe'
  if (-not (Test-Path $wrapper)) { throw 'Build the host-link wrapper first (build-rhwp-wasm.ps1 builds it).' }
  $env:RUSTC_WRAPPER = $wrapper
  $env:HOP_HOST_RUSTC_ARGS = $hostLink -join [char]0x1f
  Push-Location (& $relative $Source)
  try {
    $arguments = @('test') + $CargoArgs
    if ($Filter) { $arguments += @($Filter) }
    & cargo @arguments
    if ($LASTEXITCODE -ne 0) { throw "rhwp tests failed: $LASTEXITCODE" }
  } finally { Pop-Location }
} finally {
  & subst $label /D | Out-Null
}
