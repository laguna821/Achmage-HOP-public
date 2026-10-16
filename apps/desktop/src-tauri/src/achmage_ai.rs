//! Window-fenced AI turns. Restore is status-only; login requires an explicit action.
use achmage_providers::{ClaudeHost, Config as ClaudeConfig, GrokConfig, GrokHost, LoginMode};
use hangul_ai_session::{
    bridge::{Action, Host},
    cli::CliHost,
    process::LaunchConfig,
};
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Manager, WebviewWindow};

#[derive(Default)]
pub struct AiState(
    Mutex<HashMap<String, WindowHost>>,
    Mutex<Option<Arc<Mutex<SharedSession>>>>,
    Mutex<Option<Arc<Mutex<SharedSession>>>>,
    /// When missing official CLIs were last looked for; status polls rediscover at most this often.
    Mutex<Option<std::time::Instant>>,
    /// Providers the owner disconnected in a window ("연결 해제"). Only the desktop reconnects them;
    /// a remote session (Telegram) may not, because for Claude, Grok and Gemini the disconnect is
    /// app-level and a restore would sign every window back in.
    Mutex<HashSet<String>>,
);

const DESKTOP_DISCONNECTED: &str =
    "PC에서 연결을 해제한 AI입니다. 쓰려면 PC의 Achmage HOP AI 패널에서 다시 연결해 주세요.";

/// Applies the owner's desktop disconnect to a reconnecting action on `provider`: a window's
/// explicit login, restore or refresh lifts it; a remote session's is refused while it holds.
fn disconnect_gate(
    disconnected: &mut HashSet<String>,
    provider: &str,
    action: &Action,
    remote: bool,
) -> Result<(), String> {
    let reconnect = matches!(
        action,
        Action::BeginLogin {}
            | Action::BeginConsoleLogin {}
            | Action::RestoreConnection {}
            | Action::RefreshModels {}
    );
    if !reconnect {
        return Ok(());
    }
    if remote {
        if disconnected.contains(provider) {
            return Err(DESKTOP_DISCONNECTED.into());
        }
    } else {
        disconnected.remove(provider);
    }
    Ok(())
}

/// Switching provider waits only for this session's own work. A CLI shared by all windows
/// (`shared_owner` is `Some`) may be busy with another window's turn; that must not pin this
/// session to the shared provider.
fn switch_blocked(state: &Value, shared_owner: Option<Option<&str>>, label: &str) -> bool {
    let busy = state["busy"] == true || state["commandPending"] == true;
    busy && shared_owner.is_none_or(|owner| owner == Some(label))
}

const REDISCOVERY: std::time::Duration = std::time::Duration::from_secs(10);

/// A provider that cannot be prepared is reported as unavailable; it never fails the other providers.
fn optional<T>(found: Result<Option<T>, String>) -> Option<T> {
    found.unwrap_or_else(|reason| {
        eprintln!("AI provider unavailable: {reason}");
        None
    })
}

/// One official CLI whose account and child process are shared by every document window.
trait OfficialCli: Send {
    fn name(&self) -> &'static str;
    fn view(&mut self) -> Value;
    fn dispatch(&mut self, action: Action) -> Result<(), String>;
}

fn start_failed(name: &'static str) -> impl Fn(&'static str) -> String {
    move |code| format!("{name} 작업을 시작하지 못했습니다 ({code}).")
}

impl OfficialCli for ClaudeHost {
    fn name(&self) -> &'static str {
        "Claude"
    }
    fn view(&mut self) -> Value {
        self.state()
    }
    fn dispatch(&mut self, action: Action) -> Result<(), String> {
        match action {
            Action::BeginLogin {} => self.begin_login(),
            Action::BeginConsoleLogin {} => self.begin_console_login(),
            Action::RestoreConnection {} => self.restore(),
            Action::RefreshModels {} => self.refresh_models(),
            Action::CancelLogin {} => self.cancel_login(),
            Action::CancelTurn { turn_id } => self.cancel_turn(&turn_id),
            Action::Logout {} => self.disconnect(),
            Action::Send {
                request_id,
                prompt,
                model,
                reasoning_effort,
            } => { if reasoning_effort.is_some() { return Err("Claude 추론 강도 선택은 아직 지원하지 않습니다.".into()); } self.send(request_id, prompt, model) },
            Action::SelectProvider { .. } => {
                return Err("제공자 선택은 창에서 처리해야 합니다.".into())
            }
        }
        .map_err(start_failed("Claude"))
    }
}

