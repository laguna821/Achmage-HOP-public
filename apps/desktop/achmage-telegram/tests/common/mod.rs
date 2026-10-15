//! Loopback Bot API emulator (minimal HTTP/1.1 over a tokio TcpListener) and fixtures shared by
//! the integration tests. Not every test file uses every helper.
#![allow(dead_code)]

use achmage_telegram::{access::Action, AccessControl, BotApi, BotToken, Clock, Update};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

/// Telegram-shaped but fake; never a real bot.
pub const TOKEN: &str = "1234567890:TESTONLY_not_a_real_token_0000000000";
pub const SECRET_PART: &str = "TESTONLY_not_a_real_token_0000000000";
pub const OWNER: i64 = 1001;
pub const STRANGER: i64 = 2002;
pub const T0: u64 = 1_700_000_000;

pub struct ManualClock(AtomicU64);

impl ManualClock {
    pub fn at(now: u64) -> Arc<Self> {
        Arc::new(Self(AtomicU64::new(now)))
    }
    pub fn advance(&self, secs: u64) {
        self.0.fetch_add(secs, Ordering::SeqCst);
    }
}

impl Clock for ManualClock {
    fn now(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
}

#[derive(Clone, Debug)]
pub struct Recorded {
    pub method: String,
    pub path: String,
    pub content_type: String,
    pub body: Value,
    pub raw: Vec<u8>,
}

#[derive(Clone)]
struct Canned {
    status: u16,
    body: String,
    with_length: bool,
}

#[derive(Default)]
struct State {
    batches: VecDeque<Vec<Value>>,
    canned: HashMap<String, Canned>,
    requests: Vec<Recorded>,
    latest_poll: u64,
}

/// Emulates getMe, getUpdates (long polling over scripted batches), sendMessage and
/// sendDocument, and records every request.
#[derive(Clone)]
pub struct MockTelegram {
    pub base: String,
    state: Arc<Mutex<State>>,
}

impl MockTelegram {
    pub async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let state = Arc::new(Mutex::new(State::default()));
        let shared = state.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                tokio::spawn(serve(stream, shared.clone()));
            }
        });
        Self { base, state }
    }
    pub fn api(&self) -> BotApi {
        BotApi::with_base_url(BotToken::parse(TOKEN).unwrap(), &self.base).unwrap()
    }
    pub fn push_updates(&self, batch: Vec<Value>) {
        self.state.lock().unwrap().batches.push_back(batch);
    }
    /// Sticky canned response for one method.
    pub fn respond(&self, method: &str, status: u16, body: &str) {
        self.can(method, status, body, true);
    }
    /// Canned response without Content-Length (close-delimited body).
    pub fn respond_unbounded(&self, method: &str, status: u16, body: &str) {
        self.can(method, status, body, false);
    }
    pub fn clear_responses(&self) {
        self.state.lock().unwrap().canned.clear();
    }
    fn can(&self, method: &str, status: u16, body: &str, with_length: bool) {
        self.state.lock().unwrap().canned.insert(
            method.into(),
            Canned {
                status,
                body: body.into(),
                with_length,
            },
        );
    }
    pub fn requests(&self, method: &str) -> Vec<Recorded> {
        let state = self.state.lock().unwrap();
        state
            .requests
            .iter()
            .filter(|r| r.method == method)
            .cloned()
            .collect()
    }
    pub fn sent(&self) -> Vec<(i64, String)> {
        self.requests("sendMessage")
            .into_iter()
            .map(|r| {
                assert_eq!(
                    r.body["link_preview_options"]["is_disabled"], true,
                    "every message is sent with link previews off"
                );
                (
                    r.body["chat_id"].as_i64().unwrap(),
                    r.body["text"].as_str().unwrap().to_string(),
                )
            })
            .collect()
    }
    pub fn polled_offsets(&self) -> Vec<i64> {
        self.requests("getUpdates")
            .iter()
            .filter_map(|r| r.body["offset"].as_i64())
            .collect()
    }
}

async fn serve(mut stream: TcpStream, state: Arc<Mutex<State>>) {
    let Some((path, content_type, raw)) = read_request(&mut stream).await else {
        return;
    };
    let method = path.rsplit('/').next().unwrap_or_default().to_string();
    let body: Value = serde_json::from_slice(&raw).unwrap_or(Value::Null);
    let (canned, poll) = {
        let mut s = state.lock().unwrap();
        s.requests.push(Recorded {
            method: method.clone(),
            path,
            content_type,
            body: body.clone(),
            raw,
        });
        let poll = if method == "getUpdates" {
            s.latest_poll += 1;
            s.latest_poll
        } else {
            0
        };
        (s.canned.get(&method).cloned(), poll)
    };
    if let Some(c) = canned {
        return reply(&mut stream, c.status, &c.body, c.with_length).await;
    }
    let result = match method.as_str() {
        "getMe" => {
            json!({"id": 42, "is_bot": true, "first_name": "HOP", "username": "hop_test_bot"})
        }
        "sendMessage" => {
            json!({"message_id": 1, "date": 0, "chat": {"id": body["chat_id"], "type": "private"}, "text": body["text"]})
        }
        "sendDocument" => {
            json!({"message_id": 2, "date": 0, "chat": {"id": 0, "type": "private"}, "document": {"file_id": "f", "file_unique_id": "u"}})
        }
        "getUpdates" => {
            let wait = body["timeout"].as_u64().unwrap_or(0);
            match long_poll(&mut stream, &state, poll, wait).await {
                Some(batch) => Value::Array(batch),
                None => return,
            }
        }
        _ => {
            let missing = r#"{"ok":false,"error_code":404,"description":"Not Found"}"#;
            return reply(&mut stream, 404, missing, true).await;
        }
    };
    let envelope = json!({"ok": true, "result": result}).to_string();
    reply(&mut stream, 200, &envelope, true).await;
}

