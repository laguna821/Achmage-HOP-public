//! Official Grok CLI adapter: `grok login` / `grok login --device-auth` for sign-in and
//! `grok agent stdio` (ACP) for conversation. The CLI alone owns credentials inside the
//! app-owned profile; this adapter never reads, stores or prints tokens.
use crate::{
    acp::{Launch, Pipes, Progress, Rpc, Timing, Wire},
    Result,
};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GrokStatus {
    NotInstalled,
    LoginRequired,
    Ready,
}
impl GrokStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotInstalled => "not_installed",
            Self::LoginRequired => "login_required",
            Self::Ready => "ready",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LoginMode {
    /// `grok login`: browser OIDC with PKCE, performed entirely by the CLI.
    Browser,
    /// `grok login --device-auth`: device flow, performed entirely by the CLI.
    DeviceAuth,
}

#[derive(Clone, Debug)]
pub struct GrokLimits {
    pub status: Duration,
    pub login: Duration,
    /// Hard cap for one turn, from child start.
    pub turn: Duration,
    /// Idle limit, refreshed only by activity that belongs to this request/session.
    pub idle: Duration,
    pub cancel_grace: Duration,
}
impl Default for GrokLimits {
    fn default() -> Self {
        Self {
            status: Duration::from_secs(30),
            login: Duration::from_secs(600),
            turn: Duration::from_secs(900),
            idle: Duration::from_secs(120),
            cancel_grace: Duration::from_secs(3),
        }
    }
}

#[derive(Clone, Debug)]
pub struct GrokConfig {
    /// Explicit trusted absolute executable. `None` searches `search_path` for `grok`.
    pub executable: Option<PathBuf>,
    /// PATH value searched when `executable` is `None`; `None` means this process's PATH.
    pub search_path: Option<OsString>,
    /// App-owned profile root. Becomes HOME/USERPROFILE; `<profile>/.grok` becomes GROK_HOME.
    pub profile: PathBuf,
    /// App-owned empty working directory (never a user document directory).
    pub cwd: PathBuf,
    pub limits: GrokLimits,
}
impl GrokConfig {
    pub fn new(executable: Option<PathBuf>, profile: PathBuf, cwd: PathBuf) -> Self {
        Self {
            executable,
            search_path: None,
            profile,
            cwd,
            limits: GrokLimits::default(),
        }
    }
}

/// Explicit absolute file, else the first `grok` executable on an absolute PATH entry.
/// A configured but missing explicit path is reported missing; it never falls back to PATH.
pub fn locate_grok(explicit: Option<&Path>, search_path: Option<&OsStr>) -> Option<PathBuf> {
    if let Some(p) = explicit {
        return (p.is_absolute() && p.is_file()).then(|| p.to_path_buf());
    }
    let owned;
    let search = match search_path {
        Some(s) => s,
        None => {
            owned = std::env::var_os("PATH")?;
            owned.as_os_str()
        }
    };
    let name = if cfg!(windows) { "grok.exe" } else { "grok" };
    std::env::split_paths(search)
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join(name))
        .find(|c| c.is_file() && is_executable(c))
}

#[cfg(unix)]
fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    p.metadata()
        .is_ok_and(|m| m.permissions().mode() & 0o111 != 0)
}
#[cfg(not(unix))]
fn is_executable(_: &Path) -> bool {
    true
}

