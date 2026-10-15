mod common;

use achmage_telegram::{
    BotApi, BotToken, Error, Gateway, GatewayStatus, InboundRequest, MAX_DOCUMENT_BYTES,
    MAX_MESSAGE_LEN,
};
use common::*;
use serde_json::json;
use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use tempfile::TempDir;

struct Fixture {
    _dir: TempDir,
    path: PathBuf,
    clock: Arc<ManualClock>,
    mock: MockTelegram,
}

impl Fixture {
    async fn new(with_owner: bool) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("telegram-state.json");
        let clock = ManualClock::at(T0);
        if with_owner {
            seed_owner(&path, clock.clone());
        }
        Self {
            _dir: dir,
            path,
            clock,
            mock: MockTelegram::start().await,
        }
    }
    fn gateway(&self) -> Gateway {
        Gateway::open_with_clock(&self.path, self.clock.clone()).unwrap()
    }
    async fn running(&self) -> Gateway {
        let gateway = self.gateway();
        let me = gateway.start(self.mock.api()).await.unwrap();
        assert_eq!(me.username, "hop_test_bot");
        gateway
    }
}

async fn drain(gateway: &Gateway, count: usize) -> Vec<InboundRequest> {
    let mut got = Vec::new();
    wait_until("queued requests", || {
        got.extend(gateway.take_requests());
        got.len() >= count
    })
    .await;
    got
}

fn texts(requests: &[InboundRequest]) -> Vec<&str> {
    requests.iter().map(|r| r.text.as_str()).collect()
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

#[tokio::test]
async fn owner_text_becomes_a_request_and_other_chats_are_ignored() {
    let f = Fixture::new(true).await;
    let gateway = f.gateway();
    assert_eq!(gateway.status(), GatewayStatus::Disabled);
    gateway.start(f.mock.api()).await.unwrap();
    assert_eq!(
        gateway.status(),
        GatewayStatus::Running {
            bot_username: "hop_test_bot".into()
        }
    );
    f.mock.push_updates(vec![
        group_text(10, OWNER, "그룹 메시지"),
        group_text(11, STRANGER, "낯선 그룹"),
        private_text(12, OWNER, "오늘 일정 알려줘"),
        private_photo(13, OWNER),
    ]);
    let got = drain(&gateway, 1).await;
    assert_eq!(
        got,
        vec![InboundRequest {
            update_id: 12,
            user_id: OWNER,
            chat_id: OWNER,
            display_name: "Tester 1001 (@user1001)".into(),
            text: "오늘 일정 알려줘".into(),
            received_at: T0,
        }]
    );
    wait_until("text-only note", || f.mock.sent().len() == 1).await;
    let (chat, note) = &f.mock.sent()[0];
    assert_eq!(*chat, OWNER);
    assert!(note.contains("텍스트"));
    wait_until("offset 14", || f.mock.polled_offsets().contains(&14)).await;
    let first_poll = &f.mock.requests("getUpdates")[0].body;
    assert_eq!(first_poll["offset"], 2);
    assert_eq!(first_poll["timeout"], 25);
    assert_eq!(first_poll["allowed_updates"], json!(["message"]));
    assert!(gateway.take_requests().is_empty());
    assert!(gateway.pending().is_empty());
    assert_eq!(f.mock.sent().len(), 1);
    gateway.stop().await;
}

#[tokio::test]
async fn duplicates_are_processed_once_and_the_offset_survives_a_restart() {
    let f = Fixture::new(true).await;
    let gateway = f.running().await;
    f.mock
        .push_updates(vec![private_text(20, OWNER, "a"), private_text(21, OWNER, "b")]);
    f.mock
        .push_updates(vec![private_text(21, OWNER, "b"), private_text(22, OWNER, "c")]);
    assert_eq!(texts(&drain(&gateway, 3).await), ["a", "b", "c"]);
    wait_until("offset 23", || f.mock.polled_offsets().contains(&23)).await;
    assert!(gateway.take_requests().is_empty());
    gateway.stop().await;
    drop(gateway);

    let before = f.mock.requests("getUpdates").len();
    let gateway = f.running().await;
    wait_until("poll after restart", || {
        f.mock.requests("getUpdates").len() > before
    })
    .await;
    assert_eq!(f.mock.requests("getUpdates")[before].body["offset"], 23);
    f.mock
        .push_updates(vec![private_text(22, OWNER, "c"), private_text(23, OWNER, "d")]);
    assert_eq!(texts(&drain(&gateway, 1).await), ["d"]);
    wait_until("offset 24", || f.mock.polled_offsets().contains(&24)).await;
    assert!(gateway.take_requests().is_empty());
}

#[tokio::test]
async fn strangers_pair_only_through_desktop_approval() {
    let f = Fixture::new(false).await;
    let gateway = f.running().await;
    f.mock
        .push_updates(vec![private_text(1, STRANGER, "연결해줘")]);
    wait_until("pairing code", || f.mock.sent().len() == 1).await;
    let (chat, text) = f.mock.sent()[0].clone();
    assert_eq!(chat, STRANGER);
    let code = code_in(&text);
    assert!(gateway.take_requests().is_empty());
    let pending = gateway.pending();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].user_id, STRANGER);
    assert_eq!(pending[0].expires_at, T0 + 3600);
    assert!(!std::fs::read_to_string(&f.path).unwrap().contains(&code));

    // Sending the code back over Telegram approves nothing and earns no second code.
    f.mock
        .push_updates(vec![private_text(2, STRANGER, &code)]);
    wait_until("offset 3", || f.mock.polled_offsets().contains(&3)).await;
    assert!(gateway.allowed().is_empty());
    assert!(gateway.take_requests().is_empty());
    assert_eq!(f.mock.sent().len(), 1);
    assert_eq!(gateway.reply(STRANGER, "몰래").await, Err(Error::NotAllowed));

    assert_eq!(gateway.approve(&wrong(&code)), Err(Error::CodeRejected));
    let approved = gateway.approve(&code).unwrap();
    assert_eq!(approved.user_id, STRANGER);
    assert!(gateway.pending().is_empty());
    f.mock
        .push_updates(vec![private_text(3, STRANGER, "이제 질문")]);
    assert_eq!(texts(&drain(&gateway, 1).await), ["이제 질문"]);
    gateway.reply(STRANGER, "답변").await.unwrap();
    assert_eq!(f.mock.sent().last().unwrap(), &(STRANGER, "답변".to_string()));
}