async fn long_poll(
    stream: &mut TcpStream,
    state: &Mutex<State>,
    poll: u64,
    wait: u64,
) -> Option<Vec<Value>> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(wait);
    let mut probe = [0u8; 1];
    loop {
        // Only the newest poll may take a batch: an older one belongs to a stopped gateway.
        let batch = {
            let mut s = state.lock().unwrap();
            if s.latest_poll == poll {
                s.batches.pop_front()
            } else {
                None
            }
        };
        if batch.is_some() {
            return batch;
        }
        if tokio::time::Instant::now() >= deadline {
            return Some(Vec::new());
        }
        tokio::select! {
            biased;
            _ = stream.read(&mut probe) => return None, // the client hung up
            _ = tokio::time::sleep(Duration::from_millis(20)) => {}
        }
    }
}

async fn read_request(stream: &mut TcpStream) -> Option<(String, String, Vec<u8>)> {
    let mut data = Vec::new();
    let mut buf = [0u8; 16 * 1024];
    loop {
        let n = stream.read(&mut buf).await.ok()?;
        if n == 0 {
            return None;
        }
        data.extend_from_slice(&buf[..n]);
        let Some(at) = data.windows(4).position(|w| w == b"\r\n\r\n") else {
            continue;
        };
        let head = String::from_utf8_lossy(&data[..at]).to_string();
        let header = |name: &str| {
            head.lines().find_map(|line| {
                let (key, value) = line.split_once(':')?;
                key.trim()
                    .eq_ignore_ascii_case(name)
                    .then(|| value.trim().to_string())
            })
        };
        let length: usize = header("content-length")
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        if data.len() >= at + 4 + length {
            let path = head.split_whitespace().nth(1).unwrap_or_default().to_string();
            let content_type = header("content-type").unwrap_or_default();
            return Some((path, content_type, data[at + 4..at + 4 + length].to_vec()));
        }
    }
}

async fn reply(stream: &mut TcpStream, status: u16, body: &str, with_length: bool) {
    let length = if with_length {
        format!("Content-Length: {}\r\n", body.len())
    } else {
        String::new()
    };
    let head = format!(
        "HTTP/1.1 {status} Fixture\r\nConnection: close\r\nContent-Type: application/json\r\n{length}\r\n"
    );
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.write_all(body.as_bytes()).await;
    let _ = stream.shutdown().await;
}

fn person(user_id: i64) -> Value {
    json!({"id": user_id, "is_bot": false, "first_name": "Tester", "last_name": user_id.to_string(), "username": format!("user{user_id}")})
}

pub fn private_text(update_id: i64, user_id: i64, text: &str) -> Value {
    json!({"update_id": update_id, "message": {"message_id": update_id, "date": 0, "from": person(user_id),
        "chat": {"id": user_id, "type": "private"}, "text": text}})
}

pub fn group_text(update_id: i64, user_id: i64, text: &str) -> Value {
    json!({"update_id": update_id, "message": {"message_id": update_id, "date": 0, "from": person(user_id),
        "chat": {"id": -100_777, "type": "supergroup"}, "text": text}})
}

pub fn private_photo(update_id: i64, user_id: i64) -> Value {
    json!({"update_id": update_id, "message": {"message_id": update_id, "date": 0, "from": person(user_id),
        "chat": {"id": user_id, "type": "private"},
        "photo": [{"file_id": "x", "file_unique_id": "y", "width": 1, "height": 1}]}})
}

pub fn update(value: Value) -> Update {
    serde_json::from_value(value).unwrap()
}

/// The first run of exactly eight digits, i.e. the pairing code in a reply.
pub fn code_in(text: &str) -> String {
    text.split(|c: char| !c.is_ascii_digit())
        .find(|run| run.len() == 8)
        .expect("pairing code in message")
        .to_string()
}

/// A well-formed code that differs from `code`.
pub fn wrong(code: &str) -> String {
    if code == "00000000" { "11111111" } else { "00000000" }.to_string()
}

pub fn assert_no_token(text: &str) {
    assert!(!text.contains(SECRET_PART), "token leaked into: {text}");
}

/// Polls `condition` every 20 ms for up to 5 s.
pub async fn wait_until(what: &str, mut condition: impl FnMut() -> bool) {
    for _ in 0..250 {
        if condition() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("timed out waiting for {what}");
}

/// Pairs OWNER through the real pairing path; leaves the polling offset at 2.
pub fn seed_owner(path: &Path, clock: Arc<ManualClock>) {
    let mut access = AccessControl::open(path, clock).unwrap();
    let Action::Reply { text, .. } = access
        .handle_update(&update(private_text(1, OWNER, "hello")))
        .unwrap()
    else {
        panic!("expected a pairing reply");
    };
    access.approve(&code_in(&text)).unwrap();
}
