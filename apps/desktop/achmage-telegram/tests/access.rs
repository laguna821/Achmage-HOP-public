mod common;

use achmage_telegram::{access::Action, AccessControl, Error};
use common::*;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{path::PathBuf, sync::Arc};
use tempfile::TempDir;

struct Fixture {
    _dir: TempDir,
    path: PathBuf,
    clock: Arc<ManualClock>,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("telegram-state.json");
        Self {
            _dir: dir,
            path,
            clock: ManualClock::at(T0),
        }
    }
    fn open(&self) -> AccessControl {
        AccessControl::open(&self.path, self.clock.clone()).unwrap()
    }
}

fn handle(access: &mut AccessControl, value: Value) -> Action {
    access.handle_update(&update(value)).unwrap()
}

fn request_code(access: &mut AccessControl, update_id: i64, user_id: i64) -> String {
    match handle(access, private_text(update_id, user_id, "연결하고 싶어요")) {
        Action::Reply { chat_id, text } => {
            assert_eq!(chat_id, user_id);
            assert!(text.contains("HOP 앱"));
            code_in(&text)
        }
        other => panic!("expected a pairing reply, got {other:?}"),
    }
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
        .collect()
}

#[test]
fn codes_are_stored_only_as_salted_hashes_and_approve_exactly_one_user() {
    let f = Fixture::new();
    let mut access = f.open();
    let first = request_code(&mut access, 1, 3001);
    let second = request_code(&mut access, 2, 3002);

    let raw = std::fs::read_to_string(&f.path).unwrap();
    assert!(!raw.contains(&first) && !raw.contains(&second));
    let state: Value = serde_json::from_str(&raw).unwrap();
    let entries = state["pending"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    for (entry, code) in entries.iter().zip([&first, &second]) {
        assert!(entry.get("code").is_none());
        let salt = unhex(entry["salt"].as_str().unwrap());
        assert_eq!(salt.len(), 16);
        let expected = Sha256::new()
            .chain_update(salt)
            .chain_update(code.as_bytes())
            .finalize();
        assert_eq!(entry["codeHash"], format!("{expected:x}"));
    }

    let pending = access.pending();
    assert_eq!(pending.len(), 2);
    assert_eq!(pending[0].display_name, "Tester 3001 (@user3001)");
    assert_eq!(
        (pending[0].created_at, pending[0].expires_at),
        (T0, T0 + 3600)
    );

    let approved = access.approve(&first).unwrap();
    assert_eq!(approved.user_id, 3001);
    assert_eq!(approved.display_name, "Tester 3001 (@user3001)");
    assert!(access.is_allowed(3001) && !access.is_allowed(3002));
    // One owner: the other request is dropped, and nobody else gets a code.
    assert!(access.pending().is_empty());

    match handle(&mut access, private_text(3, 3001, "보고서 요약해줘")) {
        Action::Deliver(request) => {
            assert_eq!(
                (request.update_id, request.user_id, request.chat_id),
                (3, 3001, 3001)
            );
            assert_eq!(request.text, "보고서 요약해줘");
            assert_eq!(request.received_at, T0);
        }
        other => panic!("expected delivery, got {other:?}"),
    }
    assert_eq!(handle(&mut access, private_text(4, 3002, "저도요")), Action::Ignore);
    assert!(access.pending().is_empty());
}

#[test]
fn wrong_and_expired_codes_are_rejected() {
    let f = Fixture::new();
    let mut access = f.open();
    let code = request_code(&mut access, 1, 3001);
    assert_eq!(access.approve(&wrong(&code)), Err(Error::CodeRejected));
    assert_eq!(access.approve("12ab"), Err(Error::CodeRejected));
    f.clock.advance(3600);
    assert!(access.pending().is_empty());
    assert_eq!(access.approve(&code), Err(Error::CodeRejected));
    assert!(access.allowed().is_empty());
}

#[test]
fn spaced_code_input_is_accepted() {
    let f = Fixture::new();
    let mut access = f.open();
    let code = request_code(&mut access, 1, 3001);
    let spaced = format!(" {}-{} ", &code[..4], &code[4..]);
    assert_eq!(access.approve(&spaced).unwrap().user_id, 3001);
}

#[test]
fn one_new_code_per_user_per_ten_minutes() {
    let f = Fixture::new();
    let mut access = f.open();
    let first = request_code(&mut access, 1, 3001);
    f.clock.advance(599);
    assert_eq!(
        handle(&mut access, private_text(2, 3001, "다시")),
        Action::Ignore
    );
    f.clock.advance(1);
    let second = request_code(&mut access, 3, 3001);
    assert_eq!(access.pending().len(), 1);
    if first != second {
        assert_eq!(access.approve(&first), Err(Error::CodeRejected));
    }
    assert_eq!(access.approve(&second).unwrap().user_id, 3001);
}

#[test]
fn at_most_three_requests_wait_at_once() {
    let f = Fixture::new();
    let mut access = f.open();
    let codes: Vec<String> = [3001, 3002, 3003]
        .iter()
        .zip(1..)
        .map(|(user, id)| request_code(&mut access, id, *user))
        .collect();
    assert_eq!(
        handle(&mut access, private_text(4, 3004, "나도")),
        Action::Ignore
    );
    assert_eq!(access.pending().len(), 3);
    assert!(access.pending().iter().all(|p| p.user_id != 3004));
    // Approving one makes it the owner; no further requests are taken.
    access.approve(&codes[0]).unwrap();
    assert_eq!(handle(&mut access, private_text(5, 3004, "나도")), Action::Ignore);
    assert!(access.pending().is_empty());
}

#[test]
fn five_wrong_codes_lock_approval_for_an_hour() {
    let f = Fixture::new();
    let mut access = f.open();
    let code = request_code(&mut access, 1, 3001);
    for _ in 0..5 {
        assert_eq!(access.approve(&wrong(&code)), Err(Error::CodeRejected));
    }
    let locked = Err(Error::ApprovalLocked { until: T0 + 3600 });
    assert_eq!(access.approve(&code), locked);
    assert_eq!(access.approval_locked_until(), Some(T0 + 3600));
    drop(access);

    // The lock survives a restart.
    let mut access = f.open();
    assert_eq!(access.approve(&code), locked);
    f.clock.advance(3599);
    assert_eq!(access.approve(&code), locked);
    f.clock.advance(1);
    assert_eq!(access.approval_locked_until(), None);
    // The old code expired with the lock; a fresh one works.
    let fresh = request_code(&mut access, 2, 3001);
    assert_eq!(access.approve(&fresh).unwrap().user_id, 3001);
}

#[test]
fn only_private_chats_with_humans_are_processed_once() {
    let f = Fixture::new();
    let mut access = f.open();
    assert_eq!(handle(&mut access, group_text(1, 3001, "hi")), Action::Ignore);
    let mut bot = private_text(2, 3001, "hi");
    bot["message"]["from"]["is_bot"] = json!(true);
    assert_eq!(handle(&mut access, bot), Action::Ignore);
    let mut forged = private_text(3, 3001, "hi");
    forged["message"]["chat"]["id"] = json!(9999);
    assert_eq!(handle(&mut access, forged), Action::Ignore);
    assert_eq!(
        handle(&mut access, json!({"update_id": 4, "edited_message": {}})),
        Action::Ignore
    );
    assert!(access.pending().is_empty());
    assert_eq!(access.next_offset(), 5);

    let code = request_code(&mut access, 5, 3001);
    access.approve(&code).unwrap();
    assert!(matches!(
        handle(&mut access, private_text(6, 3001, "a")),
        Action::Deliver(_)
    ));
    assert_eq!(
        handle(&mut access, private_text(6, 3001, "a")),
        Action::Ignore
    );
    match handle(&mut access, private_photo(7, 3001)) {
        Action::Reply { chat_id, text } => {
            assert_eq!(chat_id, 3001);
            assert!(text.contains("텍스트"));
        }
        other => panic!("expected a text-only note, got {other:?}"),
    }
    // Group messages from the owner are still ignored.
    assert_eq!(handle(&mut access, group_text(8, 3001, "hi")), Action::Ignore);
}

#[test]
fn hostile_display_names_are_cleaned() {
    let f = Fixture::new();
    let mut access = f.open();
    let mut message = private_text(1, 3001, "hi");
    message["message"]["from"] = json!({"id": 3001, "is_bot": false, "first_name": "Ow\u{202E}ner\u{0}\n"});
    handle(&mut access, message);
    let names: Vec<String> = access.pending().into_iter().map(|p| p.display_name).collect();
    assert!(names.contains(&"Owner".to_string()), "{names:?}");
}

#[test]
fn revoke_removes_access_and_persists() {
    let f = Fixture::new();
    let mut access = f.open();
    let code = request_code(&mut access, 1, 3001);
    access.approve(&code).unwrap();
    assert!(access.revoke(3001).unwrap());
    assert!(!access.revoke(3001).unwrap());
    // With the owner removed, a new owner can pair.
    request_code(&mut access, 2, 3002);
    drop(access);
    let access = f.open();
    assert!(!access.is_allowed(3001));
    assert_eq!(access.next_offset(), 3);
}

#[test]
fn corrupt_state_starts_empty_and_keeps_a_copy() {
    let f = Fixture::new();
    let damaged = br#"{"version":1,"allowed":[{"userId":"#;
    std::fs::write(&f.path, damaged).unwrap();
    let mut access = f.open();
    assert_eq!(access.next_offset(), 0);
    assert!(access.allowed().is_empty() && access.pending().is_empty());
    let mut copy = f.path.clone().into_os_string();
    copy.push(".corrupt");
    assert_eq!(std::fs::read(&copy).unwrap(), damaged);
    // The next write produces a valid file again.
    request_code(&mut access, 1, 3001);
    let state: Value = serde_json::from_slice(&std::fs::read(&f.path).unwrap()).unwrap();
    assert_eq!(state["nextOffset"], 2);

    // An unknown version is treated the same way rather than half-trusted.
    std::fs::write(&f.path, br#"{"version":99}"#).unwrap();
    assert_eq!(f.open().next_offset(), 0);
}