impl OfficialCli for GrokHost {
    fn name(&self) -> &'static str {
        "Grok"
    }
    fn view(&mut self) -> Value {
        // `session/set_model` is not a verified official contract yet, so a listed model could not
        // be honoured. The picker therefore shows the CLI default instead of unusable choices.
        let mut state = self.state();
        state["models"] = serde_json::json!([]);
        state
    }
    fn dispatch(&mut self, action: Action) -> Result<(), String> {
        match action {
            Action::BeginLogin {} | Action::BeginConsoleLogin {} => self.begin_login(LoginMode::Browser),
            // The CLI only reports models through a fresh status probe.
            Action::RestoreConnection {} | Action::RefreshModels {} => self.restore(),
            Action::CancelLogin {} => self.cancel_login(),
            Action::CancelTurn { turn_id } => self.cancel_turn(&turn_id),
            Action::Logout {} => self.disconnect(),
            Action::Send {
                request_id,
                prompt,
                model,
                reasoning_effort,
            } => {
                if reasoning_effort.is_some() {
                    return Err("Grok 추론 강도 선택은 지원하지 않습니다.".into());
                }
                if model.is_some() {
                    return Err("Grok 모델 선택은 아직 지원하지 않습니다. 공식 기본 모델을 사용합니다.".into());
                }
                self.send(request_id, prompt)
            }
            Action::SelectProvider { .. } => {
                return Err("제공자 선택은 창에서 처리해야 합니다.".into())
            }
        }
        .map_err(start_failed("Grok"))
    }
}

struct SharedSession {
    host: Box<dyn OfficialCli>,
    owner: Option<String>,
}

fn claude_projection(mut state: Value, owner: Option<&str>, window: &str) -> Value {
    if owner != Some(window) {
        state["turn"] = serde_json::json!({"id":null,"status":"idle","text":null});
        state["usage"] =
            serde_json::json!({"inputTokens":null,"outputTokens":null,"remainingPercent":null});
    }
    state
}

fn claude_control_allowed(
    state: &Value,
    owner: Option<&str>,
    window: &str,
    action: &Action,
) -> bool {
    if matches!(action, Action::Logout {}) {
        return true;
    }
    if matches!(action, Action::CancelLogin {} | Action::CancelTurn { .. }) {
        return owner == Some(window);
    }
    state["busy"] != true || owner == Some(window)
}

impl SharedSession {
    fn action(&mut self, window: &str, action: Action) -> Result<(), String> {
        let state = self.host.view();
        if !claude_control_allowed(&state, self.owner.as_deref(), window, &action) {
            return Err(format!(
                "다른 문서창의 {} 작업이 진행 중입니다. 해당 창에서 마치거나 취소하세요.",
                self.host.name()
            ));
        }
        let claim = matches!(
            action,
            Action::BeginLogin {}
                | Action::BeginConsoleLogin {}
                | Action::RestoreConnection {}
                | Action::RefreshModels {}
                | Action::Send { .. }
        );
        self.host.dispatch(action)?;
        if claim {
            self.owner = Some(window.to_owned());
        }
        if matches!(
            self.host.view()["auth"]["status"].as_str(),
            Some("signed_out")
        ) {
            self.owner = None;
        }
        Ok(())
    }
}

struct WindowHost {
    core: Host,
    label: String,
    claude: Option<Arc<Mutex<SharedSession>>>,
    grok: Option<Arc<Mutex<SharedSession>>>,
    google: Option<CliHost>,
    selected: String,
    generation: u64,
    last: Value,
}

/// Provider availability states the actual installation: an official CLI is found or it is not.
fn project_availability(providers: &mut Value, id: &str, installed: bool, missing: &str) {
    if let Some(entry) = providers
        .as_array_mut()
        .and_then(|list| list.iter_mut().find(|p| p["id"] == id))
    {
        entry["available"] = serde_json::json!(installed);
        entry["unavailableReason"] = if installed {
            Value::Null
        } else {
            serde_json::json!(missing)
        };
        entry["authMethods"] = if installed {
            serde_json::json!(["official_cli"])
        } else {
            serde_json::json!([])
        };
    }
}

fn shared_projection(session: &Arc<Mutex<SharedSession>>, window: &str) -> Value {
    let mut c = session.lock().unwrap();
    let state = c.host.view();
    claude_projection(state, c.owner.as_deref(), window)
}

