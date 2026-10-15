//! Long-polling gateway: one background task turns owner messages into [`InboundRequest`]s and
//! answers pairing requests, while the desktop UI approves codes and sends replies.

use crate::{
    access::{
        AccessControl, Action, AllowedUser, Clock, InboundRequest, PendingRequest, SystemClock,
    },
    api::{BotApi, BotInfo, Update},
    Error,
};
use serde::Serialize;
use std::{
    collections::VecDeque,
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};
use tokio::{
    sync::{oneshot, watch, Notify},
    task::JoinHandle,
};

/// Long-poll wait per `getUpdates` call.
pub const POLL_TIMEOUT_SECS: u64 = 25;
/// Requests waiting for the app; further owner messages get a "busy" reply and are dropped.
pub const QUEUE_CAPACITY: usize = 32;
const MAX_BACKOFF_SECS: u64 = 60;
const MAX_RATE_LIMIT_WAIT_SECS: u64 = 300;
const STOP_GRACE: Duration = Duration::from_secs(2);
const BUSY: &str = "HOP 앱이 지금 밀린 요청을 처리하고 있습니다. 잠시 후 다시 보내 주세요.";

/// Gateway state for the UI. Reasons are Korean and never contain secrets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum GatewayStatus {
    /// Not started, or stopped by the user.
    Disabled,
    /// Verifying the token, or reconnecting after a network error.
    Connecting,
    /// Polling for messages.
    Running {
        /// Bot username without `@`.
        bot_username: String,
    },
    /// Stopped on its own; the user must fix the cause and start again.
    Stopped {
        /// Why, in Korean.
        reason: String,
    },
}

struct Shared {
    access: Mutex<AccessControl>,
    status: Mutex<GatewayStatus>,
    queue: Mutex<VecDeque<InboundRequest>>,
    arrived: Notify,
    api: Mutex<Option<Arc<BotApi>>>,
}

impl Shared {
    fn set_status(&self, status: GatewayStatus) {
        *lock(&self.status) = status;
    }
    fn set_api(&self, api: Option<Arc<BotApi>>) {
        *lock(&self.api) = api;
    }
    fn enqueue(&self, request: InboundRequest) -> bool {
        {
            let mut queue = lock(&self.queue);
            if queue.len() >= QUEUE_CAPACITY {
                return false;
            }
            queue.push_back(request);
        }
        self.arrived.notify_one();
        true
    }
}

struct Running {
    stop: watch::Sender<bool>,
    task: JoinHandle<()>,
}

/// The Telegram gateway. Create one per app; it is `Send + Sync` and every async method returns
/// a `Send` future, so it can live in shared app state.
pub struct Gateway {
    shared: Arc<Shared>,
    running: tokio::sync::Mutex<Option<Running>>,
}