static PROFILES: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
struct Lease(PathBuf);
impl Drop for Lease {
    fn drop(&mut self) {
        PROFILES.get().unwrap().lock().unwrap().remove(&self.0);
    }
}
struct Running(Arc<AtomicBool>);
impl Drop for Running {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
struct Shared {
    view: Value,
    generation: u64,
    requests: crate::recent::RecentIds,
}

#[derive(Clone)]
struct Owned {
    executable: Option<PathBuf>,
    search_path: Option<OsString>,
    profile: PathBuf,
    cwd: PathBuf,
    limits: GrokLimits,
}
impl Owned {
    fn launch(&self) -> Option<Launch> {
        let executable = locate_grok(self.executable.as_deref(), self.search_path.as_deref())?;
        let p = &self.profile;
        Some(Launch {
            executable,
            cwd: self.cwd.clone(),
            env: vec![
                // GROK_HOME is documented in Orca source (a0f3e788151d81ba81250c67d5fd4e28803ca7bf:
                // src/main/acp/acp-launch-specs.ts directoryAccountBinding('GROK_HOME') and
                // src/shared/grok-session-paths.ts resolveGrokHomeDir), not in the official CLI
                // reference checked on 2026-10-14. HOME/USERPROFILE/APPDATA also point at the owned
                // profile so a missing override can never fall back to the user's own ~/.grok.
                ("GROK_HOME", p.join(".grok").into_os_string()),
                ("HOME", p.clone().into_os_string()),
                ("USERPROFILE", p.clone().into_os_string()),
                (
                    "APPDATA",
                    p.join("AppData").join("Roaming").into_os_string(),
                ),
                (
                    "LOCALAPPDATA",
                    p.join("AppData").join("Local").into_os_string(),
                ),
            ],
        })
    }
    fn cwd_param(&self) -> Result<String> {
        self.cwd
            .to_str()
            .map(str::to_string)
            .ok_or("cwd_unavailable")
    }
    fn timing(&self, hard: Duration, idle: Duration) -> Timing {
        Timing {
            idle,
            hard,
            cancel_grace: self.limits.cancel_grace,
        }
    }
}

/// Windows `canonicalize` yields `\\?\C:\...`; children and ACP `cwd` get the plain form.
fn plain(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        if rest.as_bytes().get(1) == Some(&b':') {
            return PathBuf::from(rest);
        }
    }
    p
}

pub struct GrokHost {
    cfg: Owned,
    shared: Arc<Mutex<Shared>>,
    cancel: Arc<AtomicBool>,
    lease: Arc<Lease>,
    running: Arc<AtomicBool>,
}

impl GrokHost {
    pub fn new(cfg: GrokConfig) -> Result<Self> {
        if !cfg.profile.is_absolute()
            || !cfg.cwd.is_absolute()
            || cfg.executable.as_ref().is_some_and(|e| !e.is_absolute())
        {
            return Err("absolute_paths_required");
        }
        for dir in [
            cfg.profile.join(".grok"),
            cfg.profile.join("AppData").join("Roaming"),
            cfg.profile.join("AppData").join("Local"),
        ] {
            std::fs::create_dir_all(dir).map_err(|_| "profile_unavailable")?;
        }
        std::fs::create_dir_all(&cfg.cwd).map_err(|_| "cwd_unavailable")?;
        let profile = cfg
            .profile
            .canonicalize()
            .map_err(|_| "profile_unavailable")?;
        let cwd = cfg.cwd.canonicalize().map_err(|_| "cwd_unavailable")?;
        if profile.starts_with(&cwd) || cwd.starts_with(&profile) {
            return Err("separate_cwd_required");
        }
        if !PROFILES
            .get_or_init(Default::default)
            .lock()
            .unwrap()
            .insert(profile.clone())
        {
            return Err("profile_in_use");
        }
        let lease = Arc::new(Lease(profile.clone()));
        Ok(Self {
            cfg: Owned {
                executable: cfg.executable,
                search_path: cfg.search_path,
                profile: plain(profile),
                cwd: plain(cwd),
                limits: cfg.limits,
            },
            shared: Arc::new(Mutex::new(Shared {
                view: json!({"selectedProvider":"grok","providerStatus":null,"cliVersion":null,"auth":{"status":"signed_out","sessionGeneration":null,"accountLabel":null},"usage":{"inputTokens":null,"outputTokens":null,"remainingPercent":null},"turn":{"id":null,"status":"idle","text":null},"busy":false,"commandPending":false,"sessionPersistence":"official_cli","notice":null,"models":[]}),
                generation: 0,
                requests: crate::recent::RecentIds::new(4096),
            })),
            cancel: Arc::new(AtomicBool::new(false)),
            lease,
            running: Arc::new(AtomicBool::new(false)),
        })
    }

    pub fn state(&self) -> Value {
        let mut s = self.shared.lock().unwrap().view.clone();
        s["busy"] = json!(self.running.load(Ordering::Acquire));
        s
    }

