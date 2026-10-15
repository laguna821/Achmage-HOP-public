//! Bounded owned child process and a minimal ACP client (Agent Client Protocol: JSON-RPC 2.0,
//! newline-delimited JSON over stdio) for the official `grok agent stdio`.
//! The client advertises no fs/terminal capability, refuses every permission request and
//! answers every other client-bound request with method-not-found. It never runs anything.
use crate::Result;
use serde_json::{json, Value};
use std::{
    ffi::OsString,
    io::{Read, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    thread,
    time::{Duration, Instant},
};

pub(crate) const LINE_LIMIT: usize = 32 * 1024 * 1024;
pub(crate) const OUTPUT_LIMIT: usize = 256 * 1024 * 1024;
pub(crate) const TEXT_LIMIT: usize = 32 * 1024 * 1024;

/// Executable, working directory and the owned-profile variables for one child.
#[derive(Clone)]
pub(crate) struct Launch {
    pub executable: PathBuf,
    pub cwd: PathBuf,
    pub env: Vec<(&'static str, OsString)>,
}

pub(crate) enum Wire {
    Line(Vec<u8>),
    LineLimit,
    OutputLimit,
    Truncated,
    Eof,
    ReadFailed,
}

/// One direct child with a bounded line reader and a non-blocking writer.
pub(crate) struct Pipes {
    child: Child,
    input: Option<mpsc::Sender<Vec<u8>>>,
    input_failed: Arc<AtomicBool>,
    output: mpsc::Receiver<Wire>,
    workers: Vec<thread::JoinHandle<()>>,
}

impl Pipes {
    pub fn spawn(
        l: &Launch,
        args: &[&str],
        line_limit: usize,
        output_limit: usize,
    ) -> Result<Self> {
        let mut command = Command::new(&l.executable);
        command.args(args).current_dir(&l.cwd).env_clear();
        // OS runtime only. Provider keys (XAI_API_KEY), proxies, debug flags and the user's own
        // home variables are never forwarded; the owned profile variables come from `l.env`.
        for key in [
            "SystemRoot",
            "WINDIR",
            "PATH",
            "PATHEXT",
            "COMSPEC",
            "TEMP",
            "TMP",
            "TMPDIR",
            "LANG",
            "LC_ALL",
            // Linux session: lets the CLI open the sign-in page in a browser and reach the Secret Service.
            "DISPLAY",
            "WAYLAND_DISPLAY",
            "DBUS_SESSION_BUS_ADDRESS",
            "XDG_RUNTIME_DIR",
        ] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        for (key, value) in &l.env {
            command.env(key, value);
        }
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "not_installed"
            } else {
                "spawn_failed"
            }
        })?;
        let (Some(mut stdin), Some(mut stdout)) = (child.stdin.take(), child.stdout.take()) else {
            let _ = child.kill();
            let _ = child.wait();
            return Err("pipe_missing");
        };
        let (tx, output) = mpsc::sync_channel(64);
        let reader = thread::spawn(move || {
            let mut buffer: Vec<u8> = Vec::new();
            let mut scanned = 0usize;
            let mut total = 0usize;
            let mut chunk = [0u8; 8192];
            loop {
                match stdout.read(&mut chunk) {
                    Ok(0) => {
                        if !buffer.iter().all(u8::is_ascii_whitespace) {
                            let _ = tx.send(Wire::Truncated);
                        }
                        let _ = tx.send(Wire::Eof);
                        return;
                    }
                    Ok(n) => {
                        total += n;
                        if total > output_limit {
                            let _ = tx.send(Wire::OutputLimit);
                            return;
                        }
                        buffer.extend_from_slice(&chunk[..n]);
                        while let Some(offset) = buffer[scanned..].iter().position(|b| *b == b'\n')
                        {
                            let mut line: Vec<u8> = buffer.drain(..=scanned + offset).collect();
                            scanned = 0;
                            line.pop();
                            if line.last() == Some(&b'\r') {
                                line.pop();
                            }
                            if line.len() > line_limit {
                                let _ = tx.send(Wire::LineLimit);
                                return;
                            }
                            if line.iter().all(u8::is_ascii_whitespace) {
                                continue;
                            }
                            if tx.send(Wire::Line(line)).is_err() {
                                return;
                            }
                        }
                        scanned = buffer.len();
                        if buffer.len() > line_limit {
                            let _ = tx.send(Wire::LineLimit);
                            return;
                        }
                    }
                    Err(_) => {
                        let _ = tx.send(Wire::ReadFailed);
                        return;
                    }
                }
            }
        });
        let (input, rx) = mpsc::channel::<Vec<u8>>();
        let input_failed = Arc::new(AtomicBool::new(false));
        let failed = input_failed.clone();
        // A writer thread keeps a child that stops reading from blocking the protocol loop.
        let writer = thread::spawn(move || {
            for frame in rx {
                if stdin.write_all(&frame).and_then(|_| stdin.flush()).is_err() {
                    failed.store(true, Ordering::Release);
                    return;
                }
            }
        });
        Ok(Self {
            child,
            input: Some(input),
            input_failed,
            output,
            workers: vec![reader, writer],
        })
    }
    pub fn send(&self, v: &Value) -> Result<()> {
        if self.input_failed.load(Ordering::Acquire) {
            return Err("stdin_failed");
        }
        let mut frame = serde_json::to_vec(v).map_err(|_| "input_encoding")?;
        frame.push(b'\n');
        self.input
            .as_ref()
            .ok_or("stdin_closed")?
            .send(frame)
            .map_err(|_| "stdin_failed")
    }
    /// `None` on timeout. A finished reader keeps reporting `Eof`.
    pub fn recv(&self, wait: Duration) -> Option<Wire> {
        match self.output.recv_timeout(wait) {
            Ok(w) => Some(w),
            Err(mpsc::RecvTimeoutError::Timeout) => None,
            Err(mpsc::RecvTimeoutError::Disconnected) => Some(Wire::Eof),
        }
    }
    pub fn try_exit(&mut self) -> Result<Option<i32>> {
        match self.child.try_wait() {
            Ok(Some(s)) => Ok(Some(s.code().unwrap_or(-1))),
            Ok(None) => Ok(None),
            Err(_) => Err("wait_failed"),
        }
    }
    /// Close stdin, allow a bounded graceful exit, then `Drop` kills the direct child.
    pub fn shutdown(mut self, grace: Duration) {
        self.input.take();
        let until = Instant::now() + grace;
        while Instant::now() < until {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
    }
}

