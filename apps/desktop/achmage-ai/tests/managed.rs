use hangul_ai_session::{managed::*, process::*, *};
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};

#[test]
fn repeated_logout_does_not_duplicate_provider_request() {
    let (mut c, mut a) = default_ready("success");
    connected(&mut c, &mut a);
    a.logout(&mut c).unwrap();
    a.logout(&mut c).unwrap();
    let v = until(&mut c, &mut a, |_, v| v.active_process.is_none());
    assert_eq!(v.status, AuthStatus::LoggedOut);
    assert!(v.provider_logout_confirmed);
}
#[test]
fn other_coordinator_cannot_logout_managed_session() {
    let (mut c, mut a) = default_ready("success");
    connected(&mut c, &mut a);
    let mut foreign = Coordinator::new(id("codex"), id("host-fixture")).unwrap();
    let before = foreign.view();
    assert_eq!(a.logout(&mut foreign), Err(Error::BindingMismatch));
    assert_eq!(foreign.view(), before);
    assert_eq!(a.auth_view().status, AuthStatus::Connected);
    assert_eq!(
        a.pump(&mut foreign, Duration::ZERO).fault,
        Some(ProcessFault::StaleCoordinator)
    );
    assert_eq!(foreign.view(), before);
    assert_eq!(a.pump(&mut c, Duration::ZERO).status, AuthStatus::Connected);
}
fn id(s: &str) -> Id {
    Id::new(s).unwrap()
}
fn ready(mode: &str, method: LoginMethod, timeout: Duration) -> (Coordinator, ManagedCodexAdapter) {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let cwd = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let home = cwd.join("target").join("auth-fixtures").join(format!(
        "{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&home).unwrap();
    let mut cfg = LaunchConfig::codex(PathBuf::from(env!("CARGO_BIN_EXE_auth_fixture")), cwd, home);
    cfg.args = vec![mode.into()];
    cfg.cancel_grace = Duration::from_millis(30);
    cfg.handshake_timeout = Duration::from_secs(2);
    (
        Coordinator::new(id("codex"), id("host-fixture")).unwrap(),
        ManagedCodexAdapter::new(id("codex"), id("host-fixture"), cfg, method, timeout).unwrap(),
    )
}
fn default_ready(mode: &str) -> (Coordinator, ManagedCodexAdapter) {
    ready(mode, LoginMethod::Browser, Duration::from_secs(3))
}
#[test]
fn contradictory_cancel_response_never_confirms() {
    let (mut c, mut a) = default_ready("cancel-malformed");
    let t = c.begin_login(&mut a, None).unwrap();
    until(&mut c, &mut a, |_, v| v.action_available);
    c.cancel_login(&mut a, &t).unwrap();
    let v = retired(&mut c, &mut a);
    assert!(!v.cancel_response_confirmed);
    assert!(c.view().selected_account.is_none());
}
#[test]
fn cancel_notfound_or_missing_status_does_not_confirm_cancellation() {
    for mode in ["cancel-notfound", "cancel-empty"] {
        let (mut c, mut a) = default_ready(mode);
        let t = c.begin_login(&mut a, None).unwrap();
        until(&mut c, &mut a, |_, v| v.action_available);
        c.cancel_login(&mut a, &t).unwrap();
        let v = retired(&mut c, &mut a);
        assert!(!v.cancel_response_confirmed, "{mode}");
        assert!(c.view().selected_account.is_none());
    }
}
fn until(
    c: &mut Coordinator,
    a: &mut ManagedCodexAdapter,
    done: impl Fn(&Coordinator, &AuthView) -> bool,
) -> AuthView {
    let end = Instant::now() + Duration::from_secs(5);
    loop {
        let v = a.pump(c, Duration::from_millis(5));
        if done(c, &v) {
            return v;
        }
        assert!(Instant::now() < end, "{v:?}");
    }
}
fn connected(c: &mut Coordinator, a: &mut ManagedCodexAdapter) {
    c.begin_login(a, None).unwrap();
    until(c, a, |c, v| {
        c.view().login.status == LoginStatus::Connected && v.status == AuthStatus::Connected
    });
}
fn retired(c: &mut Coordinator, a: &mut ManagedCodexAdapter) -> AuthView {
    until(c, a, |_, v| v.pending_process.is_none())
}
#[test]
fn browser_prompt_only_explicit_display_not_debug_or_state() {
    let (mut c, mut a) = default_ready("await");
    let t = c.begin_login(&mut a, None).unwrap();
    until(&mut c, &mut a, |_, v| v.action_available);
    let prompt = a.take_prompt().unwrap();
    assert!(!format!("{prompt:?}").contains("FIXTURE_DISPLAY_SECRET"));
    assert!(
        !serde_json::to_string(&a.auth_view())
            .unwrap()
            .contains("FIXTURE_DISPLAY_SECRET")
    );
    prompt.with_user_display(|m, url, code| {
        assert_eq!(m, LoginMethod::Browser);
        assert!(url.contains("FIXTURE_DISPLAY_SECRET"));
        assert_eq!(code, None);
    });
    c.cancel_login(&mut a, &t).unwrap();
    let v = retired(&mut c, &mut a);
    assert_eq!(v.status, AuthStatus::Cancelled);
    assert!(c.view().selected_account.is_none());
}
#[test]
fn device_code_is_explicit_not_log() {
    let (mut c, mut a) = ready("await", LoginMethod::DeviceCode, Duration::from_secs(3));
    let t = c.begin_login(&mut a, None).unwrap();
    until(&mut c, &mut a, |_, v| v.action_available);
    a.take_prompt().unwrap().with_user_display(|m, _, code| {
        assert_eq!(m, LoginMethod::DeviceCode);
        assert_eq!(code, Some("ABCD-1234"));
    });
    c.cancel_login(&mut a, &t).unwrap();
    retired(&mut c, &mut a);
}
#[test]
fn managed_success_then_existing_turn_adapter_without_secret() {
    let (mut c, mut a) = default_ready("success");
    connected(&mut c, &mut a);
    assert_eq!(
        c.view().credential_persistence,
        Persistence::ProviderManaged
    );
    let v = serde_json::to_string(&a.auth_view()).unwrap();
    assert!(!v.contains("fixture@example.invalid"));
    assert!(!v.contains("FIXTURE_DISPLAY_SECRET"));
    c.start_turn(
        &mut a,
        TurnRequest {
            reasoning_effort: None,
            model_id: id("fixture-model"),
            prompt: "시험".into(),
        },
    )
    .unwrap();
    until(&mut c, &mut a, |c, _| {
        c.view()
            .turn
            .as_ref()
            .is_some_and(|t| t.status == TurnStatus::Completed)
    });
    assert_eq!(c.view().turn.unwrap().text, "시험 프로세스 응답");
    assert!(!a.turn_process_view().unwrap().credentials_forwarded);
    a.logout(&mut c).unwrap();
    until(&mut c, &mut a, |_, v| {
        v.provider_logout_confirmed && v.active_process.is_none()
    });
}
#[test]
fn matching_completion_before_start_reply_is_handled() {
    let (mut c, mut a) = default_ready("early");
    connected(&mut c, &mut a);
    assert!(c.view().selected_account.is_some());
}
#[test]
fn success_notification_without_account_is_not_login() {
    let (mut c, mut a) = default_ready("account-null");
    c.begin_login(&mut a, None).unwrap();
    retired(&mut c, &mut a);
    assert_eq!(c.view().login.status, LoginStatus::Failed);
    assert!(c.view().selected_account.is_none());
}
#[test]
fn wrong_login_id_is_rejected() {
    let (mut c, mut a) = default_ready("wrong-id");
    c.begin_login(&mut a, None).unwrap();
    let v = retired(&mut c, &mut a);
    assert_eq!(v.fault, Some(ProcessFault::Protocol));
    assert!(c.view().selected_account.is_none());
}
#[test]
fn failed_relogin_preserves_old_account() {
    let (mut c, mut a) = default_ready("second-fails");
    connected(&mut c, &mut a);
    let old = c.view().selected_account.unwrap();
    c.begin_login(&mut a, None).unwrap();
    retired(&mut c, &mut a);
    assert_eq!(c.view().selected_account, Some(old));
    assert_eq!(c.view().login.status, LoginStatus::Failed);
}
#[test]
fn wrong_reauthentication_identity_preserves_old_account() {
    let (mut c, mut a) = default_ready("second-different");
    connected(&mut c, &mut a);
    let old = c.view().selected_account.unwrap();
    c.begin_login(&mut a, Some(old.account_id.clone())).unwrap();
    let v = retired(&mut c, &mut a);
    assert_eq!(v.fault, Some(ProcessFault::Protocol));
    assert_eq!(c.view().selected_account, Some(old));
}
#[test]
fn cancellation_fences_late_success() {
    let (mut c, mut a) = default_ready("late-success");
    let t = c.begin_login(&mut a, None).unwrap();
    until(&mut c, &mut a, |_, v| v.action_available);
    c.cancel_login(&mut a, &t).unwrap();
    let v = retired(&mut c, &mut a);
    assert!(v.cancel_response_confirmed);
    assert_eq!(c.view().login.status, LoginStatus::Cancelled);
    assert!(c.view().selected_account.is_none());
    assert!(a.take_prompt().is_none());
}
#[test]
fn expire_fences_late_completion() {
    let (mut c, mut a) = ready(
        "late-success",
        LoginMethod::Browser,
        Duration::from_millis(100),
    );
    c.begin_login(&mut a, None).unwrap();
    let v = retired(&mut c, &mut a);
    assert_eq!(v.status, AuthStatus::Expired);
    assert_eq!(c.view().login.status, LoginStatus::Expired);
    assert!(c.view().selected_account.is_none());
}
#[test]
fn early_cancel_kills_only_pending_child() {
    let (mut c, mut a) = default_ready("await");
    let t = c.begin_login(&mut a, None).unwrap();
    c.cancel_login(&mut a, &t).unwrap();
    let v = retired(&mut c, &mut a);
    assert_eq!(v.status, AuthStatus::Cancelled);
}
#[test]
fn logout_requires_rpc_and_account_read_null() {
    let (mut c, mut a) = default_ready("success");
    connected(&mut c, &mut a);
    a.logout(&mut c).unwrap();
    assert!(c.view().selected_account.is_none());
    assert!(!a.auth_view().provider_logout_confirmed);
    let v = until(&mut c, &mut a, |_, v| v.active_process.is_none());
    assert_eq!(v.status, AuthStatus::LoggedOut);
    assert!(v.provider_logout_confirmed);
}
#[test]
fn logout_failure_never_restores_local_account() {
    for mode in ["logout-fail", "logout-still-account"] {
        let (mut c, mut a) = default_ready(mode);
        connected(&mut c, &mut a);
        a.logout(&mut c).unwrap();
        let v = until(&mut c, &mut a, |_, v| v.active_process.is_none());
        assert_eq!(v.status, AuthStatus::LogoutUnconfirmed);
        assert!(!v.provider_logout_confirmed);
        assert!(c.view().selected_account.is_none());
    }
}
#[test]
fn unsafe_auth_urls_fail_closed() {
    for mode in [
        "url-http",
        "url-evil",
        "url-userinfo",
        "url-backslash",
        "url-javascript",
    ] {
        let (mut c, mut a) = default_ready(mode);
        c.begin_login(&mut a, None).unwrap();
        retired(&mut c, &mut a);
        assert_eq!(c.view().login.status, LoginStatus::Failed);
        assert!(a.take_prompt().is_none());
    }
}
#[test]
fn provider_error_text_not_exported() {
    let (mut c, mut a) = default_ready("failed");
    c.begin_login(&mut a, None).unwrap();
    retired(&mut c, &mut a);
    let text = format!(
        "{c:?}{a:?}{}",
        serde_json::to_string(&a.auth_view()).unwrap()
    );
    assert!(!text.contains("FIXTURE_ERROR_SECRET"));
}
#[test]
fn auth_eof_is_not_success() {
    let (mut c, mut a) = default_ready("eof");
    c.begin_login(&mut a, None).unwrap();
    let v = retired(&mut c, &mut a);
    assert_eq!(v.fault, Some(ProcessFault::UnexpectedEof));
    assert!(c.view().selected_account.is_none());
}
#[test]
fn unexpected_server_request_denied() {
    let (mut c, mut a) = default_ready("request");
    c.begin_login(&mut a, None).unwrap();
    let v = retired(&mut c, &mut a);
    assert_eq!(v.fault, Some(ProcessFault::UnsupportedTool));
}
#[test]
fn reauthentication_success_keeps_opaque_account_identity() {
    let (mut c, mut a) = default_ready("success");
    connected(&mut c, &mut a);
    let old = c.view().selected_account.unwrap();
    let generation = c.view().account_generation;
    c.begin_login(&mut a, Some(old.account_id.clone())).unwrap();
    until(&mut c, &mut a, |c, v| {
        c.view().account_generation > generation && v.status == AuthStatus::Connected
    });
    assert_eq!(c.view().selected_account, Some(old));
}
