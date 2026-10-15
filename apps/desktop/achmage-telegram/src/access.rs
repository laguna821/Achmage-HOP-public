//! Owner allowlist and pairing: who may talk to the app, and how a stranger becomes the owner.
//! There is one owner: the AI accounts signed in on this PC are the owner's own, so once someone is approved
//! nobody else gets a pairing code until the owner is removed on the desktop.
//!
//! A message from an unknown user in a private chat gets an 8-digit code. The code is shown only
//! to that user on Telegram and stored only as `SHA-256(salt || code)`; the owner types it into
//! the desktop app, which calls [`AccessControl::approve`]. Nothing received over Telegram can
//! approve anyone. State persists in a small JSON file written atomically.

use crate::{
    api::{Message, Update, User},
    Error,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fmt::Write as _,
    fs,
    io::{self, Read, Write as _},
    path::{Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

/// A pairing code is valid for one hour.
pub const CODE_TTL_SECS: u64 = 3600;
/// At most one new code per user per ten minutes; messages in between are ignored.
pub const CODE_INTERVAL_SECS: u64 = 600;
/// At most this many users may wait for approval at once; further strangers are ignored.
pub const MAX_PENDING: usize = 3;
/// Wrong codes allowed before approvals lock.
pub const MAX_FAILED_APPROVALS: u32 = 5;
/// How long approvals stay locked after too many wrong codes.
pub const LOCKOUT_SECS: u64 = 3600;
const CODE_DIGITS: usize = 8;
const STATE_VERSION: u32 = 1;
const MAX_STATE_BYTES: u64 = 1024 * 1024;
const TEXT_ONLY: &str = "텍스트 메시지만 지원합니다. 사진·파일·음성은 처리하지 않습니다.";

/// Source of the current Unix time in seconds; injectable so expiry and rate limits are testable.
pub trait Clock: Send + Sync {
    /// Current Unix time in seconds.
    fn now(&self) -> u64;
}

/// Wall-clock time.
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_secs())
    }
}

/// A text message from an allowlisted user, queued for the app. The text is user content: show
/// it or answer it, never execute it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboundRequest {
    /// Telegram update id (unique, increasing).
    pub update_id: i64,
    /// Sender's Telegram user id; pass it to [`crate::Gateway::reply`].
    pub user_id: i64,
    /// Private chat id (equal to `user_id`).
    pub chat_id: i64,
    /// Sanitized sender name for display.
    pub display_name: String,
    /// Message text, verbatim.
    pub text: String,
    /// Unix time (seconds) the gateway processed the message.
    pub received_at: u64,
}

/// A user allowed to talk to the app.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AllowedUser {
    /// Telegram user id.
    pub user_id: i64,
    /// Sanitized name captured at pairing time.
    pub display_name: String,
    /// Unix time (seconds) of approval.
    pub approved_at: u64,
}

/// A pairing request waiting for the owner, as shown in the desktop UI. Carries no code or hash.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingRequest {
    /// Telegram user id of the requester.
    pub user_id: i64,
    /// Sanitized requester name.
    pub display_name: String,
    /// Unix time (seconds) the code was issued.
    pub created_at: u64,
    /// Unix time (seconds) the code stops working.
    pub expires_at: u64,
}