impl Drop for Pipes {
    fn drop(&mut self) {
        self.input.take();
        // Only this direct child. Never kill by name or a shared provider process.
        let _ = self.child.kill();
        let until = Instant::now() + Duration::from_millis(500);
        while Instant::now() < until {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                break;
            }
            thread::sleep(Duration::from_millis(2));
        }
        // A descendant may retain inherited pipes; never block cleanup joining such workers.
        for worker in self.workers.drain(..) {
            if worker.is_finished() {
                let _ = worker.join();
            }
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Timing {
    /// Refreshed only by activity that belongs to this request/session.
    pub idle: Duration,
    /// Hard cap from child start.
    pub hard: Duration,
    /// After `session/cancel`, how long to wait for the prompt result before killing.
    pub cancel_grace: Duration,
}

#[derive(Default, Clone, Copy, Debug)]
pub(crate) struct Counts {
    pub other_updates: u64,
    pub permission_refused: u64,
    pub requests_rejected: u64,
    pub foreign_session: u64,
    pub ignored_notifications: u64,
}

#[derive(Default)]
pub(crate) struct Progress {
    pub text: String,
    pub usage: Value,
    usage_rank: u8,
    pub counts: Counts,
}

impl Progress {
    fn usage(&mut self, raw: &Value, rank: u8, source: &str) {
        if rank < self.usage_rank {
            return;
        }
        if let Some(mut u) = usage(raw) {
            u["source"] = json!(source);
            self.usage = u;
            self.usage_rank = rank;
        }
    }
}

pub(crate) struct Opened {
    pub models: Vec<Value>,
}

/// JSON-RPC 2.0 error code the agent answered with.
type Reply = std::result::Result<Value, i64>;

pub(crate) struct Rpc<'a> {
    pipes: Pipes,
    next_id: u64,
    started: Instant,
    last_activity: Instant,
    timing: Timing,
    cancel: &'a AtomicBool,
    session: Option<String>,
    pub progress: Progress,
}

impl<'a> Rpc<'a> {
    pub fn start(l: &Launch, timing: Timing, cancel: &'a AtomicBool) -> Result<Self> {
        let pipes = Pipes::spawn(l, &["agent", "stdio"], LINE_LIMIT, OUTPUT_LIMIT)?;
        let now = Instant::now();
        Ok(Self {
            pipes,
            next_id: 1,
            started: now,
            last_activity: now,
            timing,
            cancel,
            session: None,
            progress: Progress::default(),
        })
    }

