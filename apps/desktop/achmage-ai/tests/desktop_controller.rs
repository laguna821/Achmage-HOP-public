// Exercise the same exported controller/review types used by native IPC.
use hangul_ai_session::{controller::*, review as ai_review};
use hangul_ai_session::{managed::*, process::*, *};
use std::{
    path::PathBuf,
    thread,
    time::{Duration, Instant},
};
fn id(s: &str) -> Id {
    Id::new(s).unwrap()
}
fn config(mode: &str) -> LaunchConfig {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let cwd = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let home = cwd.join("target/desktop-fixtures").join(format!(
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
fn controller(mode: &str) -> DesktopAiController {
    DesktopAiController::new(
        id("codex"),
        id("desktop-fixture"),
        config(mode),
        LoginMethod::Browser,
        Duration::from_secs(3),
    )
    .unwrap()
}
fn until(c: &mut DesktopAiController, done: impl Fn(&DesktopAiUpdate) -> bool) -> DesktopAiUpdate {
    let end = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(u) = c.poll() {
            if done(&u) {
                return u;
            }
        }
        assert!(Instant::now() < end, "desktop controller timed out");
        thread::sleep(Duration::from_millis(2));
    }
}
fn login(c: &mut DesktopAiController) -> DesktopAiUpdate {
    c.login(None).unwrap();
    until(c, |u| {
        u.view.coordinator.login.status == LoginStatus::Connected
    })
}
#[test]
fn successful_login_turn_and_logout_are_separate_dispatch_and_outcome() {
    let mut c = controller("success");
    let v = login(&mut c);
    assert_eq!(v.view.last_command.unwrap().result, Ok(()));
    c.send(id("fixture-model"), "본문 보내기 시험".into())
        .unwrap();
    let v = until(&mut c, |u| {
        u.view
            .coordinator
            .turn
            .as_ref()
            .is_some_and(|t| t.status == TurnStatus::Completed)
    });
    assert_eq!(v.view.coordinator.turn.unwrap().text, "시험 프로세스 응답");
    assert!(!v.view.turn_process.unwrap().credentials_forwarded);
    c.logout().unwrap();
    let v = until(&mut c, |u| {
        u.view
            .auth
            .as_ref()
            .is_some_and(|a| a.provider_logout_confirmed)
    });
    assert!(v.view.coordinator.selected_account.is_none());
}
#[test]
fn bounded_command_gate_waits_for_ui_ack_not_just_worker() {
    let mut c = controller("await");
    c.login(None).unwrap();
    assert!(c.command_pending());
    thread::sleep(Duration::from_millis(60));
    assert_eq!(c.logout(), Err(DesktopAiError::Busy));
    until(&mut c, |u| u.view.last_command.is_some());
    assert!(!c.command_pending());
    c.cancel_login().unwrap();
    until(&mut c, |u| {
        u.view.coordinator.login.status == LoginStatus::Cancelled
    });
}
#[test]
fn prompt_is_redacted_retained_until_polled_and_cleared_on_cancel() {
    let mut c = controller("late-success");
    c.login(None).unwrap();
    thread::sleep(Duration::from_millis(100));
    let v = until(&mut c, |u| u.prompt.is_some());
    assert!(!format!("{v:?}").contains("FIXTURE_DISPLAY_SECRET"));
    v.prompt
        .unwrap()
        .with_user_display(|_, url, _| assert!(url.contains("FIXTURE_DISPLAY_SECRET")));
    c.cancel_login().unwrap();
    let v = until(&mut c, |u| {
        u.view.coordinator.login.status == LoginStatus::Cancelled
    });
    assert!(v.prompt.is_none());
    assert!(v.view.coordinator.selected_account.is_none());
    let v = until(&mut c, |u| {
        u.view
            .auth
            .as_ref()
            .is_some_and(|a| a.pending_process.is_none())
    });
    assert!(v.prompt.is_none());
    assert!(v.view.coordinator.selected_account.is_none());
}
#[test]
fn turn_cancel_fences_late_text_and_tracks_direct_child_settlement() {
    let mut c = controller("turn-await");
    login(&mut c);
    c.send(id("fixture-model"), "한글 원문\n".repeat(50_000)).unwrap();
    until(&mut c, |u| {
        u.view
            .coordinator
            .turn
            .as_ref()
            .is_some_and(|t| t.status == TurnStatus::Streaming)
    });
    c.cancel_turn().unwrap();
    let u = until(&mut c, |u| {
        u.view.turn_process.as_ref().is_some_and(|p| p.settled)
    });
    let t = u.view.coordinator.turn.unwrap();
    assert_eq!(t.status, TurnStatus::Cancelled);
    assert_eq!(t.text, "대기");
    assert_eq!(t.cancellation, Cancellation::Acknowledged);
}
#[test]
fn dispatch_without_account_reports_session_error_and_recovers() {
    let mut c = controller("success");
    c.send(id("fixture-model"), "시험".into()).unwrap();
    let u = until(&mut c, |u| u.view.last_command.is_some());
    assert_eq!(
        u.view.last_command.unwrap().result,
        Err(DesktopAiError::Session(Error::NoAccount))
    );
    login(&mut c);
}
#[test]
fn empty_prompt_rejected_long_prompt_crosses_process_and_debug_omits_response_text() {
    let mut c = controller("long-prompt");
    assert_eq!(
        c.send(id("fixture-model"), "".into()),
        Err(DesktopAiError::InvalidPrompt)
    );
    assert!(!c.command_pending());
    login(&mut c);
    c.send(id("fixture-model"), "한글 원문\n".repeat(50_000)).unwrap();
    let u = until(&mut c, |u| {
        u.view
            .coordinator
            .turn
            .as_ref()
            .is_some_and(|t| t.status == TurnStatus::Completed)
    });
    assert!(!format!("{u:?}").contains("시험 프로세스 응답"));
}
#[test]
fn invalid_configuration_reports_fatal_without_provider_launch() {
    let mut cfg = config("success");
    cfg.executable = PathBuf::from("relative-forbidden.exe");
    let mut c = DesktopAiController::new(
        id("codex"),
        id("desktop-fixture"),
        cfg,
        LoginMethod::Browser,
        Duration::from_secs(3),
    )
    .unwrap();
    let u = until(&mut c, |u| u.view.fatal.is_some());
    assert_eq!(
        u.view.fatal,
        Some(DesktopAiError::Process(ProcessFault::InvalidConfig))
    );
    assert!(u.view.auth.is_none());
}
#[test]
fn shutdown_is_nonblocking_and_worker_owns_cleanup() {
    let mut c = controller("await");
    c.login(None).unwrap();
    until(&mut c, |u| u.prompt.is_some());
    let start = Instant::now();
    c.shutdown();
    assert!(start.elapsed() < Duration::from_millis(50));
    assert_eq!(c.login(None), Err(DesktopAiError::Closed));
    let end = Instant::now() + Duration::from_secs(3);
    while c.worker_running() {
        assert!(Instant::now() < end);
        thread::sleep(Duration::from_millis(5));
    }
    let u = c.poll().unwrap();
    assert!(!u.view.worker_running);
    assert!(u.prompt.is_none());
}
#[test]
fn failed_reauthentication_preserves_selected_account() {
    let mut c = controller("second-fails");
    let old = login(&mut c).view.coordinator.selected_account;
    c.login(None).unwrap();
    let u = until(&mut c, |u| {
        u.view.coordinator.login.status == LoginStatus::Failed
    });
    assert_eq!(u.view.coordinator.selected_account, old);
}
fn completed_fixture_turn(c: &mut DesktopAiController) -> DesktopAiUpdate {
    c.send(id("fixture-model"), "시험".into()).unwrap();
    until(c, |u| {
        u.view
            .coordinator
            .turn
            .as_ref()
            .is_some_and(|t| t.status == TurnStatus::Completed)
            && u.view.turn_process.as_ref().is_some_and(|p| p.settled)
    })
}
#[test]
fn review_fence_accepts_only_new_command_ticket_after_old_completed_turn() {
    let mut c = controller("success");
    login(&mut c);
    let old = completed_fixture_turn(&mut c).view;
    let previous = old.coordinator.turn.as_ref().unwrap();
    let command = c.send(id("fixture-model"), "새 문단 요청".into()).unwrap();
    let mut fence = ai_review::ReviewFence::new(command, Some(previous.ticket.clone()));
    fence.observe(&old);
    assert!(!fence.permits(previous));
    let fresh = until(&mut c, |u| {
        u.view.last_command.is_some_and(|o| o.id == command)
            && u.view
                .coordinator
                .turn
                .as_ref()
                .is_some_and(|t| t.status == TurnStatus::Completed)
    })
    .view;
    let current = fresh.coordinator.turn.as_ref().unwrap();
    assert_ne!(previous.ticket, current.ticket);
    assert!(
        !fence.permits(current),
        "unobserved dispatch must not grant review"
    );
    fence.observe(&fresh);
    assert!(fence.permits(current));
    fence.observe(&old); // Delayed older snapshot must not replace the accepted ticket.
    assert!(!fence.permits(previous));
    assert!(fence.permits(current));
}
#[test]
fn review_fence_rejects_old_completed_response_when_new_send_fails() {
    let mut c = controller("success");
    login(&mut c);
    let old = completed_fixture_turn(&mut c).view;
    let previous = old.coordinator.turn.as_ref().unwrap();
    c.logout().unwrap();
    until(&mut c, |u| {
        u.view
            .auth
            .as_ref()
            .is_some_and(|a| a.provider_logout_confirmed)
    });
    let command = c
        .send(id("fixture-model"), "로그아웃 뒤 새 요청".into())
        .unwrap();
    let mut fence = ai_review::ReviewFence::new(command, Some(previous.ticket.clone()));
    fence.observe(&old);
    assert!(!fence.permits(previous));
    let failed = until(&mut c, |u| {
        u.view.last_command.is_some_and(|o| o.id == command)
    })
    .view;
    assert_eq!(
        failed.last_command.unwrap().result,
        Err(DesktopAiError::Session(Error::NoAccount))
    );
    assert_eq!(
        failed.coordinator.turn.as_ref().unwrap().ticket,
        previous.ticket
    );
    fence.observe(&failed);
    assert!(!fence.permits(failed.coordinator.turn.as_ref().unwrap()));
    fence.observe(&old);
    assert!(!fence.permits(previous));
}
