//! Narrow official runtime lifecycle; no credential storage or arbitrary shell IPC.
pub mod install;
pub mod login;
pub type Result<T> = std::result::Result<T, &'static str>;
