use hangul_ai_session::*;
fn id(s: &str) -> Id {
    Id::new(s).unwrap()
}
fn secret() -> Secret {
    Secret::new(b"AUTH_SECRET_MUST_NOT_LEAK".to_vec()).unwrap()
}
fn binding(account: &str) -> Binding {
    Binding {
        provider_id: id("mock"),
        host_id: id("host-1"),
        account_id: id(account),
    }
}
fn request() -> TurnRequest {
    TurnRequest {
        reasoning_effort: None,
            model_id: id("model-1"),
        prompt: "한글 선택 문맥".into(),
    }
}
#[derive(Debug)]
struct Mock {
    provider: Id,
    host: Id,
    events: Vec<&'static str>,
    login_error: bool,
    turn_error: bool,
    cancel_error: bool,
    received_secret: bool,
}
impl Mock {
    fn new() -> Self {
        Self {
            provider: id("mock"),
            host: id("host-1"),
            events: vec![],
            login_error: false,
            turn_error: false,
            cancel_error: false,
            received_secret: false,
        }
    }
}
impl ProviderAdapter for Mock {
    fn provider_id(&self) -> &Id {
        &self.provider
    }
    fn host_id(&self) -> &Id {
        &self.host
    }
    fn start_login(&mut self, _: &LoginTicket, _: Option<&Id>) -> Result<(), ProviderError> {
        self.events.push("login");
        if self.login_error {
            Err(ProviderError::Transport)
        } else {
            Ok(())
        }
    }
    fn cancel_login(&mut self, _: &LoginTicket) -> Result<(), ProviderError> {
        self.events.push("cancel-login");
        if self.cancel_error {
            Err(ProviderError::Transport)
        } else {
            Ok(())
        }
    }
    fn start_turn(
        &mut self,
        _: &TurnTicket,
        credential: &Secret,
        _: &TurnRequest,
    ) -> Result<(), ProviderError> {
        self.events.push("turn");
        self.received_secret =
            credential.with_transport_bytes(|b| b == b"AUTH_SECRET_MUST_NOT_LEAK");
        if self.turn_error {
            Err(ProviderError::Denied)
        } else {
            Ok(())
        }
    }
    fn cancel_turn(&mut self, _: &TurnTicket) -> Result<(), ProviderError> {
        self.events.push("cancel-turn");
        if self.cancel_error {
            Err(ProviderError::Transport)
        } else {
            Ok(())
        }
    }
}
fn fresh() -> (Coordinator, Mock) {
    (
        Coordinator::new(id("mock"), id("host-1")).unwrap(),
        Mock::new(),
    )
}
fn connected() -> (Coordinator, Mock) {
    let (mut c, mut a) = fresh();
    let t = c.begin_login(&mut a, None).unwrap();
    c.complete_login(&mut a, &t, binding("account-a"), secret())
        .unwrap();
    (c, a)
}
fn json(c: &Coordinator) -> String {
    serde_json::to_string(&c.view()).unwrap()
}

#[test]
fn logout_acknowledgement_can_record_retired_turn_without_reviving_it() {
    let (mut c, mut a) = connected();
    let t = c.start_turn(&mut a, request()).unwrap();
    c.logout(&mut a).unwrap();
    c.acknowledge_cancellation(&t).unwrap();
    assert_eq!(
        c.view().turn.unwrap().cancellation,
        Cancellation::Acknowledged
    );
    assert_eq!(c.push_delta(&t, 0, "late"), Err(Error::StaleTurn));
    assert!(c.view().selected_account.is_none());
}
#[test]
fn repeated_logout_reports_only_new_cancel_dispatches() {
    let (mut c, mut a) = connected();
    c.start_turn(&mut a, request()).unwrap();
    c.logout(&mut a).unwrap();
    let n = a.events.len();
    let second = c.logout(&mut a).unwrap();
    assert_eq!(second.turn_cancel, None);
    assert_eq!(second.login_cancel, None);
    assert_eq!(a.events.len(), n);
}

