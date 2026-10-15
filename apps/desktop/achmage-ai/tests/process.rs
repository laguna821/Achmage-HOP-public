use hangul_ai_session::{process::*, *};
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};
fn id(s: &str) -> Id {
    Id::new(s).unwrap()
}
struct IdentityFixture;
impl ProviderAdapter for IdentityFixture {
    fn provider_id(&self) -> &Id {
        static ID: std::sync::OnceLock<Id> = std::sync::OnceLock::new();
        ID.get_or_init(|| id("codex"))
    }
    fn host_id(&self) -> &Id {
        static ID: std::sync::OnceLock<Id> = std::sync::OnceLock::new();
        ID.get_or_init(|| id("fixture-host"))
    }
    fn start_login(&mut self, _: &LoginTicket, _: Option<&Id>) -> Result<(), ProviderError> {
        Ok(())
    }
    fn cancel_login(&mut self, _: &LoginTicket) -> Result<(), ProviderError> {
        Ok(())
    }
    fn start_turn(
        &mut self,
        _: &TurnTicket,
        _: &Secret,
        _: &TurnRequest,
    ) -> Result<(), ProviderError> {
        unreachable!()
    }
    fn cancel_turn(&mut self, _: &TurnTicket) -> Result<(), ProviderError> {
        Ok(())
    }
}
fn config(mode: &str) -> LaunchConfig {
    let cwd = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let home = cwd.join("target").join("process-fixtures").join(format!(
        "{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&home).unwrap();
    let mut c = LaunchConfig::codex(
        PathBuf::from(env!("CARGO_BIN_EXE_transport_fixture")),
        cwd.clone(),
        home,
    );
    c.args = vec![mode.into()];
    c.handshake_timeout = Duration::from_secs(2);
    c.turn_timeout = Duration::from_secs(3);
    c.cancel_grace = Duration::from_millis(30);
    c
}
#[test]
fn final_message_without_deltas_is_not_lost() {
    let (mut c, mut a, _) = ready("final-only");
    let v = settle(&mut c, &mut a);
    assert_eq!(v.fault, None);
    assert_eq!(c.view().turn.unwrap().text, "prefix");
}
#[test]
fn matching_final_message_is_not_duplicated() {
    let (mut c, mut a, _) = ready("final-match");
    let v = settle(&mut c, &mut a);
    assert_eq!(v.fault, None);
    assert_eq!(c.view().turn.unwrap().text, "prefix");
}
#[test]
fn mismatched_final_message_is_not_success() {
    let (mut c, mut a, _) = ready("final-mismatch");
    let v = settle(&mut c, &mut a);
    assert_eq!(v.fault, Some(ProcessFault::Protocol));
    assert_eq!(c.view().turn.unwrap().text, "prefix");
}
#[test]
fn response_limit_keeps_partial_text_and_fails() {
    let (mut c, mut a, _) = ready("response-limit");
    let v = settle(&mut c, &mut a);
    assert_eq!(v.fault, Some(ProcessFault::ResponseLimit));
    assert_eq!(c.view().turn.unwrap().text.len(), MAX_RESPONSE_BYTES);
}
fn ready_config(config: LaunchConfig) -> (Coordinator, CodexProcessAdapter, TurnTicket) {
    let mut c = Coordinator::new(id("codex"), id("fixture-host")).unwrap();
    let mut f = IdentityFixture;
    let login = c.begin_login(&mut f, None).unwrap();
    c.complete_login(
        &mut f,
        &login,
        Binding {
            provider_id: id("codex"),
            host_id: id("fixture-host"),
            account_id: id("not-a-real-account"),
        },
        Secret::new(b"NOT_A_REAL_CREDENTIAL_NEVER_FORWARDED".to_vec()).unwrap(),
    )
    .unwrap();
    let mut a = CodexProcessAdapter::new(id("codex"), id("fixture-host"), config).unwrap();
    let t = c
        .start_turn(
            &mut a,
            TurnRequest {
                reasoning_effort: None,
                model_id: id("fixture-model"),
                prompt: "자체 파이프 시험".into(),
            },
        )
        .unwrap();
    (c, a, t)
}
fn ready(mode: &str) -> (Coordinator, CodexProcessAdapter, TurnTicket) {
    ready_config(config(mode))
}
fn settle(c: &mut Coordinator, a: &mut CodexProcessAdapter) -> ProcessView {
    let limit = Instant::now() + Duration::from_secs(6);
    loop {
        let v = a.pump(c, Duration::from_millis(5));
        if v.settled {
            return v;
        }
        assert!(Instant::now() < limit, "child did not settle: {v:?}");
    }
}
fn streaming(c: &mut Coordinator, a: &mut CodexProcessAdapter) {
    let until = Instant::now() + Duration::from_secs(3);
    while c.view().turn.as_ref().unwrap().status != TurnStatus::Streaming {
        a.pump(c, Duration::from_millis(5));
        assert!(Instant::now() < until);
    }
}
#[test]
fn fragmented_utf8_eof_and_stderr_are_real_pipes() {
    let (mut c, mut a, _) = ready("fragment");
    let v = settle(&mut c, &mut a);
    assert_eq!(c.view().turn.unwrap().text, "한글🦀e\u{301}");
    assert_eq!(c.view().turn.unwrap().status, TurnStatus::Completed);
    assert_eq!(v.fault, None);
    assert!(v.stderr_bytes > 0);
    assert!(v.direct_child_exited);
    let metadata = serde_json::to_string(&v).unwrap();
    assert!(!metadata.contains("SECRET"));
    assert!(!v.credentials_forwarded);
}
#[test]
fn events_before_turn_response_are_retained() {
    let (mut c, mut a, _) = ready("early");
    settle(&mut c, &mut a);
    assert_eq!(c.view().turn.unwrap().text, "선행한글🦀e\u{301}");
}
#[test]
fn premature_eof_is_not_completed() {
    let (mut c, mut a, _) = ready("eof");
    let v = settle(&mut c, &mut a);
    assert_eq!(v.fault, Some(ProcessFault::UnexpectedEof));
    assert_eq!(c.view().turn.unwrap().status, TurnStatus::Failed);
}
#[test]
fn partial_jsonl_eof_is_rejected() {
    let (mut c, mut a, _) = ready("partial");
    let v = settle(&mut c, &mut a);
    assert_eq!(v.fault, Some(ProcessFault::PartialEof));
}
#[test]
fn invalid_utf8_rejected() {
    let (mut c, mut a, _) = ready("utf8");
    assert_eq!(
        settle(&mut c, &mut a).fault,
        Some(ProcessFault::InvalidUtf8)
    );
}
#[test]
fn invalid_json_rejected() {
    let (mut c, mut a, _) = ready("json");
    assert_eq!(
        settle(&mut c, &mut a).fault,
        Some(ProcessFault::InvalidJson)
    );
}
#[test]
fn line_limit_kills_owned_child() {
    let mut cfg = config("long");
    cfg.max_line_bytes = 262_144;
    let (mut c, mut a, _) = ready_config(cfg);
    assert_eq!(settle(&mut c, &mut a).fault, Some(ProcessFault::LineLimit));
}
#[test]
fn stderr_is_drained_bounded_without_content() {
    let mut cfg = config("stderr");
    cfg.max_stderr_bytes = 4096;
    let (mut c, mut a, _) = ready_config(cfg);
    let v = settle(&mut c, &mut a);
    assert_eq!(v.fault, Some(ProcessFault::StderrLimit));
    assert!(!v.stderr_content_retained);
}
#[test]
fn stdout_total_limit_is_independent() {
    let mut cfg = config("fragment");
    cfg.max_stdout_bytes = 256;
    let (mut c, mut a, _) = ready_config(cfg);
    assert_eq!(
        settle(&mut c, &mut a).fault,
        Some(ProcessFault::StdoutLimit)
    );
}
#[test]
fn ignored_burst_backpressures_without_dropping() {
    let (mut c, mut a, _) = ready("queue");
    for _ in 0..3 {
        a.pump(&mut c, Duration::from_millis(50));
    }
    std::thread::sleep(Duration::from_millis(100));
    let v = settle(&mut c, &mut a);
    assert_eq!(v.fault, None);
    assert_eq!(v.ignored_notifications, 200);
}
#[test]
fn approval_and_unknown_requests_never_accepted() {
    for mode in ["approval", "unknown-request"] {
        let (mut c, mut a, _) = ready(mode);
        let v = settle(&mut c, &mut a);
        assert_eq!(v.fault, Some(ProcessFault::UnsupportedTool));
        assert_eq!(v.denied_requests, 1);
        assert_eq!(c.view().turn.unwrap().text, "");
    }
}
#[test]
fn tool_item_not_misreported_as_text_success() {
    let (mut c, mut a, _) = ready("tool");
    assert_eq!(
        settle(&mut c, &mut a).fault,
        Some(ProcessFault::UnsupportedTool)
    );
}
#[test]
fn wrong_thread_is_rejected() {
    let (mut c, mut a, _) = ready("wrong-thread");
    assert_eq!(settle(&mut c, &mut a).fault, Some(ProcessFault::Protocol));
    assert_eq!(c.view().turn.unwrap().text, "");
}
#[test]
fn separate_agent_items_not_silently_concatenated() {
    let (mut c, mut a, _) = ready("multi-item");
    assert_eq!(settle(&mut c, &mut a).fault, Some(ProcessFault::Protocol));
    assert_eq!(c.view().turn.unwrap().text, "first");
}
#[test]
fn explicit_provider_failure_and_interrupt_are_distinct() {
    for (mode, status) in [
        ("failed", TurnStatus::Failed),
        ("interrupted", TurnStatus::Cancelled),
    ] {
        let (mut c, mut a, _) = ready(mode);
        let v = settle(&mut c, &mut a);
        assert_eq!(v.fault, None);
        assert_eq!(c.view().turn.unwrap().status, status);
    }
}
#[test]
fn cancellation_fences_late_delta_and_waits_for_exit() {
    let (mut c, mut a, t) = ready("cancel");
    streaming(&mut c, &mut a);
    assert_eq!(c.cancel_turn(&mut a, &t).unwrap(), Cancellation::Requested);
    assert_eq!(c.view().turn.unwrap().cancellation, Cancellation::Requested);
    let v = settle(&mut c, &mut a);
    assert!(v.direct_child_exited);
    assert_eq!(
        c.view().turn.unwrap().cancellation,
        Cancellation::Acknowledged
    );
    assert_eq!(c.view().turn.unwrap().text, "before-cancel");
}
#[test]
fn ignored_interrupt_is_killed_after_grace() {
    let (mut c, mut a, t) = ready("ignore-cancel");
    streaming(&mut c, &mut a);
    let now = Instant::now();
    c.cancel_turn(&mut a, &t).unwrap();
    settle(&mut c, &mut a);
    assert!(now.elapsed() < Duration::from_secs(2));
    assert_eq!(c.view().turn.unwrap().text, "before-cancel");
    assert_eq!(
        c.view().turn.unwrap().cancellation,
        Cancellation::Acknowledged
    );
}
#[test]
fn early_cancel_does_not_wait_for_handshake() {
    let (mut c, mut a, t) = ready("no-read");
    c.cancel_turn(&mut a, &t).unwrap();
    settle(&mut c, &mut a);
    assert_eq!(
        c.view().turn.unwrap().cancellation,
        Cancellation::Acknowledged
    );
}
#[test]
fn logout_late_output_does_not_restore_account() {
    let (mut c, mut a, _) = ready("cancel");
    streaming(&mut c, &mut a);
    c.logout(&mut a).unwrap();
    settle(&mut c, &mut a);
    assert!(c.view().selected_account.is_none());
    assert_eq!(c.view().turn.unwrap().text, "before-cancel");
}
#[test]
fn different_coordinator_cannot_receive_child_output() {
    let (mut c, mut a, _) = ready("cancel");
    streaming(&mut c, &mut a);
    let mut other = Coordinator::new(id("codex"), id("fixture-host")).unwrap();
    let v = settle(&mut other, &mut a);
    assert_eq!(v.fault, Some(ProcessFault::StaleCoordinator));
    assert!(other.view().turn.is_none());
}
#[test]
fn streaming_turn_outlives_idle_limit_but_not_turn_max() {
    let mut cfg = config("slow-stream");
    cfg.turn_timeout = Duration::from_millis(500);
    cfg.turn_max = Duration::from_secs(5);
    let (mut c, mut a, _) = ready_config(cfg);
    let v = settle(&mut c, &mut a);
    assert_eq!(v.fault, None);
    assert_eq!(c.view().turn.unwrap().text, "abcdef");
    let mut capped = config("slow-stream");
    capped.turn_timeout = Duration::from_millis(500);
    capped.turn_max = Duration::from_millis(500);
    let (mut c, mut a, _) = ready_config(capped);
    assert_eq!(settle(&mut c, &mut a).fault, Some(ProcessFault::Timeout));
}
#[test]
fn silent_turn_hits_idle_limit() {
    let mut cfg = config("silent");
    cfg.turn_timeout = Duration::from_millis(300);
    let (mut c, mut a, _) = ready_config(cfg);
    assert_eq!(settle(&mut c, &mut a).fault, Some(ProcessFault::Timeout));
}
#[test]
fn hanging_child_has_bounded_handshake() {
    let mut cfg = config("no-read");
    cfg.handshake_timeout = Duration::from_millis(30);
    let (mut c, mut a, _) = ready_config(cfg);
    assert_eq!(settle(&mut c, &mut a).fault, Some(ProcessFault::Timeout));
}
#[test]
fn complete_then_new_turn_uses_fresh_process_generation() {
    let (mut c, mut a, old) = ready("fragment");
    settle(&mut c, &mut a);
    let new = c
        .start_turn(
            &mut a,
            TurnRequest {
                reasoning_effort: None,
                model_id: id("fixture-model"),
                prompt: "second".into(),
            },
        )
        .unwrap();
    assert_ne!(old, new);
    settle(&mut c, &mut a);
    assert_eq!(c.view().turn.unwrap().text, "한글🦀e\u{301}");
    assert!(c.push_delta(&old, 0, "stale").is_err());
}
#[test]
fn adapter_does_not_implement_login() {
    let mut c = Coordinator::new(id("codex"), id("fixture-host")).unwrap();
    let mut a =
        CodexProcessAdapter::new(id("codex"), id("fixture-host"), config("fragment")).unwrap();
    assert_eq!(c.begin_login(&mut a, None), Err(Error::ProviderDispatch));
    assert_eq!(a.process_view().pid, None);
}
#[test]
fn no_shell_or_relative_executable_config() {
    for path in [
        PathBuf::from("codex"),
        PathBuf::from("C:/Windows/System32/cmd.exe"),
    ] {
        let mut cfg = config("fragment");
        cfg.executable = path;
        assert_eq!(
            CodexProcessAdapter::new(id("codex"), id("fixture-host"), cfg).unwrap_err(),
            ProcessFault::InvalidConfig
        );
    }
}

#[test]
fn document_draft_uses_explicit_text_contract_and_returns_without_tools() {
    let (mut c, mut a, _) = ready("document-draft");
    let v = settle(&mut c, &mut a);
    assert_eq!(v.fault, None);
    assert_eq!(v.denied_requests, 0);
    assert_eq!(
        c.view().turn.unwrap().text,
        "{\"schemaVersion\":2,\"blocks\":[]}"
    );
    assert_eq!(c.view().turn.unwrap().status, TurnStatus::Completed);
    assert!(v.direct_child_exited);
}

#[test]
fn external_tool_items_remain_rejected_after_document_contract() {
    for mode in ["mcp-tool", "web-tool"] {
        let (mut c, mut a, _) = ready(mode);
        let v = settle(&mut c, &mut a);
        assert_eq!(v.fault, Some(ProcessFault::UnsupportedTool));
        assert_eq!(c.view().turn.unwrap().status, TurnStatus::Failed);
        assert!(c.view().turn.unwrap().text.is_empty());
        assert!(v.direct_child_exited);
    }
}

#[test]
fn valid_small_burst_independent_reproduction() {
    let (mut c, mut a, _) = ready("burst-valid");
    for _ in 0..2 {
        a.pump(&mut c, Duration::from_millis(50));
    }
    std::thread::sleep(Duration::from_millis(100));
    let v = settle(&mut c, &mut a);
    assert_eq!(v.fault, None);
    assert_eq!(c.view().turn.as_ref().unwrap().text, "한".repeat(200));
    assert_eq!(
        c.view().turn.as_ref().unwrap().status,
        TurnStatus::Completed
    );
    assert!(v.stdout_bytes < 100_000);
    println!(
        "owned 200x3byte response burst: fault={:?}, stdout_bytes={}, user incident unproven",
        v.fault, v.stdout_bytes
    );
}

#[test]
fn cancelled_full_burst_reader_and_child_settle() {
    let (mut c, mut a, t) = ready("burst-cancel");
    for _ in 0..3 {
        a.pump(&mut c, Duration::from_millis(50));
    }
    std::thread::sleep(Duration::from_millis(100));
    let retained = c.view().turn.as_ref().unwrap().text.clone();
    c.cancel_turn(&mut a, &t).unwrap();
    let at = Instant::now();
    let v = settle(&mut c, &mut a);
    assert!(v.direct_child_exited);
    assert!(at.elapsed() < Duration::from_secs(2));
    assert_eq!(c.view().turn.as_ref().unwrap().text, retained);
    assert_eq!(
        c.view().turn.as_ref().unwrap().cancellation,
        Cancellation::Acknowledged
    );
}