/// What the gateway should do with one update.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// Nothing: duplicate, non-private chat, bot, rate-limited pairing, or no message.
    Ignore,
    /// Queue this request for the app.
    Deliver(InboundRequest),
    /// Send this text to a private chat (pairing code or "text only" note).
    Reply {
        /// Private chat id (the user's id).
        chat_id: i64,
        /// Message text.
        text: String,
    },
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pending {
    user_id: i64,
    display_name: String,
    created_at: u64,
    expires_at: u64,
    salt: String,
    code_hash: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct State {
    version: u32,
    #[serde(default)]
    next_offset: i64,
    #[serde(default)]
    allowed: Vec<AllowedUser>,
    #[serde(default)]
    pending: Vec<Pending>,
    #[serde(default)]
    failed_approvals: u32,
    #[serde(default)]
    locked_until: u64,
}

impl Default for State {
    fn default() -> Self {
        Self {
            version: STATE_VERSION,
            next_offset: 0,
            allowed: Vec::new(),
            pending: Vec::new(),
            failed_approvals: 0,
            locked_until: 0,
        }
    }
}

/// Allowlist, pending pairing codes, approval lockout and the polling offset, persisted together.
pub struct AccessControl {
    path: PathBuf,
    clock: Arc<dyn Clock>,
    state: State,
}

impl AccessControl {
    /// Loads state from `path`, or starts empty when the file does not exist. A corrupt file is
    /// moved aside to `<path>.corrupt` and replaced by empty state on the next write.
    pub fn open(path: impl Into<PathBuf>, clock: Arc<dyn Clock>) -> Result<Self, Error> {
        let path = path.into();
        let state = load(&path)?;
        Ok(Self { path, clock, state })
    }
    /// Offset for the next `getUpdates` call (last processed `update_id + 1`).
    pub fn next_offset(&self) -> i64 {
        self.state.next_offset
    }
    /// Whether `user_id` may talk to the app.
    pub fn is_allowed(&self, user_id: i64) -> bool {
        self.state.allowed.iter().any(|u| u.user_id == user_id)
    }
    /// Allowlisted users.
    pub fn allowed(&self) -> Vec<AllowedUser> {
        self.state.allowed.clone()
    }
    /// Unexpired pairing requests, without codes or hashes.
    pub fn pending(&self) -> Vec<PendingRequest> {
        let now = self.clock.now();
        self.state
            .pending
            .iter()
            .filter(|p| p.expires_at > now)
            .map(|p| PendingRequest {
                user_id: p.user_id,
                display_name: p.display_name.clone(),
                created_at: p.created_at,
                expires_at: p.expires_at,
            })
            .collect()
    }
    /// Unix time when approvals unlock, if they are locked now.
    pub fn approval_locked_until(&self) -> Option<u64> {
        (self.state.locked_until > self.clock.now()).then_some(self.state.locked_until)
    }
    /// Approves the pending user whose code matches. Call only from the desktop UI. Every wrong
    /// code counts; after [`MAX_FAILED_APPROVALS`] approvals lock for [`LOCKOUT_SECS`].
    pub fn approve(&mut self, code: &str) -> Result<AllowedUser, Error> {
        let now = self.clock.now();
        self.prune(now);
        if self.state.locked_until > now {
            return Err(Error::ApprovalLocked {
                until: self.state.locked_until,
            });
        }
        let code: String = code
            .chars()
            .filter(|c| !c.is_whitespace() && *c != '-')
            .collect();
        let well_formed = code.len() == CODE_DIGITS && code.bytes().all(|b| b.is_ascii_digit());
        let found = if well_formed {
            self.find_pending(&code)
        } else {
            None
        };
        let Some(index) = found else {
            self.state.failed_approvals += 1;
            if self.state.failed_approvals >= MAX_FAILED_APPROVALS {
                self.state.locked_until = now.saturating_add(LOCKOUT_SECS);
                self.state.failed_approvals = 0;
            }
            self.persist()?;
            return Err(Error::CodeRejected);
        };
        let pending = self.state.pending.remove(index);
        let user = AllowedUser {
            user_id: pending.user_id,
            display_name: pending.display_name,
            approved_at: now,
        };
        self.state.allowed.retain(|u| u.user_id != user.user_id);
        self.state.allowed.push(user.clone());
        // One owner: the other requests are dropped.
        self.state.pending.clear();
        self.state.failed_approvals = 0;
        self.persist()?;
        Ok(user)
    }
    /// Removes `user_id` from the allowlist; returns whether it was there.
    pub fn revoke(&mut self, user_id: i64) -> Result<bool, Error> {
        let before = self.state.allowed.len();
        self.state.allowed.retain(|u| u.user_id != user_id);
        let removed = self.state.allowed.len() != before;
        if removed {
            self.persist()?;
        }
        Ok(removed)
    }
    /// Decides what to do with one update and advances the persisted offset. Updates below the
    /// offset (already processed) are ignored. The offset is saved before any reply is sent, so a
    /// crash can drop a reply but never deliver a request twice.
    pub fn handle_update(&mut self, update: &Update) -> Result<Action, Error> {
        if update.update_id < self.state.next_offset {
            return Ok(Action::Ignore);
        }
        let now = self.clock.now();
        self.prune(now);
        self.state.next_offset = update.update_id.saturating_add(1);
        let action = match &update.message {
            Some(message) => self.decide(message, update.update_id, now)?,
            None => Action::Ignore,
        };
        self.persist()?;
        Ok(action)
    }
    fn decide(&mut self, message: &Message, update_id: i64, now: u64) -> Result<Action, Error> {
        // Only one-to-one chats with a human. A private chat's id equals the sender's id, which
        // also guarantees replies can never land in a group.
        let Some(from) = message
            .from
            .as_ref()
            .filter(|u| !u.is_bot && message.chat.kind == "private" && message.chat.id == u.id)
        else {
            return Ok(Action::Ignore);
        };
        let name = display_name(from);
        if !self.is_allowed(from.id) {
            return self.start_pairing(from.id, name, now);
        }
        Ok(match &message.text {
            Some(text) => Action::Deliver(InboundRequest {
                update_id,
                user_id: from.id,
                chat_id: message.chat.id,
                display_name: name,
                text: text.clone(),
                received_at: now,
            }),
            None => Action::Reply {
                chat_id: message.chat.id,
                text: TEXT_ONLY.into(),
            },
        })
    }
    fn start_pairing(&mut self, user_id: i64, display_name: String, now: u64) -> Result<Action, Error> {
        if !self.state.allowed.is_empty() {
            return Ok(Action::Ignore);
        }
        let existing = self.state.pending.iter().position(|p| p.user_id == user_id);
        match existing {
            Some(i) if now < self.state.pending[i].created_at.saturating_add(CODE_INTERVAL_SECS) => {
                return Ok(Action::Ignore)
            }
            None if self.state.pending.len() >= MAX_PENDING => return Ok(Action::Ignore),
            _ => {}
        }
        let code = new_code()?;
        let salt: [u8; 16] = random()?;
        let entry = Pending {
            user_id,
            display_name,
            created_at: now,
            expires_at: now.saturating_add(CODE_TTL_SECS),
            salt: hex(&salt),
            code_hash: hex(&code_hash(&salt, &code)),
        };
        // A re-issued code replaces the old one, so each user holds at most one valid code.
        match existing {
            Some(i) => self.state.pending[i] = entry,
            None => self.state.pending.push(entry),
        }
        Ok(Action::Reply {
            chat_id: user_id,
            text: format!(
                "HOP 데스크톱 앱 연결 요청을 받았습니다.\n\n연결 코드: {code}\n\n\
                 HOP 앱의 텔레그램 설정에서 이 코드를 입력하면 연결이 승인됩니다. \
                 코드는 1시간 동안 유효합니다. 요청한 적이 없다면 무시하세요."
            ),
        })
    }
    fn find_pending(&self, code: &str) -> Option<usize> {
        // Check every entry without stopping early, comparing in constant time.
        let mut found = None;
        for (index, pending) in self.state.pending.iter().enumerate() {
            let (Some(salt), Some(stored)) = (
                decode_hex::<16>(&pending.salt),
                decode_hex::<32>(&pending.code_hash),
            ) else {
                continue;
            };
            if constant_time_eq(&code_hash(&salt, code), &stored) {
                found = Some(index);
            }
        }
        found
    }
    fn prune(&mut self, now: u64) {
        self.state.pending.retain(|p| p.expires_at > now);
        if self.state.locked_until != 0 && self.state.locked_until <= now {
            self.state.locked_until = 0;
            self.state.failed_approvals = 0;
        }
    }
    fn persist(&self) -> Result<(), Error> {
        let bytes = serde_json::to_vec_pretty(&self.state).map_err(|_| save_failed())?;
        write_atomic(&self.path, &bytes).map_err(|_| save_failed())
    }
}

fn save_failed() -> Error {
    Error::State("텔레그램 상태 파일을 저장하지 못했습니다.".into())
}

fn load(path: &Path) -> Result<State, Error> {
    let bytes = match read_bounded(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(State::default()),
        Err(_) => return Err(Error::State("텔레그램 상태 파일을 읽지 못했습니다.".into())),
    };
    Ok(parse_state(&bytes).unwrap_or_else(|| {
        quarantine(path);
        State::default()
    }))
}

fn read_bounded(path: &Path) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(MAX_STATE_BYTES + 1)
        .read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn parse_state(bytes: &[u8]) -> Option<State> {
    if bytes.len() as u64 > MAX_STATE_BYTES {
        return None;
    }
    let mut state: State = serde_json::from_slice(bytes).ok()?;
    if state.version != STATE_VERSION {
        return None;
    }
    state.next_offset = state.next_offset.max(0);
    state.pending.retain(|p| {
        decode_hex::<16>(&p.salt).is_some() && decode_hex::<32>(&p.code_hash).is_some()
    });
    state.pending.truncate(MAX_PENDING);
    Some(state)
}

fn quarantine(path: &Path) {
    let mut name = path.as_os_str().to_owned();
    name.push(".corrupt");
    let target = PathBuf::from(name);
    // Keep the evidence; starting empty is safer than trusting a damaged allowlist.
    if fs::rename(path, &target).is_err() {
        let _ = fs::copy(path, &target);
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    fs::create_dir_all(parent)?;
    let mut name = path
        .file_name()
        .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?
        .to_owned();
    let nonce: [u8; 8] = random().map_err(|_| io::Error::other("no secure random"))?;
    name.push(format!(".{}.tmp", hex(&nonce)));
    let temp = parent.join(name);
    // Same-directory rename replaces the old file in one step (MoveFileEx on Windows).
    let result = write_new(&temp, bytes).and_then(|()| fs::rename(&temp, path));
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn write_new(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

fn display_name(user: &User) -> String {
    let mut name = user.first_name.clone();
    if let Some(last) = &user.last_name {
        name.push(' ');
        name.push_str(last);
    }
    if let Some(handle) = &user.username {
        name.push_str(" (@");
        name.push_str(handle);
        name.push(')');
    }
    // Names are attacker-controlled: drop control and bidi/invisible characters that could make
    // a stranger look like someone else in the approval list.
    let clean: String = name
        .chars()
        .filter(|c| !c.is_control() && !is_invisible(*c))
        .take(64)
        .collect();
    let clean = clean.trim();
    if clean.is_empty() {
        format!("텔레그램 사용자 {}", user.id)
    } else {
        clean.to_string()
    }
}

pub(crate) fn is_invisible(c: char) -> bool {
    matches!(
        c,
        '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2069}' | '\u{FEFF}'
    )
}

fn new_code() -> Result<String, Error> {
    // Rejection sampling keeps all 10^8 codes equally likely.
    loop {
        let n = u32::from_le_bytes(random()?);
        if n < 4_200_000_000 {
            return Ok(format!("{:08}", n % 100_000_000));
        }
    }
}

fn random<const N: usize>() -> Result<[u8; N], Error> {
    let mut bytes = [0u8; N];
    getrandom::getrandom(&mut bytes)
        .map_err(|_| Error::State("보안 난수를 만들지 못했습니다.".into()))?;
    Ok(bytes)
}

fn code_hash(salt: &[u8; 16], code: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(salt);
    hasher.update(code.as_bytes());
    hasher.finalize().into()
}

fn constant_time_eq(a: &[u8; 32], b: &[u8; 32]) -> bool {
    // Fold every byte so timing does not reveal where the first mismatch is.
    let diff = a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y));
    std::hint::black_box(diff) == 0
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(out, "{b:02x}");
    }
    out
}

fn decode_hex<const N: usize>(text: &str) -> Option<[u8; N]> {
    if text.len() != N * 2 {
        return None;
    }
    let mut out = [0u8; N];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(text.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}
