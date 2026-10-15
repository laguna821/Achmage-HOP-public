//! Telegram remote access to HOP's AI, also while no HOP window is open.
//!
//! - One [`Gateway`] per app (state in `app_local_data_dir/telegram/state.json`, bot token only in
//!   the OS credential store) and one worker that turns owner messages into replies
//!   ([`router`]). Remote chats drive the same provider sessions as the AI panel, under the label
//!   `telegram-<user id>`, so the CLIs run in the same no-tool modes.
//! - With Telegram enabled and "keep running" on, closing the last window keeps the process alive
//!   with a tray icon, and `--background` starts it with no window. Otherwise nothing changes.
//! - Commands for the settings screen never return the token.
//! - `/doc` makes an HWPX with the fixed Kordoc engine and sends it as a file; `/ask` reads the text
//!   of an open document through its window ([`DocumentReads`]), which answers only for itself.

mod autostart;
mod outbound_gate;
mod remote_templates;
mod router;

pub(crate) use autostart::is_background_launch;

use ::achmage_telegram::{
    AllowedUser, BotApi, BotToken, Error, Gateway, GatewayStatus, InboundRequest, OsSecretStore,
    SecretStore,
};
use hangul_ai_session::bridge::Action;
use router::{Admitted, ChatBackend, Command, DocumentText, Generated, Limits, OpenDocument, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, MutexGuard,
    },
    time::{Duration, Instant},
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, State, WebviewWindow, Wry,
};
use tokio::sync::{oneshot, Notify};
use zeroize::Zeroizing;

const STATE_FILE: &str = "state.json";
const SETTINGS_FILE: &str = "settings.json";
const MAX_SETTINGS_BYTES: usize = 64 * 1024;
const TRAY_ID: &str = "hop-telegram";
// Tray menu ids carry no ':' so the macOS app menu never forwards them to a document window.
const MENU_OPEN: &str = "hop-telegram-open";
const MENU_STATUS: &str = "hop-telegram-status";
const MENU_QUIT: &str = "hop-telegram-quit";
const TRAY_REFRESH: Duration = Duration::from_secs(3);
/// After a failed credential-store read (locked Keychain or Secret Service), background readers
/// (tray) wait this long before asking again; the settings dialog waits `TOKEN_RETRY_DIALOG`.
const TOKEN_RETRY_BACKGROUND: Duration = Duration::from_secs(300);
const TOKEN_RETRY_DIALOG: Duration = Duration::from_secs(60);
const APPROVED: &str = "연결되었습니다. 이제 이 대화에서 Achmage HOP의 AI를 쓸 수 있습니다. /help 로 사용법을 확인하세요.";

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn text(error: Error) -> String {
    error.to_string()
}

/// Non-secret switches, persisted next to the gateway state.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct Settings {
    /// Run the gateway.
    pub enabled: bool,
    /// Keep HOP running in the tray after the last window closes.
    pub keep_running: bool,
    /// Bot behind the stored token; a different bot starts with fresh pairing state.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bot_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bot_username: Option<String>,
}

impl Settings {
    fn load(dir: &Path) -> Self {
        match std::fs::read(dir.join(SETTINGS_FILE)) {
            Ok(bytes) if bytes.len() <= MAX_SETTINGS_BYTES => {
                serde_json::from_slice(&bytes).unwrap_or_default()
            }
            _ => Self::default(),
        }
    }

    fn save(&self, dir: &Path) -> Result<(), String> {
        fn failed<E>(_: E) -> String {
            "텔레그램 설정을 저장하지 못했습니다.".to_owned()
        }
        std::fs::create_dir_all(dir).map_err(failed)?;
        let bytes = serde_json::to_vec_pretty(self).map_err(failed)?;
        let temp = dir.join(format!("{SETTINGS_FILE}.tmp"));
        std::fs::write(&temp, bytes).map_err(failed)?;
        std::fs::rename(&temp, dir.join(SETTINGS_FILE)).map_err(failed)
    }
}

/// Inputs of the "close the last window" decision.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct ExitInputs {
    /// `app.exit(code)` was called (tray "종료", the app quit flow), not a last-window close.
    pub explicit_exit: bool,
    /// The owner chose "종료" in the tray and windows are closing.
    pub quitting: bool,
    pub enabled: bool,
    pub keep_running: bool,
    /// The gateway is polling or reconnecting.
    pub gateway_active: bool,
    /// The tray icon exists, so the owner can still reach and quit HOP.
    pub tray_present: bool,
}

/// Whether closing the last window must leave HOP running in the tray. Without a tray icon the
/// process would be invisible and unquittable, so it exits as usual.
pub(crate) fn should_keep_running(inputs: ExitInputs) -> bool {
    !inputs.explicit_exit
        && !inputs.quitting
        && inputs.enabled
        && inputs.keep_running
        && inputs.gateway_active
        && inputs.tray_present
}

/// Tracks the tray's "종료", which closes every window through its own unsaved-changes prompt.
/// The front end has no cancel path, so the quit counts as abandoned when a window it asked to
/// close is asked to close again (its first prompt was cancelled), when a window it did not ask
/// about closes, or when a new window opens. An abandoned quit lets the tray keep HOP running.
#[derive(Debug, Default)]
pub(crate) struct QuitTracker {
    /// Windows asked to close, and whether a close request has reached each since.
    pending: Option<HashMap<String, bool>>,
}

impl QuitTracker {
    pub(crate) fn begin(&mut self, labels: impl IntoIterator<Item = String>) {
        self.pending = Some(labels.into_iter().map(|label| (label, false)).collect());
    }
    pub(crate) fn cancel(&mut self) {
        self.pending = None;
    }
    pub(crate) fn quitting(&self) -> bool {
        self.pending.is_some()
    }
    pub(crate) fn close_requested(&mut self, label: &str) {
        let Some(pending) = self.pending.as_mut() else {
            return;
        };
        let first = match pending.get_mut(label) {
            Some(seen) if !*seen => {
                *seen = true;
                true
            }
            _ => false,
        };
        if !first {
            self.pending = None;
        }
    }
    pub(crate) fn destroyed(&mut self, label: &str) {
        if let Some(pending) = self.pending.as_mut() {
            pending.remove(label);
        }
    }
    pub(crate) fn window_opened(&mut self) {
        self.pending = None;
    }
}

