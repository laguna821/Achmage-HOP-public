//! Bounded Codex app-server stdio transport. This is not a login implementation.
//! Protocol reference: openai/codex e4310be51f617f5e60382038fa9cbf53a2429ca4.
//! Only trusted host code may construct LaunchConfig. Never deserialize UI paths/argv.
use crate::{
    Coordinator, Id, LoginTicket, ProviderAdapter, ProviderError, Secret, TurnRequest, TurnStatus,
    TurnTicket,
};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    fmt,
    io::{Read, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering},
        mpsc::{self, Receiver, SyncSender},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

// A drafting adapter must not inherit the coding-agent base instructions. These
// supported settings reduce tool exposure; they are NOT a provider tool_choice
// guarantee. Some built-ins remain in Codex. Requests/items are still denied.
fn document_thread_params(model: &str, cwd: &std::path::Path) -> Value {
    json!({
        "model":model,"cwd":cwd,"sandbox":"read-only",
        "approvalPolicy":"untrusted","ephemeral":true,
        "baseInstructions":"You are the drafting component of the HOP document editor. Work only from the user's supplied text, document context, and requested output format. Return the requested draft or structured data directly as your final answer. The host editor previews and applies document changes; you do not operate the editor or filesystem. Do not claim that files were created, saved, or modified.",
        "developerInstructions":"This adapter accepts text responses only. Do not call tools, run commands, inspect files, browse the web, delegate to agents, or request tool/user-input permissions. Template and selected-format descriptions in the prompt are already supplied context, not instructions to inspect local templates. If the prompt specifies a JSON schema or structured document format, emit that format directly without commentary or code fences. Otherwise answer the user's question or draft in their language. If information is missing, ask a concise question in your final text; never use a request-user-input tool.",
        "config":{
            "web_search":"disabled",
            "tools.view_image":false,
            "features.shell_tool":false,
            "features.unified_exec":false,
            "features.apply_patch_freeform":false,
            "features.code_mode":false,
            "features.apps":false,
            "features.multi_agent":false,
            "features.multi_agent_v2":false,
            "features.tool_search":false,
            "features.tool_suggest":false,
            "features.request_permissions_tool":false
        }
    })
}