    /// Status probe only (`--version`, then ACP initialize + session/new). Never starts login.
    pub fn restore(&mut self) -> Result<()> {
        self.connect(None)
    }

    /// Explicit user action. Probes first; launches the official login only when required.
    pub fn begin_login(&mut self, mode: LoginMode) -> Result<()> {
        self.connect(Some(mode))
    }

    fn connect(&mut self, login: Option<LoginMode>) -> Result<()> {
        let mut s = self.shared.lock().unwrap();
        if self.running.load(Ordering::Acquire) {
            return Err("busy");
        }
        s.generation = s.generation.checked_add(1).ok_or("generation_exhausted")?;
        let generation = s.generation;
        s.view["auth"] =
            json!({"status":"pending","phase":"checking_account","sessionGeneration":null});
        s.view["turn"] = json!({"id":null,"status":"idle","text":null});
        s.view["busy"] = json!(true);
        s.view["notice"] = Value::Null;
        self.cancel = Arc::new(AtomicBool::new(false));
        let (cfg, shared, cancel, lease) = (
            self.cfg.clone(),
            self.shared.clone(),
            self.cancel.clone(),
            self.lease.clone(),
        );
        self.running.store(true, Ordering::Release);
        let running = Running(self.running.clone());
        drop(s);
        thread::spawn(move || {
            let _running = running;
            let _lease = lease;
            let result = (|| {
                let first = probe(&cfg, &cancel)?;
                let Some(mode) = login else { return Ok(first) };
                if first.0 != GrokStatus::LoginRequired {
                    return Ok(first);
                }
                let launch = cfg.launch().ok_or("not_installed")?;
                update(&shared, generation, |s| {
                    s["auth"]["phase"] = json!(match mode {
                        LoginMode::Browser => "awaiting_browser",
                        LoginMode::DeviceAuth => "awaiting_device_authorization",
                    });
                });
                let code = run_login(&launch, mode, cfg.limits.login, &cancel, |uri, code| {
                    update(&shared, generation, |s| {
                        s["auth"]["device"] = json!({"verificationUri":uri,"userCode":code});
                    })
                })?;
                if code != 0 {
                    return Err("login_failed");
                }
                probe(&cfg, &cancel)
            })();
            update(&shared, generation, |s| {
                s["busy"] = json!(false);
                let cancelled = cancel.load(Ordering::Acquire);
                match result {
                    Ok((status, version, models)) if !cancelled => {
                        s["providerStatus"] = json!(status.as_str());
                        s["cliVersion"] = json!(version);
                        s["models"] = json!(models);
                        s["auth"] = match status {
                            GrokStatus::Ready => {
                                json!({"status":"signed_in","sessionGeneration":generation.to_string(),"accountLabel":"Grok 공식 CLI 계정"})
                            }
                            _ => json!({"status":"signed_out","sessionGeneration":null}),
                        };
                        s["notice"] = match status {
                            GrokStatus::NotInstalled => json!("Grok CLI가 설치되어 있지 않습니다."),
                            GrokStatus::LoginRequired => json!("Grok 로그인이 필요합니다."),
                            GrokStatus::Ready => Value::Null,
                        };
                    }
                    Ok(_) | Err("cancelled") => {
                        s["auth"] = json!({"status":"signed_out","sessionGeneration":null});
                    }
                    Err(e) => {
                        s["auth"] = json!({"status":"error","sessionGeneration":null,"errorCode":e,"message":"공식 Grok CLI 연결 상태를 확인하지 못했습니다."});
                    }
                }
            });
        });
        Ok(())
    }

    pub fn cancel_login(&mut self) -> Result<()> {
        if self.state()["auth"]["status"] != "pending" {
            return Err("no_pending_login");
        }
        self.cancel.store(true, Ordering::Release);
        Ok(())
    }