/// Cached answer to "is a bot token stored?". The token itself is never kept.
#[derive(Debug, Default)]
struct TokenCache {
    known: Option<bool>,
    failed_at: Option<Instant>,
}

/// Gateway, token and switches; independent of Tauri so it can be tested in a temp directory.
pub(crate) struct Service {
    dir: PathBuf,
    gateway: Mutex<Result<Arc<Gateway>, String>>,
    /// Signals the worker that `gateway` was replaced.
    changed: Notify,
    secrets: Arc<dyn SecretStore>,
    settings: Mutex<Settings>,
    token: Mutex<TokenCache>,
    quit: Mutex<QuitTracker>,
    /// Serializes start, stop and token changes.
    control: tokio::sync::Mutex<()>,
}

impl Service {
    pub(crate) fn open(dir: PathBuf, secrets: Arc<dyn SecretStore>) -> Self {
        let gateway = open_gateway(&dir);
        let settings = Settings::load(&dir);
        Self {
            dir,
            gateway: Mutex::new(gateway),
            changed: Notify::new(),
            secrets,
            settings: Mutex::new(settings),
            token: Mutex::default(),
            quit: Mutex::default(),
            control: tokio::sync::Mutex::new(()),
        }
    }

    fn gateway(&self) -> Result<Arc<Gateway>, Error> {
        lock(&self.gateway).clone().map_err(Error::State)
    }

    pub(crate) fn settings(&self) -> Settings {
        lock(&self.settings).clone()
    }

    fn update(&self, change: impl FnOnce(&mut Settings)) -> Result<Settings, String> {
        let mut current = lock(&self.settings);
        let mut next = current.clone();
        change(&mut next);
        next.save(&self.dir)?;
        *current = next.clone();
        Ok(next)
    }

    /// Whether a token is stored. A successful read is cached for good (token changes go through
    /// this service); a failed read is not retried for `retry_after`, so a locked credential store
    /// is not asked again every few seconds. The token itself is dropped (and wiped) at once.
    fn has_token(&self, retry_after: Duration) -> bool {
        let mut cache = lock(&self.token);
        if let Some(known) = cache.known {
            return known;
        }
        if cache.failed_at.is_some_and(|at| at.elapsed() < retry_after) {
            return false;
        }
        match BotToken::load(&*self.secrets) {
            Ok(token) => {
                cache.failed_at = None;
                *cache.known.insert(token.is_some())
            }
            Err(_) => {
                cache.failed_at = Some(Instant::now());
                false
            }
        }
    }

    fn set_has_token(&self, stored: bool) {
        *lock(&self.token) = TokenCache {
            known: Some(stored),
            failed_at: None,
        };
    }

    fn status(&self) -> GatewayStatus {
        match &*lock(&self.gateway) {
            Ok(gateway) => gateway.status(),
            Err(reason) => GatewayStatus::Stopped {
                reason: reason.clone(),
            },
        }
    }

    pub(crate) fn gateway_active(&self) -> bool {
        matches!(
            self.status(),
            GatewayStatus::Running { .. } | GatewayStatus::Connecting
        )
    }

    pub(crate) fn shows_tray(&self) -> bool {
        let settings = self.settings();
        settings.enabled && settings.keep_running
    }

    pub(crate) fn keep_running_on_exit(&self, explicit_exit: bool, tray_present: bool) -> bool {
        let settings = self.settings();
        should_keep_running(ExitInputs {
            explicit_exit,
            quitting: lock(&self.quit).quitting(),
            enabled: settings.enabled,
            keep_running: settings.keep_running,
            gateway_active: self.gateway_active(),
            tray_present,
        })
    }

    fn allowed_ids(&self) -> Vec<i64> {
        self.gateway()
            .map(|gateway| gateway.allowed().into_iter().map(|u| u.user_id).collect())
            .unwrap_or_default()
    }

    /// Settings-screen state. Never contains the token.
    pub(crate) fn status_json(&self, autostart: bool) -> Value {
        let settings = self.settings();
        let has_token = self.has_token(TOKEN_RETRY_DIALOG);
        let status = self.status();
        let bot_username = match &status {
            GatewayStatus::Running { bot_username } => Some(bot_username.clone()),
            _ => settings.bot_username.clone().filter(|_| has_token),
        };
        let (pending, allowed, locked_until) = match self.gateway() {
            Ok(gateway) => (
                json!(gateway.pending()),
                json!(gateway.allowed()),
                json!(gateway.approval_locked_until()),
            ),
            Err(_) => (json!([]), json!([]), Value::Null),
        };
        json!({
            "status": status,
            "botUsername": bot_username,
            "hasToken": has_token,
            "enabled": settings.enabled,
            "keepRunning": settings.keep_running,
            "autostart": autostart,
            "pending": pending,
            "allowed": allowed,
            "approvalLockedUntil": locked_until,
        })
    }

    /// Starts polling when enabled and a token is stored. Callers hold `control`.
    async fn start_if_ready(&self, token_retry: Duration) -> Result<(), Error> {
        if !self.settings().enabled || !self.has_token(token_retry) {
            return Ok(());
        }
        let api = BotApi::from_store(&*self.secrets)?;
        let me = self.gateway()?.start(api).await?;
        let _ = self.update(|s| s.bot_username = Some(me.username));
        Ok(())
    }

    /// App start: the network may not be up yet right after login, so connection failures are
    /// retried for a few minutes while the owner keeps Telegram enabled.
    pub(crate) async fn start_at_launch(&self) {
        let mut wait = 5;
        for _ in 0..8 {
            let started = {
                let _control = self.control.lock().await;
                self.start_if_ready(TOKEN_RETRY_BACKGROUND).await
            };
            match started {
                Err(Error::Network | Error::RateLimited { .. }) => {
                    tokio::time::sleep(Duration::from_secs(wait)).await;
                    wait = (wait * 2).min(120);
                }
                Err(error) => {
                    eprintln!("[telegram] 시작하지 못했습니다: {error}");
                    return;
                }
                Ok(()) => return,
            }
        }
    }