impl WindowHost {
    fn state(&mut self) -> Value {
        let base = self.core.state();
        let mut result = if self.selected == "gemini" {
            self.google
                .as_ref()
                .map(CliHost::state)
                .unwrap_or_else(|| base.clone())
        } else if self.selected == "claude" {
            self.claude
                .as_ref()
                .map(|c| shared_projection(c, &self.label))
                .unwrap_or_else(|| base.clone())
        } else if self.selected == "grok" {
            self.grok
                .as_ref()
                .map(|c| shared_projection(c, &self.label))
                .unwrap_or_else(|| base.clone())
        } else {
            base.clone()
        };
        result["providers"] = base["providers"].clone();
        project_availability(&mut result["providers"], "gemini", self.google.is_some(), "Gemini 공식 CLI(agy)가 설치되어 있지 않습니다.");
        project_availability(&mut result["providers"], "claude", self.claude.is_some(), "Claude 공식 CLI가 설치되어 있지 않습니다.");
        project_availability(&mut result["providers"], "grok", self.grok.is_some(), "Grok 공식 CLI가 설치되어 있지 않습니다.");
        result["selectedProvider"] = serde_json::json!(self.selected);
        result.as_object_mut().unwrap().remove("generation");
        if result != self.last {
            self.generation = self.generation.saturating_add(1);
            self.last = result.clone();
        }
        result["generation"] = serde_json::json!(self.generation);
        result
    }
    fn action(&mut self, request: Request) -> Result<Value, String> {
        // Refresh worker/account changes before accepting a request tied to an older view.
        self.state();
        if request.expected.is_some_and(|expected| expected != self.generation) {
            return Err("AI 상태가 변경되었습니다. 다시 시도하세요.".into());
        }
        if let Action::SelectProvider { ref provider } = request.action {
            let current = self.state();
            let shared = match self.selected.as_str() {
                "claude" => self.claude.as_ref(),
                "grok" => self.grok.as_ref(),
                _ => None,
            };
            let owner = shared.map(|session| {
                session
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .owner
                    .clone()
            });
            if switch_blocked(&current, owner.as_ref().map(Option::as_deref), &self.label) {
                return Err("진행 중인 작업을 먼저 마치거나 중단하세요.".into());
            }
            let selected = provider.clone();
            let generation = self.core.state()["generation"].as_u64().unwrap_or(0);
            self.core.action(generation, request.action)?;
            self.selected = selected;
        } else if let Some(claude) = self.claude.as_ref().filter(|_| self.selected == "claude") {
            claude
                .lock()
                .map_err(|_| "Claude 상태를 읽지 못했습니다.")?
                .action(&self.label, request.action)?;
        } else if let Some(grok) = self.grok.as_ref().filter(|_| self.selected == "grok") {
            grok.lock()
                .map_err(|_| "Grok 상태를 읽지 못했습니다.")?
                .action(&self.label, request.action)?;
        } else if let Some(google) = self.google.as_mut().filter(|_| self.selected == "gemini") {
            google.action(request.action)?;
        } else {
            let generation = self.core.state()["generation"].as_u64().unwrap_or(0);
            self.core.action(generation, request.action)?;
        }
        Ok(self.state())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiRequest {
    expected_generation: u64,
    action: Action,
}

/// One action for a session. A window must name the generation it last saw; an internal session
/// (Telegram) acts on the latest state because it re-reads the state before every step.
struct Request {
    expected: Option<u64>,
    action: Action,
}

impl From<AiRequest> for Request {
    fn from(request: AiRequest) -> Self {
        Self {
            expected: Some(request.expected_generation),
            action: request.action,
        }
    }
}

fn discover_codex() -> Option<PathBuf> {
    let override_path = std::env::var_os("ACHMAGE_CODEX_EXE").map(PathBuf::from);
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let roaming = std::env::var_os("APPDATA").map(PathBuf::from);
    let search_path = std::env::var_os("PATH");
    let candidates = codex_candidates(
        override_path.as_deref(),
        local.as_deref(),
        search_path.as_deref(),
        roaming.as_deref(),
        cfg!(windows),
    );
    // Desktop launchers often have a shorter PATH than an interactive shell. Prefer the
    // engine maintained by the installed ChatGPT app, while respecting an explicit override.
    #[cfg(target_os = "linux")]
    let candidates = prefer_bundled_codex(candidates, override_path.is_some(), PathBuf::from("/usr/lib/chatgpt/resources/codex"));
    candidates.into_iter().find_map(valid_codex_candidate)
}

#[cfg(target_os = "linux")]
fn prefer_bundled_codex(mut candidates: Vec<PathBuf>, has_override: bool, bundle: PathBuf) -> Vec<PathBuf> {
    candidates.insert(usize::from(has_override), bundle);
    candidates
}

// Keep discovery separate from process launch: inspecting installed paths never
// reads an account, starts a CLI, or changes an installation.
fn codex_candidates(
    override_path: Option<&std::path::Path>,
    local: Option<&std::path::Path>,
    search_path: Option<&std::ffi::OsStr>,
    roaming: Option<&std::path::Path>,
    windows: bool,
) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = override_path { candidates.push(path.to_owned()); }
    if windows {
        if let Some(local) = local {
            let root = local.join("OpenAI/Codex/bin");
            let mut bundles = Vec::new();
            if let Ok(entries) = std::fs::read_dir(root) {
                for entry in entries.flatten() {
                    let executable = entry.path().join("codex.exe");
                    if let Ok(metadata) = executable.metadata() {
                        if metadata.is_file() {
                            bundles.push((metadata.modified().unwrap_or(std::time::UNIX_EPOCH), executable));
                        }
                    }
                }
            }
            // Newest executable mtime first; lexical path breaks timestamp ties.
            bundles.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
            candidates.extend(bundles.into_iter().map(|(_, path)| path));
        }
    }
    if let Some(paths) = search_path {
        for path in std::env::split_paths(paths) {
            candidates.push(path.join(if windows { "codex.exe" } else { "codex" }));
        }
    }
    if windows {
        if let Some(roaming) = roaming {
            candidates.push(roaming.join("npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/codex/codex.exe"));
        }
    }
    candidates
}

fn valid_codex_candidate(path: PathBuf) -> Option<PathBuf> {
    let path = path.canonicalize().ok()?;
    (path.is_file()
        && path.file_name().and_then(|n| n.to_str())
            .is_some_and(|n| n == "codex" || n.eq_ignore_ascii_case("codex.exe")))
    .then_some(path)
}

fn host(
    app: &AppHandle,
    label: &str,
    claude: Option<Arc<Mutex<SharedSession>>>,
    grok: Option<Arc<Mutex<SharedSession>>>,
    restore_openai: bool,
) -> Result<WindowHost, String> {
    let config = if let Some(executable) = discover_codex() {
        let root = app
            .path()
            .app_local_data_dir()
            .map_err(|_| "AI 작업 경로를 준비하지 못했습니다.")?
            .join("achmage-ai");
        std::fs::create_dir_all(&root).map_err(|_| "AI 작업 경로를 만들지 못했습니다.")?;
        let profile = root.join("openai");
        std::fs::create_dir_all(&profile).map_err(|_| "AI 로그인 경로를 만들지 못했습니다.")?;
        // On Linux the sign-in is a file in this profile (achmage_ai::managed::PERSISTENT_CREDENTIAL_STORE).
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&profile, std::fs::Permissions::from_mode(0o700));
        }
        let mut config = LaunchConfig::codex(executable, root, profile);
        config.persistent_auth = true;
        config.handshake_timeout = std::time::Duration::from_secs(30);
        Some(config)
    } else {
        None
    };
    let restore = restore_openai && config.as_ref().is_some_and(|c| c.persistent_auth);
    let mut h = Host::new(config);
    if restore {
        let generation = h.state()["generation"].as_u64().unwrap_or(0);
        h.action(generation, Action::RestoreConnection {})?;
    }
    let google = optional(google_host(app));
    Ok(WindowHost {
        core: h,
        label: label.to_owned(),
        claude,
        grok,
        google,
        selected: "openai".into(),
        generation: 0,
        last: Value::Null,
    })
}