    /// Local disconnection: cancels the owned child and invalidates generations. Not a logout.
    pub fn disconnect(&mut self) -> Result<()> {
        let mut s = self.shared.lock().unwrap();
        let n = s.generation.checked_add(1).ok_or("generation_exhausted")?;
        self.cancel.store(true, Ordering::Release);
        s.generation = n;
        s.view["auth"] = json!({"status":"signed_out","sessionGeneration":null});
        s.view["turn"] = json!({"id":null,"status":"idle","text":null});
        s.view["busy"] = json!(false);
        s.view["usage"] = json!({"inputTokens":null,"outputTokens":null,"remainingPercent":null});
        s.view["notice"] = json!("앱 연결을 해제했습니다. 공식 CLI 로그인은 유지됩니다.");
        Ok(())
    }

    /// One independent turn: new `grok agent stdio` child, new session, one prompt.
    pub fn send(&mut self, request_id: String, prompt: String) -> Result<()> {
        if request_id.is_empty()
            || request_id.len() > 128
            || !request_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
        {
            return Err("invalid_request_id");
        }
        if prompt.trim().is_empty() {
            return Err("prompt_limit");
        }
        let mut s = self.shared.lock().unwrap();
        if self.running.load(Ordering::Acquire) {
            return Err("busy");
        }
        if s.view["auth"]["status"] != "signed_in" {
            return Err("signed_out");
        }
        if s.requests.contains(&request_id) {
            return Err("request_replayed");
        }
        s.requests.insert(request_id.clone());
        let generation = s.generation;
        s.view["turn"] =
            json!({"id":request_id,"requestId":request_id,"status":"running","text":""});
        s.view["busy"] = json!(true);
        s.view["usage"] = json!({"inputTokens":null,"outputTokens":null,"remainingPercent":null});
        self.cancel = Arc::new(AtomicBool::new(false));
        let (cfg, shared, cancel, lease) = (
            self.cfg.clone(),
            self.shared.clone(),
            self.cancel.clone(),
            self.lease.clone(),
        );
        self.running.store(true, Ordering::Release);
        let running = Running(self.running.clone());
        drop(s);
        thread::spawn(move || {
            let _running = running;
            let _lease = lease;
            let result = (|| -> Result<(String, Progress)> {
                let launch = cfg.launch().ok_or("not_installed")?;
                let cwd = cfg.cwd_param()?;
                let mut rpc = Rpc::start(
                    &launch,
                    cfg.timing(cfg.limits.turn, cfg.limits.idle),
                    &cancel,
                )?;
                rpc.open(&cwd)?;
                let stop = rpc.prompt(&prompt, &mut |p| {
                    update(&shared, generation, |s| {
                        s["turn"]["text"] = json!(p.text);
                        if !p.usage.is_null() {
                            s["usage"] = p.usage.clone();
                        }
                    })
                })?;
                let progress = std::mem::take(&mut rpc.progress);
                rpc.finish();
                Ok((stop, progress))
            })();
            let cancelled = cancel.load(Ordering::Acquire);
            update(&shared, generation, |s| {
                s["busy"] = json!(false);
                let fail = |s: &mut Value, code: &str| {
                    s["turn"]["status"] = json!("error");
                    s["turn"]["text"] = Value::Null;
                    s["turn"]["errorCode"] = json!(code);
                    s["turn"]["message"] = json!(crate::turn_failure_message(code));
                };
                match result {
                    _ if cancelled => {
                        s["turn"]["status"] = json!("cancelled");
                        s["turn"]["text"] = Value::Null;
                    }
                    Ok((stop, p)) => {
                        let c = p.counts;
                        s["turn"]["stopReason"] = json!(stop);
                        s["turn"]["activity"] = json!({"otherUpdates":c.other_updates,"permissionRequestsRefused":c.permission_refused,"clientRequestsRejected":c.requests_rejected,"foreignSessionUpdates":c.foreign_session,"ignoredNotifications":c.ignored_notifications});
                        if !p.usage.is_null() {
                            s["usage"] = p.usage;
                        }
                        if stop != "end_turn" {
                            fail(s, &format!("stop_{stop}"));
                        } else if p.text.is_empty() {
                            fail(s, "empty_result");
                        } else {
                            s["turn"]["status"] = json!("completed");
                            s["turn"]["text"] = json!(p.text);
                        }
                    }
                    Err(e) => {
                        fail(s, e);
                        if e == "login_required" || e == "not_installed" {
                            s["providerStatus"] = json!(e);
                            s["auth"] = json!({"status":"signed_out","sessionGeneration":null});
                        }
                    }
                }
            });
        });
        Ok(())
    }