    pub(crate) async fn stop(&self) {
        if let Ok(gateway) = self.gateway() {
            gateway.stop().await;
        }
    }

    /// Verifies the token with `getMe`, stores it, and (re)starts when enabled. Returns whether
    /// the bot changed, in which case pairing state starts fresh.
    pub(crate) async fn set_token(&self, raw: &str) -> Result<bool, String> {
        let _control = self.control.lock().await;
        let api = BotApi::new(BotToken::parse(raw).map_err(text)?).map_err(text)?;
        let me = api.get_me().await.map_err(text)?;
        BotToken::parse(raw)
            .and_then(|token| token.save(&*self.secrets))
            .map_err(text)?;
        self.set_has_token(true);
        let changed = self.settings().bot_id.is_some_and(|id| id != me.id);
        if changed {
            self.reset_state().await?;
        }
        let settings = self.update(|s| {
            s.bot_id = Some(me.id);
            s.bot_username = Some(me.username.clone());
        })?;
        if settings.enabled {
            self.gateway().map_err(text)?.start(api).await.map_err(text)?;
        }
        Ok(changed)
    }

    /// Pairing state and the polling offset belong to one bot.
    async fn reset_state(&self) -> Result<(), String> {
        let previous = lock(&self.gateway).clone();
        if let Ok(gateway) = previous {
            gateway.stop().await;
        }
        match std::fs::remove_file(self.dir.join(STATE_FILE)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("이전 봇의 연결 상태를 지우지 못했습니다.".to_owned()),
        }
        *lock(&self.gateway) = open_gateway(&self.dir);
        self.changed.notify_one();
        Ok(())
    }

    pub(crate) async fn clear_token(&self) -> Result<(), String> {
        let _control = self.control.lock().await;
        self.stop().await;
        BotToken::clear(&*self.secrets).map_err(text)?;
        self.set_has_token(false);
        Ok(())
    }

    /// Persists the switch, then starts or stops. A failed start is reported through the status.
    pub(crate) async fn set_enabled(&self, enabled: bool) -> Result<(), String> {
        let _control = self.control.lock().await;
        self.update(|s| s.enabled = enabled)?;
        if enabled {
            // The owner's own switch: ask the credential store again even after a failure.
            if let Err(error) = self.start_if_ready(Duration::ZERO).await {
                eprintln!("[telegram] 시작하지 못했습니다: {error}");
            }
        } else {
            self.stop().await;
        }
        Ok(())
    }

    pub(crate) fn set_keep_running(&self, keep_running: bool) -> Result<(), String> {
        self.update(|s| s.keep_running = keep_running)?;
        Ok(())
    }

    pub(crate) fn approve(&self, code: &str) -> Result<AllowedUser, String> {
        self.gateway().and_then(|g| g.approve(code)).map_err(text)
    }

    pub(crate) fn revoke(&self, user_id: i64) -> Result<bool, String> {
        self.gateway().and_then(|g| g.revoke(user_id)).map_err(text)
    }
}

fn open_gateway(dir: &Path) -> Result<Arc<Gateway>, String> {
    Gateway::open(dir.join(STATE_FILE))
        .map(Arc::new)
        .map_err(text)
}

/// Asks a document window for its text (`achmage-telegram-read-document`, answered with
/// `achmage_telegram_document_text`). A reply counts only from the window that was asked.
#[derive(Default)]
pub(crate) struct DocumentReads {
    next: AtomicU64,
    /// Request id → (window asked, where its answer goes).
    pending: Mutex<HashMap<String, (String, ReadAnswer)>>,
}

type ReadAnswer = oneshot::Sender<Result<DocumentText, String>>;

const READ_EVENT: &str = "achmage-telegram-read-document";
const READ_TIMEOUT: Duration = Duration::from_secs(20);
/// Largest document text a window may send: its own budget (`REMOTE_TEXT_BUDGET`).
const READ_LIMIT: usize = 256 * 1024;

/// Removes a read request when its wait ends in any way.
struct PendingRead<'a> {
    reads: &'a DocumentReads,
    id: String,
}

impl Drop for PendingRead<'_> {
    fn drop(&mut self) {
        lock(&self.reads.pending).remove(&self.id);
    }
}

impl DocumentReads {
    async fn read(&self, app: &AppHandle, label: &str) -> Result<DocumentText, String> {
        if app.get_webview_window(label).is_none() {
            return Err("문서 창이 닫혔습니다.".into());
        }
        let id = format!("read-{}", self.next.fetch_add(1, Ordering::Relaxed) + 1);
        let (sender, receiver) = oneshot::channel();
        lock(&self.pending).insert(id.clone(), (label.to_owned(), sender));
        let _pending = PendingRead {
            reads: self,
            id: id.clone(),
        };
        app.emit_to(label, READ_EVENT, json!({ "requestId": id }))
            .map_err(|_| "문서 창에 요청을 보내지 못했습니다.".to_owned())?;
        match tokio::time::timeout(READ_TIMEOUT, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("문서 창이 응답하지 않았습니다.".into()),
            Err(_) => Err("문서 창이 20초 안에 응답하지 않았습니다. PC의 Achmage HOP이 바쁜지 확인해 주세요.".into()),
        }
    }

    fn answer(&self, label: &str, id: &str, result: Result<DocumentText, String>) -> Result<(), String> {
        let mut pending = lock(&self.pending);
        if pending.get(id).is_none_or(|(asked, _)| asked != label) {
            return Err("요청하지 않은 문서 응답입니다.".into());
        }
        if let Some((_, sender)) = pending.remove(id) {
            let _ = sender.send(result);
        }
        Ok(())
    }
}

/// A window title as the owner knows it: "• 회의록 - Achmage HOP" → "회의록 (저장 안 됨)".
fn document_title(window_title: &str) -> String {
    let title = window_title.trim();
    let title = title.strip_suffix(" - Achmage HOP").or_else(|| title.strip_suffix(" - HOP")).unwrap_or(title);
    let (title, dirty) = match title.strip_prefix("• ") {
        Some(title) => (title, true),
        None => (title, false),
    };
    let title = if title.is_empty() || title == "HOP" || title == "Achmage HOP" { "빈 창" } else { title };
    let title: String = title.chars().take(80).collect();
    if dirty {
        format!("{title} (저장 안 됨)")
    } else {
        title
    }
}