#[test]
fn secret_is_redacted_and_view_contains_no_token() {
    let (mut c, mut a) = connected();
    c.start_turn(&mut a, request()).unwrap();
    assert!(a.received_secret);
    for text in [format!("{:?}", secret()), format!("{c:?}"), json(&c)] {
        assert!(!text.contains("AUTH_SECRET_MUST_NOT_LEAK"));
    }
    assert!(json(&c).contains("memory_only"));
    assert!(json(&c).contains("coordinator_only"));
}
#[test]
fn ids_reject_paths_controls_and_deserialization_bypass() {
    for text in [
        "",
        "..",
        ".",
        "/tmp/secret",
        "C:\\users",
        "hello world",
        "a\nb",
        "a\u{0}b",
        "계정",
    ] {
        assert!(Id::new(text).is_err(), "{text:?}");
        assert!(serde_json::from_str::<Id>(&serde_json::to_string(text).unwrap()).is_err());
    }
    assert!(Id::new("x".repeat(129)).is_err());
    assert!(Id::new("host-12_x.y").is_ok());
}
#[test]
fn secrets_bound_and_empty_rejected() {
    assert!(Secret::new(vec![]).is_err());
    assert!(Secret::new(vec![1; 65_537]).is_err());
}
#[test]
fn failed_new_login_preserves_selected_account() {
    let (mut c, mut a) = connected();
    let ticket = c.begin_login(&mut a, None).unwrap();
    c.fail_login(&ticket, ProviderError::Denied).unwrap();
    assert_eq!(c.view().selected_account, Some(binding("account-a")));
    assert_eq!(c.view().login.status, LoginStatus::Failed);
    c.start_turn(&mut a, request()).unwrap();
}
#[test]
fn cancel_and_expiry_fence_late_login_preserving_current() {
    for expire in [false, true] {
        let (mut c, mut a) = connected();
        let t = c.begin_login(&mut a, None).unwrap();
        if expire {
            c.expire_login(&mut a, &t).unwrap();
        } else {
            c.cancel_login(&mut a, &t).unwrap();
        }
        let before = json(&c);
        assert_eq!(
            c.complete_login(&mut a, &t, binding("account-b"), secret()),
            Err(Error::StaleLogin)
        );
        assert_eq!(json(&c), before);
        assert_eq!(c.view().selected_account, Some(binding("account-a")));
    }
}
#[test]
fn logout_invalidates_pending_login_and_removes_secret() {
    let (mut c, mut a) = connected();
    let login = c.begin_login(&mut a, None).unwrap();
    let turn = c.start_turn(&mut a, request()).unwrap();
    let report = c.logout(&mut a).unwrap();
    assert!(!report.provider_revocation_implemented);
    assert_eq!(report.login_cancel, Some(Cancellation::Requested));
    assert_eq!(report.turn_cancel, Some(Cancellation::Requested));
    assert!(c.view().selected_account.is_none());
    assert_eq!(
        c.complete_login(&mut a, &login, binding("account-a"), secret()),
        Err(Error::StaleLogin)
    );
    assert_eq!(c.push_delta(&turn, 0, "late"), Err(Error::StaleTurn));
    assert_eq!(c.start_turn(&mut a, request()), Err(Error::NoAccount));
}
#[test]
fn foreign_host_adapter_fails_before_mutation_or_dispatch() {
    let (mut c, mut a) = connected();
    a.host = id("host-2");
    let before = json(&c);
    let calls = a.events.len();
    assert_eq!(c.begin_login(&mut a, None), Err(Error::BindingMismatch));
    assert_eq!(c.logout(&mut a), Err(Error::BindingMismatch));
    assert_eq!(c.start_turn(&mut a, request()), Err(Error::BindingMismatch));
    assert_eq!(json(&c), before);
    assert_eq!(a.events.len(), calls);
}
#[test]
fn wrong_callback_binding_and_reauth_identity_are_atomic() {
    let (mut c, mut a) = connected();
    let t = c.begin_login(&mut a, Some(id("account-a"))).unwrap();
    let before = json(&c);
    let mut b = binding("account-a");
    b.host_id = id("host-2");
    assert_eq!(
        c.complete_login(&mut a, &t, b, secret()),
        Err(Error::BindingMismatch)
    );
    assert_eq!(
        c.complete_login(&mut a, &t, binding("account-b"), secret()),
        Err(Error::AccountMismatch)
    );
    assert_eq!(json(&c), before);
    c.complete_login(&mut a, &t, binding("account-a"), secret())
        .unwrap();
}
#[test]
fn tickets_cannot_cross_coordinators_with_same_provider_host() {
    let (mut c, mut a) = fresh();
    let (mut other, mut b) = fresh();
    let t = c.begin_login(&mut a, None).unwrap();
    other.begin_login(&mut b, None).unwrap();
    let before = json(&other);
    assert_eq!(
        other.complete_login(&mut b, &t, binding("account-a"), secret()),
        Err(Error::StaleLogin)
    );
    assert_eq!(json(&other), before);
}
#[test]
fn pending_login_must_be_cancelled_before_new_attempt() {
    let (mut c, mut a) = fresh();
    let t = c.begin_login(&mut a, None).unwrap();
    let before = json(&c);
    assert_eq!(c.begin_login(&mut a, None), Err(Error::LoginInProgress));
    assert_eq!(json(&c), before);
    c.cancel_login(&mut a, &t).unwrap();
    let new = c.begin_login(&mut a, None).unwrap();
    assert_ne!(new, t);
    assert_eq!(
        c.fail_login(&t, ProviderError::Transport),
        Err(Error::StaleLogin)
    );
}
#[test]
fn dispatch_success_is_not_login_or_turn_completion() {
    let (mut c, mut a) = fresh();
    let t = c.begin_login(&mut a, None).unwrap();
    assert_eq!(c.view().login.status, LoginStatus::Pending);
    assert!(c.view().selected_account.is_none());
    c.complete_login(&mut a, &t, binding("a"), secret())
        .unwrap();
    c.start_turn(&mut a, request()).unwrap();
    assert_eq!(c.view().turn.unwrap().status, TurnStatus::Started);
}
#[test]
fn stream_sequence_duplicate_and_terminal_events_are_atomic() {
    let (mut c, mut a) = connected();
    let t = c.start_turn(&mut a, request()).unwrap();
    assert_eq!(c.push_delta(&t, 1, "wrong"), Err(Error::OutOfOrder));
    c.push_delta(&t, 0, "한").unwrap();
    let before = json(&c);
    assert_eq!(c.push_delta(&t, 0, "duplicate"), Err(Error::OutOfOrder));
    assert_eq!(json(&c), before);
    c.push_delta(&t, 1, "글😀").unwrap();
    c.complete_turn(&t, 2).unwrap();
    let done = json(&c);
    assert_eq!(c.view().turn.unwrap().text, "한글😀");
    assert_eq!(c.complete_turn(&t, 2), Err(Error::TerminalTurn));
    assert_eq!(c.push_delta(&t, 2, "late"), Err(Error::TerminalTurn));
    assert_eq!(json(&c), done);
}
#[test]
fn failed_turn_keeps_partial_text_but_is_not_success() {
    let (mut c, mut a) = connected();
    let t = c.start_turn(&mut a, request()).unwrap();
    c.push_delta(&t, 0, "partial").unwrap();
    c.fail_turn(&t, 1, ProviderError::Transport).unwrap();
    let v = c.view().turn.unwrap();
    assert_eq!(v.status, TurnStatus::Failed);
    assert_eq!(v.text, "partial");
    assert_eq!(v.error, Some(ProviderError::Transport));
}
#[test]
fn failed_cancel_dispatch_still_fences_output_without_exit_claim() {
    let (mut c, mut a) = connected();
    let t = c.start_turn(&mut a, request()).unwrap();
    a.cancel_error = true;
    assert_eq!(c.cancel_turn(&mut a, &t), Ok(Cancellation::DispatchFailed));
    assert_eq!(c.push_delta(&t, 0, "late"), Err(Error::TerminalTurn));
    let v = c.view().turn.unwrap();
    assert_eq!(v.status, TurnStatus::Cancelled);
    assert_eq!(v.cancellation, Cancellation::DispatchFailed);
    c.acknowledge_cancellation(&t).unwrap();
    assert_eq!(
        c.view().turn.unwrap().cancellation,
        Cancellation::Acknowledged
    );
}
#[test]
fn replacement_account_cancels_old_turn_and_routes_new_secret() {
    let (mut c, mut a) = connected();
    let old = c.start_turn(&mut a, request()).unwrap();
    let login = c.begin_login(&mut a, None).unwrap();
    c.push_delta(&old, 0, "old still selected").unwrap();
    c.complete_login(&mut a, &login, binding("account-b"), secret())
        .unwrap();
    assert_eq!(
        c.view().turn.unwrap().cancel_reason,
        Some(CancelReason::AccountChanged)
    );
    assert_eq!(c.push_delta(&old, 1, "late"), Err(Error::StaleTurn));
    let new = c.start_turn(&mut a, request()).unwrap();
    assert_ne!(old, new);
    assert_eq!(c.push_delta(&old, 1, "late"), Err(Error::StaleTurn));
    c.push_delta(&new, 0, "new").unwrap();
}
#[test]
fn provider_dispatch_failures_report_safe_codes() {
    let (mut c, mut a) = connected();
    a.login_error = true;
    assert_eq!(c.begin_login(&mut a, None), Err(Error::ProviderDispatch));
    assert_eq!(c.view().selected_account, Some(binding("account-a")));
    assert_eq!(c.view().login.error, Some(ProviderError::Transport));
    a.turn_error = true;
    assert_eq!(
        c.start_turn(&mut a, request()),
        Err(Error::ProviderDispatch)
    );
    assert_eq!(c.view().turn.unwrap().status, TurnStatus::Failed);
}
#[test]
fn empty_prompt_and_response_limits_do_not_partially_mutate() {
    let (mut c, mut a) = connected();
    let before = json(&c);
    for prompt in [String::new()] {
        assert_eq!(
            c.start_turn(
                &mut a,
                TurnRequest {
                    reasoning_effort: None,
            model_id: id("model"),
                    prompt
                }
            ),
            Err(Error::InvalidPrompt)
        );
        assert_eq!(json(&c), before);
    }
    let mut long = request();
    long.prompt = "한글 원문\n".repeat(50_000);
    let t = c.start_turn(&mut a, long).unwrap();
    c.push_delta(&t, 0, &"x".repeat(MAX_RESPONSE_BYTES))
        .unwrap();
    let before = json(&c);
    assert_eq!(c.push_delta(&t, 1, "😀"), Err(Error::ResponseLimit));
    assert_eq!(json(&c), before);
    c.complete_turn(&t, 1).unwrap();
}
#[test]
fn provider_cancel_is_acknowledged_and_new_turn_rejects_old_events() {
    let (mut c, mut a) = connected();
    let t = c.start_turn(&mut a, request()).unwrap();
    c.provider_cancelled_turn(&t, 0).unwrap();
    assert_eq!(
        c.view().turn.unwrap().cancellation,
        Cancellation::Acknowledged
    );
    let next = c.start_turn(&mut a, request()).unwrap();
    assert_ne!(t, next);
    assert_eq!(c.complete_turn(&t, 0), Err(Error::StaleTurn));
}
#[test]
fn json_input_rejects_unknown_fields_and_invalid_ids() {
    assert!(
        serde_json::from_str::<TurnRequest>(r#"{"model_id":"m","prompt":"x","path":"C:/secret"}"#)
            .is_err()
    );
    assert!(
        serde_json::from_str::<Binding>(
            r#"{"provider_id":"p","host_id":"h","account_id":"a","token":"bad"}"#
        )
        .is_err()
    );
}
#[test]
fn active_turn_rejects_second_start_without_extra_dispatch() {
    let (mut c, mut a) = connected();
    c.start_turn(&mut a, request()).unwrap();
    let before = json(&c);
    let calls = a.events.len();
    assert_eq!(c.start_turn(&mut a, request()), Err(Error::TurnInProgress));
    assert_eq!(json(&c), before);
    assert_eq!(a.events.len(), calls);
}