fn discover_claude() -> Option<PathBuf> {
    let name = if cfg!(windows) {
        "claude.exe"
    } else {
        "claude"
    };
    let mut candidates = Vec::new();
    if let Some(paths) = std::env::var_os("PATH") {
        for path in std::env::split_paths(&paths) {
            if path.is_absolute() {
                candidates.push(path.join(name));
            }
        }
    }
    for home in ["USERPROFILE", "HOME"] {
        if let Some(home) = std::env::var_os(home) {
            let home = PathBuf::from(home);
            if home.is_absolute() {
                candidates.push(home.join(".local/bin").join(name));
            }
        }
    }
    candidates.into_iter().find_map(|p| {
        // Check requested executable basename before resolving installation symlinks.
        if p.file_name()?.to_str()? != name || !p.is_file() {
            return None;
        }
        p.canonicalize().ok()
    })
}

fn claude_host(app: &AppHandle) -> Result<Option<Arc<Mutex<SharedSession>>>, String> {
    let Some(executable) = discover_claude() else {
        return Ok(None);
    };
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Claude 작업 경로를 준비하지 못했습니다.")?
        .join("achmage-ai");
    let mut host = ClaudeHost::new(ClaudeConfig {
        executable,
        profile: root.join("claude"),
        cwd: root.join("claude-work"),
    })
    .map_err(|code| format!("Claude 앱 프로필을 준비하지 못했습니다 ({code})."))?;
    // Restore never starts auth login or a browser. It only asks the official CLI for status.
    host.restore()
        .map_err(|code| format!("Claude 로그인 상태 확인을 시작하지 못했습니다 ({code})."))?;
    Ok(Some(Arc::new(Mutex::new(SharedSession {
        host: Box::new(host),
        owner: None,
    }))))
}

fn grok_host(app: &AppHandle) -> Result<Option<Arc<Mutex<SharedSession>>>, String> {
    let Some(executable) = achmage_providers::locate_grok(None, None) else {
        return Ok(None);
    };
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Grok 작업 경로를 준비하지 못했습니다.")?
        .join("achmage-ai");
    let mut host = GrokHost::new(GrokConfig::new(
        Some(executable),
        root.join("grok"),
        root.join("grok-work"),
    ))
    .map_err(|code| format!("Grok 앱 프로필을 준비하지 못했습니다 ({code})."))?;
    // Status probe only: never starts `grok login` or a browser.
    host.restore()
        .map_err(|code| format!("Grok 로그인 상태 확인을 시작하지 못했습니다 ({code})."))?;
    Ok(Some(Arc::new(Mutex::new(SharedSession {
        host: Box::new(host),
        owner: None,
    }))))
}