    pub fn cancel_turn(&mut self, id: &str) -> Result<()> {
        let s = self.state();
        if s["turn"]["id"] != id || s["turn"]["status"] != "running" {
            return Err("stale_turn");
        }
        self.cancel.store(true, Ordering::Release);
        Ok(())
    }
}

impl Drop for GrokHost {
    fn drop(&mut self) {
        let _ = self.disconnect();
    }
}

fn update(shared: &Arc<Mutex<Shared>>, generation: u64, f: impl FnOnce(&mut Value)) {
    let mut s = shared.lock().unwrap();
    if s.generation == generation {
        f(&mut s.view)
    }
}

/// (status, informational `--version` line, models the CLI listed for a ready session).
fn probe(cfg: &Owned, cancel: &AtomicBool) -> Result<(GrokStatus, Option<String>, Vec<Value>)> {
    let Some(launch) = cfg.launch() else {
        return Ok((GrokStatus::NotInstalled, None, vec![]));
    };
    let version = match version(&launch, cfg.limits.status, cancel) {
        Err("not_installed") => return Ok((GrokStatus::NotInstalled, None, vec![])),
        Err("cancelled") => return Err("cancelled"),
        Err(_) => None,
        Ok(v) => v,
    };
    let limit = cfg.limits.status;
    let mut rpc = match Rpc::start(&launch, cfg.timing(limit, limit), cancel) {
        Err("not_installed") => return Ok((GrokStatus::NotInstalled, version, vec![])),
        r => r?,
    };
    match rpc.open(&cfg.cwd_param()?) {
        Ok(opened) => {
            rpc.finish();
            Ok((GrokStatus::Ready, version, opened.models))
        }
        Err("login_required") => {
            rpc.finish();
            Ok((GrokStatus::LoginRequired, version, vec![]))
        }
        Err(e) => Err(e),
    }
}

/// Informational only: a failing or odd `--version` does not decide status.
fn version(launch: &Launch, timeout: Duration, cancel: &AtomicBool) -> Result<Option<String>> {
    let mut p = Pipes::spawn(launch, &["--version"], 4096, 16 * 1024)?;
    let start = Instant::now();
    let mut first: Option<String> = None;
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err("cancelled");
        }
        if start.elapsed() > timeout {
            return Err("timeout");
        }
        match p.recv(Duration::from_millis(20)) {
            Some(Wire::Line(l)) if first.is_none() => {
                first = Some(String::from_utf8_lossy(&l).trim().to_string())
            }
            Some(Wire::Eof) => thread::sleep(Duration::from_millis(5)),
            Some(Wire::LineLimit | Wire::OutputLimit | Wire::ReadFailed) => return Ok(None),
            _ => {}
        }
        if let Some(code) = p.try_exit()? {
            while let Some(Wire::Line(l)) = p.recv(Duration::from_millis(20)) {
                first.get_or_insert_with(|| String::from_utf8_lossy(&l).trim().to_string());
            }
            return Ok(first.filter(|v| {
                code == 0
                    && !v.is_empty()
                    && v.len() <= 64
                    && v.chars()
                        .all(|c| c.is_ascii_alphanumeric() || " .-+_()/".contains(c))
            }));
        }
    }
}

