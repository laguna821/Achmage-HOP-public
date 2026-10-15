use achmage_providers::{ClaudeHost, Config};
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};
fn config(d: &OwnedDir) -> Config {
    Config {
        executable: PathBuf::from(env!("CARGO_BIN_EXE_claude_fixture")),
        profile: d.path().join("profile"),
        cwd: d.path().join("cwd"),
    }
}
fn wait(h: &ClaudeHost) -> serde_json::Value {
    let start = Instant::now();
    loop {
        let s = h.state();
        if s["busy"] == false {
            return s;
        }
        assert!(start.elapsed() < Duration::from_secs(5), "{s}");
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn login(h: &mut ClaudeHost) {
    h.begin_login().unwrap();
    assert_eq!(wait(h)["auth"]["status"], "signed_in")
}
#[test]
fn sign_in_kind_follows_the_chosen_method() {
    // A Claude subscription and an Anthropic Console account both sign in through the official CLI;
    // the panel names the kind the CLI reports.
    let d = OwnedDir::new();
    let mut h = ClaudeHost::new(config(&d)).unwrap();
    h.begin_console_login().unwrap();
    let s = wait(&h);
    assert_eq!(s["auth"]["status"], "signed_in");
    assert_eq!(s["auth"]["accountLabel"], "Anthropic Console 계정");
    let d = OwnedDir::new();
    let mut h = ClaudeHost::new(config(&d)).unwrap();
    login(&mut h);
    assert_eq!(h.state()["auth"]["accountLabel"], "Claude 구독 계정");
}
#[test]
fn restore_login_stream_usage() {
    let d = OwnedDir::new();
    let mut h = ClaudeHost::new(config(&d)).unwrap();
    h.restore().unwrap();
    assert_eq!(wait(&h)["auth"]["status"], "signed_out");
    login(&mut h);
    h.send("r1".into(), "한글 😀".into(), None).unwrap();
    let s = wait(&h);
    assert_eq!(s["turn"]["status"], "completed");
    assert_eq!(s["turn"]["text"], "응답: 한글 😀");
    assert_eq!(s["usage"]["inputTokens"], 0);
    assert!(s["usage"]["remainingPercent"].is_null());
    assert_eq!(
        h.send("r1".into(), "again".into(), None),
        Err("request_replayed")
    );
}
#[test]
fn cancel_and_disconnect_fence() {
    let d = OwnedDir::new();
    let cfg = config(&d);
    let mut h = ClaudeHost::new(cfg.clone()).unwrap();
    assert!(matches!(ClaudeHost::new(cfg), Err("profile_in_use")));
    login(&mut h);
    let generation = h.state()["auth"]["sessionGeneration"].clone();
    h.send("r1".into(), "WAIT".into(), None).unwrap();
    assert_eq!(h.cancel_turn("wrong"), Err("stale_turn"));
    h.cancel_turn("r1").unwrap();
    assert_eq!(wait(&h)["turn"]["status"], "cancelled");
    h.send("r2".into(), "WAIT".into(), None).unwrap();
    h.disconnect().unwrap();
    assert_eq!(h.restore(), Err("busy"));
    let s = wait(&h);
    assert_eq!(s["auth"]["status"], "signed_out");
    assert!(s["turn"]["text"].is_null());
    h.restore().unwrap();
    let s = wait(&h);
    assert_eq!(s["auth"]["status"], "signed_in");
    assert_ne!(s["auth"]["sessionGeneration"], generation);
}
#[test]
fn cancel_login_keeps_stdin_and_no_publish() {
    let d = OwnedDir::new();
    let cfg = config(&d);
    let mut h = ClaudeHost::new(cfg.clone()).unwrap();
    std::fs::write(cfg.profile.join("fixture-login-wait"), b"").unwrap();
    h.begin_login().unwrap();
    let started = Instant::now();
    while h.state()["auth"]["phase"] != "awaiting_browser" {
        assert!(started.elapsed() < Duration::from_secs(5));
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(h.state()["auth"]["phase"], "awaiting_browser");
    h.cancel_login().unwrap();
    assert_eq!(wait(&h)["auth"]["status"], "signed_out");
}
#[test]
fn errors_are_sanitized_and_no_automatic_retry() {
    let d = OwnedDir::new();
    let mut h = ClaudeHost::new(config(&d)).unwrap();
    login(&mut h);
    for (id, prompt, code) in [
        ("r1", "BAD", "invalid_stream"),
        ("r2", "TOOL", "control_forbidden"),
    ] {
        h.send(id.into(), prompt.into(), None).unwrap();
        let s = wait(&h);
        assert_eq!(s["turn"]["errorCode"], code);
        assert!(s["turn"]["text"].is_null());
        assert!(!s.to_string().contains("secret-token"));
    }
}
#[test]
fn validation_does_not_mutate() {
    let d = OwnedDir::new();
    let mut h = ClaudeHost::new(config(&d)).unwrap();
    let before = h.state();
    assert_eq!(h.send("id".into(), "x".into(), None), Err("signed_out"));
    assert_eq!(
        h.send("id".into(), "x".repeat(65537), None),
        Err("signed_out")
    );
    assert_eq!(
        h.send("id".into(), "x".into(), Some("--option".into())),
        Err("signed_out")
    );
    assert_eq!(before, h.state());
}

struct OwnedDir(std::path::PathBuf);
impl OwnedDir {
    fn new() -> Self {
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let p = std::env::temp_dir().join(format!(
            "achmage-claude-fixture-{}-{}",
            std::process::id(),
            N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir(&p).unwrap();
        Self(p)
    }
    fn path(&self) -> &std::path::Path {
        &self.0
    }
}
impl Drop for OwnedDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn wrong_profile_and_api_credentials_fail_closed() {
    for (marker, code) in [
        ("fixture-wrong-status", "profile_identity_mismatch"),
        ("fixture-api-status", "unsupported_auth_method"),
    ] {
        let d = OwnedDir::new();
        let cfg = config(&d);
        let mut h = ClaudeHost::new(cfg.clone()).unwrap();
        std::fs::write(cfg.profile.join(marker), b"").unwrap();
        h.restore().unwrap();
        let s = wait(&h);
        assert_eq!(s["auth"]["status"], "error");
        assert_eq!(s["auth"]["errorCode"], code);
        assert!(s["auth"]["sessionGeneration"].is_null());
    }
}
#[test]
fn expired_auth_removes_session_and_truncated_stream_errors() {
    let d = OwnedDir::new();
    let cfg = config(&d);
    let mut h = ClaudeHost::new(cfg.clone()).unwrap();
    login(&mut h);
    h.send("t1".into(), "TRUNCATED".into(), None).unwrap();
    assert_eq!(wait(&h)["turn"]["errorCode"], "truncated_stream");
    std::fs::remove_file(cfg.profile.join("fixture-signed")).unwrap();
    h.send("t2".into(), "not sent".into(), None).unwrap();
    let s = wait(&h);
    assert_eq!(s["auth"]["status"], "signed_out");
    assert!(s["turn"]["text"].is_null());
}
#[test]
fn profile_lease_survives_drop_until_worker_cleanup() {
    let d = OwnedDir::new();
    let cfg = config(&d);
    let mut h = ClaudeHost::new(cfg.clone()).unwrap();
    login(&mut h);
    h.send("wait".into(), "WAIT".into(), None).unwrap();
    drop(h);
    let start = Instant::now();
    loop {
        match ClaudeHost::new(cfg.clone()) {
            Ok(h) => {
                assert_eq!(h.state()["auth"]["status"], "signed_out");
                break;
            }
            Err("profile_in_use") => {
                assert!(start.elapsed() < Duration::from_secs(5));
                std::thread::sleep(Duration::from_millis(10));
            }
            _ => panic!("unexpected"),
        }
    }
}

#[test]
fn long_unicode_prompt_roundtrips_without_truncation() {
    let d = OwnedDir::new();
    let mut h = ClaudeHost::new(config(&d)).unwrap();
    login(&mut h);
    let prompt = "한글".repeat(20_000) + "END";
    h.send("long".into(), prompt.clone(), None).unwrap();
    let s = wait(&h);
    assert_eq!(s["turn"]["status"], "completed", "{s}");
    assert_eq!(s["turn"]["text"], format!("응답: {prompt}"));
}