impl Gateway {
    /// Opens the gateway with its state file (allowlist, pending codes, polling offset). The
    /// caller chooses the path, typically inside the app data directory.
    pub fn open(state_path: impl Into<PathBuf>) -> Result<Self, Error> {
        Self::open_with_clock(state_path, Arc::new(SystemClock))
    }
    /// Like [`Gateway::open`] with an injected clock (tests).
    pub fn open_with_clock(
        state_path: impl Into<PathBuf>,
        clock: Arc<dyn Clock>,
    ) -> Result<Self, Error> {
        let access = AccessControl::open(state_path, clock)?;
        Ok(Self {
            shared: Arc::new(Shared {
                access: Mutex::new(access),
                status: Mutex::new(GatewayStatus::Disabled),
                queue: Mutex::new(VecDeque::new()),
                arrived: Notify::new(),
                api: Mutex::new(None),
            }),
            running: tokio::sync::Mutex::new(None),
        })
    }
    /// Verifies the token with `getMe`, then spawns the polling task. Any previous task is
    /// stopped first. Must be called inside a tokio runtime.
    pub async fn start(&self, api: BotApi) -> Result<BotInfo, Error> {
        let mut slot = self.running.lock().await;
        if let Some(previous) = slot.take() {
            shutdown(previous).await;
        }
        self.shared.set_api(None);
        self.shared.set_status(GatewayStatus::Connecting);
        let (stop, stop_rx) = watch::channel(false);
        let (ready, ready_rx) = oneshot::channel();
        let task = tokio::spawn(run(self.shared.clone(), Arc::new(api), stop_rx, ready));
        *slot = Some(Running { stop, task });
        drop(slot);
        // A stop() racing with verification drops the sender before a verdict arrives.
        ready_rx.await.unwrap_or(Err(Error::NotRunning))
    }
    /// Stops polling promptly, aborting an in-flight long poll, and disables replies.
    pub async fn stop(&self) {
        let mut slot = self.running.lock().await;
        if let Some(previous) = slot.take() {
            shutdown(previous).await;
        }
        self.shared.set_api(None);
        self.shared.set_status(GatewayStatus::Disabled);
    }
    /// Current state for the UI.
    pub fn status(&self) -> GatewayStatus {
        lock(&self.shared.status).clone()
    }
    /// Drains queued requests, oldest first.
    pub fn take_requests(&self) -> Vec<InboundRequest> {
        lock(&self.shared.queue).drain(..).collect()
    }
    /// Resolves once at least one request is queued (immediately if one already is).
    pub async fn wait_for_requests(&self) {
        loop {
            let empty = lock(&self.shared.queue).is_empty();
            if !empty {
                return;
            }
            self.shared.arrived.notified().await;
        }
    }
    /// Sends `text` to `user_id`'s private chat, only while that user is allowlisted and the bot
    /// is connected. Long text is split into several messages.
    pub async fn reply(&self, user_id: i64, text: &str) -> Result<(), Error> {
        self.reply_target(user_id)?
            .send_message(user_id, text)
            .await
    }
    /// Sends a generated document to `user_id`'s private chat, under the same allowlist and
    /// connection rules as [`Gateway::reply`] (see [`BotApi::send_document`] for limits).
    pub async fn reply_document(
        &self,
        user_id: i64,
        file_name: &str,
        bytes: Vec<u8>,
        caption: Option<&str>,
    ) -> Result<(), Error> {
        self.reply_target(user_id)?
            .send_document(user_id, file_name, bytes, caption)
            .await
    }
    fn reply_target(&self, user_id: i64) -> Result<Arc<BotApi>, Error> {
        if !lock(&self.shared.access).is_allowed(user_id) {
            return Err(Error::NotAllowed);
        }
        // Replies go to chat id == user id: a private chat, never a group.
        lock(&self.shared.api).clone().ok_or(Error::NotRunning)
    }
    /// Approves the pending user whose pairing code the owner typed into the desktop app.
    pub fn approve(&self, code: &str) -> Result<AllowedUser, Error> {
        lock(&self.shared.access).approve(code)
    }
    /// Pairing requests waiting for approval (no codes or hashes).
    pub fn pending(&self) -> Vec<PendingRequest> {
        lock(&self.shared.access).pending()
    }
    /// Allowlisted users.
    pub fn allowed(&self) -> Vec<AllowedUser> {
        lock(&self.shared.access).allowed()
    }
    /// Unix time when approvals unlock, if they are locked after too many wrong codes.
    pub fn approval_locked_until(&self) -> Option<u64> {
        lock(&self.shared.access).approval_locked_until()
    }
    /// Removes a user from the allowlist; returns whether it was there.
    pub fn revoke(&self, user_id: i64) -> Result<bool, Error> {
        lock(&self.shared.access).revoke(user_id)
    }
}