fn google_host(app: &AppHandle) -> Result<Option<CliHost>, String> {
    let mut google_candidates = Vec::new();
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        google_candidates.push(PathBuf::from(local).join("agy/bin/agy.exe"));
    }
    if let Some(home) = std::env::var_os("HOME") {
        google_candidates.push(PathBuf::from(home).join(".local/bin/agy"));
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for path in std::env::split_paths(&paths) {
            google_candidates.push(path.join(if cfg!(windows) { "agy.exe" } else { "agy" }));
        }
    }
    if let Some(owned) = crate::achmage_runtime::installed_runtime(app) {
        google_candidates.push(owned);
    }
    let google = google_candidates
        .into_iter()
        .find(|p| p.is_file())
        .map(|exe| {
            let cwd = app
                .path()
                .app_local_data_dir()
                .unwrap()
                .join("achmage-ai/google-work");
            std::fs::create_dir_all(&cwd)
                .map_err(|_| "Google 작업 폴더를 준비하지 못했습니다.".to_owned())?;
            Ok::<_, String>(CliHost::google(exe, cwd))
        })
        .transpose()?;
    Ok(google)
}

/// `remote` marks a non-window session (Telegram), which may not undo a desktop disconnect.
fn project(
    app: &AppHandle,
    label: &str,
    state: &AiState,
    action: Option<Request>,
    remote: bool,
) -> Result<Value, String> {
    let mut hosts = state.0.lock().map_err(|_| "AI 상태를 읽지 못했습니다.")?;
    // Looking for a newly installed CLI walks PATH and the disk; status polls do it at most every 10 s.
    let rediscover = {
        let mut last = state.3.lock().map_err(|_| "AI 상태를 읽지 못했습니다.")?;
        let due = last.is_none_or(|at| at.elapsed() >= REDISCOVERY);
        if due {
            *last = Some(std::time::Instant::now());
        }
        due
    };
    let claude = {
        let mut shared = state
            .1
            .lock()
            .map_err(|_| "Claude 상태를 읽지 못했습니다.")?;
        if shared.is_none() && rediscover {
            *shared = optional(claude_host(app));
        }
        shared.clone()
    };
    let grok = {
        let mut shared = state
            .2
            .lock()
            .map_err(|_| "Grok 상태를 읽지 못했습니다.")?;
        if shared.is_none() && rediscover {
            *shared = optional(grok_host(app));
        }
        shared.clone()
    };
    if !hosts.contains_key(label) {
        // A window resumes Codex as it always has; a remote session not after a desktop disconnect.
        let restore_openai = !remote
            || !state
                .4
                .lock()
                .map_err(|_| "AI 상태를 읽지 못했습니다.")?
                .contains("openai");
        let created = host(app, label, claude.clone(), grok.clone(), restore_openai)?;
        hosts.insert(label.to_owned(), created);
    }
    // Rediscovery supports installing an official CLI while the app stays open.
    for h in hosts.values_mut() {
        if h.claude.is_none() {
            h.claude = claude.clone();
        }
        if h.grok.is_none() {
            h.grok = grok.clone();
        }
    }
    if action
        .as_ref()
        .is_some_and(|r| matches!(r.action, Action::BeginLogin {} | Action::BeginConsoleLogin {}))
    {
        for (other_label, other) in hosts.iter_mut() {
            if other_label != label {
                let state = other.state();
                if state["auth"]["status"] == "pending" {
                    return Err("다른 문서창에서 연결을 확인 중입니다. 해당 연결을 마친 뒤 다시 시도하세요.".into());
                }
            }
        }
    }
    let disconnect = action
        .as_ref()
        .is_some_and(|r| matches!(r.action, Action::Logout {}));
    let h = hosts.get_mut(label).ok_or("AI 상태를 읽지 못했습니다.")?;
    if h.google.is_none() && rediscover {
        h.google = optional(google_host(app));
    }
    let disconnected_provider = h.selected.clone();
    if let Some(r) = &action {
        let mut disconnected = state.4.lock().map_err(|_| "AI 상태를 읽지 못했습니다.")?;
        disconnect_gate(&mut disconnected, &disconnected_provider, &r.action, remote)?;
    }
    let result = if let Some(r) = action {
        h.action(r)?
    } else {
        h.state()
    };
    if let Some(url) = h.core.take_login_url() {
        if open::that_detached(url).is_err() {
            h.core.browser_failed();
            return Ok(h.state());
        }
    }
    if disconnect {
        state
            .4
            .lock()
            .map_err(|_| "AI 상태를 읽지 못했습니다.")?
            .insert(disconnected_provider.clone());
        for (other_label, other) in hosts.iter_mut() {
            if other_label != label {
                if disconnected_provider == "gemini" {
                    if let Some(google) = other.google.as_mut() {
                        let _ = google.action(Action::Logout {});
                    }
                } else if disconnected_provider == "claude" || disconnected_provider == "grok" {
                    // A single shared CLI session was already fenced by the originating action.
                } else if disconnected_provider == "openai" {
                    other.core.disconnect_local();
                }
            }
        }
    }
    Ok(result)
}

