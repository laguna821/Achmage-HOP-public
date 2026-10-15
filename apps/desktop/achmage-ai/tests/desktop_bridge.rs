//! End-to-end IPC projection against an owned child fixture; no provider login/network.
use hangul_ai_session::{
    bridge::{Action, Host},
    process::LaunchConfig,
};
use serde_json::Value;
use std::{
    path::PathBuf,
    thread,
    time::{Duration, Instant},
};

fn config(mode: &str) -> LaunchConfig {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let cwd = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let home = cwd.join("target/bridge-fixtures").join(format!(
        "{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&home).unwrap();
    let mut cfg = LaunchConfig::codex(PathBuf::from(env!("CARGO_BIN_EXE_auth_fixture")), cwd, home);
    cfg.args = vec![mode.into()];
    cfg.cancel_grace = Duration::from_millis(30);
    cfg.handshake_timeout = Duration::from_secs(2);
    cfg
}
fn act(h: &mut Host, a: Action) -> Value {
    let generation = h.state()["generation"].as_u64().unwrap();
    h.action(generation, a).unwrap()
}
fn until(h: &mut Host, done: impl Fn(&Value) -> bool) -> Value {
    let end = Instant::now() + Duration::from_secs(6);
    loop {
        let v = h.state();
        assert!(!v.to_string().contains("FIXTURE_DISPLAY_SECRET"));
        assert!(!v.to_string().contains("FIXTURE_ERROR_SECRET"));
        if done(&v) {
            return v;
        }
        assert!(Instant::now() < end, "bridge state did not settle: {v}");
        thread::sleep(Duration::from_millis(3));
    }
}
fn login(h: &mut Host) {
    act(h, Action::BeginLogin {});
    until(h, |v| {
        v["auth"]["status"] == "signed_in"
            && v["busy"] == false
            && v["modelCatalogStatus"] == "ready"
    });
}
fn send(h: &mut Host, id: &str) -> Value {
    act(
        h,
        Action::Send {
            prompt: "소유 fixture 문단".into(),
            request_id: id.into(),
            model: Some("fixture-model".into()),
            reasoning_effort: None,
        },
    )
}

#[test]
fn persistent_connection_restores_without_another_browser_login() {
    let mut cfg = config("existing-session");
    cfg.persistent_auth = true;
    let mut first = Host::new(Some(cfg.clone()));
    act(&mut first, Action::RestoreConnection {});
    until(&mut first, |v| v["auth"]["status"] == "signed_in");
    assert!(first.take_login_url().is_none());
    drop(first);
    let mut restarted = Host::new(Some(cfg));
    act(&mut restarted, Action::RestoreConnection {});
    let state = until(&mut restarted, |v| v["auth"]["status"] == "signed_in");
    assert_eq!(
        state["sessionPersistence"],
        if cfg!(target_os = "linux") { "provider_file" } else { "provider_keyring" }
    );
    assert!(restarted.take_login_url().is_none());
}

#[test]
fn signed_out_restore_does_not_open_browser() {
    let mut cfg = config("signed-out-resume");
    cfg.persistent_auth = true;
    let mut h = Host::new(Some(cfg));
    act(&mut h, Action::RestoreConnection {});
    let state = until(&mut h, |v| {
        v["auth"]["phase"] == "signed_out" && v["busy"] == false
    });
    assert_eq!(state["auth"]["status"], "signed_out");
    assert!(h.take_login_url().is_none());
}

#[test]
fn runtime_environment_failure_has_a_safe_actionable_category() {
    let mut h = Host::new(Some(config("environment-error")));
    act(&mut h, Action::BeginLogin {});
    let state = until(&mut h, |v| v["auth"]["status"] == "error");
    assert_eq!(state["auth"]["errorCode"], "runtime_environment");
    assert!(
        state["auth"]["message"]
            .as_str()
            .unwrap()
            .contains("운영체제")
    );
}

#[test]
fn completed_response_is_bound_to_latest_request_then_logout_clears_it() {
    let mut h = Host::new(Some(config("success")));
    login(&mut h);
    send(&mut h, "request-one");
    let first = until(&mut h, |v| v["turn"]["status"] == "completed");
    assert_eq!(first["turn"]["requestId"], "request-one");
    assert_eq!(first["turn"]["text"], "시험 프로세스 응답");
    let pending = send(&mut h, "request-two");
    assert_eq!(pending["turn"]["requestId"], "request-two");
    if pending["turn"]["status"] == "running" {
        assert_eq!(pending["turn"]["text"], "");
    }
    let second = until(&mut h, |v| v["turn"]["status"] == "completed");
    assert_eq!(second["turn"]["requestId"], "request-two");
    act(&mut h, Action::Logout {});
    let out = until(&mut h, |v| {
        v["auth"]["status"] == "signed_out" && v["busy"] == false
    });
    assert_eq!(out["turn"]["status"], "idle");
    assert!(out["usage"]["inputTokens"].is_null());
}

#[test]
fn cancel_login_discards_official_browser_url_and_late_success() {
    let mut h = Host::new(Some(config("late-success")));
    act(&mut h, Action::BeginLogin {});
    until(&mut h, |v| v["auth"]["status"] == "pending");
    let end = Instant::now() + Duration::from_secs(3);
    loop {
        h.state();
        if let Some(url) = h.take_login_url() {
            assert!(url.starts_with("https://auth.openai.com/"));
            break;
        }
        assert!(Instant::now() < end);
        thread::sleep(Duration::from_millis(3));
    }
    act(&mut h, Action::CancelLogin {});
    until(&mut h, |v| {
        v["auth"]["status"] == "signed_out" && v["busy"] == false
    });
    assert!(h.take_login_url().is_none());
}

#[test]
fn cancellation_keeps_request_binding_and_blocks_late_text() {
    let mut h = Host::new(Some(config("turn-await")));
    login(&mut h);
    send(&mut h, "cancel-me");
    until(&mut h, |v| v["turn"]["text"] == "대기");
    let generation = h.state()["generation"].as_u64().unwrap();
    assert!(
        h.action(
            generation,
            Action::CancelTurn {
                turn_id: "old-request".into()
            }
        )
        .is_err()
    );
    act(
        &mut h,
        Action::CancelTurn {
            turn_id: "cancel-me".into(),
        },
    );
    let done = until(&mut h, |v| {
        v["turn"]["status"] == "cancelled" && v["busy"] == false
    });
    assert_eq!(done["turn"]["requestId"], "cancel-me");
    assert_eq!(done["turn"]["text"], "대기");
}

#[test]
fn invalid_executable_reports_error_instead_of_silent_signed_out() {
    let mut cfg = config("success");
    cfg.executable = PathBuf::from("relative-invalid.exe");
    let mut h = Host::new(Some(cfg));
    act(&mut h, Action::BeginLogin {});
    let failed = until(&mut h, |v| v["auth"]["status"] == "error");
    assert!(failed["notice"].as_str().is_some_and(|s| !s.is_empty()));
}

#[test]
fn cancel_after_backend_completion_cannot_revert_response_to_running() {
    let mut h = Host::new(Some(config("success")));
    login(&mut h);
    send(&mut h, "completed-before-cancel");
    until(&mut h, |v| v["turn"]["status"] == "completed");
    act(
        &mut h,
        Action::CancelTurn {
            turn_id: "completed-before-cancel".into(),
        },
    );
    let state = until(&mut h, |v| v["commandPending"] == false);
    assert_eq!(state["turn"]["status"], "completed");
    assert_eq!(state["turn"]["text"], "시험 프로세스 응답");
    assert_eq!(state["turn"]["requestId"], "completed-before-cancel");
    send(&mut h, "next-request");
    until(&mut h, |v| v["turn"]["status"] == "completed");
}

#[test]
fn asynchronous_account_loss_removes_completed_response_and_session_binding() {
    let mut h = Host::new(Some(config("auth-dies-after-login")));
    login(&mut h);
    let session = h.state()["auth"]["sessionGeneration"].clone();
    assert!(session.is_string());
    send(&mut h, "before-account-loss");
    until(&mut h, |v| v["turn"]["status"] == "completed");
    let lost = until(&mut h, |v| v["auth"]["status"] != "signed_in");
    assert!(lost["auth"]["sessionGeneration"].is_null());
    assert_eq!(lost["turn"]["status"], "idle");
    assert!(lost["turn"]["text"].is_null());
}

#[test]
fn failed_turn_has_safe_message_category_and_stage_without_provider_details() {
    for (mode, code, stage) in [
        ("turn-failed", "context_limit", "response"),
        ("turn-unknown-failed", "provider_failed", "response"),
        ("turn-notice-failed", "rate_limit", "response"),
        ("thread-rejected", "invalid_request", "thread_start"),
    ] {
        let mut h = Host::new(Some(config(mode)));
        login(&mut h);
        send(&mut h, "safe-failure");
        let state = until(&mut h, |v| v["turn"]["status"] == "error");
        assert_eq!(state["auth"]["status"], "signed_in");
        assert_eq!(state["turn"]["errorCode"], code);
        assert_eq!(state["turn"]["errorStage"], stage);
        assert!(!state["turn"]["message"].as_str().unwrap().is_empty());
        assert_eq!(state["turn"]["retryPolicy"], "manual");
        assert_eq!(state["turn"]["text"], "");
        let transport=state["turn"]["transport"].as_object().unwrap();
        let mut keys=transport.keys().map(String::as_str).collect::<Vec<_>>();keys.sort();
        assert_eq!(keys,vec!["deniedRequests","fault","ignoredNotifications","settled","stderrBytes","stdoutBytes"]);
        assert!(transport["stdoutBytes"].as_u64().unwrap()>0);
        assert!(transport["stderrBytes"].is_u64());
        assert!(transport["settled"].is_boolean());
    }
}
#[test]
fn retry_notification_does_not_fail_successful_turn_or_retain_error() {
    let mut h = Host::new(Some(config("turn-notice-recovered")));
    login(&mut h);
    send(&mut h, "retry-recovered");
    let state = until(&mut h, |v| v["turn"]["status"] == "completed");
    assert_eq!(state["turn"]["text"], "시험 프로세스 응답");
    assert!(state["turn"]["errorCode"].is_null());
    assert!(state["turn"]["message"].is_null());
}

#[test]
fn official_catalog_default_and_supported_effort_reach_owned_child() {
    let mut h = Host::new(Some(config("effort-high")));
    login(&mut h);
    let state = h.state();
    assert_eq!(state["models"][0]["id"], "fixture-model");
    assert_eq!(state["models"][0]["isDefault"], true);
    act(
        &mut h,
        Action::Send {
            prompt: "Fixture reasoning request".into(),
            request_id: "catalog-turn".into(),
            model: None,
            reasoning_effort: Some("high".into()),
        },
    );
    let state = until(&mut h, |v| v["turn"]["status"] == "completed");
    assert_eq!(state["turn"]["text"], "시험 프로세스 응답");
    act(&mut h, Action::Logout {});
    let state = until(&mut h, |v| v["auth"]["status"] == "signed_out");
    assert_eq!(state["models"].as_array().unwrap().len(), 0);
}
#[test]
fn unknown_model_or_unadvertised_effort_are_rejected_before_turn() {
    let mut h = Host::new(Some(config("success")));
    login(&mut h);
    for (model, effort) in [("invented-model", "high"), ("fixture-model", "ultra")] {
        let generation = h.state()["generation"].as_u64().unwrap();
        assert!(
            h.action(
                generation,
                Action::Send {
                    prompt: "must not dispatch".into(),
                    request_id: "invalid-catalog".into(),
                    model: Some(model.into()),
                    reasoning_effort: Some(effort.into())
                }
            )
            .is_err()
        );
        assert_eq!(h.state()["turn"]["status"], "idle");
    }
    act(&mut h, Action::RefreshModels {});
    until(&mut h, |v| {
        v["modelCatalogStatus"] == "ready" && !v["commandPending"].as_bool().unwrap()
    });
}
#[test]
fn catalog_failure_does_not_claim_login_failure_or_invent_models() {
    let mut h = Host::new(Some(config("catalog-error")));
    act(&mut h, Action::BeginLogin {});
    let state = until(&mut h, |v| v["modelCatalogStatus"] == "error");
    assert_eq!(state["auth"]["status"], "signed_in");
    assert_eq!(state["modelCatalogErrorCode"], "catalog_rejected");
    assert!(state["models"].as_array().unwrap().is_empty());
    let generation = state["generation"].as_u64().unwrap();
    assert!(
        h.action(
            generation,
            Action::Send {
                prompt: "not dispatched".into(),
                request_id: "no-catalog".into(),
                model: None,
                reasoning_effort: None
            }
        )
        .is_err()
    );
}

#[test]
fn installed_desktop_catalog_default_and_ultra_are_sent_by_official_schema() {
    let mut h=Host::new(Some(config("desktop-catalog-ultra")));
    login(&mut h);
    let state=h.state();
    assert_eq!(state["models"].as_array().unwrap().len(),8);
    assert_eq!(state["models"][0]["id"],"gpt-6.1-sol");
    act(&mut h,Action::Send{prompt:"Synthetic input, no real inference".into(),request_id:"desktop-ultra".into(),model:None,reasoning_effort:Some("ultra".into())});
    until(&mut h,|v|v["turn"]["status"]=="completed");
    let generation=h.state()["generation"].as_u64().unwrap();
    assert!(h.action(generation,Action::Send{prompt:"must reject".into(),request_id:"luna-ultra".into(),model:Some("gpt-6-luna".into()),reasoning_effort:Some("ultra".into())}).is_err());
}
