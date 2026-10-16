//! Official CLI adapters. Native callers own paths and account selection.
mod acp;
mod grok;
mod host;
mod models;
mod process;
mod recent;
mod stream;
pub use grok::{locate_grok, GrokConfig, GrokHost, GrokLimits, GrokStatus, LoginMode};
pub use host::{ClaudeHost, Config};
pub type Result<T> = std::result::Result<T, &'static str>;

/// What a stopped turn tells the user. A long answer streams for as long as it needs: only silence or the hard maximum ends it.
pub(crate) fn turn_failure_message(code: &str) -> &'static str {
    match code {
        "idle_timeout" => "AI가 2분 동안 아무 응답도 보내지 않아 멈췄습니다. 자동 재전송하지 않습니다.",
        "timeout" => "응답이 15분을 넘어 멈췄습니다. 자동 재전송하지 않습니다.",
        _ => "응답을 완료하지 못했습니다. 자동 재전송하지 않습니다.",
    }
}