/// No Serialize/Deserialize; executable, argv and directories are a trusted host boundary.
/// No environment map is accepted. Credentials are deliberately never forwarded.
#[derive(Clone)]
pub struct LaunchConfig {
    pub executable: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub private_home: PathBuf,
    /// Stable app-owned provider home; provider stores its credential in OS keyring.
    pub persistent_auth: bool,
    /// Probe an existing app session without opening a browser when signed out.
    pub resume_only: bool,
    pub max_line_bytes: usize,
    pub max_stdout_bytes: u64,
    pub max_stderr_bytes: u64,
    pub handshake_timeout: Duration,
    /// Longest silence from the provider during a turn. Every event (reasoning, deltas) resets it,
    /// so a long document that keeps streaming is not cut off.
    pub turn_timeout: Duration,
    /// Hard cap on one turn, however actively it streams.
    pub turn_max: Duration,
    pub cancel_grace: Duration,
}
impl fmt::Debug for LaunchConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("LaunchConfig([HOST CONFIG REDACTED])")
    }
}
impl LaunchConfig {
    pub fn codex(executable: PathBuf, cwd: PathBuf, private_home: PathBuf) -> Self {
        Self {
            executable,
            args: vec!["app-server".into(), "--listen".into(), "stdio://".into()],
            cwd,
            private_home,
            persistent_auth: false,
            resume_only: false,
            // One JSON line can carry the whole answer (item/completed) or echo the whole prompt.
            max_line_bytes: 64 * 1024 * 1024,
            max_stdout_bytes: 512 * 1024 * 1024,
            max_stderr_bytes: 1_048_576,
            handshake_timeout: Duration::from_secs(10),
            turn_timeout: Duration::from_secs(120),
            turn_max: Duration::from_secs(900),
            cancel_grace: Duration::from_millis(250),
        }
    }
    pub(crate) fn validate(&self) -> Result<(), ProcessFault> {
        let ext = self
            .executable
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let stem = self
            .executable
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !self.executable.is_absolute()
            || !self.executable.is_file()
            || !self.cwd.is_absolute()
            || !self.cwd.is_dir()
            || !self.private_home.is_absolute()
            || !self.private_home.is_dir()
            || matches!(ext.as_str(), "cmd" | "bat" | "ps1" | "sh")
            || matches!(
                stem.as_str(),
                "cmd" | "powershell" | "pwsh" | "bash" | "sh" | "zsh"
            )
            || self.args.len() > 64
            || self.args.iter().any(|a| a.len() > 4096 || a.contains('\0'))
            || self.args.iter().map(String::len).sum::<usize>() > 32768
            || !(256..=256 * 1024 * 1024).contains(&self.max_line_bytes)
            || !(256..=2048 * 1024 * 1024).contains(&self.max_stdout_bytes)
            || !(256..=1_048_576).contains(&self.max_stderr_bytes)
            || !(Duration::from_millis(10)..=Duration::from_secs(30))
                .contains(&self.handshake_timeout)
            || !(Duration::from_millis(10)..=Duration::from_secs(600)).contains(&self.turn_timeout)
            || !(self.turn_timeout..=Duration::from_secs(1800)).contains(&self.turn_max)
            || self.cancel_grace > Duration::from_secs(2)
        {
            return Err(ProcessFault::InvalidConfig);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProcessFault {
    InvalidConfig,
    Spawn,
    Io,
    InvalidUtf8,
    InvalidJson,
    LineLimit,
    StdoutLimit,
    StderrLimit,
    QueueLimit,
    PartialEof,
    UnexpectedEof,
    Protocol,
    UnsupportedTool,
    Timeout,
    StaleCoordinator,
    ResponseLimit,
}
/// Only fixed application categories cross the process boundary. Never retain
/// provider message/additionalDetails, request IDs, URLs, or error data strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct TurnDiagnostic {
    pub code: &'static str,
    pub stage: &'static str,
}
impl TurnDiagnostic {
    fn provider(stage: &'static str, error: &Value) -> Self {
        let info = error
            .get("codexErrorInfo")
            .or_else(|| error.pointer("/data/codexErrorInfo"));
        let code = match info.and_then(Value::as_str) {
            Some("contextWindowExceeded") => "context_limit",
            Some("usageLimitExceeded" | "sessionBudgetExceeded") => "usage_limit",
            Some("rateLimitExceeded") => "rate_limit",
            Some("unauthorized") => "authorization",
            Some("badRequest") => "invalid_request",
            Some("cyberPolicy" | "misalignmentPolicyViolation" | "tooManyDenials") => {
                "request_denied"
            }
            Some("serverOverloaded" | "internalServerError" | "flexUnavailable") => {
                "provider_unavailable"
            }
            _ if info.is_some_and(|i| {
                [
                    "httpConnectionFailed",
                    "responseStreamConnectionFailed",
                    "responseStreamDisconnected",
                    "responseTooManyFailedAttempts",
                ]
                .iter()
                .any(|key| i.get(key).is_some())
            }) =>
            {
                "network"
            }
            _ if error.get("code").and_then(Value::as_i64) == Some(-32602) => "invalid_request",
            _ => "provider_failed",
        };
        Self { code, stage }
    }
    pub fn fault(stage: &'static str, fault: ProcessFault) -> Self {
        let code = match fault {
            ProcessFault::Timeout => "timeout",
            ProcessFault::Spawn | ProcessFault::InvalidConfig => "runtime_start",
            ProcessFault::Io | ProcessFault::UnexpectedEof => "runtime_connection",
            ProcessFault::UnsupportedTool => "unsupported_tool",
            ProcessFault::ResponseLimit => "response_limit",
            ProcessFault::LineLimit => "frame_limit",
            ProcessFault::StdoutLimit => "transport_output_limit",
            ProcessFault::StderrLimit => "transport_diagnostic_limit",
            ProcessFault::QueueLimit => "transport_queue_limit",
            _ => "protocol",
        };
        Self { code, stage }
    }
    pub fn message(self) -> &'static str {
        match self.code {
            "context_limit" => {
                "입력 길이가 모델 한도를 넘었습니다. 첨부 문서나 질문을 줄여 다시 요청하세요."
            }
            "usage_limit" => "사용 한도에 도달했습니다. 계정의 사용 한도와 갱신 시간을 확인하세요.",
            "rate_limit" | "provider_unavailable" => {
                "제공자가 현재 요청을 처리하지 못했습니다. 잠시 뒤 다시 요청하세요."
            }
            "authorization" => {
                "모델 요청의 인증이 거부되었습니다. 계정을 다시 연결한 뒤 요청하세요."
            }
            "invalid_request" => {
                "제공자가 요청 형식을 거부했습니다. 모델 선택과 입력을 확인하세요."
            }
            "request_denied" => "제공자가 요청을 허용하지 않았습니다. 요청 내용을 확인하세요.",
            "network" | "runtime_connection" => {
                "응답 연결이 끊겼습니다. 네트워크와 AI 실행기를 확인한 뒤 다시 요청하세요."
            }
            "timeout" => "응답 시간이 초과되었습니다. 잠시 뒤 다시 요청하세요.",
            "runtime_start" => "AI 실행기를 시작하지 못했습니다. 실행 파일과 앱을 확인하세요.",
            "unsupported_tool" => {
                "AI가 문서 초안 대신 외부 도구를 요청해 응답을 중단했습니다. 도구는 승인하지 않았습니다. 요청 내용을 유지한 채 다시 생성할 수 있습니다."
            }
            "response_limit" => {
                "응답이 앱의 처리 한도를 넘었습니다. 요청 범위를 줄여 다시 요청하세요."
            }
            "frame_limit" => {
                "AI 실행기가 처리 가능한 통신 프레임 크기를 넘겼습니다. 앱과 실행기 호환성을 확인하세요."
            }
            "transport_output_limit" => {
                "AI 실행기의 통신 출력이 처리 한도를 넘었습니다. 앱의 통신 진단을 확인하세요."
            }
            "transport_diagnostic_limit" => {
                "AI 실행기의 진단 출력이 처리 한도를 넘었습니다. 본문 길이와는 별개의 오류입니다."
            }
            "transport_queue_limit" => {
                "AI 통신의 요청 대기열을 처리하지 못했습니다. 앱의 연결 상태를 확인하세요."
            }
            "protocol" => {
                "AI 실행기 응답 형식을 처리하지 못했습니다. 앱과 실행기 버전을 확인하세요."
            }
            "dispatch_failed" => {
                "응답 요청을 시작하지 못했습니다. 로그인과 현재 작업 상태를 확인한 뒤 다시 요청하세요."
            }
            _ => {
                "제공자가 응답을 완료하지 못했습니다. 잠시 뒤 다시 요청하세요. 문제가 계속되면 계정과 모델 설정을 확인하세요."
            }
        }
    }
}
#[derive(Debug, Clone, Serialize)]
pub struct ProcessView {
    pub schema_version: u32,
    pub pid: Option<u32>,
    pub direct_child_exited: bool,
    pub settled: bool,
    pub exit_code: Option<i32>,
    pub stdout_bytes: u64,
    pub stderr_bytes: u64,
    pub stderr_content_retained: bool,
    pub ignored_notifications: u64,
    pub denied_requests: u64,
    pub fault: Option<ProcessFault>,
    pub diagnostic: Option<TurnDiagnostic>,
    pub login_implemented: bool,
    pub credentials_forwarded: bool,
    pub descendants_managed: bool,
}
impl Default for ProcessView {
    fn default() -> Self {
        Self {
            schema_version: 1,
            pid: None,
            direct_child_exited: true,
            settled: true,
            exit_code: None,
            stdout_bytes: 0,
            stderr_bytes: 0,
            stderr_content_retained: false,
            ignored_notifications: 0,
            denied_requests: 0,
            fault: None,
            diagnostic: None,
            login_implemented: false,
            credentials_forwarded: false,
            descendants_managed: false,
        }
    }
}
enum Wire {
    Line(Vec<u8>),
    Eof,
}
pub(crate) struct Pipes {
    child: Child,
    input: Option<SyncSender<Vec<u8>>>,
    output: Receiver<Wire>,
    fault: Arc<AtomicU8>,
    stopping: Arc<AtomicBool>,
    stdout_bytes: Arc<AtomicU64>,
    stderr_bytes: Arc<AtomicU64>,
    workers: Vec<JoinHandle<()>>,
    /// The stderr reader reached EOF (or stopped), so `stderr_bytes` is final.
    stderr_done: Arc<AtomicBool>,
    exited_at: Option<Instant>,
}
fn signal(a: &AtomicU8, n: u8) {
    let _ = a.compare_exchange(0, n, Ordering::SeqCst, Ordering::SeqCst);
}
// Preserve the bounded queue and let the OS pipe apply backpressure. A transient
// Full is not oversized model text. Kill/fault/disconnect interrupt this wait.
fn enqueue_wire(
    tx: &SyncSender<Wire>,
    mut wire: Wire,
    stopping: &AtomicBool,
    fault: &AtomicU8,
) -> bool {
    loop {
        if stopping.load(Ordering::Acquire) || fault.load(Ordering::Acquire) != 0 {
            return false;
        }
        match tx.try_send(wire) {
            Ok(()) => return true,
            Err(mpsc::TrySendError::Full(value)) => {
                wire = value;
                thread::sleep(Duration::from_millis(1));
            }
            Err(mpsc::TrySendError::Disconnected(_)) => return false,
        }
    }
}
impl Pipes {
    pub(crate) fn start(c: &LaunchConfig) -> Result<Self, ProcessFault> {
        c.validate()?;
        let mut cmd = Command::new(&c.executable);
        cmd.args(&c.args)
            .current_dir(&c.cwd)
            .env_clear()
            .env("CODEX_HOME", &c.private_home)
            .env("HOME", &c.private_home)
            .env("USERPROFILE", &c.private_home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Windows login needs OS paths (notably SystemRoot). env_clear without
        // these passes initialize but account/login/start fails with an OS error.
        // Never inherit provider keys, tokens, proxy overrides or arbitrary env.
        for key in [
            "SystemRoot",
            "WINDIR",
            "TEMP",
            "TMP",
            "LOCALAPPDATA",
            "APPDATA",
            "PATH",
            "LANG",
            "LC_ALL",
            "DISPLAY",
            "WAYLAND_DISPLAY",
            "DBUS_SESSION_BUS_ADDRESS",
            "XDG_RUNTIME_DIR",
        ] {
            if let Some(value) = std::env::var_os(key) {
                cmd.env(key, value);
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }
        let mut child = cmd.spawn().map_err(|_| ProcessFault::Spawn)?;
        let mut stdin = child.stdin.take().ok_or(ProcessFault::Io)?;
        let mut stdout = child.stdout.take().ok_or(ProcessFault::Io)?;
        let mut stderr = child.stderr.take().ok_or(ProcessFault::Io)?;
        let fault = Arc::new(AtomicU8::new(0));
        let stopping = Arc::new(AtomicBool::new(false));
        let stdout_bytes = Arc::new(AtomicU64::new(0));
        let stderr_bytes = Arc::new(AtomicU64::new(0));
        let (tx, output) = mpsc::sync_channel(32);
        let (input, rx) = mpsc::sync_channel::<Vec<u8>>(8);
        let f = fault.clone();
        let writer = thread::spawn(move || {
            while let Ok(bytes) = rx.recv() {
                if stdin.write_all(&bytes).and_then(|_| stdin.flush()).is_err() {
                    signal(&f, 1);
                    break;
                }
            }
        });
        let f = fault.clone();
        let count = stdout_bytes.clone();
        let maxline = c.max_line_bytes;
        let maxtotal = c.max_stdout_bytes;
        let stop_reader = stopping.clone();
        let reader = thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let mut line = Vec::new();
            loop {
                let n = match stdout.read(&mut buf) {
                    Ok(0) => {
                        if !line.is_empty() {
                            signal(&f, 6);
                        } else {
                            enqueue_wire(&tx, Wire::Eof, &stop_reader, &f);
                        }
                        break;
                    }
                    Ok(n) => n,
                    Err(_) => {
                        signal(&f, 1);
                        break;
                    }
                };
                if count.fetch_add(n as u64, Ordering::Relaxed) + n as u64 > maxtotal {
                    signal(&f, 3);
                    break;
                }
                for &b in &buf[..n] {
                    if b == b'\n' {
                        if line.last() == Some(&b'\r') {
                            line.pop();
                        }
                        if !enqueue_wire(
                            &tx,
                            Wire::Line(std::mem::take(&mut line)),
                            &stop_reader,
                            &f,
                        ) {
                            return;
                        }
                    } else {
                        line.push(b);
                        if line.len() > maxline {
                            signal(&f, 2);
                            return;
                        }
                    }
                }
            }
        });
        let f = fault.clone();
        let count = stderr_bytes.clone();
        let max = c.max_stderr_bytes;
        let stderr_done = Arc::new(AtomicBool::new(false));
        let done = stderr_done.clone();
        let errors = thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match stderr.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if count.fetch_add(n as u64, Ordering::Relaxed) + n as u64 > max {
                            signal(&f, 4);
                            break;
                        }
                    }
                    Err(_) => {
                        signal(&f, 1);
                        break;
                    }
                }
            }
            done.store(true, Ordering::Release);
        });
        Ok(Self {
            child,
            input: Some(input),
            output,
            fault,
            stopping,
            stdout_bytes,
            stderr_bytes,
            workers: vec![writer, reader, errors],
            stderr_done,
            exited_at: None,
        })
    }
    pub(crate) fn send(&self, v: Value) -> Result<(), ProcessFault> {
        let mut b = serde_json::to_vec(&v).map_err(|_| ProcessFault::InvalidJson)?;
        b.push(b'\n');
        self.input
            .as_ref()
            .ok_or(ProcessFault::Io)?
            .try_send(b)
            .map_err(|_| ProcessFault::QueueLimit)
    }
    fn fault(&self) -> Option<ProcessFault> {
        match self.fault.load(Ordering::SeqCst) {
            0 => None,
            1 => Some(ProcessFault::Io),
            2 => Some(ProcessFault::LineLimit),
            3 => Some(ProcessFault::StdoutLimit),
            4 => Some(ProcessFault::StderrLimit),
            5 => Some(ProcessFault::QueueLimit),
            _ => Some(ProcessFault::PartialEof),
        }
    }
    pub(crate) fn refresh(&mut self, v: &mut ProcessView) {
        v.pid = Some(self.child.id());
        v.stdout_bytes = self.stdout_bytes.load(Ordering::Relaxed);
        v.stderr_bytes = self.stderr_bytes.load(Ordering::Relaxed);
        if let Ok(Some(s)) = self.child.try_wait() {
            v.direct_child_exited = true;
            v.exit_code = s.code();
            self.exited_at.get_or_insert_with(Instant::now);
        }
        let mut remaining = Vec::new();
        for h in self.workers.drain(..) {
            if h.is_finished() {
                let _ = h.join();
            } else {
                remaining.push(h);
            }
        }
        self.workers = remaining;
    }
    /// Output left in the stderr pipe when the child exits is still counted before settling; a
    /// descendant that keeps the inherited pipe open cannot hold settlement past a short grace.
    pub(crate) fn stderr_drained(&self) -> bool {
        self.stderr_done.load(Ordering::Acquire)
            || self
                .exited_at
                .is_some_and(|at| at.elapsed() >= Duration::from_millis(250))
    }
    pub(crate) fn receive(&self, wait: Duration) -> Result<Option<Value>, ProcessFault> {
        if let Some(f) = self.fault() {
            return Err(f);
        }
        match self
            .output
            .recv_timeout(wait.min(Duration::from_millis(100)))
        {
            Ok(Wire::Line(bytes)) => {
                let s = std::str::from_utf8(&bytes).map_err(|_| ProcessFault::InvalidUtf8)?;
                Ok(Some(
                    serde_json::from_str(s).map_err(|_| ProcessFault::InvalidJson)?,
                ))
            }
            Err(mpsc::RecvTimeoutError::Timeout) => Ok(None),
            _ => Err(self.fault().unwrap_or(ProcessFault::UnexpectedEof)),
        }
    }
    pub(crate) fn kill(&mut self) {
        self.stopping.store(true, Ordering::Release);
        self.input.take();
        let _ = self.child.kill();
    }
}
impl Drop for Pipes {
    fn drop(&mut self) {
        self.kill(); // Only this child. Never kill by name or a shared provider process.
        let until = Instant::now() + Duration::from_millis(250);
        while Instant::now() < until {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                break;
            }
            thread::sleep(Duration::from_millis(2));
        }
        // A hostile descendant can retain inherited pipes. Do not block UI joining such readers.
        for h in self.workers.drain(..) {
            if h.is_finished() {
                let _ = h.join();
            }
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Stage {
    Initialize,
    Thread,
    Turn,
    Running,
    Terminal,
}
impl Stage {
    fn label(self) -> &'static str {
        match self {
            Self::Initialize => "initialize",
            Self::Thread => "thread_start",
            Self::Turn => "turn_start",
            Self::Running | Self::Terminal => "response",
        }
    }
}
struct Run {
    ticket: TurnTicket,
    model: String,
    reasoning_effort: Option<String>,
    prompt: String,
    thread_id: Option<String>,
    turn_id: Option<String>,
    sequence: u64,
    stage: Stage,
    started: Instant,
    stage_started: Instant,
    last_activity: Instant,
    cancelled: Option<Instant>,
    terminal: bool,
    pending: Vec<Value>,
    item_id: Option<String>,
    item_text: String,
    item_completed: bool,
}
/// One ephemeral provider thread and one direct child per turn. Pump on a host worker thread.
/// This adapter does not authenticate, forward Secret, persist credentials or load host env.
pub struct CodexProcessAdapter {
    provider: Id,
    host: Id,
    config: LaunchConfig,
    pipes: Option<Pipes>,
    run: Option<Run>,
    view: ProcessView,
}
impl fmt::Debug for CodexProcessAdapter {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CodexProcessAdapter")
            .field("view", &self.view)
            .finish()
    }
}
impl CodexProcessAdapter {
    pub fn new(provider: Id, host: Id, config: LaunchConfig) -> Result<Self, ProcessFault> {
        config.validate()?;
        Ok(Self {
            provider,
            host,
            config,
            pipes: None,
            run: None,
            view: ProcessView::default(),
        })
    }
    pub fn process_view(&mut self) -> ProcessView {
        // Checked before the counters are read, so a settled view carries the final stderr count.
        let drained = self.pipes.as_ref().is_none_or(|p| p.stderr_drained());
        if let Some(p) = &mut self.pipes {
            p.refresh(&mut self.view);
        }
        self.view.settled = self.view.direct_child_exited
            && self.run.as_ref().is_none_or(|r| r.terminal)
            && drained;
        self.view.clone()
    }
    fn send(&self, v: Value) -> Result<(), ProcessFault> {
        self.pipes.as_ref().ok_or(ProcessFault::Io)?.send(v)
    }
    fn stop(&mut self) {
        if let Some(p) = &mut self.pipes {
            p.kill();
        }
        if let Some(r) = &mut self.run {
            r.terminal = true;
            r.stage = Stage::Terminal;
        }
    }
    fn fail(&mut self, c: &mut Coordinator, f: ProcessFault) {
        self.view.fault = Some(f);
        if self.view.diagnostic.is_none() {
            self.view.diagnostic = Some(TurnDiagnostic::fault(
                self.run.as_ref().map_or("initialize", |r| r.stage.label()),
                f,
            ));
        }
        if let Some(r) = &self.run {
            let _ = c.fail_turn(
                &r.ticket,
                r.sequence,
                if f == ProcessFault::UnsupportedTool {
                    ProviderError::Denied
                } else {
                    ProviderError::Protocol
                },
            );
        }
        self.stop();
    }
    fn report(&mut self, c: &mut Coordinator) -> ProcessView {
        let v = self.process_view();
        if v.settled && self.run.as_ref().is_some_and(|r| r.cancelled.is_some()) {
            let _ = c.acknowledge_cancellation(&self.run.as_ref().unwrap().ticket);
        }
        v
    }
    /// Poll at most one wire message; wait is capped at 100 ms. Call until settled.
    /// Returns sanitized transport metadata; model text is only in Coordinator::view().
    pub fn pump(&mut self, c: &mut Coordinator, wait: Duration) -> ProcessView {
        if self.pipes.is_none() {
            return self.process_view();
        }
        let current = c.view();
        if let Some(r) = &self.run {
            let matches = current.turn.as_ref().is_some_and(|t| t.ticket == r.ticket);
            if !matches {
                self.fail(c, ProcessFault::StaleCoordinator);
                return self.process_view();
            }
            if !r.terminal && r.cancelled.is_none() {
                if !current.turn.as_ref().is_some_and(|t| {
                    matches!(t.status, TurnStatus::Started | TurnStatus::Streaming)
                }) {
                    self.fail(c, ProcessFault::StaleCoordinator);
                    return self.process_view();
                }
                let timed = r.last_activity.elapsed() > self.config.turn_timeout
                    || r.started.elapsed() > self.config.turn_max
                    || (r.stage != Stage::Running
                        && r.stage_started.elapsed() > self.config.handshake_timeout);
                if timed {
                    self.fail(c, ProcessFault::Timeout);
                    return self.process_view();
                }
            }
        }
        if let Some(r) = &self.run {
            if r.cancelled
                .is_some_and(|t| t.elapsed() >= self.config.cancel_grace)
            {
                self.stop();
            }
        }
        if let Some(r) = &self.run {
            if r.terminal {
                return self.report(c);
            }
        }
        if let Some(f) = self.pipes.as_ref().unwrap().fault() {
            self.fail(c, f);
            return self.process_view();
        }
        let msg = match self
            .pipes
            .as_ref()
            .unwrap()
            .output
            .recv_timeout(wait.min(Duration::from_millis(100)))
        {
            Ok(m) => Some(m),
            Err(mpsc::RecvTimeoutError::Timeout) => None,
            Err(_) => Some(Wire::Eof),
        };
        if let Some(m) = msg {
            let result = match m {
                Wire::Eof => Err(self
                    .pipes
                    .as_ref()
                    .unwrap()
                    .fault()
                    .unwrap_or(ProcessFault::UnexpectedEof)),
                Wire::Line(b) => match std::str::from_utf8(&b) {
                    Err(_) => Err(ProcessFault::InvalidUtf8),
                    Ok(s) => match serde_json::from_str(s) {
                        Err(_) => Err(ProcessFault::InvalidJson),
                        Ok(v) => self.handle(c, v),
                    },
                },
            };
            if let Err(f) = result {
                self.fail(c, f);
            }
        }
        self.report(c)
    }
    fn handle(&mut self, c: &mut Coordinator, v: Value) -> Result<(), ProcessFault> {
        if !v.is_object() {
            return Err(ProcessFault::Protocol);
        }
        if let Some(method) = v.get("method").and_then(Value::as_str) {
            if let Some(id) = v.get("id") {
                self.view.denied_requests += 1;
                if matches!(
                    method,
                    "item/commandExecution/requestApproval" | "item/fileChange/requestApproval"
                ) {
                    self.send(json!({"id":id,"result":{"decision":"decline"}}))?;
                } else {
                    self.send(json!({"id":id,"error":{"code":-32601,"message":"Unsupported by this text-only adapter"}}))?;
                }
                return Err(ProcessFault::UnsupportedTool);
            }
            let stage = self.run.as_ref().unwrap().stage;
            if stage == Stage::Turn
                && matches!(
                    method,
                    "item/agentMessage/delta"
                        | "turn/completed"
                        | "item/started"
                        | "item/completed"
                        | "error"
                )
            {
                let r = self.run.as_mut().unwrap();
                if r.pending.len() >= 16 {
                    return Err(ProcessFault::QueueLimit);
                }
                r.pending.push(v);
                return Ok(());
            }
            return self.notification(c, method, v.get("params").unwrap_or(&Value::Null));
        }
        let id = v
            .get("id")
            .and_then(Value::as_u64)
            .ok_or(ProcessFault::Protocol)?;
        if id == 4 && self.run.as_ref().unwrap().cancelled.is_some() {
            return Ok(());
        }
        if let Some(error) = v.get("error") {
            let stage = self.run.as_ref().unwrap().stage;
            if matches!(
                (stage, id),
                (Stage::Initialize, 1) | (Stage::Thread, 2) | (Stage::Turn, 3)
            ) {
                self.view.diagnostic = Some(TurnDiagnostic::provider(stage.label(), error));
            }
            return Err(ProcessFault::Protocol);
        }
        let result = v.get("result").ok_or(ProcessFault::Protocol)?;
        match (self.run.as_ref().unwrap().stage, id) {
            (Stage::Initialize, 1) => {
                self.send(json!({"method":"initialized"}))?;
                let r = self.run.as_ref().unwrap();
                self.send(json!({"id":2,"method":"thread/start","params":document_thread_params(&r.model, &self.config.cwd)}))?;
                self.run.as_mut().unwrap().stage = Stage::Thread;
            }
            (Stage::Thread, 2) => {
                let thread = wire_id(result.pointer("/thread/id"))?;
                let r = self.run.as_mut().unwrap();
                r.thread_id = Some(thread.clone());
                let prompt = std::mem::take(&mut r.prompt);
                let mut params = json!({"threadId":thread,"input":[{"type":"text","text":prompt}]});
                if let Some(effort) = &r.reasoning_effort {
                    params["effort"] = json!(effort);
                }
                self.send(json!({"id":3,"method":"turn/start","params":params}))?;
                self.run.as_mut().unwrap().stage = Stage::Turn;
            }
            (Stage::Turn, 3) => {
                let turn = wire_id(result.pointer("/turn/id"))?;
                self.run.as_mut().unwrap().turn_id = Some(turn);
                self.run.as_mut().unwrap().stage = Stage::Running;
                let pending = std::mem::take(&mut self.run.as_mut().unwrap().pending);
                for event in pending {
                    self.notification(
                        c,
                        event["method"].as_str().ok_or(ProcessFault::Protocol)?,
                        &event["params"],
                    )?;
                    if self.run.as_ref().unwrap().terminal {
                        break;
                    }
                }
            }
            _ => return Err(ProcessFault::Protocol),
        }
        self.run.as_mut().unwrap().stage_started = Instant::now();
        Ok(())
    }
    fn notification(
        &mut self,
        c: &mut Coordinator,
        method: &str,
        p: &Value,
    ) -> Result<(), ProcessFault> {
        // Any event of this turn's thread, including reasoning the editor ignores, shows it is alive.
        if let Some(r) = self.run.as_mut() {
            if p.get("threadId").and_then(Value::as_str) == r.thread_id.as_deref() {
                r.last_activity = Instant::now();
            }
        }
        if matches!(method, "item/started" | "item/completed") {
            let kind = p
                .pointer("/item/type")
                .and_then(Value::as_str)
                .ok_or(ProcessFault::Protocol)?;
            if !matches!(kind, "agentMessage" | "userMessage" | "reasoning" | "plan") {
                return Err(ProcessFault::UnsupportedTool);
            }
        }
        let final_message = method == "item/completed"
            && p.pointer("/item/type").and_then(Value::as_str) == Some("agentMessage");
        if !matches!(
            method,
            "item/agentMessage/delta" | "turn/completed" | "error"
        ) && !final_message
        {
            self.view.ignored_notifications += 1;
            return Ok(());
        }
        let r = self.run.as_mut().unwrap();
        let tid = if method == "turn/completed" {
            p.pointer("/turn/id")
        } else {
            p.get("turnId")
        };
        if p.get("threadId").and_then(Value::as_str) != r.thread_id.as_deref()
            || tid.and_then(Value::as_str) != r.turn_id.as_deref()
        {
            return Err(ProcessFault::Protocol);
        }
        if r.cancelled.is_some() {
            if method == "turn/completed" {
                self.stop();
            }
            return Ok(()); // No cancelled output is allowed to reach the coordinator.
        }
        if method == "error" {
            // A retry notice is not a terminal failure. Only the matching final
            // turn event decides success/failure; successful completion clears it.
            self.view.diagnostic = Some(TurnDiagnostic::provider("response", &p["error"]));
            return Ok(());
        }
        if method == "item/agentMessage/delta" || final_message {
            let item = wire_id(if final_message {
                p.pointer("/item/id")
            } else {
                p.get("itemId")
            })?;
            // First increment supports one agent message only; never silently concatenate distinct items.
            if r.item_id.as_ref().is_some_and(|id| id != &item) {
                return Err(ProcessFault::Protocol);
            }
            if r.item_completed {
                return Err(ProcessFault::Protocol);
            }
            r.item_id = Some(item);
            let text = if final_message {
                p.pointer("/item/text")
            } else {
                p.get("delta")
            }
            .and_then(Value::as_str)
            .ok_or(ProcessFault::Protocol)?;
            if final_message {
                if !r.item_text.is_empty() && r.item_text != text {
                    return Err(ProcessFault::Protocol);
                }
                r.item_completed = true;
                if !r.item_text.is_empty() {
                    return Ok(());
                }
            }
            c.push_delta(&r.ticket, r.sequence, text).map_err(|e| {
                if e == crate::Error::ResponseLimit {
                    ProcessFault::ResponseLimit
                } else {
                    ProcessFault::StaleCoordinator
                }
            })?;
            r.item_text.push_str(text);
            r.sequence += 1;
        } else {
            match p.pointer("/turn/status").and_then(Value::as_str) {
                Some("completed") => {
                    self.view.diagnostic = None;
                    c.complete_turn(&r.ticket, r.sequence)
                }
                Some("failed") => {
                    let final_diagnostic =
                        TurnDiagnostic::provider("response", &p["turn"]["error"]);
                    if final_diagnostic.code != "provider_failed" || self.view.diagnostic.is_none()
                    {
                        self.view.diagnostic = Some(final_diagnostic);
                    }
                    c.fail_turn(&r.ticket, r.sequence, ProviderError::Transport)
                }
                Some("interrupted") => c.provider_cancelled_turn(&r.ticket, r.sequence),
                _ => return Err(ProcessFault::Protocol),
            }
            .map_err(|_| ProcessFault::StaleCoordinator)?;
            self.stop();
        }
        Ok(())
    }
}
fn wire_id(v: Option<&Value>) -> Result<String, ProcessFault> {
    let s = v.and_then(Value::as_str).ok_or(ProcessFault::Protocol)?;
    if s.is_empty() || s.len() > 256 || s.chars().any(char::is_control) {
        return Err(ProcessFault::Protocol);
    }
    Ok(s.into())
}
impl ProviderAdapter for CodexProcessAdapter {
    fn provider_id(&self) -> &Id {
        &self.provider
    }
    fn host_id(&self) -> &Id {
        &self.host
    }
    fn start_login(&mut self, _: &LoginTicket, _: Option<&Id>) -> Result<(), ProviderError> {
        Err(ProviderError::Unavailable)
    }
    fn cancel_login(&mut self, _: &LoginTicket) -> Result<(), ProviderError> {
        Err(ProviderError::Unavailable)
    }
    fn start_turn(
        &mut self,
        t: &TurnTicket,
        _credential: &Secret,
        request: &TurnRequest,
    ) -> Result<(), ProviderError> {
        self.start_managed_turn(t, request)
    }
    fn start_managed_turn(
        &mut self,
        t: &TurnTicket,
        request: &TurnRequest,
    ) -> Result<(), ProviderError> {
        if self.pipes.is_some() && !self.process_view().direct_child_exited {
            return Err(ProviderError::Unavailable);
        }
        self.pipes.take();
        self.run = None;
        self.view = ProcessView::default();
        let p = Pipes::start(&self.config).map_err(|f| {
            self.view.fault = Some(f);
            ProviderError::Transport
        })?;
        self.view.pid = Some(p.child.id());
        self.view.direct_child_exited = false;
        self.pipes = Some(p);
        let now = Instant::now();
        self.run = Some(Run {
            ticket: t.clone(),
            model: request.model_id.as_str().into(),
            reasoning_effort: request.reasoning_effort.clone(),
            prompt: request.prompt.clone(),
            thread_id: None,
            turn_id: None,
            sequence: 0,
            stage: Stage::Initialize,
            started: now,
            stage_started: now,
            last_activity: now,
            cancelled: None,
            terminal: false,
            pending: vec![],
            item_id: None,
            item_text: String::new(),
            item_completed: false,
        });
        if self.send(json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"hangul_ai_session","title":"Hangul Rust process adapter","version":"0.1.0"}}})).is_err(){self.stop();return Err(ProviderError::Transport);}
        Ok(())
    }
    fn cancel_turn(&mut self, t: &TurnTicket) -> Result<(), ProviderError> {
        let r = self.run.as_mut().ok_or(ProviderError::Unavailable)?;
        if &r.ticket != t {
            return Err(ProviderError::Protocol);
        }
        r.cancelled = Some(Instant::now());
        let ids = r.thread_id.clone().zip(r.turn_id.clone());
        if let Some((thread, turn)) = ids {
            self.send(json!({"id":4,"method":"turn/interrupt","params":{"threadId":thread,"turnId":turn}})).map_err(|_|ProviderError::Transport)
        } else {
            self.stop();
            Ok(())
        }
    }
}