// The panel polls state every 500 ms. A projection can look for newly installed CLIs on PATH,
// hash an installed runtime on first use or start a provider process, so it runs on a blocking
// worker instead of the window's main thread (a sync command there freezes the whole window).
#[tauri::command]
pub async fn achmage_ai_state(app: AppHandle, window: WebviewWindow) -> Result<Value, String> {
    let label = window.label().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AiState>();
        project(&app, &label, state.inner(), None, false)
    })
    .await
    .map_err(|_| "AI 상태를 읽지 못했습니다.".to_string())?
}
#[tauri::command]
pub async fn achmage_ai_action(
    app: AppHandle,
    window: WebviewWindow,
    request: AiRequest,
) -> Result<Value, String> {
    let label = window.label().to_owned();
    let request: Request = request.into();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AiState>();
        project(&app, &label, state.inner(), Some(request), false)
    })
    .await
    .map_err(|_| "AI 요청을 처리하지 못했습니다.".to_string())?
}

/// Polled state of a non-window session, e.g. `telegram-<user id>`. The session gets the same
/// providers in the same no-tool modes as a document window; it is created on first use.
pub(crate) fn snapshot(app: &AppHandle, state: &AiState, label: &str) -> Result<Value, String> {
    project(app, label, state, None, true)
}

/// Applies `action` to a non-window session against its latest state (see [`snapshot`]).
pub(crate) fn act(
    app: &AppHandle,
    state: &AiState,
    label: &str,
    action: Action,
) -> Result<Value, String> {
    project(
        app,
        label,
        state,
        Some(Request {
            expected: None,
            action,
        }),
        true,
    )
}

/// Sign-in status (`signed_in`, `signed_out`, `pending`, ...) of every installed provider for one
/// session without changing its selection. `null` means not installed, or, for Codex, unknown until
/// it is the selected provider (its account is only reported while selected).
pub(crate) fn accounts(state: &AiState, label: &str) -> Value {
    let Ok(mut hosts) = state.0.lock() else {
        return Value::Null;
    };
    let Some(h) = hosts.get_mut(label) else {
        return Value::Null;
    };
    let auth = |state: Value| state["auth"]["status"].clone();
    let openai = if h.selected == "openai" {
        auth(h.core.state())
    } else {
        Value::Null
    };
    let claude = h
        .claude
        .as_ref()
        .map_or(Value::Null, |c| auth(shared_projection(c, &h.label)));
    let grok = h
        .grok
        .as_ref()
        .map_or(Value::Null, |c| auth(shared_projection(c, &h.label)));
    let gemini = h.google.as_ref().map_or(Value::Null, |g| auth(g.state()));
    serde_json::json!({"openai": openai, "claude": claude, "gemini": gemini, "grok": grok})
}
/// A closing window gives up its claim on a shared CLI session: its own sign-in attempt or answer in
/// progress is cancelled, but the account stays connected for the other document windows.
fn release_window(session: &mut SharedSession, label: &str) {
    if session.owner.as_deref() != Some(label) {
        return;
    }
    let state = session.host.view();
    if state["auth"]["status"] == "pending" {
        let _ = session.host.dispatch(Action::CancelLogin {});
    }
    if state["busy"] == true {
        if let Some(turn_id) = state["turn"]["id"].as_str() {
            let _ = session.host.dispatch(Action::CancelTurn { turn_id: turn_id.to_owned() });
        }
    }
    session.owner = None;
}

pub fn close(state: &AiState, label: &str) {
    if let Ok(mut hosts) = state.0.lock() {
        if let Some(host) = hosts.remove(label) {
            for shared in [host.claude, host.grok].into_iter().flatten() {
                if let Ok(mut session) = shared.lock() {
                    release_window(&mut session, label);
                }
            }
        }
    }
}

#[cfg(test)]
mod claude_tests {
    use super::*;
    use serde_json::json;
    fn state() -> Value {
        json!({"auth":{"status":"signed_in","sessionGeneration":"8"},"turn":{"id":"r1","status":"completed","text":"private window response"},"usage":{"inputTokens":8},"busy":false})
    }
    #[test]
    fn other_window_cannot_see_response_or_usage() {
        let projected = claude_projection(state(), Some("doc-a"), "doc-b");
        assert!(projected["turn"]["text"].is_null());
        assert!(projected["usage"]["inputTokens"].is_null());
        assert_eq!(projected["auth"]["sessionGeneration"], "8");
    }
    #[test]
    fn owner_projection_is_exact() {
        assert_eq!(claude_projection(state(), Some("doc-a"), "doc-a"), state());
    }
    #[test]
    fn cancelling_another_window_is_rejected() {
        assert!(!claude_control_allowed(
            &state(),
            Some("doc-a"),
            "doc-b",
            &Action::CancelTurn {
                turn_id: "r1".into()
            }
        ));
        assert!(!claude_control_allowed(
            &state(),
            None,
            "doc-b",
            &Action::CancelLogin {}
        ));
    }
    #[test]
    fn busy_shared_provider_blocks_new_window_but_logout_fences_all() {
        let mut s = state();
        s["busy"] = json!(true);
        assert!(!claude_control_allowed(
            &s,
            Some("doc-a"),
            "doc-b",
            &Action::BeginLogin {}
        ));
        assert!(claude_control_allowed(
            &s,
            Some("doc-a"),
            "doc-b",
            &Action::Logout {}
        ));
        assert!(claude_control_allowed(
            &s,
            Some("doc-a"),
            "doc-a",
            &Action::CancelLogin {}
        ));
    }
    #[test]
    fn idle_provider_allows_other_window_send() {
        assert!(claude_control_allowed(
            &state(),
            Some("doc-a"),
            "doc-b",
            &Action::Send {
                request_id: "r2".into(),
                prompt: "hello".into(),
                model: None,
                reasoning_effort: None
            }
        ));
    }
}


