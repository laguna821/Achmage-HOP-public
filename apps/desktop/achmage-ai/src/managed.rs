//! Provider-owned ChatGPT login. No token/auth-file reading or token forwarding.
//! OAuth and account/read are delegated to a trusted, explicitly selected app-server.
use crate::{
    process::{CodexProcessAdapter, LaunchConfig, Pipes, ProcessFault, ProcessView},
    *,
};
use serde_json::{Value, json};
use std::{
    fmt,
    path::PathBuf,
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

/// Where a persistent ChatGPT sign-in is kept. Linux desktops often have no unlocked Secret Service
/// (niri, sway, a locked or session-only keyring), so the keyring store loses the sign-in at restart or
/// blocks the restore; Codex's own default, a file in the app-private CODEX_HOME, is used there.
#[cfg(target_os = "linux")]
pub const PERSISTENT_CREDENTIAL_STORE: &str = "file";
#[cfg(not(target_os = "linux"))]
pub const PERSISTENT_CREDENTIAL_STORE: &str = "keyring";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LoginMethod {
    Browser,
    DeviceCode,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthStatus {
    Idle,
    Starting,
    AwaitingUser,
    CheckingAccount,
    Connected,
    Cancelled,
    Expired,
    Failed,
    LogoutPending,
    LoggedOut,
    LogoutUnconfirmed,
}
/// Intentionally not serializable. Render only using an explicit user-facing display callback.
pub struct LoginPrompt {
    method: LoginMethod,
    url: Zeroizing<String>,
    code: Option<Zeroizing<String>>,
}
impl fmt::Debug for LoginPrompt {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("LoginPrompt([REDACTED])")
    }
}
impl LoginPrompt {
    pub fn with_user_display<R>(
        &self,
        display: impl FnOnce(LoginMethod, &str, Option<&str>) -> R,
    ) -> R {
        display(
            self.method,
            &self.url,
            self.code.as_ref().map(|c| c.as_str()),
        )
    }
}
#[derive(Debug, Clone, Serialize)]
pub struct AuthView {
    pub status: AuthStatus,
    pub model_catalog: crate::models::CatalogView,
    pub login_generation: u64,
    pub selected_account: Option<Id>,
    pub action_available: bool,
    pub cancel_response_confirmed: bool,
    pub provider_logout_confirmed: bool,
    pub fault: Option<ProcessFault>,
    pub phase: &'static str,
    pub error_code: Option<&'static str>,
    pub pending_process: Option<ProcessView>,
    pub active_process: Option<ProcessView>,
    pub tokens_owned_by_provider: bool,
    pub token_files_read_by_adapter: bool,
    pub automatic_browser_open: bool,
}
#[derive(PartialEq, Eq)]
enum Stage {
    Initialize,
    CheckExisting,
    Start,
    Await,
    Read,
    Stopping,
}
struct Attempt {
    ticket: LoginTicket,
    expected: Option<Id>,
    home: PathBuf,
    pipes: Pipes,
    view: ProcessView,
    stage: Stage,
    login_id: Option<String>,
    started: Instant,
    stage_started: Instant,
    stop_at: Option<Instant>,
    early: Vec<Value>,
}
#[derive(PartialEq, Eq)]
enum SessionStage {
    Ready,
    Logout,
    ReadLogout,
    Stopping,
}
struct Session {
    id: Id,
    email: Zeroizing<String>,
    pipes: Pipes,
    view: ProcessView,
    stage: SessionStage,
    catalog: crate::models::Query,
    changed: Instant,
}
/// Host-owned adapter; browser/device actions are shown, never automatically opened.
/// Test sessions use isolated attempts; production uses a stable provider home.
pub struct ManagedCodexAdapter {
    owner_instance: Option<u64>,
    provider: Id,
    host: Id,
    base: LaunchConfig,
    method: LoginMethod,
    login_timeout: Duration,
    pending: Option<Attempt>,
    active: Option<Session>,
    turn: Option<CodexProcessAdapter>,
    prompt: Option<LoginPrompt>,
    view: AuthView,
}
impl fmt::Debug for ManagedCodexAdapter {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ManagedCodexAdapter")
            .field("view", &self.view)
            .finish()
    }
}
impl ManagedCodexAdapter {
    pub fn new(
        provider: Id,
        host: Id,
        mut base: LaunchConfig,
        method: LoginMethod,
        login_timeout: Duration,
    ) -> Result<Self, ProcessFault> {
        // Official pinned schema: file uses this CODEX_HOME/auth.json. Never choose
        // a user's OS keyring implicitly. Caller overrides of this policy are rejected.
        // A persistent sign-in uses the OS keyring on Windows/macOS and the app-private profile
        // file on Linux (PERSISTENT_CREDENTIAL_STORE).
        if base
            .args
            .iter()
            .any(|a| a.contains("cli_auth_credentials_store"))
        {
            return Err(ProcessFault::InvalidConfig);
        }
        let store = if base.persistent_auth {
            PERSISTENT_CREDENTIAL_STORE
        } else {
            "file"
        };
        base.args.extend([
            "-c".into(),
            format!("cli_auth_credentials_store=\"{store}\""),
        ]);
        base.validate()?;
        if !(Duration::from_millis(10)..=Duration::from_secs(900)).contains(&login_timeout) {
            return Err(ProcessFault::InvalidConfig);
        }
        Ok(Self {
            owner_instance: None,
            provider,
            host,
            base,
            method,
            login_timeout,
            pending: None,
            active: None,
            turn: None,
            prompt: None,
            view: AuthView {
                status: AuthStatus::Idle,
                model_catalog: Default::default(),
                login_generation: 0,
                selected_account: None,
                action_available: false,
                cancel_response_confirmed: false,
                provider_logout_confirmed: false,
                fault: None,
                phase: "idle",
                error_code: None,
                pending_process: None,
                active_process: None,
                tokens_owned_by_provider: true,
                token_files_read_by_adapter: false,
                automatic_browser_open: false,
            },
        })
    }
    pub fn take_prompt(&mut self) -> Option<LoginPrompt> {
        self.view.action_available = false;
        self.prompt.take()
    }
    pub fn auth_view(&mut self) -> AuthView {
        if let Some(p) = &mut self.pending {
            p.pipes.refresh(&mut p.view);
            p.view.settled = p.stage == Stage::Stopping && p.view.direct_child_exited;
        }
        if let Some(s) = &mut self.active {
            s.pipes.refresh(&mut s.view);
            s.view.settled = s.stage == SessionStage::Stopping && s.view.direct_child_exited;
        }
        self.view.model_catalog = self
            .active
            .as_ref()
            .filter(|s| s.stage == SessionStage::Ready && self.view.status == AuthStatus::Connected)
            .map(|s| s.catalog.view.clone())
            .unwrap_or_default();
        self.view.pending_process = self.pending.as_ref().map(|p| p.view.clone());
        self.view.active_process = self.active.as_ref().map(|s| s.view.clone());
        self.view.clone()
    }
    pub fn refresh_models(&mut self) -> Result<(), ProcessFault> {
        let s = self
            .active
            .as_mut()
            .filter(|s| s.stage == SessionStage::Ready)
            .ok_or(ProcessFault::Protocol)?;
        if s.catalog.view.status == "loading" {
            return Err(ProcessFault::Protocol);
        }
        let request = s.catalog.begin()?;
        s.pipes
            .send(request)
            .inspect_err(|_| s.catalog.fail("catalog_connection"))
    }
    pub fn turn_process_view(&mut self) -> Option<ProcessView> {
        self.turn.as_mut().map(CodexProcessAdapter::process_view)
    }
    /// Local sign-out is immediate. Provider logout remains pending until response + account/read(null).
    pub fn logout(&mut self, c: &mut Coordinator) -> Result<LogoutReport, Error> {
        if self.owner_instance.is_some_and(|owner| owner != c.instance) {
            return Err(Error::BindingMismatch);
        }
        self.owner_instance = Some(c.instance);
        let report = c.logout(self)?;
        self.view.selected_account = None;
        self.prompt = None;
        self.view.action_available = false;
        if let Some(s) = &mut self.active {
            if s.catalog.view.status == "loading"
                && s.catalog.started.elapsed() > self.base.handshake_timeout
            {
                s.catalog.fail("catalog_timeout");
            }
            if s.stage != SessionStage::Ready {
                return Ok(report);
            }
            self.view.provider_logout_confirmed = false;
            s.stage = SessionStage::Logout;
            s.changed = Instant::now();
            self.view.status = AuthStatus::LogoutPending;
            if s.pipes
                .send(json!({"id":20,"method":"account/logout"}))
                .is_err()
            {
                s.stage = SessionStage::Stopping;
                s.pipes.kill();
                self.view.status = AuthStatus::LogoutUnconfirmed;
                self.view.fault = Some(ProcessFault::Io);
            }
        } else {
            self.view.status = AuthStatus::LoggedOut;
        }
        Ok(report)
    }
    fn fail_pending(&mut self, c: &mut Coordinator, f: ProcessFault) {
        if let Some(p) = &mut self.pending {
            let _ = c.fail_login(&p.ticket, ProviderError::Protocol);
            p.stage = Stage::Stopping;
            p.stop_at = Some(Instant::now());
            p.pipes.kill();
        }
        self.prompt = None;
        self.view.action_available = false;
        self.view.fault = Some(f);
        self.view.status = AuthStatus::Failed;
    }
    pub fn pump(&mut self, c: &mut Coordinator, wait: Duration) -> AuthView {
        if self.owner_instance.is_some_and(|owner| owner != c.instance) {
            let mut rejected = self.auth_view();
            rejected.fault = Some(ProcessFault::StaleCoordinator);
            return rejected;
        }
        if let Some(turn) = &mut self.turn {
            turn.pump(c, Duration::ZERO);
        }
        if let Some(p) = &self.pending {
            if p.stage != Stage::Stopping && c.check_login(&p.ticket).is_err() {
                self.fail_pending(c, ProcessFault::StaleCoordinator);
            }
        }
        if let Some(p) = &self.pending {
            if p.stage != Stage::Stopping && p.started.elapsed() > self.login_timeout {
                let t = p.ticket.clone();
                let _ = c.expire_login(self, &t);
                self.view.status = AuthStatus::Expired;
            }
        }
        if let Some(p) = &self.pending {
            if matches!(
                p.stage,
                Stage::Initialize | Stage::CheckExisting | Stage::Start | Stage::Read
            ) && p.stage_started.elapsed() > self.base.handshake_timeout
            {
                self.fail_pending(c, ProcessFault::Timeout);
            }
        }
        if let Some(p) = &mut self.pending {
            if p.stage == Stage::Stopping
                && p.stop_at
                    .is_some_and(|t| t.elapsed() >= self.base.cancel_grace)
            {
                p.pipes.kill();
            }
            let stopped = p.stage == Stage::Stopping;
            let result = p.pipes.receive(if stopped { Duration::ZERO } else { wait });
            match result {
                Ok(Some(v)) => {
                    if let Err(f) = self.pending_message(c, v) {
                        self.fail_pending(c, f);
                    }
                }
                Err(f) if !stopped => self.fail_pending(c, f),
                _ => {}
            }
        }
        if self.pending.as_mut().is_some_and(|p| {
            p.pipes.refresh(&mut p.view);
            p.stage == Stage::Stopping && p.view.direct_child_exited
        }) {
            self.pending.take();
        }
        if let Some(s) = &mut self.active {
            if s.stage != SessionStage::Ready && s.changed.elapsed() > self.base.handshake_timeout {
                s.stage = SessionStage::Stopping;
                s.pipes.kill();
                self.view.status = AuthStatus::LogoutUnconfirmed;
                self.view.fault = Some(ProcessFault::Timeout);
            }
            let stopped = s.stage == SessionStage::Stopping;
            match s.pipes.receive(Duration::ZERO) {
                Ok(Some(v)) => {
                    if let Err(f) = self.active_message(c, v) {
                        self.fail_active(c, f);
                    }
                }
                Err(f) if !stopped => self.fail_active(c, f),
                _ => {}
            }
        }
        if self.active.as_mut().is_some_and(|s| {
            s.pipes.refresh(&mut s.view);
            s.stage == SessionStage::Stopping && s.view.direct_child_exited
        }) {
            self.active.take();
        }
        self.auth_view()
    }
    fn fail_active(&mut self, c: &mut Coordinator, f: ProcessFault) {
        let logging_out = self
            .active
            .as_ref()
            .is_some_and(|s| s.stage != SessionStage::Ready);
        // Direct Coordinator logout cannot revoke provider storage. Fence local callbacks first.
        let _ = c.logout(self);
        self.view.selected_account = None;
        self.view.status = if logging_out {
            AuthStatus::LogoutUnconfirmed
        } else {
            AuthStatus::Failed
        };
        self.view.fault = Some(f);
        if let Some(s) = &mut self.active {
            s.stage = SessionStage::Stopping;
            s.pipes.kill();
            s.changed = Instant::now();
        }
    }
    fn active_message(&mut self, c: &mut Coordinator, v: Value) -> Result<(), ProcessFault> {
        if v.get("method").is_some() {
            if v.get("id").is_some() {
                return Err(ProcessFault::UnsupportedTool);
            }
            if v["method"] == "account/updated"
                && v.pointer("/params/authMode") == Some(&Value::Null)
                && self.active.as_ref().unwrap().stage == SessionStage::Ready
            {
                self.fail_active(c, ProcessFault::Protocol);
            }
            return Ok(());
        }
        if v["id"].as_u64().is_some_and(|id| id >= 100) {
            let s = self.active.as_mut().unwrap();
            if s.stage == SessionStage::Ready {
                if let Some(request) = s.catalog.receive(&v) {
                    if s.pipes.send(request).is_err() {
                        s.catalog.fail("catalog_connection");
                    }
                }
            }
            return Ok(());
        }
        if v.get("error").is_some() {
            return Err(ProcessFault::Protocol);
        }
        let s = self.active.as_mut().unwrap();
        match (s.stage == SessionStage::Logout, v["id"].as_u64()) {
            (true, Some(20)) if v["result"].is_object() => {
                s.pipes.send(
                    json!({"id":21,"method":"account/read","params":{"refreshToken":false}}),
                )?;
                s.stage = SessionStage::ReadLogout;
                s.changed = Instant::now();
            }
            (false, Some(21))
                if s.stage == SessionStage::ReadLogout
                    && v.pointer("/result/account") == Some(&Value::Null) =>
            {
                self.view.provider_logout_confirmed = true;
                self.view.status = AuthStatus::LoggedOut;
                s.stage = SessionStage::Stopping;
                s.changed = Instant::now();
                s.pipes.kill();
            }
            _ => return Err(ProcessFault::Protocol),
        }
        Ok(())
    }
    fn pending_message(&mut self, c: &mut Coordinator, v: Value) -> Result<(), ProcessFault> {
        if !v.is_object() {
            return Err(ProcessFault::Protocol);
        }
        if let Some(method) = v.get("method").and_then(Value::as_str) {
            if v.get("id").is_some() {
                return Err(ProcessFault::UnsupportedTool);
            }
            if method != "account/login/completed" {
                return Ok(());
            }
            let p = self.pending.as_mut().unwrap();
            if p.stage == Stage::Stopping {
                return Ok(());
            }
            if p.stage == Stage::Start {
                if p.early.len() >= 4 {
                    return Err(ProcessFault::QueueLimit);
                }
                p.early.push(v);
                return Ok(());
            }
            if p.stage != Stage::Await
                || v.pointer("/params/loginId").and_then(Value::as_str) != p.login_id.as_deref()
            {
                return Err(ProcessFault::Protocol);
            }
            self.prompt = None;
            self.view.action_available = false;
            if v.pointer("/params/success").and_then(Value::as_bool) != Some(true) {
                let t = p.ticket.clone();
                c.fail_login(&t, ProviderError::Denied)
                    .map_err(|_| ProcessFault::StaleCoordinator)?;
                p.stage = Stage::Stopping;
                p.pipes.kill();
                p.stop_at = Some(Instant::now());
                self.view.status = AuthStatus::Failed;
                return Ok(());
            }
            p.pipes
                .send(json!({"id":3,"method":"account/read","params":{"refreshToken":false}}))?;
            p.stage = Stage::Read;
            p.stage_started = Instant::now();
            self.view.status = AuthStatus::CheckingAccount;
            return Ok(());
        }
        let p = self.pending.as_mut().unwrap();
        if p.stage == Stage::Stopping {
            if v["id"] == 4 && v["result"]["status"] == "canceled" && v.get("error").is_none() {
                self.view.cancel_response_confirmed = true;
            }
            return Ok(());
        }
        if v.get("error").is_some() {
            // Classify only fixed categories; never project raw provider text,
            // callback URLs or secrets to diagnostics.
            let message = v["error"]["message"]
                .as_str()
                .unwrap_or("")
                .to_ascii_lowercase();
            self.view.error_code = Some(
                if message.contains("address already in use") || message.contains("10048") {
                    "callback_busy"
                } else if message.contains("keyring") || message.contains("credential store") {
                    "credential_store"
                } else if message.contains("os error") {
                    "runtime_environment"
                } else if message.contains("network") || message.contains("connection") {
                    "network"
                } else {
                    "provider_protocol"
                },
            );
            return Err(ProcessFault::Protocol);
        }
        match (&p.stage, v["id"].as_u64()) {
            (Stage::Initialize, Some(1)) if v["result"].is_object() => {
                p.pipes.send(json!({"method":"initialized"}))?;
                if self.base.persistent_auth {
                    p.pipes.send(
                        json!({"id":5,"method":"account/read","params":{"refreshToken":false}}),
                    )?;
                    p.stage = Stage::CheckExisting;
                    self.view.phase = "checking_account";
                } else {
                    p.pipes.send(json!({"id":2,"method":"account/login/start","params":{"type":if self.method==LoginMethod::Browser{"chatgpt"}else{"chatgptDeviceCode"}}}))?;
                    p.stage = Stage::Start;
                    self.view.phase = "starting_login";
                }
                p.stage_started = Instant::now();
            }
            (Stage::CheckExisting, Some(5)) => {
                if v["result"]["account"]["type"] == "chatgpt" {
                    p.stage = Stage::Read;
                    let mut existing = v;
                    existing["id"] = json!(3);
                    return self.pending_message(c, existing);
                }
                if self.base.resume_only {
                    let ticket = p.ticket.clone();
                    c.cancel_login(self, &ticket)
                        .map_err(|_| ProcessFault::StaleCoordinator)?;
                    self.view.phase = "signed_out";
                    return Ok(());
                }
                p.pipes.send(json!({"id":2,"method":"account/login/start","params":{"type":if self.method==LoginMethod::Browser{"chatgpt"}else{"chatgptDeviceCode"}}}))?;
                p.stage = Stage::Start;
                p.stage_started = Instant::now();
                self.view.phase = "starting_login";
            }
            (Stage::Start, Some(2)) => {
                let r = &v["result"];
                let expected = if self.method == LoginMethod::Browser {
                    "chatgpt"
                } else {
                    "chatgptDeviceCode"
                };
                if r["type"] != expected {
                    return Err(ProcessFault::Protocol);
                }
                let login = r["loginId"]
                    .as_str()
                    .filter(|s| !s.is_empty() && s.len() <= 256 && !s.chars().any(char::is_control))
                    .ok_or(ProcessFault::Protocol)?
                    .to_owned();
                let url = r[if self.method == LoginMethod::Browser {
                    "authUrl"
                } else {
                    "verificationUrl"
                }]
                .as_str()
                .ok_or(ProcessFault::Protocol)?;
                if !valid_url(url) {
                    return Err(ProcessFault::Protocol);
                }
                let code = if self.method == LoginMethod::DeviceCode {
                    let s = r["userCode"]
                        .as_str()
                        .filter(|s| {
                            !s.is_empty()
                                && s.len() <= 128
                                && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                        })
                        .ok_or(ProcessFault::Protocol)?;
                    Some(Zeroizing::new(s.to_owned()))
                } else {
                    None
                };
                self.prompt = Some(LoginPrompt {
                    method: self.method,
                    url: Zeroizing::new(url.to_owned()),
                    code,
                });
                self.view.action_available = true;
                self.view.status = AuthStatus::AwaitingUser;
                self.view.phase = "awaiting_browser";
                p.login_id = Some(login);
                p.stage = Stage::Await;
                let early = std::mem::take(&mut p.early);
                for event in early {
                    self.pending_message(c, event)?;
                }
            }
            (Stage::Read, Some(3)) => {
                let account = &v["result"]["account"];
                if account["type"] != "chatgpt" {
                    return Err(ProcessFault::Protocol);
                }
                let email = account["email"]
                    .as_str()
                    .filter(|s| !s.is_empty() && s.len() <= 320 && !s.chars().any(char::is_control))
                    .ok_or(ProcessFault::Protocol)?
                    .to_owned();
                let id = if let Some(expected) = &p.expected {
                    let old = self.active.as_ref().ok_or(ProcessFault::Protocol)?;
                    if &old.id != expected || old.email.as_str() != email {
                        return Err(ProcessFault::Protocol);
                    }
                    expected.clone()
                } else {
                    Id::new(format!(
                        "managed-{}-{}",
                        p.ticket.instance, p.ticket.generation
                    ))
                    .map_err(|_| ProcessFault::Protocol)?
                };
                let ticket = p.ticket.clone();
                let binding = Binding {
                    provider_id: self.provider.clone(),
                    host_id: self.host.clone(),
                    account_id: id.clone(),
                };
                let mut config = self.base.clone();
                config.private_home = p.home.clone();
                let next_turn =
                    CodexProcessAdapter::new(self.provider.clone(), self.host.clone(), config)?;
                c.complete_managed_login(self, &ticket, binding)
                    .map_err(|_| ProcessFault::StaleCoordinator)?;
                let p = self.pending.take().unwrap();
                // Old active turn is already fenced by complete_managed_login. Never reuse its child.
                self.turn = Some(next_turn);
                self.active = Some(Session {
                    id: id.clone(),
                    email: Zeroizing::new(email),
                    pipes: p.pipes,
                    view: p.view,
                    stage: SessionStage::Ready,
                    catalog: crate::models::Query::new(),
                    changed: Instant::now(),
                });
                // Catalogue failure is distinct from account login failure.
                let _ = self.refresh_models();
                self.view.selected_account = Some(id);
                self.view.status = AuthStatus::Connected;
                self.view.phase = "connected";
                self.view.error_code = None;
                self.view.fault = None;
                self.prompt = None;
                self.view.action_available = false;
            }
            _ => return Err(ProcessFault::Protocol),
        }
        Ok(())
    }
}
fn valid_url(s: &str) -> bool {
    s.len() <= 8192
        && s.is_ascii()
        && !s
            .bytes()
            .any(|b| b.is_ascii_whitespace() || b.is_ascii_control() || b == b'\\')
        && (s.starts_with("https://auth.openai.com/") || s.starts_with("https://chatgpt.com/"))
}
impl ProviderAdapter for ManagedCodexAdapter {
    fn provider_id(&self) -> &Id {
        &self.provider
    }
    fn host_id(&self) -> &Id {
        &self.host
    }
    fn start_login(&mut self, t: &LoginTicket, expected: Option<&Id>) -> Result<(), ProviderError> {
        if self.owner_instance.is_some_and(|owner| owner != t.instance) {
            return Err(ProviderError::Denied);
        }
        self.owner_instance = Some(t.instance);
        if self.pending.is_some()
            || self
                .active
                .as_ref()
                .is_some_and(|s| s.stage != SessionStage::Ready)
        {
            return Err(ProviderError::Unavailable);
        }
        if expected.is_some_and(|id| self.active.as_ref().is_none_or(|s| &s.id != id)) {
            return Err(ProviderError::Denied);
        }
        let home = if self.base.persistent_auth {
            self.base.private_home.clone()
        } else {
            self.base.private_home.join(format!(
                "attempt-{}-{}-{}",
                std::process::id(),
                t.instance,
                t.generation
            ))
        };
        if !self.base.persistent_auth {
            std::fs::create_dir(&home).map_err(|_| ProviderError::Transport)?;
        }
        let mut cfg = self.base.clone();
        cfg.private_home = home.clone();
        let pipes = Pipes::start(&cfg).map_err(|_| ProviderError::Transport)?;
        pipes.send(json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"hangul_ai_managed_login","title":"Hangul Rust managed login","version":"0.1.0"}}})).map_err(|_|ProviderError::Transport)?;
        let now = Instant::now();
        self.pending = Some(Attempt {
            ticket: t.clone(),
            expected: expected.cloned(),
            home,
            pipes,
            view: ProcessView {
                direct_child_exited: false,
                settled: false,
                login_implemented: true,
                ..ProcessView::default()
            },
            stage: Stage::Initialize,
            login_id: None,
            started: now,
            stage_started: now,
            stop_at: None,
            early: vec![],
        });
        self.prompt = None;
        self.view.action_available = false;
        self.view.status = AuthStatus::Starting;
        self.view.phase = "initializing";
        self.view.error_code = None;
        self.view.login_generation = t.generation;
        self.view.fault = None;
        self.view.cancel_response_confirmed = false;
        self.view.provider_logout_confirmed = false;
        Ok(())
    }
    fn cancel_login(&mut self, t: &LoginTicket) -> Result<(), ProviderError> {
        let p = self.pending.as_mut().ok_or(ProviderError::Unavailable)?;
        if &p.ticket != t {
            return Err(ProviderError::Protocol);
        }
        p.stage = Stage::Stopping;
        p.stop_at = Some(Instant::now());
        self.prompt = None;
        self.view.action_available = false;
        self.view.status = AuthStatus::Cancelled;
        if let Some(id) = &p.login_id {
            p.pipes
                .send(json!({"id":4,"method":"account/login/cancel","params":{"loginId":id}}))
                .map_err(|_| ProviderError::Transport)
        } else {
            p.pipes.kill();
            Ok(())
        }
    }
    fn start_turn(
        &mut self,
        _: &TurnTicket,
        _: &Secret,
        _: &TurnRequest,
    ) -> Result<(), ProviderError> {
        Err(ProviderError::Unavailable)
    }
    fn start_managed_turn(&mut self, t: &TurnTicket, r: &TurnRequest) -> Result<(), ProviderError> {
        if self.owner_instance != Some(t.instance) {
            return Err(ProviderError::Denied);
        }
        let s = self.active.as_ref().ok_or(ProviderError::Unavailable)?;
        if s.stage != SessionStage::Ready
            || s.id != t.binding.account_id
            || self.view.selected_account.as_ref() != Some(&s.id)
        {
            return Err(ProviderError::Denied);
        }
        self.turn
            .as_mut()
            .ok_or(ProviderError::Unavailable)?
            .start_managed_turn(t, r)
    }
    fn cancel_turn(&mut self, t: &TurnTicket) -> Result<(), ProviderError> {
        self.turn
            .as_mut()
            .ok_or(ProviderError::Unavailable)?
            .cancel_turn(t)
    }
}