    /// `initialize` then `session/new` in the owned empty cwd. An auth-required answer
    /// (-32000) is retried once through an advertised `cached_token` method, never an API key.
    pub fn open(&mut self, cwd: &str) -> Result<Opened> {
        let init = match self.call(
            "initialize",
            json!({"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false}}),
            &mut |_| {},
        )? {
            Ok(v) => v,
            Err(_) => return Err("initialize_failed"),
        };
        if init["protocolVersion"].as_u64() != Some(1) {
            return Err("protocol_version_unsupported");
        }
        if !(init["agentCapabilities"].is_object() || init["agentCapabilities"].is_null()) {
            return Err("invalid_initialize");
        }
        let cached_token = init["authMethods"]
            .as_array()
            .is_some_and(|m| m.iter().take(32).any(|x| x["id"] == "cached_token"));
        let params = json!({"cwd":cwd,"mcpServers":[]});
        let mut authenticated = false;
        let session = loop {
            match self.call("session/new", params.clone(), &mut |_| {})? {
                Ok(v) => break v,
                Err(-32000) if cached_token && !authenticated => {
                    authenticated = true;
                    match self.call(
                        "authenticate",
                        json!({"methodId":"cached_token"}),
                        &mut |_| {},
                    )? {
                        Ok(_) => continue,
                        Err(_) => return Err("login_required"),
                    }
                }
                Err(-32000) => return Err("login_required"),
                Err(_) => return Err("session_new_failed"),
            }
        };
        let id = session["sessionId"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 256 && s.bytes().all(|b| b.is_ascii_graphic()))
            .ok_or("invalid_session")?;
        self.session = Some(id.to_string());
        let mut models = models(&session["models"]);
        if models.is_empty() {
            models = self::models(&init["_meta"]["modelState"]);
        }
        Ok(Opened { models })
    }

    /// One `session/prompt`; returns the agent's stop reason. Text accumulates in `progress`.
    pub fn prompt(&mut self, text: &str, on_text: &mut dyn FnMut(&Progress)) -> Result<String> {
        let session = self.session.clone().ok_or("no_session")?;
        let reply = self.call(
            "session/prompt",
            json!({"sessionId":session,"prompt":[{"type":"text","text":text}]}),
            on_text,
        )?;
        let result = match reply {
            Ok(v) => v,
            Err(-32000) => return Err("login_required"),
            Err(_) => return Err("prompt_failed"),
        };
        let stop = result["stopReason"]
            .as_str()
            .filter(|s| {
                !s.is_empty()
                    && s.len() <= 32
                    && s.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
            })
            .ok_or("invalid_stop_reason")?
            .to_string();
        self.progress
            .usage(&result["usage"], 3, "acp_prompt_result");
        Ok(stop)
    }

    pub fn finish(self) {
        self.pipes.shutdown(Duration::from_millis(300));
    }

    fn call(
        &mut self,
        method: &str,
        params: Value,
        on_text: &mut dyn FnMut(&Progress),
    ) -> Result<Reply> {
        let id = self.next_id;
        self.next_id += 1;
        self.pipes
            .send(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))?;
        let mut cancel_sent: Option<Instant> = None;
        loop {
            let now = Instant::now();
            if self.cancel.load(Ordering::Acquire) {
                match (&self.session, method == "session/prompt", cancel_sent) {
                    (Some(sid), true, None) => {
                        self.pipes
                            .send(&json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":sid}}))?;
                        cancel_sent = Some(now);
                    }
                    (Some(_), true, Some(at))
                        if now.duration_since(at) <= self.timing.cancel_grace => {}
                    _ => return Err("cancelled"),
                }
            }
            if now.duration_since(self.started) > self.timing.hard {
                return Err("timeout");
            }
            if cancel_sent.is_none() && now.duration_since(self.last_activity) > self.timing.idle {
                return Err("idle_timeout");
            }
            let line = match self.pipes.recv(Duration::from_millis(20)) {
                None => continue,
                Some(Wire::Line(l)) => l,
                Some(Wire::LineLimit) => return Err("line_limit"),
                Some(Wire::OutputLimit) => return Err("output_limit"),
                Some(Wire::Truncated) => return Err("truncated_stream"),
                Some(Wire::Eof) => return Err("unexpected_eof"),
                Some(Wire::ReadFailed) => return Err("stdout_failed"),
            };
            let v: Value = serde_json::from_slice(&line).map_err(|_| "invalid_json")?;
            if !v.is_object() || v["jsonrpc"] != "2.0" {
                return Err("invalid_jsonrpc");
            }
            match (v.get("method"), v.get("id")) {
                (None, Some(rid)) => {
                    if *rid != json!(id) {
                        return Err("unexpected_response");
                    }
                    self.last_activity = Instant::now();
                    if let Some(e) = v.get("error") {
                        return Ok(Err(e["code"].as_i64().ok_or("invalid_jsonrpc")?));
                    }
                    return v.get("result").cloned().map(Ok).ok_or("invalid_jsonrpc");
                }
                (Some(_), Some(rid)) => {
                    let rid = rid.clone();
                    self.client_request(&v, rid)?
                }
                (Some(_), None) => self.notification(&v, on_text)?,
                (None, None) => return Err("invalid_jsonrpc"),
            }
        }
    }

    fn ours(&self, params: &Value) -> bool {
        self.session.is_some() && params["sessionId"].as_str() == self.session.as_deref()
    }

    fn client_request(&mut self, v: &Value, rid: Value) -> Result<()> {
        let method = v["method"].as_str().ok_or("invalid_jsonrpc")?;
        let params = &v["params"];
        let ours = self.ours(params);
        if ours {
            self.last_activity = Instant::now();
        }
        let reply = if method == "session/request_permission" {
            self.progress.counts.permission_refused += 1;
            // Prefer an offered one-time reject so the agent can finish the turn; otherwise, or
            // after cancellation or for another session, answer cancelled. Never select allow.
            let reject = (ours && !self.cancel.load(Ordering::Acquire))
                .then(|| params["options"].as_array())
                .flatten()
                .and_then(|o| o.iter().take(32).find(|x| x["kind"] == "reject_once"))
                .and_then(|x| x["optionId"].as_str())
                .filter(|s| !s.is_empty() && s.len() <= 256);
            let outcome = match reject {
                Some(option) => json!({"outcome":"selected","optionId":option}),
                None => json!({"outcome":"cancelled"}),
            };
            json!({"jsonrpc":"2.0","id":rid,"result":{"outcome":outcome}})
        } else {
            // fs/*, terminal/* and anything else: no capability was granted.
            self.progress.counts.requests_rejected += 1;
            json!({"jsonrpc":"2.0","id":rid,"error":{"code":-32601,"message":"Method not found"}})
        };
        self.pipes.send(&reply)
    }

    fn notification(&mut self, v: &Value, on_text: &mut dyn FnMut(&Progress)) -> Result<()> {
        let method = v["method"].as_str().ok_or("invalid_jsonrpc")?;
        // ACP extension notifications may carry a leading underscore.
        let canonical = method.strip_prefix('_').unwrap_or(method);
        let params = &v["params"];
        match canonical {
            "session/update" | "x.ai/session/update" | "x.ai/session_notification" => {
                if !self.ours(params) {
                    self.progress.counts.foreign_session += 1;
                    return Ok(());
                }
                self.last_activity = Instant::now();
                let update = &params["update"];
                match update["sessionUpdate"].as_str() {
                    Some("agent_message_chunk")
                        if canonical == "session/update" && update["content"]["type"] == "text" =>
                    {
                        let s = update["content"]["text"].as_str().ok_or("invalid_update")?;
                        if self.progress.text.len() + s.len() > TEXT_LIMIT {
                            return Err("text_limit");
                        }
                        self.progress.text.push_str(s);
                        on_text(&self.progress);
                    }
                    Some("response_completed") => {
                        self.progress
                            .usage(&update["usage"], 1, "grok_response_completed");
                        on_text(&self.progress);
                    }
                    _ => self.progress.counts.other_updates += 1,
                }
            }
            "x.ai/session/prompt_complete" => {
                if !self.ours(params) {
                    self.progress.counts.foreign_session += 1;
                    return Ok(());
                }
                self.last_activity = Instant::now();
                self.progress
                    .usage(&params["usage"], 2, "grok_prompt_complete");
            }
            _ => self.progress.counts.ignored_notifications += 1,
        }
        Ok(())
    }
}

/// Only values the provider actually sent; anything absent or not a non-negative integer is null.
pub(crate) fn usage(v: &Value) -> Option<Value> {
    if !v.is_object() {
        return None;
    }
    let pick = |keys: [&str; 2]| -> Value {
        keys.iter()
            .find_map(|k| v.get(*k).and_then(Value::as_u64))
            .map_or(Value::Null, Value::from)
    };
    let u = json!({
        "inputTokens": pick(["input_tokens", "inputTokens"]),
        "outputTokens": pick(["output_tokens", "outputTokens"]),
        "cacheReadTokens": pick(["cache_read_input_tokens", "cachedReadTokens"]),
        "cacheCreationTokens": pick(["cache_creation_input_tokens", "cachedWriteTokens"]),
        "remainingPercent": null
    });
    [
        "inputTokens",
        "outputTokens",
        "cacheReadTokens",
        "cacheCreationTokens",
    ]
    .iter()
    .any(|k| !u[*k].is_null())
    .then_some(u)
}

/// Models exactly as the CLI listed them (`availableModels`); none listed means none reported.
pub(crate) fn models(state: &Value) -> Vec<Value> {
    let Some(list) = state["availableModels"].as_array() else {
        return vec![];
    };
    list.iter()
        .take(64)
        .filter_map(|m| {
            let id = m["modelId"].as_str().filter(|s| {
                !s.is_empty()
                    && s.len() <= 128
                    && s.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"-_.:/".contains(&b))
            })?;
            let label = m["name"]
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 128 && !s.chars().any(char::is_control))
                .unwrap_or(id);
            Some(json!({"id":id,"label":label}))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn usage_reports_only_present_values() {
        assert!(usage(&json!({})).is_none());
        assert!(usage(&Value::Null).is_none());
        let u = usage(&json!({"input_tokens":5,"output_tokens":0})).unwrap();
        assert_eq!(u["inputTokens"], 5);
        assert_eq!(u["outputTokens"], 0);
        assert!(u["cacheReadTokens"].is_null());
        let u = usage(&json!({"inputTokens":-1,"cachedReadTokens":3})).unwrap();
        assert!(u["inputTokens"].is_null());
        assert_eq!(u["cacheReadTokens"], 3);
    }
    #[test]
    fn models_are_never_invented() {
        assert!(models(&Value::Null).is_empty());
        assert!(models(&json!({"currentModelId":"x"})).is_empty());
        let m = models(
            &json!({"availableModels":[{"modelId":"grok-a","name":"Grok A"},{"modelId":"bad id"},{"modelId":"grok-b"}]}),
        );
        assert_eq!(
            m,
            vec![
                json!({"id":"grok-a","label":"Grok A"}),
                json!({"id":"grok-b","label":"grok-b"})
            ]
        );
    }
}