#[cfg(test)]
mod diagnostic_tests {
    use super::*;
    #[test]
    fn provider_category_is_allowlisted_and_never_retains_raw_details() {
        for (info, expected) in [
            (json!("contextWindowExceeded"), "context_limit"),
            (json!("usageLimitExceeded"), "usage_limit"),
            (json!("unauthorized"), "authorization"),
            (json!("badRequest"), "invalid_request"),
            (
                json!({"responseStreamDisconnected":{"httpStatusCode":503,"url":"PRIVATE_SENTINEL"}}),
                "network",
            ),
            (json!("PRIVATE_SENTINEL"), "provider_failed"),
            (json!({"unknown":"PRIVATE_SENTINEL"}), "provider_failed"),
        ] {
            let d = TurnDiagnostic::provider(
                "response",
                &json!({"codexErrorInfo":info,"message":"PRIVATE_SENTINEL","additionalDetails":"PRIVATE_SENTINEL"}),
            );
            assert_eq!(d.code, expected);
            assert!(
                !serde_json::to_string(&d)
                    .unwrap()
                    .contains("PRIVATE_SENTINEL")
            );
            assert!(!format!("{d:?}").contains("PRIVATE_SENTINEL"));
            assert!(!d.message().is_empty());
        }
    }
    #[test]
    fn rpc_structured_category_survives_but_plain_message_is_not_classified() {
        let d = TurnDiagnostic::provider(
            "turn_start",
            &json!({"code":-32000,"message":"contextWindowExceeded PRIVATE_SENTINEL"}),
        );
        assert_eq!(d.code, "provider_failed");
        let d = TurnDiagnostic::provider(
            "thread_start",
            &json!({"code":-32602,"data":{"codexErrorInfo":"usageLimitExceeded"}}),
        );
        assert_eq!(d.code, "usage_limit");
        assert_eq!(d.stage, "thread_start");
    }
}

