//! Explicit maintainer probe; never called during unit tests or application startup.
use achmage_runtime::install::*;
use std::{path::PathBuf, sync::atomic::AtomicBool};
fn main() {
    let path = PathBuf::from(
        std::env::args_os()
            .nth(1)
            .expect("new owned output directory"),
    );
    assert!(!path.exists(), "output must be new");
    let platform = Platform::current().unwrap();
    let manifest = fetch_manifest(platform).unwrap();
    let installed = install(&path, platform, &manifest, &AtomicBool::new(false)).unwrap();
    verify_installed(&installed.executable, &installed.sha512).unwrap();
    println!("{}", serde_json::to_string_pretty(&installed).unwrap());
}