/// Remote sessions on the panel's provider machinery (`achmage_ai`).
pub(crate) struct AppBackend {
    app: AppHandle,
    reads: Arc<DocumentReads>,
}

/// Remote messages may only select a provider, check sign-in status, ask, and cancel their own
/// turn. Login, logout and model refresh stay on the desktop (a login would open a browser there).
/// The status check is refused for a provider the owner disconnected on the desktop
/// (`achmage_ai::disconnect_gate`), so a phone can never undo a desktop disconnect.
fn remote_action_allowed(action: &Action) -> bool {
    matches!(
        action,
        Action::SelectProvider { .. }
            | Action::RestoreConnection {}
            | Action::Send { .. }
            | Action::CancelTurn { .. }
    )
}

impl ChatBackend for AppBackend {
    fn snapshot(&self, session: &str) -> Result<Value, String> {
        let ai = self.app.state::<crate::achmage_ai::AiState>();
        let mut state = crate::achmage_ai::snapshot(&self.app, &ai, session)?;
        state["accounts"] = crate::achmage_ai::accounts(&ai, session);
        Ok(state)
    }
    fn act(&self, session: &str, action: Action) -> Result<Value, String> {
        if !remote_action_allowed(&action) {
            return Err("원격에서는 AI 로그인과 로그아웃을 할 수 없습니다.".to_owned());
        }
        let ai = self.app.state::<crate::achmage_ai::AiState>();
        crate::achmage_ai::act(&self.app, &ai, session, action)
    }
    fn end(&self, session: &str) {
        crate::achmage_ai::close(&self.app.state::<crate::achmage_ai::AiState>(), session);
    }
    fn documents(&self) -> Vec<OpenDocument> {
        let mut documents: Vec<OpenDocument> = self
            .app
            .webview_windows()
            .into_iter()
            .map(|(label, window)| OpenDocument {
                title: document_title(&window.title().unwrap_or_default()),
                focused: window.is_focused().unwrap_or(false),
                label,
            })
            .collect();
        documents.sort_by(|a, b| a.label.cmp(&b.label));
        documents
    }
    async fn read_document(&self, label: &str) -> Result<DocumentText, String> {
        self.reads.read(&self.app, label).await
    }
    async fn generate(&self, template: &Value, markdown: &str) -> Result<Generated, String> {
        let (bytes, pages, warnings) =
            crate::kordoc::generate_for_remote(&self.app, template, markdown).await?;
        Ok(Generated {
            bytes,
            pages,
            warnings,
        })
    }
}

/// Tauri managed state.
pub struct TelegramState {
    service: Arc<Service>,
    router: Arc<Router<AppBackend>>,
    reads: Arc<DocumentReads>,
    tray_status: Mutex<Option<MenuItem<Wry>>>,
}

impl TelegramState {
    fn status_json(&self, app: &AppHandle) -> Value {
        self.service.status_json(autostart_enabled(app))
    }
    fn forget_all(&self, users: impl IntoIterator<Item = i64>) {
        for user in users {
            self.router.forget(user);
        }
    }
}

fn autostart_entry(app: &AppHandle) -> Result<autostart::Entry, String> {
    autostart::Entry::current(&app.config().identifier, &app.package_info().name)
}

fn autostart_enabled(app: &AppHandle) -> bool {
    autostart_entry(app).is_ok_and(|entry| autostart::is_enabled(&entry))
}

fn is_allowed(gateway: &Gateway, user_id: i64) -> bool {
    gateway.allowed().iter().any(|user| user.user_id == user_id)
}

/// What to do with one queued message, decided in queue order.
enum Triage {
    /// The sender is no longer allowlisted (revoked after the message was queued).
    Drop,
    Reply(&'static str),
    Run(Admitted, Command),
}

fn triage<B: ChatBackend>(gateway: &Gateway, router: &Router<B>, request: &InboundRequest) -> Triage {
    if !is_allowed(gateway, request.user_id) {
        return Triage::Drop;
    }
    let command = router::parse(&request.text);
    match router.admit(request.user_id, &command) {
        Ok(admitted) => Triage::Run(admitted, command),
        Err(busy) => Triage::Reply(busy),
    }
}

/// Answers queued owner messages, one task per message.
async fn worker<B: ChatBackend>(service: Arc<Service>, router: Arc<Router<B>>) {
    loop {
        let Ok(gateway) = service.gateway() else {
            service.changed.notified().await;
            continue;
        };
        tokio::select! {
            () = gateway.wait_for_requests() => {}
            () = service.changed.notified() => continue,
        }
        for request in gateway.take_requests() {
            match triage(&gateway, &router, &request) {
                Triage::Drop => {}
                Triage::Reply(text) => {
                    let _ = gateway.reply(request.user_id, text).await;
                }
                Triage::Run(admitted, command) => {
                    let (gateway, router) = (gateway.clone(), router.clone());
                    tauri::async_runtime::spawn(async move {
                        if !is_allowed(&gateway, request.user_id) {
                            return;
                        }
                        let reply = router
                            .run(admitted, request.user_id, request.update_id, command)
                            .await;
                        let mut text = reply.text;
                        if let Some(document) = reply.document {
                            if let Err(error) = gateway
                                .reply_document(request.user_id, &document.file_name, document.bytes, None)
                                .await
                            {
                                text = format!("문서를 만들었지만 파일을 보내지 못했습니다: {error}");
                            }
                        }
                        if let Err(error) = gateway.reply(request.user_id, &text).await {
                            eprintln!("[telegram] 답장하지 못했습니다: {error}");
                        }
                    });
                }
            }
        }
    }
}

/// Called from app setup. `background` is the `--background` launch flag.
pub(crate) fn install(app: &AppHandle, background: bool) {
    let dir = match app.path().app_local_data_dir() {
        Ok(dir) => dir.join("telegram"),
        Err(_) => {
            eprintln!("[telegram] 앱 데이터 경로를 찾지 못해 텔레그램을 끕니다.");
            if background {
                open_first_window(app);
            }
            return;
        }
    };
    let service = Arc::new(Service::open(dir, Arc::new(OsSecretStore)));
    let reads = Arc::new(DocumentReads::default());
    let router = Arc::new(Router::new(
        Arc::new(AppBackend {
            app: app.clone(),
            reads: reads.clone(),
        }),
        Limits::default(),
    ));
    app.manage(TelegramState {
        service: service.clone(),
        router: router.clone(),
        reads,
        tray_status: Mutex::new(None),
    });
    tauri::async_runtime::spawn(worker(service.clone(), router));
    {
        let service = service.clone();
        tauri::async_runtime::spawn(async move { service.start_at_launch().await });
    }
    // One global listener: a tray rebuilt after a settings toggle must not add another.
    app.on_menu_event(|app, event| match event.id().0.as_str() {
        MENU_OPEN => show_window(app),
        MENU_QUIT => quit(app),
        _ => {}
    });
    sync_tray(app);
    {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(TRAY_REFRESH).await;
                refresh_tray(&app);
            }
        });
    }
    // A background start is only useful with the tray; otherwise behave like a normal launch.
    if background && app.tray_by_id(TRAY_ID).is_none() {
        open_first_window(app);
    }
}