#[cfg(test)]
mod provider_projection_tests {
    use super::*;
    use serde_json::json;
    fn grok() -> GrokHost {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "hop-grok-projection-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        GrokHost::new(GrokConfig::new(
            Some(root.join("missing/grok.exe")),
            root.join("grok"),
            root.join("grok-work"),
        ))
        .unwrap()
    }
    #[test]
    fn missing_cli_is_reported_as_not_installed_and_found_cli_as_official() {
        let mut providers = json!([{"id":"grok","available":false,"unavailableReason":"준비 중","authMethods":[]},{"id":"claude","available":false,"authMethods":[]}]);
        project_availability(&mut providers, "grok", false, "Grok 공식 CLI가 설치되어 있지 않습니다.");
        project_availability(&mut providers, "claude", true, "unused");
        assert_eq!(providers[0]["unavailableReason"], "Grok 공식 CLI가 설치되어 있지 않습니다.");
        assert_eq!(providers[0]["available"], false);
        assert_eq!(providers[1]["available"], true);
        assert!(providers[1]["unavailableReason"].is_null());
        assert_eq!(providers[1]["authMethods"], json!(["official_cli"]));
    }
    #[test]
    fn grok_never_offers_a_model_it_cannot_pass_and_refuses_model_or_effort() {
        let mut host = grok();
        assert_eq!(host.view()["models"], json!([]));
        assert_eq!(host.view()["selectedProvider"], "grok");
        let send = |model: Option<&str>, effort: Option<&str>| Action::Send {
            request_id: "r1".into(),
            prompt: "질문".into(),
            model: model.map(str::to_owned),
            reasoning_effort: effort.map(str::to_owned),
        };
        assert!(host.dispatch(send(Some("grok-guess"), None)).unwrap_err().contains("공식 기본 모델"));
        assert!(host.dispatch(send(None, Some("high"))).unwrap_err().contains("추론 강도"));
        // Not signed in: the adapter refuses before any child process starts.
        assert!(host.dispatch(send(None, None)).unwrap_err().starts_with("Grok 작업을 시작하지 못했습니다"));
    }
    #[test]
    fn closing_the_owner_window_keeps_the_shared_account_for_other_windows() {
        let mut session = SharedSession { host: Box::new(grok()), owner: Some("doc-a".into()) };
        let before = session.host.view();
        release_window(&mut session, "doc-b");
        assert_eq!(session.owner.as_deref(), Some("doc-a"));
        release_window(&mut session, "doc-a");
        assert!(session.owner.is_none());
        let after = session.host.view();
        assert_eq!(after["auth"], before["auth"]);
        assert!(after["notice"].is_null(), "closing a window must not disconnect: {}", after["notice"]);
    }
    #[test]
    fn shared_grok_session_is_fenced_per_window_like_claude() {
        let session = Arc::new(Mutex::new(SharedSession { host: Box::new(grok()), owner: Some("doc-a".into()) }));
        let other = shared_projection(&session, "doc-b");
        assert!(other["turn"]["text"].is_null());
        assert!(session.lock().unwrap().action("doc-b", Action::CancelLogin {}).unwrap_err().contains("다른 문서창의 Grok"));
    }
}