impl Drop for Gateway {
    fn drop(&mut self) {
        if let Some(running) = self.running.get_mut().take() {
            let _ = running.stop.send(true);
            running.task.abort();
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // State is only mutated in short synchronous sections; a poisoned lock still holds it.
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

async fn shutdown(mut running: Running) {
    let _ = running.stop.send(true);
    if tokio::time::timeout(STOP_GRACE, &mut running.task)
        .await
        .is_err()
    {
        running.task.abort();
        let _ = running.task.await;
    }
}

async fn stopped(stop: &mut watch::Receiver<bool>) {
    // A dropped sender (gateway dropped) also means stop.
    let _ = stop.wait_for(|stop| *stop).await;
}

fn stopped_status(error: &Error) -> GatewayStatus {
    let reason = match error {
        Error::Conflict => "다른 프로그램이 이 봇을 사용하고 있습니다(다른 앱의 메시지 수신 또는 웹훅). \
                            그 프로그램을 끈 뒤 다시 시작하세요."
            .to_string(),
        Error::InvalidToken => {
            "텔레그램이 봇 토큰을 거부했습니다. 설정에서 토큰을 다시 입력하세요.".to_string()
        }
        Error::State(_) => "텔레그램 상태 파일을 저장하지 못해 중지했습니다.".to_string(),
        other => format!("텔레그램 연결을 확인하지 못했습니다: {other}"),
    };
    GatewayStatus::Stopped { reason }
}

async fn run(
    shared: Arc<Shared>,
    api: Arc<BotApi>,
    mut stop: watch::Receiver<bool>,
    ready: oneshot::Sender<Result<BotInfo, Error>>,
) {
    let verified = tokio::select! {
        _ = stopped(&mut stop) => return,
        result = api.get_me() => result,
    };
    let me = match verified {
        Ok(me) => me,
        Err(error) => {
            shared.set_status(stopped_status(&error));
            let _ = ready.send(Err(error));
            return;
        }
    };
    let running = GatewayStatus::Running {
        bot_username: me.username.clone(),
    };
    shared.set_api(Some(api.clone()));
    shared.set_status(running.clone());
    let _ = ready.send(Ok(me));
    let mut backoff = 1;
    loop {
        let offset = lock(&shared.access).next_offset();
        let polled = tokio::select! {
            _ = stopped(&mut stop) => return,
            result = api.get_updates(offset, POLL_TIMEOUT_SECS) => result,
        };
        let wait = match polled {
            Ok(updates) => {
                backoff = 1;
                shared.set_status(running.clone());
                if !process(&shared, &api, updates, &mut stop).await {
                    return;
                }
                continue;
            }
            Err(error @ (Error::Conflict | Error::InvalidToken)) => {
                shared.set_status(stopped_status(&error));
                return;
            }
            Err(Error::RateLimited { retry_after }) => {
                retry_after.clamp(1, MAX_RATE_LIMIT_WAIT_SECS)
            }
            Err(_) => {
                shared.set_status(GatewayStatus::Connecting);
                let wait = backoff;
                backoff = (backoff * 2).min(MAX_BACKOFF_SECS);
                wait
            }
        };
        tokio::select! {
            _ = stopped(&mut stop) => return,
            _ = tokio::time::sleep(Duration::from_secs(wait)) => {}
        }
    }
}

/// Handles one batch in update order; returns false when the task must end.
async fn process(
    shared: &Shared,
    api: &BotApi,
    updates: Vec<Update>,
    stop: &mut watch::Receiver<bool>,
) -> bool {
    for update in updates {
        let action = lock(&shared.access).handle_update(&update);
        let (chat_id, text) = match action {
            Err(error) => {
                shared.set_status(stopped_status(&error));
                return false;
            }
            Ok(Action::Ignore) => continue,
            Ok(Action::Deliver(request)) => {
                let chat_id = request.chat_id;
                if shared.enqueue(request) {
                    continue;
                }
                (chat_id, BUSY.to_string())
            }
            Ok(Action::Reply { chat_id, text }) => (chat_id, text),
        };
        // Delivery failures are not fatal: the user can resend, and pairing allows a new code
        // after the rate-limit window.
        tokio::select! {
            _ = stopped(stop) => return false,
            _ = api.send_message(chat_id, &text) => {}
        }
    }
    true
}