/// Runs the official login. Stdin stays open while the CLI waits for the browser/device step.
/// Output is discarded except, in device mode, a validated x.ai verification URL and user code.
fn run_login(
    launch: &Launch,
    mode: LoginMode,
    timeout: Duration,
    cancel: &AtomicBool,
    mut hint: impl FnMut(Option<String>, Option<String>),
) -> Result<i32> {
    let args: &[&str] = match mode {
        LoginMode::Browser => &["login"],
        LoginMode::DeviceAuth => &["login", "--device-auth"],
    };
    let mut p = Pipes::spawn(launch, args, 64 * 1024, 1024 * 1024)?;
    let start = Instant::now();
    let (mut uri, mut code) = (None::<String>, None::<String>);
    let mut seen = |line: &[u8], uri: &mut Option<String>, code: &mut Option<String>| {
        if mode != LoginMode::DeviceAuth {
            return;
        }
        let (u, c) = device_hint(&String::from_utf8_lossy(line));
        let changed = (uri.is_none() && u.is_some()) || (code.is_none() && c.is_some());
        if uri.is_none() {
            *uri = u;
        }
        if code.is_none() {
            *code = c;
        }
        if changed {
            hint(uri.clone(), code.clone());
        }
    };
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err("cancelled");
        }
        if start.elapsed() > timeout {
            return Err("timeout");
        }
        match p.recv(Duration::from_millis(20)) {
            Some(Wire::Line(l)) => seen(&l, &mut uri, &mut code),
            Some(Wire::Eof) => thread::sleep(Duration::from_millis(5)),
            Some(Wire::LineLimit | Wire::OutputLimit) => return Err("login_output_limit"),
            Some(Wire::ReadFailed) => return Err("stdout_failed"),
            Some(Wire::Truncated) | None => {}
        }
        if let Some(exit) = p.try_exit()? {
            while let Some(Wire::Line(l)) = p.recv(Duration::from_millis(20)) {
                seen(&l, &mut uri, &mut code);
            }
            return Ok(exit);
        }
    }
}

/// Device-flow display hints from one CLI output line. The URL must be https on x.ai or a
/// subdomain without userinfo/port; the code must look like a short uppercase user code on a
/// line that mentions a code. Everything else (including any token-like text) is dropped.
fn device_hint(line: &str) -> (Option<String>, Option<String>) {
    let trim = |t: &str| {
        t.trim_matches(|c: char| "\"'()<>[]{},;".contains(c))
            .trim_end_matches(['.', ':'])
            .to_string()
    };
    let mut uri = None;
    let mut code = None;
    let mentions_code = line.to_ascii_lowercase().contains("code");
    for token in line.split_whitespace().map(trim) {
        if uri.is_none() {
            if let Some(rest) = token.strip_prefix("https://") {
                let host = rest
                    .split(['/', '?', '#'])
                    .next()
                    .unwrap_or("")
                    .to_ascii_lowercase();
                let host_ok = (host == "x.ai" || host.ends_with(".x.ai"))
                    && host
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-');
                let chars_ok = token.len() <= 512
                    && token
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"-._~:/?#&=%+".contains(&b));
                if host_ok && chars_ok {
                    uri = Some(token.clone());
                }
            }
        }
        if code.is_none() && mentions_code {
            let parts: Vec<&str> = token.split('-').collect();
            let shape = parts.len() <= 2
                && parts.iter().all(|p| {
                    (3..=8).contains(&p.len())
                        && p.bytes()
                            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
                });
            if shape && token.len() >= 6 {
                code = Some(token);
            }
        }
    }
    (uri, code)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn device_hint_accepts_only_x_ai_and_code_shapes() {
        assert_eq!(
            device_hint("Open https://accounts.x.ai/device?user_code=WXYZ-2345 now."),
            (
                Some("https://accounts.x.ai/device?user_code=WXYZ-2345".into()),
                None
            )
        );
        assert_eq!(
            device_hint("Enter code: WXYZ-2345"),
            (None, Some("WXYZ-2345".into()))
        );
        for bad in [
            "visit https://evil.example.com/x.ai",
            "visit https://x.ai.evil.com/device",
            "visit https://user@x.ai/device",
            "visit http://accounts.x.ai/device",
            "access_token=secret-token-value",
            "token: sk-secret ABCDEFGHIJ",
            "Your code is ab-cd",
        ] {
            assert_eq!(device_hint(bad), (None, None), "{bad}");
        }
    }
    #[test]
    fn plain_strips_verbatim_prefix() {
        assert_eq!(
            plain(PathBuf::from(r"\\?\C:\a\b")),
            PathBuf::from(r"C:\a\b")
        );
        assert_eq!(
            plain(PathBuf::from(r"\\?\UNC\srv\s")),
            PathBuf::from(r"\\srv\s")
        );
        assert_eq!(plain(PathBuf::from("/tmp/x")), PathBuf::from("/tmp/x"));
    }
}
