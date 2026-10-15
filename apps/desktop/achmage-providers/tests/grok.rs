//! Synthetic child tests only. No real `grok` binary is run and no login is performed.
use achmage_providers::{locate_grok, GrokConfig, GrokHost, GrokLimits, LoginMode};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const FIXTURE: &str = env!("CARGO_BIN_EXE_grok_fixture");
const EXE_NAME: &str = if cfg!(windows) { "grok.exe" } else { "grok" };

struct OwnedDir(PathBuf);
impl OwnedDir {
    fn new() -> Self {
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let p = std::env::temp_dir().join(format!(
            "achmage-grok-fixture-{}-{}",
            std::process::id(),
            N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir(&p).unwrap();
        Self(p)
    }
    fn path(&self) -> &Path {
        &self.0
    }
}
impl Drop for OwnedDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn limits() -> GrokLimits {
    GrokLimits {
        status: Duration::from_secs(5),
        login: Duration::from_secs(10),
        turn: Duration::from_secs(6),
        idle: Duration::from_secs(3),
        cancel_grace: Duration::from_secs(1),
    }
}
fn config(d: &OwnedDir) -> GrokConfig {
    let mut c = GrokConfig::new(
        Some(PathBuf::from(FIXTURE)),
        d.path().join("profile"),
        d.path().join("cwd"),
    );
    c.limits = limits();
    c
}
fn grok_home(cfg: &GrokConfig) -> PathBuf {
    cfg.profile.join(".grok")
}
fn mark(cfg: &GrokConfig, name: &str) {
    std::fs::write(grok_home(cfg).join(name), b"").unwrap();
}
fn wait(h: &GrokHost) -> Value {
    let start = Instant::now();
    loop {
        let s = h.state();
        if s["busy"] == false {
            return s;
        }
        assert!(start.elapsed() < Duration::from_secs(10), "{s}");
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn wait_for(h: &GrokHost, pred: impl Fn(&Value) -> bool) -> Value {
    let start = Instant::now();
    loop {
        let s = h.state();
        if pred(&s) {
            return s;
        }
        assert!(start.elapsed() < Duration::from_secs(10), "{s}");
        std::thread::sleep(Duration::from_millis(10));
    }
}
/// Signed-in fixture profile, verified through the status probe.
fn ready(cfg: &GrokConfig) -> GrokHost {
    let mut h = GrokHost::new(cfg.clone()).unwrap();
    mark(cfg, "fixture-signed");
    h.restore().unwrap();
    let s = wait(&h);
    assert_eq!(s["providerStatus"], "ready", "{s}");
    assert_eq!(s["auth"]["status"], "signed_in");
    h
}
fn turn(h: &mut GrokHost, id: &str, prompt: &str) -> Value {
    h.send(id.into(), prompt.into()).unwrap();
    wait(h)
}
fn canon(p: impl AsRef<Path>) -> PathBuf {
    p.as_ref().canonicalize().unwrap()
}

#[test]
fn not_installed_and_path_lookup() {
    let d = OwnedDir::new();
    let missing = d.path().join("nowhere").join(EXE_NAME);
    let empty = d.path().join("empty-bin");
    let bin = d.path().join("bin");
    std::fs::create_dir_all(&empty).unwrap();
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::copy(FIXTURE, bin.join(EXE_NAME)).unwrap();
    let joined = std::env::join_paths([empty.clone(), bin.clone()]).unwrap();
    assert_eq!(locate_grok(Some(&missing), None), None);
    assert_eq!(locate_grok(None, Some(empty.as_os_str())), None);
    assert_eq!(locate_grok(None, Some(&joined)), Some(bin.join(EXE_NAME)));
    // A configured explicit path never silently falls back to PATH.
    assert_eq!(locate_grok(Some(&missing), Some(&joined)), None);

    let mut cfg = config(&d);
    cfg.executable = Some(missing);
    let mut h = GrokHost::new(cfg).unwrap();
    h.restore().unwrap();
    let s = wait(&h);
    assert_eq!(s["providerStatus"], "not_installed");
    assert_eq!(s["auth"]["status"], "signed_out");
    assert_eq!(s["models"], json!([]));
    assert_eq!(h.send("r1".into(), "x".into()), Err("signed_out"));
    h.begin_login(LoginMode::Browser).unwrap();
    assert_eq!(wait(&h)["providerStatus"], "not_installed");
    drop(h);

    let d2 = OwnedDir::new();
    let mut cfg = config(&d2);
    cfg.executable = None;
    cfg.search_path = Some(joined);
    let mut h = GrokHost::new(cfg).unwrap();
    h.restore().unwrap();
    assert_eq!(wait(&h)["providerStatus"], "login_required");
}

#[test]
fn login_required_via_auth_error_then_browser_login() {
    let d = OwnedDir::new();
    let cfg = config(&d);
    let mut h = GrokHost::new(cfg.clone()).unwrap();
    h.restore().unwrap();
    let s = wait(&h);
    assert_eq!(s["providerStatus"], "login_required");
    assert_eq!(s["auth"]["status"], "signed_out");
    assert!(s["auth"]["sessionGeneration"].is_null());
    assert_eq!(s["cliVersion"], "grok 0.0.0-fixture");
    // Probe never logged in by itself.
    assert!(!grok_home(&cfg).join("fixture-signed").exists());
    h.begin_login(LoginMode::Browser).unwrap();
    let s = wait(&h);
    assert_eq!(s["providerStatus"], "ready", "{s}");
    assert_eq!(s["auth"]["status"], "signed_in");
    assert!(s["auth"]["sessionGeneration"].is_string());
    // The CLI listed no models, so none are reported.
    assert_eq!(s["models"], json!([]));
    assert!(!s.to_string().contains("secret-token"));
    assert!(!s.to_string().contains("x.ai/oauth2"));
    assert!(grok_home(&cfg).join("fixture-signed").exists());
}

#[test]
fn cached_token_authenticate_and_cli_models() {
    let d = OwnedDir::new();
    let cfg = config(&d);
    let mut h = GrokHost::new(cfg.clone()).unwrap();
    for m in [
        "fixture-signed",
        "fixture-needs-authenticate",
        "fixture-models",
    ] {
        mark(&cfg, m);
    }
    h.restore().unwrap();
    let s = wait(&h);
    assert_eq!(s["providerStatus"], "ready", "{s}");
    assert!(grok_home(&cfg).join("fixture-authenticated").exists());
    assert_eq!(
        s["models"],
        json!([{"id":"grok-fixture-1","label":"Grok Fixture 1"},{"id":"grok-fixture-2","label":"Grok Fixture 2"}])
    );
}

#[test]
fn happy_path_streams_text_and_usage() {
    let d = OwnedDir::new();
    let mut h = ready(&config(&d));
    assert_eq!(
        h.send("bad id".into(), "x".into()),
        Err("invalid_request_id")
    );
    assert_eq!(h.send("r0".into(), "".into()), Err("prompt_limit"));
    let s = turn(&mut h, "r1", "한글 😀");
    assert_eq!(s["turn"]["status"], "completed", "{s}");
    assert_eq!(s["turn"]["requestId"], "r1");
    assert_eq!(s["turn"]["text"], "응답: 한글 😀");
    assert_eq!(s["turn"]["stopReason"], "end_turn");
    assert_eq!(s["usage"]["inputTokens"], 5);
    assert_eq!(s["usage"]["outputTokens"], 7);
    assert!(s["usage"]["cacheReadTokens"].is_null());
    assert!(s["usage"]["cacheCreationTokens"].is_null());
    assert!(s["usage"]["remainingPercent"].is_null());
    assert_eq!(s["usage"]["source"], "grok_response_completed");
    // available_commands_update + tool_call + thought + plan: counted, never shown.
    assert_eq!(s["turn"]["activity"]["otherUpdates"], 4);
    assert!(!s["turn"]["text"].as_str().unwrap().contains("생각"));
    assert_eq!(h.send("r1".into(), "again".into()), Err("request_replayed"));
    let s = turn(&mut h, "r2", "USAGE_RESULT");
    assert_eq!(s["turn"]["status"], "completed");
    assert_eq!(s["usage"]["inputTokens"], 11);
    assert_eq!(s["usage"]["outputTokens"], 0);
    assert_eq!(s["usage"]["cacheReadTokens"], 3);
    assert!(s["usage"]["cacheCreationTokens"].is_null());
    assert_eq!(s["usage"]["source"], "acp_prompt_result");
}

#[test]
fn permission_requests_are_refused() {
    let d = OwnedDir::new();
    let cfg = config(&d);
    let mut h = ready(&cfg);
    let s = turn(&mut h, "p1", "PERMISSION");
    assert_eq!(s["turn"]["status"], "completed", "{s}");
    assert_eq!(s["turn"]["text"], "거절됨");
    assert_eq!(s["turn"]["activity"]["permissionRequestsRefused"], 1);
    // Without a reject option the answer is cancelled; the provider's own stop is reported.
    let s = turn(&mut h, "p2", "PERMISSION_NO_REJECT");
    assert_eq!(s["turn"]["status"], "error");
    assert_eq!(s["turn"]["stopReason"], "cancelled");
    assert_eq!(s["turn"]["errorCode"], "stop_cancelled");
    assert!(s["turn"]["text"].is_null());
    assert!(!grok_home(&cfg)
        .join("fixture-permission-unexpected")
        .exists());
}

#[test]
fn fs_and_terminal_requests_get_method_not_found() {
    let d = OwnedDir::new();
    let mut h = ready(&config(&d));
    let s = turn(&mut h, "f1", "FS");
    assert_eq!(s["turn"]["status"], "completed", "{s}");
    assert_eq!(s["turn"]["text"], "ok");
    assert_eq!(s["turn"]["activity"]["clientRequestsRejected"], 2);
}

#[test]
fn foreign_session_updates_are_ignored() {
    let d = OwnedDir::new();
    let mut h = ready(&config(&d));
    let s = turn(&mut h, "s1", "FOREIGN");
    assert_eq!(s["turn"]["text"], "mine", "{s}");
    assert_eq!(s["turn"]["activity"]["foreignSessionUpdates"], 1);
    assert!(!s.to_string().contains("LEAK"));
}

#[test]
fn malformed_and_oversize_lines_fail_bounded() {
    let d = OwnedDir::new();
    let mut h = ready(&config(&d));
    for (id, prompt, code) in [
        ("m1", "MALFORMED", "invalid_json"),
        ("m2", "OVERSIZE", "line_limit"),
        ("m3", "BAD_ID", "unexpected_response"),
    ] {
        let s = turn(&mut h, id, prompt);
        assert_eq!(s["turn"]["status"], "error", "{s}");
        assert_eq!(s["turn"]["errorCode"], code);
        assert!(s["turn"]["text"].is_null());
        assert!(!s.to_string().contains("secret-token"));
    }
}

#[test]
fn idle_limit_is_refreshed_only_by_this_session() {
    let d = OwnedDir::new();
    let mut cfg = config(&d);
    cfg.limits.idle = Duration::from_millis(700);
    let mut h = ready(&cfg);
    for (id, prompt) in [("i1", "SILENT"), ("i2", "FOREIGN_SPAM")] {
        let s = turn(&mut h, id, prompt);
        assert_eq!(s["turn"]["errorCode"], "idle_timeout", "{s}");
        assert!(!s.to_string().contains("LEAK"));
    }
    // Eight chunks 150 ms apart outlast the idle limit in total but never exceed it per gap.
    let s = turn(&mut h, "i3", "SLOW_STREAM");
    assert_eq!(s["turn"]["status"], "completed", "{s}");
    assert_eq!(s["turn"]["text"], "........");
}

#[test]
fn hard_turn_cap() {
    let d = OwnedDir::new();
    let mut cfg = config(&d);
    cfg.limits.turn = Duration::from_millis(1500);
    let mut h = ready(&cfg);
    let started = Instant::now();
    let s = turn(&mut h, "h1", "SLOW_FOREVER");
    assert_eq!(s["turn"]["errorCode"], "timeout", "{s}");
    assert!(s["turn"]["text"].is_null());
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[test]
fn cancel_sends_session_cancel_then_kills_bounded() {
    let d = OwnedDir::new();
    let cfg = config(&d);
    let mut h = ready(&cfg);
    h.send("c1".into(), "WAIT_CANCEL".into()).unwrap();
    wait_for(&h, |s| s["turn"]["text"] == "부분");
    assert_eq!(h.cancel_turn("wrong"), Err("stale_turn"));
    h.cancel_turn("c1").unwrap();
    let s = wait(&h);
    assert_eq!(s["turn"]["status"], "cancelled", "{s}");
    assert!(s["turn"]["text"].is_null());
    assert!(grok_home(&cfg).join("fixture-cancel-received").exists());
    // An agent that ignores session/cancel is killed after the bounded grace.
    h.send("c2".into(), "SILENT".into()).unwrap();
    let started = Instant::now();
    std::thread::sleep(Duration::from_millis(300));
    h.cancel_turn("c2").unwrap();
    let s = wait(&h);
    assert_eq!(s["turn"]["status"], "cancelled");
    assert!(started.elapsed() < Duration::from_secs(4));
}

#[test]
fn crash_mid_turn_is_not_success() {
    let d = OwnedDir::new();
    let mut h = ready(&config(&d));
    let s = turn(&mut h, "x1", "CRASH");
    assert_eq!(s["turn"]["status"], "error", "{s}");
    assert_eq!(s["turn"]["errorCode"], "unexpected_eof");
    assert!(s["turn"]["text"].is_null());
}

#[test]
fn non_success_stop_reasons_are_reported_as_such() {
    let d = OwnedDir::new();
    let mut h = ready(&config(&d));
    for (id, prompt, stop) in [
        ("s1", "REFUSAL", "refusal"),
        ("s2", "MAX_TOKENS", "max_tokens"),
    ] {
        let s = turn(&mut h, id, prompt);
        assert_eq!(s["turn"]["status"], "error", "{s}");
        assert_eq!(s["turn"]["stopReason"], stop);
        assert_eq!(s["turn"]["errorCode"], format!("stop_{stop}"));
        assert!(s["turn"]["text"].is_null());
    }
}

#[test]
fn expired_auth_mid_turn_requires_login() {
    let d = OwnedDir::new();
    let mut h = ready(&config(&d));
    let s = turn(&mut h, "e1", "EXPIRED");
    assert_eq!(s["turn"]["errorCode"], "login_required", "{s}");
    assert_eq!(s["providerStatus"], "login_required");
    assert_eq!(s["auth"]["status"], "signed_out");
    assert_eq!(h.send("e2".into(), "x".into()), Err("signed_out"));
}

#[test]
fn login_failure_cancel_and_device_auth() {
    let d = OwnedDir::new();
    let cfg = config(&d);
    let mut h = GrokHost::new(cfg.clone()).unwrap();
    mark(&cfg, "fixture-login-fail");
    h.begin_login(LoginMode::Browser).unwrap();
    let s = wait(&h);
    assert_eq!(s["auth"]["status"], "error", "{s}");
    assert_eq!(s["auth"]["errorCode"], "login_failed");
    assert!(!s.to_string().contains("secret-token"));

    std::fs::remove_file(grok_home(&cfg).join("fixture-login-fail")).unwrap();
    mark(&cfg, "fixture-login-wait");
    h.begin_login(LoginMode::Browser).unwrap();
    wait_for(&h, |s| s["auth"]["phase"] == "awaiting_browser");
    h.cancel_login().unwrap();
    let s = wait(&h);
    assert_eq!(s["auth"]["status"], "signed_out");
    assert!(!grok_home(&cfg).join("fixture-signed").exists());

    std::fs::remove_file(grok_home(&cfg).join("fixture-login-wait")).unwrap();
    h.begin_login(LoginMode::DeviceAuth).unwrap();
    let s = wait_for(&h, |s| s["auth"]["device"]["userCode"].is_string());
    assert_eq!(s["auth"]["phase"], "awaiting_device_authorization");
    assert_eq!(
        s["auth"]["device"]["verificationUri"],
        "https://accounts.x.ai/device"
    );
    assert_eq!(s["auth"]["device"]["userCode"], "WXYZ-2345");
    assert!(!s.to_string().contains("secret-token"));
    assert!(!s.to_string().contains("evil.example"));
    mark(&cfg, "fixture-device-approve");
    let s = wait(&h);
    assert_eq!(s["providerStatus"], "ready", "{s}");
    assert_eq!(s["auth"]["status"], "signed_in");
    assert!(s["auth"]["device"].is_null());
}

#[test]
fn grok_home_is_app_owned_and_user_home_unused() {
    // The fixture exits 98 if this reaches the child, so a completed turn proves it is not forwarded.
    std::env::set_var("XAI_API_KEY", "fixture-must-not-forward");
    let d = OwnedDir::new();
    let cfg = config(&d);
    let mut h = ready(&cfg);
    let s = turn(&mut h, "g1", "hi");
    assert_eq!(s["turn"]["status"], "completed", "{s}");
    let profile = canon(&cfg.profile);
    let user_homes: Vec<PathBuf> = ["HOME", "USERPROFILE"]
        .iter()
        .filter_map(|k| std::env::var_os(k))
        .filter_map(|p| PathBuf::from(p).canonicalize().ok())
        .collect();
    for name in ["fixture-env-version.json", "fixture-env-agent.json"] {
        let env: Value =
            serde_json::from_slice(&std::fs::read(grok_home(&cfg).join(name)).unwrap()).unwrap();
        let path = |k: &str| canon(env[k].as_str().unwrap_or_else(|| panic!("{name} {k}")));
        assert_eq!(path("GROK_HOME"), profile.join(".grok"), "{name}");
        assert_eq!(path("HOME"), profile);
        assert_eq!(path("USERPROFILE"), profile);
        assert!(path("APPDATA").starts_with(&profile));
        assert!(path("LOCALAPPDATA").starts_with(&profile));
        assert_eq!(path("cwd"), canon(&cfg.cwd));
        assert!(env["HOMEDRIVE"].is_null() && env["HOMEPATH"].is_null());
        for home in &user_homes {
            assert_ne!(&path("HOME"), home);
            assert_ne!(&path("GROK_HOME"), &home.join(".grok"));
        }
    }
}

#[test]
fn profile_lease_survives_drop_until_child_cleanup() {
    let d = OwnedDir::new();
    let cfg = config(&d);
    let mut h = ready(&cfg);
    assert!(matches!(GrokHost::new(cfg.clone()), Err("profile_in_use")));
    h.send("w1".into(), "SILENT".into()).unwrap();
    std::thread::sleep(Duration::from_millis(200));
    drop(h);
    let start = Instant::now();
    loop {
        match GrokHost::new(cfg.clone()) {
            Ok(h) => {
                assert_eq!(h.state()["auth"]["status"], "signed_out");
                break;
            }
            Err("profile_in_use") => {
                assert!(start.elapsed() < Duration::from_secs(5));
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(e) => panic!("{e}"),
        }
    }
}

#[test]
fn long_unicode_prompt_roundtrips_without_truncation() {
    let d = OwnedDir::new();
    let mut h = ready(&config(&d));
    let prompt = "한글".repeat(20_000) + "END";
    let s = turn(&mut h, "long", &prompt);
    assert_eq!(s["turn"]["status"], "completed", "{s}");
    assert_eq!(s["turn"]["text"], format!("응답: {prompt}"));
}