fn open_first_window(app: &AppHandle) {
    if let Err(error) = crate::windows::create_editor_window(app) {
        eprintln!("[telegram] 창을 열지 못했습니다: {error}");
    }
}

/// `ExitRequested` hook: true when the process must stay in the tray.
pub(crate) fn keep_running_on_exit(app: &AppHandle, explicit_exit: bool) -> bool {
    let tray_present = app.tray_by_id(TRAY_ID).is_some();
    app.try_state::<TelegramState>().is_some_and(|state| {
        state
            .service
            .keep_running_on_exit(explicit_exit, tray_present)
    })
}

/// `Exit` hook: stop polling before the process ends.
pub(crate) fn shutdown(app: &AppHandle) {
    if let Some(state) = app.try_state::<TelegramState>() {
        let service = state.service.clone();
        tauri::async_runtime::block_on(async move { service.stop().await });
    }
}

/// The owner cancelled an app quit; closing windows keeps the tray behaviour again.
pub(crate) fn cancel_quit(app: &AppHandle) {
    if let Some(state) = app.try_state::<TelegramState>() {
        lock(&state.service.quit).cancel();
    }
}

/// A new editor window means the owner keeps working: any tray quit is abandoned.
pub(crate) fn window_opened(app: &AppHandle) {
    if let Some(state) = app.try_state::<TelegramState>() {
        lock(&state.service.quit).window_opened();
    }
}

/// Window lifecycle for the tray quit (see [`QuitTracker`]).
pub(crate) fn on_window_event(app: &AppHandle, label: &str, event: &tauri::WindowEvent) {
    let Some(state) = app.try_state::<TelegramState>() else {
        return;
    };
    let mut quit = lock(&state.service.quit);
    match event {
        tauri::WindowEvent::CloseRequested { .. } => quit.close_requested(label),
        tauri::WindowEvent::Destroyed => quit.destroyed(label),
        _ => {}
    }
}

/// Shows an existing window, or creates an editor window when HOP runs only in the tray.
pub(crate) fn show_window(app: &AppHandle) {
    let existing = crate::windows::target_window_label(app)
        .and_then(|label| app.get_webview_window(&label));
    if let Some(window) = existing {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || open_first_window(&app));
}

fn quit(app: &AppHandle) {
    let Some(state) = app.try_state::<TelegramState>() else {
        app.exit(0);
        return;
    };
    let windows = app.webview_windows();
    lock(&state.service.quit).begin(windows.keys().cloned());
    if windows.is_empty() {
        let (app, service) = (app.clone(), state.service.clone());
        tauri::async_runtime::spawn(async move {
            service.stop().await;
            app.exit(0);
        });
        return;
    }
    // Windows close through their own unsaved-changes prompts; the last one ends the process.
    #[cfg(target_os = "macos")]
    if let Err(error) = crate::app_quit::request_app_quit(app) {
        eprintln!("[telegram] 앱 종료 요청 실패: {error}");
    }
    #[cfg(not(target_os = "macos"))]
    for window in windows.values() {
        let _ = window.close();
    }
}

fn tray_status_text(status: &GatewayStatus, has_token: bool) -> String {
    match status {
        GatewayStatus::Running { bot_username } => format!("텔레그램: 연결됨 (@{bot_username})"),
        GatewayStatus::Connecting => "텔레그램: 연결 중".to_owned(),
        GatewayStatus::Disabled if has_token => "텔레그램: 꺼짐".to_owned(),
        GatewayStatus::Disabled => "텔레그램: 봇 토큰 없음".to_owned(),
        GatewayStatus::Stopped { .. } => "텔레그램: 중지됨 (설정 확인)".to_owned(),
    }
}

/// Shows the tray icon exactly while Telegram is enabled with "keep running" on.
fn sync_tray(app: &AppHandle) {
    let Some(state) = app.try_state::<TelegramState>() else {
        return;
    };
    if !state.service.shows_tray() {
        if app.remove_tray_by_id(TRAY_ID).is_some() {
            *lock(&state.tray_status) = None;
        }
        return;
    }
    if app.tray_by_id(TRAY_ID).is_none() {
        if !tray_supported() {
            eprintln!("[telegram] 트레이 아이콘 라이브러리(libayatana-appindicator3)가 없어 트레이를 만들지 않습니다.");
            return;
        }
        match build_tray(app) {
            Ok(status) => *lock(&state.tray_status) = Some(status),
            Err(error) => eprintln!("[telegram] 트레이 아이콘을 만들지 못했습니다: {error}"),
        }
    }
    refresh_tray(app);
}

