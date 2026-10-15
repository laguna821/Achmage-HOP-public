use achmage_runtime::login::*;
use std::{
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
fn options() -> LoginOptions {
    LoginOptions {
        timeout: Duration::from_secs(4),
        probe_interval: Duration::from_millis(100),
    }
}
#[test]
fn owned_pty_completion_is_probe_gated() {
    let cwd = tempfile::tempdir().unwrap();
    let mut phases = Vec::new();
    let mut probes = 0;
    let c = AtomicBool::new(false);
    let result = run_login(
        Path::new(env!("CARGO_BIN_EXE_pty_fixture")),
        cwd.path(),
        &c,
        options(),
        |p| phases.push(p),
        || {
            probes += 1;
            Ok(probes == 2)
        },
    )
    .unwrap();
    assert_eq!(result, LoginOutcome::Connected);
    assert_eq!(probes, 2);
    assert_eq!(phases.last(), Some(&LoginPhase::Stopping));
}
#[test]
fn owned_pty_cancel_wins_probe_success() {
    let cwd = tempfile::tempdir().unwrap();
    let c = AtomicBool::new(false);
    let result = run_login(
        Path::new(env!("CARGO_BIN_EXE_pty_fixture")),
        cwd.path(),
        &c,
        options(),
        |_| {},
        || {
            c.store(true, Ordering::SeqCst);
            Ok(true)
        },
    )
    .unwrap();
    assert_eq!(result, LoginOutcome::Cancelled);
}
#[test]
fn owned_pty_timeout_is_not_connection() {
    let cwd = tempfile::tempdir().unwrap();
    let c = AtomicBool::new(false);
    let result = run_login(
        Path::new(env!("CARGO_BIN_EXE_pty_fixture")),
        cwd.path(),
        &c,
        LoginOptions {
            timeout: Duration::from_millis(250),
            ..options()
        },
        |_| {},
        || Ok(false),
    )
    .unwrap();
    assert_eq!(result, LoginOutcome::TimedOut);
}
