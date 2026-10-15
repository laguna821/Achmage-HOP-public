//! Official CLI adapters. Native callers own paths and account selection.
mod acp;
mod grok;
mod host;
mod process;
mod recent;
mod stream;
pub use grok::{locate_grok, GrokConfig, GrokHost, GrokLimits, GrokStatus, LoginMode};
pub use host::{ClaudeHost, Config};
pub type Result<T> = std::result::Result<T, &'static str>;
