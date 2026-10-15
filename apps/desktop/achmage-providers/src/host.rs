use crate::{process, stream::Stream, Result};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::Duration,
};
#[derive(Clone)]
pub struct Config {
    pub executable: PathBuf,
    pub profile: PathBuf,
    pub cwd: PathBuf,
}
static PROFILES: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
struct Lease(PathBuf);
impl Drop for Lease {
    fn drop(&mut self) {
        PROFILES.get().unwrap().lock().unwrap().remove(&self.0);
    }
}
struct Shared {
    view: Value,
    generation: u64,
    requests: crate::recent::RecentIds,
}
struct Running(Arc<AtomicBool>);
impl Drop for Running {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
pub struct ClaudeHost {
    cfg: Config,
    shared: Arc<Mutex<Shared>>,
    cancel: Arc<AtomicBool>,
    lease: Arc<Lease>,
    running: Arc<AtomicBool>,
}
impl ClaudeHost {
    pub fn new(mut cfg: Config) -> Result<Self> {
        if !cfg.executable.is_absolute() || !cfg.profile.is_absolute() || !cfg.cwd.is_absolute() {
            return Err("absolute_paths_required");
        }
        if !cfg.executable.is_file() {
            return Err("executable_missing");
        }
        std::fs::create_dir_all(&cfg.profile).map_err(|_| "profile_unavailable")?;
        std::fs::create_dir_all(&cfg.cwd).map_err(|_| "cwd_unavailable")?;
        cfg.profile = cfg
            .profile
            .canonicalize()
            .map_err(|_| "profile_unavailable")?;
        cfg.cwd = cfg.cwd.canonicalize().map_err(|_| "cwd_unavailable")?;
        if cfg.profile == cfg.cwd {
            return Err("separate_cwd_required");
        }
        if !PROFILES
            .get_or_init(Default::default)
            .lock()
            .unwrap()
            .insert(cfg.profile.clone())
        {
            return Err("profile_in_use");
        }
        let lease = Arc::new(Lease(cfg.profile.clone()));
        Ok(Self {
            cfg,
            shared: Arc::new(Mutex::new(Shared {
                view: json!({"selectedProvider":"claude","auth":{"status":"signed_out","sessionGeneration":null,"accountLabel":null},"usage":{"inputTokens":null,"outputTokens":null,"remainingPercent":null},"turn":{"id":null,"status":"idle","text":null},"busy":false,"commandPending":false,"sessionPersistence":"official_cli","notice":null,"models":[]}),
                generation: 0,
                requests: crate::recent::RecentIds::new(4096),
            })),
            cancel: Arc::new(AtomicBool::new(false)),
            lease,
            running: Arc::new(AtomicBool::new(false)),
        })
    }
    pub fn state(&self) -> Value {
        {
            let mut s = self.shared.lock().unwrap().view.clone();
            s["busy"] = json!(self.running.load(Ordering::Acquire));
            s
        }
    }
    pub fn restore(&mut self) -> Result<()> {
        self.connect(None)
    }
    /// Signs in with the user's Claude subscription (`claude auth login --claudeai`, the CLI's default).
    pub fn begin_login(&mut self) -> Result<()> {
        self.connect(Some("--claudeai"))
    }
    /// Signs in with an Anthropic Console account, billed by API usage (`claude auth login --console`).
    pub fn begin_console_login(&mut self) -> Result<()> {
        self.connect(Some("--console"))
    }
    /// `login`: the official CLI's sign-in flag to run when there is no session; `None` only checks the session.
    fn connect(&mut self, login: Option<&'static str>) -> Result<()> {
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
        thread::spawn(move || {
            let _running = running;
            let _lease = lease;
            let result = (|| {
                if let Some(account) = status(&cfg, &cancel)? {
                    return Ok(Some(account));
                }
                let Some(login) = login else {
                    return Ok(None);
                };
                update(&shared, generation, |s| {
                    s["auth"]["phase"] = json!("awaiting_browser")
                });
                let code = process::run(
                    &cfg,
                    &["auth".into(), "login".into(), login.into()],
                    None,
                    &cancel,
                    Duration::from_secs(600),
                    None,
                    |_| Ok(()),
                )?;
                if code != 0 {
                    return Err("login_failed");
                };
                status(&cfg, &cancel)
            })();
            update(&shared, generation, |s| {
                s["busy"] = json!(false);
                s["auth"] = match result {
                    Ok(Some(account)) if !cancel.load(Ordering::Acquire) => {
                        json!({"status":"signed_in","sessionGeneration":generation.to_string(),"accountLabel":account})
                    }
                    Ok(None) | Err("cancelled") => {
                        json!({"status":"signed_out","sessionGeneration":null})
                    }
                    Ok(Some(_)) => json!({"status":"signed_out","sessionGeneration":null}),
                    Err(e) => {
                        json!({"status":"error","sessionGeneration":null,"errorCode":e,"message":"공식 Claude CLI 연결 상태를 확인하지 못했습니다."})
                    }
                };
            });
        });
        Ok(())
    }
    pub fn cancel_login(&mut self) -> Result<()> {
        if self.state()["auth"]["status"] != "pending" {
            return Err("no_pending_login");
        };
        self.cancel.store(true, Ordering::Release);
        Ok(())
    }
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
    pub fn send(
        &mut self,
        request_id: String,
        prompt: String,
        model: Option<String>,
    ) -> Result<()> {
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
        if model.as_ref().is_some_and(|m| {
            m.is_empty()
                || m.len() > 128
                || !m
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        }) {
            return Err("invalid_model");
        }
        let mut s = self.shared.lock().unwrap();
        if self.running.load(Ordering::Acquire) {
            return Err("busy");
        };
        if s.view["auth"]["status"] != "signed_in" {
            return Err("signed_out");
        }
        if s.requests.contains(&request_id) {
            return Err("request_replayed");
        };
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
        thread::spawn(move || {
            let _running = running;
            let _lease = lease;
            let mut stream = Stream::default();
            let result = (|| {
                if status(&cfg, &cancel)?.is_none() {
                    return Err("authentication_failed");
                }
                let mut args: Vec<String> = [
                    "-p",
                    "--input-format",
                    "stream-json",
                    "--output-format",
                    "stream-json",
                    "--verbose",
                    "--include-partial-messages",
                    "--tools",
                    "",
                    "--strict-mcp-config",
                    "--mcp-config",
                    "{\"mcpServers\":{}}",
                    "--disable-slash-commands",
                    "--setting-sources",
                    "",
                    "--restricted",
                    "--no-session-persistence",
                ]
                .into_iter()
                .map(str::to_string)
                .collect();
                if let Some(m) = model {
                    args.extend(["--model".into(), m])
                }
                let mut frame=serde_json::to_vec(&json!({"type":"user","message":{"role":"user","content":prompt},"parent_tool_use_id":null,"session_id":""})).map_err(|_|"input_encoding")?;
                frame.push(b'\n');
                let code = process::run(
                    &cfg,
                    &args,
                    Some(&frame),
                    &cancel,
                    // Long documents take minutes to write; silence, not length, ends a turn.
                    Duration::from_secs(900),
                    Some(Duration::from_secs(120)),
                    |bytes| {
                        stream.push(bytes)?;
                        update(&shared, generation, |s| {
                            s["turn"]["text"] = json!(stream.text);
                            if !stream.usage.is_null() {
                                s["usage"] = stream.usage.clone()
                            }
                        });
                        Ok(())
                    },
                )?;
                if code != 0 {
                    return Err("provider_exit");
                };
                stream.finish()
            })();
            let result = if cancel.load(Ordering::Acquire) {
                Err("cancelled")
            } else {
                result
            };
            update(&shared, generation, |s| {
                s["busy"] = json!(false);
                s["turn"]["status"] = json!(match result {
                    Ok(()) => "completed",
                    Err("cancelled") => "cancelled",
                    Err(_) => "error",
                });
                if let Err(e) = result {
                    s["turn"]["text"] = Value::Null;
                    s["turn"]["errorCode"] = json!(e);
                    s["turn"]["message"] = json!(crate::turn_failure_message(e));
                    if e == "authentication_failed" {
                        s["auth"] = json!({"status":"signed_out","sessionGeneration":null})
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
        };
        self.cancel.store(true, Ordering::Release);
        Ok(())
    }
}
impl Drop for ClaudeHost {
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
/// The account kind of a signed-in session, for the panel. `claude auth status` reports both kinds as
/// `authMethod: "claude.ai"`: a Console sign-in (`claude auth login --console`) carries
/// `apiKeySource: "/login managed key"`, a Claude subscription a `subscriptionType`.
fn account_label(v: &Value) -> &'static str {
    if v["apiKeySource"].as_str() == Some("/login managed key") && v["subscriptionType"].is_null() {
        "Anthropic Console 계정"
    } else {
        "Claude 구독 계정"
    }
}
/// The signed-in account kind, or `None` when the official CLI has no session.
fn status(cfg: &Config, cancel: &AtomicBool) -> Result<Option<&'static str>> {
    let mut bytes = Vec::new();
    let code = process::run(
        cfg,
        &["auth".into(), "status".into(), "--json".into()],
        None,
        cancel,
        Duration::from_secs(20),
        None,
        |b| {
            if bytes.len() + b.len() > 64 * 1024 {
                return Err("status_limit");
            };
            bytes.extend_from_slice(b);
            Ok(())
        },
    )?;
    let v: Value = serde_json::from_slice(&bytes).map_err(|_| "invalid_status")?;
    let dir = v["configDirectory"]
        .as_str()
        .ok_or("missing_profile_identity")?;
    if PathBuf::from(dir)
        .canonicalize()
        .map_err(|_| "profile_identity_mismatch")?
        != cfg.profile
    {
        return Err("profile_identity_mismatch");
    }
    match (v["loggedIn"].as_bool(), v["authMethod"].as_str(), code) {
        (Some(true), Some("claude.ai"), 0) => Ok(Some(account_label(&v))),
        (Some(false), Some("none"), 1 | 0) => Ok(None),
        _ => Err("unsupported_auth_method"),
    }
}