/// Whether one of the AppIndicator libraries is present. On Linux the tray loads it at run time
/// and panics when it is missing, so HOP looks first and goes without a tray instead.
#[cfg(any(target_os = "linux", test))]
fn appindicator_in(dirs: impl IntoIterator<Item = PathBuf>) -> bool {
    const NAMES: [&str; 2] = ["libayatana-appindicator3.so.1", "libappindicator3.so.1"];
    dirs.into_iter()
        .any(|dir| NAMES.iter().any(|name| dir.join(name).is_file()))
}

#[cfg(target_os = "linux")]
fn tray_supported() -> bool {
    let mut dirs: Vec<PathBuf> = [
        "/usr/lib",
        "/usr/lib64",
        "/lib",
        "/lib64",
        "/usr/local/lib",
        "/usr/lib/x86_64-linux-gnu",
        "/usr/lib/aarch64-linux-gnu",
        "/lib/x86_64-linux-gnu",
        "/lib/aarch64-linux-gnu",
    ]
    .into_iter()
    .map(PathBuf::from)
    .collect();
    if let Some(paths) = std::env::var_os("LD_LIBRARY_PATH") {
        dirs.extend(std::env::split_paths(&paths));
    }
    if let Some(appdir) = std::env::var_os("APPDIR").map(PathBuf::from) {
        dirs.push(appdir.join("usr/lib"));
        dirs.push(appdir.join("usr/lib/x86_64-linux-gnu"));
        dirs.push(appdir.join("usr/lib/aarch64-linux-gnu"));
    }
    appindicator_in(dirs)
}

#[cfg(not(target_os = "linux"))]
fn tray_supported() -> bool {
    true
}

fn build_tray(app: &AppHandle) -> tauri::Result<MenuItem<Wry>> {
    let open = MenuItem::with_id(app, MENU_OPEN, "Achmage HOP 열기", true, None::<&str>)?;
    let status = MenuItem::with_id(app, MENU_STATUS, "텔레그램", false, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, MENU_QUIT, "종료", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &status, &separator, &quit_item])?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip(app.package_info().name.clone());
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(status)
}

fn refresh_tray(app: &AppHandle) {
    let Some(state) = app.try_state::<TelegramState>() else {
        return;
    };
    // No tray, no work: in particular no credential-store read while Telegram is off.
    let Some(item) = lock(&state.tray_status).clone() else {
        return;
    };
    let wanted = tray_status_text(
        &state.service.status(),
        state.service.has_token(TOKEN_RETRY_BACKGROUND),
    );
    if item.text().ok().as_deref() != Some(wanted.as_str()) {
        let _ = item.set_text(wanted);
    }
}

/// A document window's answer to `achmage-telegram-read-document`: its text, or why it could not
/// read it. Accepted only from the window that was asked.
#[tauri::command]
pub async fn achmage_telegram_document_text(
    window: WebviewWindow,
    state: State<'_, TelegramState>,
    request_id: String,
    title: String,
    text: Option<String>,
    truncated: bool,
    error: Option<String>,
) -> Result<(), String> {
    let result = match (text, error) {
        (Some(text), None) if text.len() <= READ_LIMIT => Ok(DocumentText {
            title: document_title(&title),
            text,
            truncated,
        }),
        (None, Some(error)) => Err(error.chars().take(300).collect()),
        _ => Err("문서 응답 형식이 올바르지 않습니다.".into()),
    };
    state.reads.answer(window.label(), &request_id, result)
}

// ---- Settings-screen commands. Every result is the status JSON from `achmage_telegram_status`.

#[tauri::command]
pub async fn achmage_telegram_status(
    app: AppHandle,
    state: State<'_, TelegramState>,
) -> Result<Value, String> {
    Ok(state.status_json(&app))
}

#[tauri::command]
pub async fn achmage_telegram_set_token(
    app: AppHandle,
    state: State<'_, TelegramState>,
    token: String,
) -> Result<Value, String> {
    let token = Zeroizing::new(token);
    let previous = state.service.allowed_ids();
    if state.service.set_token(&token).await? {
        state.forget_all(previous);
    }
    refresh_tray(&app);
    Ok(state.status_json(&app))
}

#[tauri::command]
pub async fn achmage_telegram_clear_token(
    app: AppHandle,
    state: State<'_, TelegramState>,
) -> Result<Value, String> {
    state.service.clear_token().await?;
    state.forget_all(state.service.allowed_ids());
    refresh_tray(&app);
    Ok(state.status_json(&app))
}

#[tauri::command]
pub async fn achmage_telegram_set_enabled(
    app: AppHandle,
    state: State<'_, TelegramState>,
    enabled: bool,
) -> Result<Value, String> {
    state.service.set_enabled(enabled).await?;
    if !enabled {
        state.forget_all(state.service.allowed_ids());
    }
    sync_tray(&app);
    Ok(state.status_json(&app))
}

#[tauri::command]
pub async fn achmage_telegram_set_keep_running(
    app: AppHandle,
    state: State<'_, TelegramState>,
    keep_running: bool,
) -> Result<Value, String> {
    state.service.set_keep_running(keep_running)?;
    sync_tray(&app);
    Ok(state.status_json(&app))
}

#[tauri::command]
pub async fn achmage_telegram_set_autostart(
    app: AppHandle,
    state: State<'_, TelegramState>,
    enabled: bool,
) -> Result<Value, String> {
    autostart::set_enabled(&autostart_entry(&app)?, enabled)?;
    Ok(state.status_json(&app))
}

#[tauri::command]
pub async fn achmage_telegram_approve(
    app: AppHandle,
    state: State<'_, TelegramState>,
    code: String,
) -> Result<Value, String> {
    let user = state.service.approve(&code)?;
    if let Ok(gateway) = state.service.gateway() {
        // The approval stands even if Telegram cannot be reached right now.
        let _ = gateway.reply(user.user_id, APPROVED).await;
    }
    Ok(state.status_json(&app))
}