#[tokio::test]
async fn replies_reach_only_allowlisted_users_and_are_split() {
    let f = Fixture::new(true).await;
    let gateway = f.gateway();
    assert_eq!(gateway.reply(OWNER, "x").await, Err(Error::NotRunning));
    gateway.start(f.mock.api()).await.unwrap();
    assert_eq!(gateway.reply(STRANGER, "비밀").await, Err(Error::NotAllowed));
    assert_eq!(gateway.reply(OWNER, "  ").await, Err(Error::EmptyMessage));
    assert!(f.mock.sent().is_empty());

    let long: String = (0..150)
        .map(|i| format!("{i:03} {}\n", "다".repeat(80)))
        .collect();
    gateway.reply(OWNER, &long).await.unwrap();
    let sent = f.mock.sent();
    assert_eq!(sent.len(), 4);
    assert!(sent.iter().all(|(chat, _)| *chat == OWNER));
    assert!(sent
        .iter()
        .all(|(_, text)| text.chars().count() <= MAX_MESSAGE_LEN));
    assert_eq!(
        sent.iter().map(|(_, text)| text.as_str()).collect::<String>(),
        long
    );

    assert!(gateway.revoke(OWNER).unwrap());
    assert_eq!(gateway.reply(OWNER, "x").await, Err(Error::NotAllowed));
    gateway.stop().await;
    assert!(!gateway.revoke(OWNER).unwrap());
}

#[tokio::test]
async fn documents_reach_only_allowlisted_users_as_multipart_uploads() {
    let f = Fixture::new(true).await;
    let gateway = f.running().await;
    let pdf = b"%PDF-1.7 fixture \x00\x01\x02\xff end".to_vec();

    assert_eq!(
        gateway
            .reply_document(STRANGER, "leak.pdf", pdf.clone(), None)
            .await,
        Err(Error::NotAllowed)
    );
    let oversized = vec![0u8; MAX_DOCUMENT_BYTES + 1];
    assert_eq!(
        gateway
            .reply_document(OWNER, "big.bin", oversized, None)
            .await,
        Err(Error::DocumentTooLarge)
    );
    assert_eq!(
        gateway
            .reply_document(OWNER, "x.pdf", pdf.clone(), Some(&"가".repeat(1025)))
            .await,
        Err(Error::CaptionTooLong)
    );
    assert!(f.mock.requests("sendDocument").is_empty());

    gateway
        .reply_document(OWNER, "../reports/q3 summary.pdf", pdf.clone(), Some("3분기 요약"))
        .await
        .unwrap();
    let uploads = f.mock.requests("sendDocument");
    assert_eq!(uploads.len(), 1);
    let upload = &uploads[0];
    assert!(upload.content_type.starts_with("multipart/form-data"));
    assert!(contains(&upload.raw, b"name=\"chat_id\"\r\n\r\n1001\r\n"));
    assert!(contains(&upload.raw, b"name=\"document\"; filename=\"q3 summary.pdf\""));
    assert!(contains(&upload.raw, &pdf));
    assert!(contains(&upload.raw, "name=\"caption\"\r\n\r\n3분기 요약".as_bytes()));
    assert!(!contains(&upload.raw, b"reports"));
}