#[cfg(test)]
mod backpressure_tests {
    use super::*;
    #[test]
    fn full_queue_waits_and_preserves_order() {
        let (tx, rx) = mpsc::sync_channel(1);
        tx.send(Wire::Line(vec![1])).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let f = Arc::new(AtomicU8::new(0));
        let (t, done) = mpsc::channel();
        let worker = thread::spawn(move || {
            t.send(enqueue_wire(&tx, Wire::Line(vec![2]), &stop, &f))
                .unwrap();
        });
        assert!(done.recv_timeout(Duration::from_millis(20)).is_err());
        assert!(matches!(rx.recv().unwrap(),Wire::Line(v) if v==vec![1]));
        assert!(done.recv_timeout(Duration::from_secs(1)).unwrap());
        assert!(matches!(rx.recv().unwrap(),Wire::Line(v) if v==vec![2]));
        worker.join().unwrap();
    }
    #[test]
    fn full_queue_shutdown_and_receiver_exit_end_reader() {
        for disconnect in [false, true] {
            let (tx, rx) = mpsc::sync_channel(1);
            tx.send(Wire::Eof).unwrap();
            let stop = Arc::new(AtomicBool::new(false));
            let worker_stop = stop.clone();
            let (t, done) = mpsc::channel();
            let worker = thread::spawn(move || {
                t.send(enqueue_wire(
                    &tx,
                    Wire::Eof,
                    &worker_stop,
                    &AtomicU8::new(0),
                ))
                .unwrap();
            });
            assert!(done.recv_timeout(Duration::from_millis(20)).is_err());
            if disconnect {
                drop(rx);
            } else {
                stop.store(true, Ordering::Release);
            }
            assert!(!done.recv_timeout(Duration::from_secs(1)).unwrap());
            worker.join().unwrap();
        }
    }
    #[test]
    fn limit_diagnostics_remain_distinct_and_safe() {
        let cases = [
            (ProcessFault::ResponseLimit, "response_limit"),
            (ProcessFault::LineLimit, "frame_limit"),
            (ProcessFault::StdoutLimit, "transport_output_limit"),
            (ProcessFault::StderrLimit, "transport_diagnostic_limit"),
            (ProcessFault::QueueLimit, "transport_queue_limit"),
        ];
        for (f, code) in cases {
            let d = TurnDiagnostic::fault("response", f);
            assert_eq!(d.code, code);
            assert!(!d.message().is_empty());
        }
    }
}