#[tauri::command]
pub async fn achmage_telegram_revoke(
    app: AppHandle,
    state: State<'_, TelegramState>,
    user_id: i64,
) -> Result<Value, String> {
    state.service.revoke(user_id)?;
    state.router.forget(user_id);
    Ok(state.status_json(&app))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ::achmage_telegram::MemorySecrets;

    const FAKE_TOKEN: &str = "123456789:AAFakeSecretPartForTestsOnly_abcdefghijk";

    fn service(dir: &Path) -> (Service, Arc<MemorySecrets>) {
        let secrets = Arc::new(MemorySecrets::default());
        (Service::open(dir.to_path_buf(), secrets.clone()), secrets)
    }

    #[test]
    fn settings_round_trip_and_default_to_off() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(Settings::load(dir.path()), Settings::default());
        let (svc, _) = service(dir.path());
        let initial = svc.settings();
        assert!(!initial.enabled);
        assert!(!initial.keep_running);
        svc.update(|s| s.enabled = true).unwrap();
        svc.set_keep_running(true).unwrap();
        let reopened = Settings::load(dir.path());
        assert!(reopened.enabled && reopened.keep_running);
        let raw = std::fs::read_to_string(dir.path().join(SETTINGS_FILE)).unwrap();
        assert!(raw.contains("\"keepRunning\": true"), "{raw}");
        svc.set_keep_running(false).unwrap();
        assert!(!Settings::load(dir.path()).keep_running);
        // A damaged file falls back to the safe defaults.
        std::fs::write(dir.path().join(SETTINGS_FILE), b"{not json").unwrap();
        assert_eq!(Settings::load(dir.path()), Settings::default());
    }

    #[test]
    fn status_json_never_contains_the_token() {
        let dir = tempfile::tempdir().unwrap();
        let (svc, secrets) = service(dir.path());
        BotToken::parse(FAKE_TOKEN).unwrap().save(&*secrets).unwrap();
        svc.update(|s| {
            s.enabled = true;
            s.bot_id = Some(123_456_789);
            s.bot_username = Some("hop_test_bot".into());
        })
        .unwrap();
        let status = svc.status_json(false);
        let serialized = status.to_string();
        let secret = FAKE_TOKEN.split_once(':').unwrap().1;
        assert!(!serialized.contains(FAKE_TOKEN), "{serialized}");
        assert!(!serialized.contains(secret), "{serialized}");
        assert_eq!(status["hasToken"], true);
        assert_eq!(status["enabled"], true);
        assert_eq!(status["keepRunning"], false);
        assert_eq!(status["autostart"], false);
        assert_eq!(status["status"]["state"], "disabled");
        assert_eq!(status["botUsername"], "hop_test_bot");
        assert_eq!(status["pending"], json!([]));
        assert_eq!(status["allowed"], json!([]));
        assert!(status["approvalLockedUntil"].is_null());
        // Nothing secret reached the settings file either.
        let files = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| std::fs::read_to_string(entry.unwrap().path()).unwrap_or_default())
            .collect::<String>();
        assert!(!files.contains(secret));
    }

    #[tokio::test]
    async fn malformed_token_is_refused_before_any_network_call_or_storage() {
        let dir = tempfile::tempdir().unwrap();
        let (svc, secrets) = service(dir.path());
        let error = svc.set_token("not-a-token").await.unwrap_err();
        assert!(error.contains("형식"), "{error}");
        assert!(BotToken::load(&*secrets).unwrap().is_none());
        assert_eq!(svc.status_json(false)["hasToken"], false);
    }

    #[test]
    fn last_window_close_keeps_running_only_when_all_conditions_hold() {
        let on = ExitInputs {
            explicit_exit: false,
            quitting: false,
            enabled: true,
            keep_running: true,
            gateway_active: true,
            tray_present: true,
        };
        assert!(should_keep_running(on));
        assert!(!should_keep_running(ExitInputs { explicit_exit: true, ..on }));
        assert!(!should_keep_running(ExitInputs { quitting: true, ..on }));
        assert!(!should_keep_running(ExitInputs { enabled: false, ..on }));
        assert!(!should_keep_running(ExitInputs { keep_running: false, ..on }));
        assert!(!should_keep_running(ExitInputs { gateway_active: false, ..on }));
        assert!(
            !should_keep_running(ExitInputs { tray_present: false, ..on }),
            "no tray: never an invisible, unquittable process"
        );
        assert!(!should_keep_running(ExitInputs::default()), "today's behaviour by default");
    }

    #[test]
    fn service_exit_decision_follows_settings_and_gateway() {
        let dir = tempfile::tempdir().unwrap();
        let (svc, _) = service(dir.path());
        svc.update(|s| {
            s.enabled = true;
            s.keep_running = true;
        })
        .unwrap();
        assert!(svc.shows_tray());
        // Not polling (no token): closing the last window exits as before.
        assert!(!svc.keep_running_on_exit(false, true));
        assert!(!svc.keep_running_on_exit(false, false));
    }

    #[test]
    fn a_cancelled_tray_quit_does_not_stick() {
        let mut quit = QuitTracker::default();
        // Every window confirms: the last close ends the process.
        quit.begin(["a".to_owned(), "b".to_owned()]);
        quit.close_requested("a");
        quit.close_requested("b");
        quit.destroyed("a");
        quit.destroyed("b");
        assert!(quit.quitting());
        // "b" cancels its unsaved-changes prompt; closing it again later is an ordinary close.
        quit.begin(["a".to_owned(), "b".to_owned()]);
        quit.close_requested("a");
        quit.close_requested("b");
        quit.destroyed("a");
        assert!(quit.quitting(), "prompt still open");
        quit.close_requested("b");
        assert!(!quit.quitting());
        // A new window, or a window the quit did not ask about, also abandons it.
        quit.begin(["a".to_owned()]);
        quit.window_opened();
        assert!(!quit.quitting());
        quit.begin(["a".to_owned()]);
        quit.close_requested("c");
        assert!(!quit.quitting());
        // The macOS quit flow cancels explicitly.
        quit.begin(["a".to_owned()]);
        quit.cancel();
        assert!(!quit.quitting());
    }

    /// A credential store that is locked: every read fails and is counted.
    #[derive(Default)]
    struct LockedStore(Mutex<usize>);

    impl SecretStore for LockedStore {
        fn get(&self, _: &str) -> Result<Option<Zeroizing<String>>, String> {
            *lock(&self.0) += 1;
            Err("locked".into())
        }
        fn set(&self, _: &str, _: &str) -> Result<(), String> {
            Err("locked".into())
        }
        fn delete(&self, _: &str) -> Result<(), String> {
            Err("locked".into())
        }
    }

    #[test]
    fn a_locked_credential_store_is_not_asked_every_few_seconds() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(LockedStore::default());
        let svc = Service::open(dir.path().to_path_buf(), store.clone());
        for _ in 0..5 {
            assert!(!svc.has_token(TOKEN_RETRY_BACKGROUND));
        }
        assert_eq!(*lock(&store.0), 1, "tray refreshes reuse the failure");
        svc.status_json(false);
        svc.status_json(false);
        assert_eq!(*lock(&store.0), 1, "dialog polling reuses it too");
        // An explicit owner action asks again.
        assert!(!svc.has_token(Duration::ZERO));
        assert_eq!(*lock(&store.0), 2);
    }

    struct Untouched(Mutex<usize>);

    impl ChatBackend for Untouched {
        fn snapshot(&self, _: &str) -> Result<Value, String> {
            *lock(&self.0) += 1;
            Err("untouched".into())
        }
        fn act(&self, _: &str, _: Action) -> Result<Value, String> {
            *lock(&self.0) += 1;
            Err("untouched".into())
        }
        fn end(&self, _: &str) {
            *lock(&self.0) += 1;
        }
        fn documents(&self) -> Vec<OpenDocument> {
            Vec::new()
        }
        async fn read_document(&self, _: &str) -> Result<DocumentText, String> {
            *lock(&self.0) += 1;
            Err("untouched".into())
        }
        async fn generate(&self, _: &Value, _: &str) -> Result<Generated, String> {
            *lock(&self.0) += 1;
            Err("untouched".into())
        }
    }

    #[test]
    fn window_titles_read_like_file_names() {
        assert_eq!(document_title("회의록.hwpx - HOP"), "회의록.hwpx");
        assert_eq!(document_title("• 예산.hwp - HOP"), "예산.hwp (저장 안 됨)");
        assert_eq!(document_title("HOP - HOP"), "빈 창");
        assert_eq!(document_title("• 회의록.hwpx - Achmage HOP"), "회의록.hwpx (저장 안 됨)");
        assert_eq!(document_title("Achmage HOP"), "빈 창");
        assert_eq!(document_title(""), "빈 창");
    }

    #[tokio::test]
    async fn document_replies_count_only_from_the_window_asked() {
        let reads = DocumentReads::default();
        let (sender, receiver) = oneshot::channel();
        lock(&reads.pending).insert("read-1".into(), ("main".into(), sender));
        let text = |t: &str| DocumentText {
            title: "a".into(),
            text: t.into(),
            truncated: false,
        };
        assert!(reads.answer("main2", "read-1", Ok(text("가짜"))).is_err());
        assert!(reads.answer("main", "read-9", Ok(text("가짜"))).is_err());
        assert!(reads.answer("main", "read-1", Ok(text("진짜"))).is_ok());
        assert_eq!(receiver.await.unwrap().unwrap().text, "진짜");
        assert!(reads.answer("main", "read-1", Ok(text("두 번"))).is_err(), "answered once");
    }

    fn request(user_id: i64, text: &str) -> InboundRequest {
        InboundRequest {
            update_id: 1,
            user_id,
            chat_id: user_id,
            display_name: "owner".into(),
            text: text.into(),
            received_at: 0,
        }
    }

    #[test]
    fn queued_messages_from_revoked_users_never_reach_the_ai() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(STATE_FILE),
            r#"{"version":1,"nextOffset":5,"allowed":[{"userId":7,"displayName":"owner","approvedAt":1}],"pending":[],"failedApprovals":0,"lockedUntil":0}"#,
        )
        .unwrap();
        let gateway = Gateway::open(dir.path().join(STATE_FILE)).unwrap();
        let backend = Arc::new(Untouched(Mutex::new(0)));
        let router = Router::new(backend.clone(), Limits::default());
        assert!(matches!(
            triage(&gateway, &router, &request(8, "안녕")),
            Triage::Drop
        ));
        let Triage::Run(admitted, command) = triage(&gateway, &router, &request(7, "안녕")) else {
            panic!("allowlisted owner must be served");
        };
        assert_eq!(command, Command::Chat("안녕".into()));
        assert!(matches!(
            triage(&gateway, &router, &request(7, "또")),
            Triage::Reply(router::BUSY)
        ));
        drop(admitted);
        gateway.revoke(7).unwrap();
        assert!(matches!(
            triage(&gateway, &router, &request(7, "안녕")),
            Triage::Drop
        ));
        assert_eq!(*lock(&backend.0), 0);
    }

    #[test]
    fn remote_sessions_cannot_log_in_or_out() {
        assert!(remote_action_allowed(&Action::Send {
            prompt: "질문".into(),
            request_id: "telegram-1".into(),
            model: None,
            reasoning_effort: None,
        }));
        assert!(remote_action_allowed(&Action::RestoreConnection {}));
        assert!(!remote_action_allowed(&Action::BeginLogin {}));
        assert!(!remote_action_allowed(&Action::Logout {}));
        assert!(!remote_action_allowed(&Action::CancelLogin {}));
        assert!(!remote_action_allowed(&Action::RefreshModels {}));
    }

    #[test]
    fn linux_tray_needs_an_appindicator_library() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!appindicator_in([dir.path().to_path_buf()]));
        std::fs::write(dir.path().join("libayatana-appindicator3.so.1"), b"").unwrap();
        assert!(appindicator_in([PathBuf::from("/missing"), dir.path().to_path_buf()]));
    }

    #[test]
    fn tray_status_text_names_the_state() {
        assert_eq!(
            tray_status_text(&GatewayStatus::Running { bot_username: "hop_bot".into() }, true),
            "텔레그램: 연결됨 (@hop_bot)"
        );
        assert_eq!(tray_status_text(&GatewayStatus::Disabled, false), "텔레그램: 봇 토큰 없음");
        assert_eq!(tray_status_text(&GatewayStatus::Disabled, true), "텔레그램: 꺼짐");
    }
}