#[cfg(test)]
mod remote_session_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_desktop_disconnect_holds_against_remote_reconnects_until_the_desktop_reconnects() {
        let mut disconnected = HashSet::from(["claude".to_owned()]);
        for action in [
            Action::RestoreConnection {},
            Action::BeginLogin {},
            Action::RefreshModels {},
        ] {
            assert_eq!(
                disconnect_gate(&mut disconnected, "claude", &action, true).unwrap_err(),
                DESKTOP_DISCONNECTED
            );
        }
        // Other providers and non-reconnecting actions are unaffected.
        assert!(
            disconnect_gate(&mut disconnected, "gemini", &Action::RestoreConnection {}, true)
                .is_ok()
        );
        let send = Action::Send {
            request_id: "r".into(),
            prompt: "p".into(),
            model: None,
            reasoning_effort: None,
        };
        assert!(disconnect_gate(&mut disconnected, "claude", &send, true).is_ok());
        assert!(disconnected.contains("claude"));
        // Only an explicit window action lifts it.
        assert!(disconnect_gate(&mut disconnected, "claude", &Action::BeginLogin {}, false).is_ok());
        assert!(!disconnected.contains("claude"));
        assert!(
            disconnect_gate(&mut disconnected, "claude", &Action::RestoreConnection {}, true)
                .is_ok()
        );
    }

    #[test]
    fn switching_away_waits_only_for_this_sessions_own_turn() {
        let busy = json!({"busy": true, "commandPending": false});
        let idle = json!({"busy": false, "commandPending": false});
        // A shared CLI busy with another window's turn does not pin this session.
        assert!(!switch_blocked(&busy, Some(Some("main-a")), "telegram-7"));
        assert!(!switch_blocked(&busy, Some(None), "telegram-7"));
        // Its own turn, or a provider of its own (Codex, Gemini), does.
        assert!(switch_blocked(&busy, Some(Some("telegram-7")), "telegram-7"));
        assert!(switch_blocked(&busy, None, "telegram-7"));
        assert!(switch_blocked(
            &json!({"busy": false, "commandPending": true}),
            None,
            "main-a"
        ));
        assert!(!switch_blocked(&idle, None, "main-a"));
    }
}

#[cfg(test)]
mod codex_discovery_tests {
    use super::*;
    fn fixture() -> PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path=std::env::temp_dir().join("hop-codex-discovery-fixtures").join(format!("{}-{}",std::process::id(),NEXT.fetch_add(1,std::sync::atomic::Ordering::Relaxed)));
        std::fs::create_dir_all(&path).unwrap();path
    }
    fn executable(path: &std::path::Path, seconds:u64) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let file=std::fs::File::create(path).unwrap();
        file.set_times(std::fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH+std::time::Duration::from_secs(seconds))).unwrap();
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn linux_bundle_precedes_path_but_not_explicit_override() {
        let root=fixture();let bundle=root.join("app/codex");let old=root.join("path/codex");let explicit=root.join("override/codex");
        executable(&bundle,200);executable(&old,100);executable(&explicit,50);
        let choose=|v:Vec<PathBuf>|v.into_iter().find_map(valid_codex_candidate);
        assert_eq!(choose(prefer_bundled_codex(vec![old.clone()],false,bundle.clone())),Some(bundle.canonicalize().unwrap()));
        assert_eq!(choose(prefer_bundled_codex(vec![explicit.clone(),old.clone()],true,bundle)),Some(explicit.canonicalize().unwrap()));
        assert_eq!(choose(prefer_bundled_codex(vec![old.clone()],false,root.join("absent/codex"))),Some(old.canonicalize().unwrap()));
    }
    #[test]
    fn override_then_newest_bundle_then_path_then_npm() {
        let root=fixture();let override_path=root.join("override/codex.exe");
        let old=root.join("OpenAI/Codex/bin/old/codex.exe");let new=root.join("OpenAI/Codex/bin/new/codex.exe");
        executable(&old,100);executable(&new,200);executable(&override_path,10);
        let paths=std::env::join_paths([root.join("path")]).unwrap();
        let list=codex_candidates(Some(&override_path),Some(&root),Some(&paths),Some(&root),true);
        assert_eq!(&list[..3],&[override_path.clone(),new.clone(),old]);
        assert_eq!(list[3],root.join("path/codex.exe"));assert!(list[4].ends_with("codex/codex.exe"));
        assert_eq!(list.into_iter().find_map(valid_codex_candidate),Some(override_path.canonicalize().unwrap()));
        let list=codex_candidates(Some(&root.join("missing/codex.exe")),Some(&root),None,None,true);
        assert_eq!(list.into_iter().find_map(valid_codex_candidate),Some(new.canonicalize().unwrap()));
    }
    #[test]
    fn equal_mtime_is_lexical_and_nonfiles_are_ignored() {
        let root=fixture();let b=root.join("OpenAI/Codex/bin/b/codex.exe");let a=root.join("OpenAI/Codex/bin/a/codex.exe");
        executable(&b,100);executable(&a,100);
        std::fs::create_dir_all(root.join("OpenAI/Codex/bin/directory/codex.exe")).unwrap();
        assert_eq!(codex_candidates(None,Some(&root),None,None,true),vec![a,b]);
    }
    #[test]
    fn absent_bundle_preserves_path_and_nonwindows_ignores_windows_roots() {
        let root=fixture();let paths=std::env::join_paths([root.join("first"),root.join("second")]).unwrap();
        assert_eq!(codex_candidates(None,Some(&root),Some(&paths),Some(&root),false),vec![root.join("first/codex"),root.join("second/codex")]);
        let binary=root.join("first/codex.exe");executable(&binary,100);
        let list=codex_candidates(None,Some(&root),Some(&paths),None,true);
        assert_eq!(list.into_iter().find_map(valid_codex_candidate),Some(binary.canonicalize().unwrap()));
        assert!(valid_codex_candidate(root.join("not-an-executable.txt")).is_none());
    }
}
