use crate::Result;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha512};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use url::Url;

const BASE: &str =
    "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/";
pub const MAX_BINARY_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Clone, Copy, Debug)]
pub enum Platform {
    WindowsX64,
    WindowsArm64,
    MacX64,
    MacArm64,
    LinuxX64,
    LinuxArm64,
}
impl Platform {
    pub fn current() -> Result<Self> {
        match (std::env::consts::OS, std::env::consts::ARCH) {
            ("windows", "x86_64") => Ok(Self::WindowsX64),
            ("windows", "aarch64") => Ok(Self::WindowsArm64),
            ("macos", "x86_64") => Ok(Self::MacX64),
            ("macos", "aarch64") => Ok(Self::MacArm64),
            ("linux", "x86_64") if !cfg!(target_env = "musl") => Ok(Self::LinuxX64),
            ("linux", "aarch64") if !cfg!(target_env = "musl") => Ok(Self::LinuxArm64),
            _ => Err("unsupported_platform"),
        }
    }
    fn name(self) -> &'static str {
        match self {
            Self::WindowsX64 => "windows_amd64",
            Self::WindowsArm64 => "windows_arm64",
            Self::MacX64 => "darwin_amd64",
            Self::MacArm64 => "darwin_arm64",
            Self::LinuxX64 => "linux_amd64",
            Self::LinuxArm64 => "linux_arm64",
        }
    }
    fn executable(self) -> &'static str {
        if matches!(self, Self::WindowsX64 | Self::WindowsArm64) {
            "agy.exe"
        } else {
            "agy"
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub version: String,
    pub url: String,
    pub sha512: String,
}
impl Manifest {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > 16384 {
            return Err("manifest_limit");
        }
        let value: Self = serde_json::from_slice(bytes).map_err(|_| "manifest_json")?;
        if value.version.is_empty()
            || value.version.len() > 64
            || !value
                .version
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b".-_".contains(&b))
            || value.version.starts_with('.')
        {
            return Err("manifest_version");
        }
        if value.sha512.len() != 128 || !value.sha512.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("manifest_hash");
        }
        let url = Url::parse(&value.url).map_err(|_| "manifest_url")?;
        if url.scheme() != "https"
            || url.host_str() != Some("storage.googleapis.com")
            || url.port().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || !url
                .path()
                .starts_with("/antigravity-public/antigravity-cli/")
            || url.path().contains('%')
        {
            return Err("manifest_url");
        }
        Ok(value)
    }
}
fn client() -> Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(120))
        .connect_timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "http_setup")
}
pub fn fetch_manifest(platform: Platform) -> Result<Manifest> {
    let response = client()?
        .get(format!("{BASE}{}.json", platform.name()))
        .send()
        .map_err(|_| "manifest_network")?
        .error_for_status()
        .map_err(|_| "manifest_status")?;
    let mut bytes = Vec::new();
    response
        .take(16385)
        .read_to_end(&mut bytes)
        .map_err(|_| "manifest_read")?;
    Manifest::parse(&bytes)
}
#[derive(Debug, Serialize)]
pub struct Installed {
    pub executable: PathBuf,
    pub version: String,
    pub sha512: String,
    pub bytes: u64,
}
pub fn verify_installed(path: &Path, expected_sha512: &str) -> Result<()> {
    if expected_sha512.len() != 128 || !expected_sha512.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("checksum");
    }
    let mut file = fs::File::open(path).map_err(|_| "runtime_missing")?;
    let size = file.metadata().map_err(|_| "runtime_missing")?.len();
    if size == 0 || size > MAX_BINARY_BYTES {
        return Err("binary_limit");
    }
    let mut hash = Sha512::new();
    let mut bytes = [0u8; 32768];
    let mut read = 0;
    loop {
        let n = file.read(&mut bytes).map_err(|_| "runtime_read")?;
        if n == 0 {
            break;
        }
        read += n as u64;
        if read > MAX_BINARY_BYTES {
            return Err("binary_limit");
        }
        hash.update(&bytes[..n]);
    }
    if format!("{:x}", hash.finalize()) != expected_sha512.to_ascii_lowercase() {
        return Err("checksum");
    }
    Ok(())
}
/// Explicitly initiated installation only. Caller supplies an application-owned directory, never a client path.
pub fn install(
    root: &Path,
    platform: Platform,
    manifest: &Manifest,
    cancel: &AtomicBool,
) -> Result<Installed> {
    let checked = Manifest::parse(&serde_json::to_vec(manifest).map_err(|_| "manifest_json")?)?;
    if cancel.load(Ordering::SeqCst) {
        return Err("cancelled");
    }
    if root
        .join(format!("{}-{}", checked.version, platform.name()))
        .exists()
    {
        return Err("already_installed");
    }
    let response = client()?
        .get(&checked.url)
        .send()
        .map_err(|_| "download_network")?
        .error_for_status()
        .map_err(|_| "download_status")?;
    if response
        .content_length()
        .is_some_and(|n| n > MAX_BINARY_BYTES)
    {
        return Err("binary_limit");
    }
    install_reader(root, platform, &checked, response, cancel)
}
/// Recover a fully verified prior download after an app-selection-record failure; never overwrite it.
pub fn existing(root: &Path, platform: Platform, manifest: &Manifest) -> Result<Installed> {
    let checked = Manifest::parse(&serde_json::to_vec(manifest).map_err(|_| "manifest_json")?)?;
    let root = root.canonicalize().map_err(|_| "runtime_missing")?;
    let executable = root
        .join(format!("{}-{}", checked.version, platform.name()))
        .join(platform.executable())
        .canonicalize()
        .map_err(|_| "runtime_missing")?;
    if !executable.starts_with(&root) {
        return Err("runtime_path");
    }
    verify_installed(&executable, &checked.sha512)?;
    let bytes = fs::metadata(&executable)
        .map_err(|_| "runtime_missing")?
        .len();
    Ok(Installed {
        executable,
        version: checked.version,
        sha512: checked.sha512,
        bytes,
    })
}
fn install_reader(
    root: &Path,
    platform: Platform,
    manifest: &Manifest,
    mut reader: impl Read,
    cancel: &AtomicBool,
) -> Result<Installed> {
    if cancel.load(Ordering::SeqCst) {
        return Err("cancelled");
    }
    fs::create_dir_all(root).map_err(|_| "install_directory")?;
    let root = root.canonicalize().map_err(|_| "install_directory")?;
    let target = root.join(format!("{}-{}", manifest.version, platform.name()));
    if target.exists() {
        return Err("already_installed");
    }
    let staging = tempfile::Builder::new()
        .prefix(".download-")
        .tempdir_in(&root)
        .map_err(|_| "install_staging")?;
    let staged = staging.path().join(platform.executable());
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&staged)
        .map_err(|_| "install_write")?;
    let mut hash = Sha512::new();
    let mut count = 0u64;
    let mut buf = [0u8; 32768];
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err("cancelled");
        }
        let n = reader.read(&mut buf).map_err(|_| "download_read")?;
        if n == 0 {
            break;
        }
        count = count.checked_add(n as u64).ok_or("binary_limit")?;
        if count > MAX_BINARY_BYTES {
            return Err("binary_limit");
        }
        hash.update(&buf[..n]);
        file.write_all(&buf[..n]).map_err(|_| "install_write")?;
    }
    let actual = format!("{:x}", hash.finalize());
    if count == 0 || actual != manifest.sha512.to_ascii_lowercase() {
        return Err("checksum");
    }
    file.sync_all().map_err(|_| "install_sync")?;
    drop(file);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&staged, fs::Permissions::from_mode(0o700))
            .map_err(|_| "install_permission")?;
    }
    if cancel.load(Ordering::SeqCst) {
        return Err("cancelled");
    }
    // Exclusive directory ownership prevents replacing any previous runtime, including concurrent installers.
    fs::create_dir(&target).map_err(|_| "already_installed")?;
    let executable = target.join(platform.executable());
    if fs::rename(&staged, &executable).is_err() {
        let _ = fs::remove_dir(&target);
        return Err("install_publish");
    }
    Ok(Installed {
        executable,
        version: manifest.version.clone(),
        sha512: actual,
        bytes: count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn manifest() -> Manifest {
        Manifest{version:"1.3.4".into(),url:"https://storage.googleapis.com/antigravity-public/antigravity-cli/1.3.4/windows-x64/cli_windows_x64.exe".into(),sha512:format!("{:x}",Sha512::digest(b"owned fixture"))}
    }
    #[test]
    fn strict_manifest() {
        let m = manifest();
        assert!(Manifest::parse(&serde_json::to_vec(&m).unwrap()).is_ok());
        for url in [
            "http://storage.googleapis.com/antigravity-public/antigravity-cli/a",
            "https://evil.test/antigravity-public/antigravity-cli/a",
            "https://storage.googleapis.com/other/a",
            "https://storage.googleapis.com/antigravity-public/antigravity-cli/a?token=x",
            "https://storage.googleapis.com/antigravity-public/antigravity-cli/%2e%2e/a",
        ] {
            let mut bad = m.clone();
            bad.url = url.into();
            assert!(Manifest::parse(&serde_json::to_vec(&bad).unwrap()).is_err());
        }
    }
    #[test]
    fn malformed_size_version_hash() {
        assert!(Manifest::parse(&vec![b' '; 16385]).is_err());
        for version in ["", "../escape", "/absolute", "a:b", ".hidden"] {
            let mut m = manifest();
            m.version = version.into();
            assert!(Manifest::parse(&serde_json::to_vec(&m).unwrap()).is_err());
        }
        let mut m = manifest();
        m.sha512 = "0".into();
        assert!(Manifest::parse(&serde_json::to_vec(&m).unwrap()).is_err());
    }
    #[test]
    fn exclusive_install_and_hash_failure() {
        let root = tempfile::tempdir().unwrap();
        let c = AtomicBool::new(false);
        let m = manifest();
        assert_eq!(
            install_reader(root.path(), Platform::WindowsX64, &m, &b"bad"[..], &c).unwrap_err(),
            "checksum"
        );
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
        let ok = install_reader(
            root.path(),
            Platform::WindowsX64,
            &m,
            &b"owned fixture"[..],
            &c,
        )
        .unwrap();
        assert_eq!(fs::read(&ok.executable).unwrap(), b"owned fixture");
        assert_eq!(
            existing(root.path(), Platform::WindowsX64, &m)
                .unwrap()
                .executable,
            ok.executable
        );
        assert_eq!(
            install_reader(
                root.path(),
                Platform::WindowsX64,
                &m,
                &b"owned fixture"[..],
                &c
            )
            .unwrap_err(),
            "already_installed"
        );
        assert_eq!(fs::read(ok.executable).unwrap(), b"owned fixture");
    }
    #[test]
    fn cancelled_install_has_no_output() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(
            install_reader(
                root.path(),
                Platform::WindowsX64,
                &manifest(),
                &b"owned fixture"[..],
                &AtomicBool::new(true)
            )
            .unwrap_err(),
            "cancelled"
        );
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
    }
    #[test]
    fn verification_rejects_changed_file_and_read_error_cleans_staging() {
        struct Broken;
        impl Read for Broken {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::ErrorKind::ConnectionReset.into())
            }
        }
        let root = tempfile::tempdir().unwrap();
        let c = AtomicBool::new(false);
        let m = manifest();
        assert_eq!(
            install_reader(root.path(), Platform::WindowsX64, &m, Broken, &c).unwrap_err(),
            "download_read"
        );
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
        let installed = install_reader(
            root.path(),
            Platform::WindowsX64,
            &m,
            &b"owned fixture"[..],
            &c,
        )
        .unwrap();
        verify_installed(&installed.executable, &m.sha512).unwrap();
        fs::write(&installed.executable, b"changed bytes").unwrap();
        assert_eq!(
            verify_installed(&installed.executable, &m.sha512).unwrap_err(),
            "checksum"
        );
    }
}