#[tokio::test]
async fn a_full_queue_answers_busy_instead_of_growing() {
    let f = Fixture::new(true).await;
    let gateway = f.running().await;
    f.mock.push_updates(
        (10..43)
            .map(|id| private_text(id, OWNER, &format!("요청 {id}")))
            .collect(),
    );
    wait_until("busy reply", || f.mock.sent().len() == 1).await;
    assert!(f.mock.sent()[0].1.contains("잠시 후"));
    let got = gateway.take_requests();
    assert_eq!(got.len(), 32);
    assert_eq!((got[0].text.as_str(), got[31].text.as_str()), ("요청 10", "요청 41"));
}

#[tokio::test]
async fn wait_for_requests_wakes_on_arrival() {
    let f = Fixture::new(true).await;
    let gateway = Arc::new(f.running().await);
    let waiter = {
        let gateway = gateway.clone();
        tokio::spawn(async move {
            gateway.wait_for_requests().await;
            gateway.take_requests()
        })
    };
    f.mock
        .push_updates(vec![private_text(10, OWNER, "깨워줘")]);
    let got = tokio::time::timeout(Duration::from_secs(5), waiter)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(texts(&got), ["깨워줘"]);
}

#[tokio::test]
async fn stop_interrupts_a_long_poll_promptly() {
    let f = Fixture::new(false).await;
    let gateway = f.running().await;
    wait_until("long poll in flight", || {
        !f.mock.requests("getUpdates").is_empty()
    })
    .await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let started = Instant::now();
    gateway.stop().await;
    assert!(started.elapsed() < Duration::from_secs(1), "{:?}", started.elapsed());
    assert_eq!(gateway.status(), GatewayStatus::Disabled);
    let polls = f.mock.requests("getUpdates").len();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(f.mock.requests("getUpdates").len(), polls);
}

#[tokio::test]
async fn conflict_stops_with_a_korean_reason() {
    let f = Fixture::new(false).await;
    f.mock.respond(
        "getUpdates",
        409,
        r#"{"ok":false,"error_code":409,"description":"Conflict: terminated by other getUpdates request; make sure that only one bot instance is running"}"#,
    );
    let gateway = f.running().await;
    wait_until("stopped", || {
        matches!(gateway.status(), GatewayStatus::Stopped { .. })
    })
    .await;
    let GatewayStatus::Stopped { reason } = gateway.status() else {
        unreachable!()
    };
    assert!(reason.contains("다른 프로그램"), "{reason}");
    assert_no_token(&reason);
    let polls = f.mock.requests("getUpdates").len();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(f.mock.requests("getUpdates").len(), polls);
}

#[tokio::test]
async fn invalid_token_fails_start_without_polling() {
    let f = Fixture::new(false).await;
    f.mock.respond(
        "getMe",
        401,
        r#"{"ok":false,"error_code":401,"description":"Unauthorized"}"#,
    );
    let gateway = f.gateway();
    let error = gateway.start(f.mock.api()).await.unwrap_err();
    assert_eq!(error, Error::InvalidToken);
    let GatewayStatus::Stopped { reason } = gateway.status() else {
        panic!("expected stopped, got {:?}", gateway.status())
    };
    assert!(reason.contains("토큰"));
    assert_no_token(&format!("{reason} {error} {error:?} {:?}", gateway.status()));
    assert!(f.mock.requests("getUpdates").is_empty());
}

#[tokio::test]
async fn network_errors_are_retried_with_backoff() {
    let f = Fixture::new(false).await;
    f.mock.respond("getUpdates", 502, "<html>bad gateway</html>");
    let gateway = f.running().await;
    wait_until("reconnecting", || gateway.status() == GatewayStatus::Connecting).await;
    let failed_at = Instant::now();
    f.mock.clear_responses();
    f.mock.push_updates(Vec::new());
    wait_until("running again", || {
        matches!(gateway.status(), GatewayStatus::Running { .. })
    })
    .await;
    // The first retry waits about one second rather than hammering the server.
    assert!(failed_at.elapsed() >= Duration::from_millis(700));
    assert!(f.mock.requests("getUpdates").len() >= 2);
}

#[test]
fn gateway_and_its_futures_are_send() {
    fn send_sync<T: Send + Sync>() {}
    fn send<T: Send>(_: &T) {}
    send_sync::<Gateway>();
    send_sync::<BotApi>();
    let dir = tempfile::tempdir().unwrap();
    let gateway = Gateway::open(dir.path().join("state.json")).unwrap();
    let api = BotApi::with_base_url(BotToken::parse(TOKEN).unwrap(), "http://127.0.0.1:9").unwrap();
    let start = gateway.start(api);
    send(&start);
    drop(start);
    send(&gateway.stop());
    send(&gateway.reply(OWNER, "x"));
    send(&gateway.reply_document(OWNER, "a.txt", vec![1], None));
    send(&gateway.wait_for_requests());
}
