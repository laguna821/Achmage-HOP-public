//! Synthetic Grok CLI stand-in for tests. Never used as a production CLI.
//! The adapter clears the environment, so modes come from marker files inside GROK_HOME and
//! from the prompt text. Speaks a small ACP subset (newline-delimited JSON-RPC 2.0).
use serde_json::{json, Value};
use std::{
    io::{BufRead, Read, Write},
    path::{Path, PathBuf},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

fn exit(code: i32) -> ! {
    std::process::exit(code)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if std::env::var_os("XAI_API_KEY").is_some() {
        exit(98)
    }
    let Some(home) = std::env::var_os("GROK_HOME").map(PathBuf::from) else {
        exit(99)
    };
    record_env(&home, &args);
    let a: Vec<&str> = args.iter().map(String::as_str).collect();
    match a.as_slice() {
        ["--version"] => {
            if home.join("fixture-version-fail").exists() {
                exit(2)
            }
            println!("grok 0.0.0-fixture");
        }
        ["login"] => login(&home, false),
        ["login", "--device-auth"] => login(&home, true),
        // `--always-approve` or any other flag is a contract violation.
        ["agent", "stdio"] => Agent::new(home).run(),
        _ => exit(94),
    }
}

fn record_env(home: &Path, args: &[String]) {
    let var = |k: &str| std::env::var(k).ok();
    let v = json!({"args":args,"GROK_HOME":var("GROK_HOME"),"HOME":var("HOME"),"USERPROFILE":var("USERPROFILE"),"APPDATA":var("APPDATA"),"LOCALAPPDATA":var("LOCALAPPDATA"),"HOMEDRIVE":var("HOMEDRIVE"),"HOMEPATH":var("HOMEPATH"),"cwd":std::env::current_dir().ok()});
    let name = args
        .first()
        .map(|s| s.trim_start_matches('-'))
        .unwrap_or("none");
    let _ = std::fs::write(home.join(format!("fixture-env-{name}.json")), v.to_string());
}

fn login(home: &Path, device: bool) {
    // The official login waits for the browser; stdin must stay open meanwhile.
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut b = [0];
        let n = std::io::stdin().read(&mut b).unwrap_or(0);
        let _ = tx.send(n);
    });
    if rx.recv_timeout(Duration::from_millis(80)).is_ok() {
        exit(91)
    }
    let out = |s: &str| {
        println!("{s}");
        std::io::stdout().flush().unwrap();
    };
    if home.join("fixture-login-fail").exists() {
        out("login failed: secret-token-value");
        exit(1)
    }
    if device {
        out("To sign in, open https://accounts.x.ai/device in a browser.");
        out("debug access_token=secret-token-value https://evil.example.com/steal");
        out("Enter code: WXYZ-2345");
        let start = Instant::now();
        while !home.join("fixture-device-approve").exists() {
            if start.elapsed() > Duration::from_secs(20) {
                exit(92)
            }
            thread::sleep(Duration::from_millis(10));
        }
    } else {
        out("Opening https://auth.x.ai/oauth2/auth?code_challenge=secret-token-value");
        if home.join("fixture-login-wait").exists() {
            thread::sleep(Duration::from_secs(30));
            return;
        }
    }
    std::fs::write(home.join("fixture-signed"), b"synthetic").unwrap();
}

struct Agent {
    home: PathBuf,
    rx: mpsc::Receiver<Value>,
    session: Option<String>,
    authenticated: bool,
}

impl Agent {
    fn new(home: PathBuf) -> Self {
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            for line in std::io::stdin().lock().lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                match serde_json::from_str::<Value>(&line) {
                    Ok(v) if v["jsonrpc"] == "2.0" => {
                        if tx.send(v).is_err() {
                            break;
                        }
                    }
                    _ => exit(90),
                }
            }
        });
        Self {
            home,
            rx,
            session: None,
            authenticated: false,
        }
    }
    fn marker(&self, name: &str) -> bool {
        self.home.join(name).exists()
    }
    fn send(&self, v: Value) {
        let line = format!("{v}\n");
        let mut out = std::io::stdout().lock();
        if line.len() < 4096 {
            // Small pieces split UTF-8 sequences and JSON lines across reads.
            for piece in line.as_bytes().chunks(3) {
                let _ = out.write_all(piece);
                let _ = out.flush();
            }
        } else {
            let _ = out.write_all(line.as_bytes());
            let _ = out.flush();
        }
    }
    fn reply(&self, id: &Value, result: Value) {
        self.send(json!({"jsonrpc":"2.0","id":id,"result":result}))
    }
    fn error(&self, id: &Value, code: i64, message: &str) {
        self.send(json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}}))
    }
    fn next(&self) -> Value {
        self.rx
            .recv_timeout(Duration::from_secs(20))
            .unwrap_or_else(|_| exit(93))
    }
    fn update(&self, session: &str, update: Value) {
        self.send(json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":session,"update":update}}))
    }
    fn chunk(&self, session: &str, text: &str) {
        self.update(
            session,
            json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":text}}),
        )
    }

    fn run(mut self) {
        // Stdin closed by the adapter ends the agent.
        while let Ok(msg) = self.rx.recv() {
            let id = msg["id"].clone();
            let params = msg["params"].clone();
            match msg["method"].as_str() {
                Some("initialize") => {
                    if params
                        != json!({"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false}})
                    {
                        exit(97)
                    }
                    let mut result = json!({"protocolVersion":1,"agentCapabilities":{"loadSession":false,"promptCapabilities":{}},"authMethods":[{"id":"cached_token","name":"Cached sign-in"},{"id":"xai.api_key","name":"API key"}]});
                    if self.marker("fixture-models") {
                        result["_meta"] = json!({"modelState":{"currentModelId":"grok-fixture-1","availableModels":[{"modelId":"grok-fixture-1","name":"Grok Fixture 1"},{"modelId":"grok-fixture-2","name":"Grok Fixture 2"}]}});
                    }
                    self.send(json!({"jsonrpc":"2.0","method":"_x.ai/models/update","params":{}}));
                    self.reply(&id, result);
                }
                Some("authenticate") => {
                    if params["methodId"] == "cached_token" && self.marker("fixture-signed") {
                        self.authenticated = true;
                        let _ = std::fs::write(self.home.join("fixture-authenticated"), b"");
                        self.reply(&id, json!({}));
                    } else {
                        self.error(&id, -32000, "Authentication required");
                    }
                }
                Some("session/new") => {
                    let canonical = |p: Option<PathBuf>| p.and_then(|p| p.canonicalize().ok());
                    let cwd_ok = canonical(params["cwd"].as_str().map(PathBuf::from))
                        == canonical(std::env::current_dir().ok());
                    if !cwd_ok || params["mcpServers"] != json!([]) {
                        exit(89)
                    }
                    let signed = self.marker("fixture-signed")
                        && (!self.marker("fixture-needs-authenticate") || self.authenticated);
                    if !signed {
                        self.error(&id, -32000, "Authentication required");
                        continue;
                    }
                    let sid = "sess-fixture-1".to_string();
                    self.session = Some(sid.clone());
                    self.reply(&id, json!({"sessionId":sid}));
                    self.update(
                        &sid,
                        json!({"sessionUpdate":"available_commands_update","availableCommands":[]}),
                    );
                }
                Some("session/prompt") => self.prompt(&id, &params),
                Some("session/cancel") => {}
                Some(_) => self.error(&id, -32601, "Method not found"),
                None => {}
            }
        }
    }

    fn prompt(&self, id: &Value, params: &Value) {
        let sid = self.session.clone().unwrap_or_else(|| exit(88));
        if params["sessionId"] != sid.as_str()
            || params["prompt"].as_array().map(Vec::len) != Some(1)
            || params["prompt"][0]["type"] != "text"
        {
            exit(88)
        }
        let text = params["prompt"][0]["text"]
            .as_str()
            .unwrap_or_else(|| exit(87));
        let end = |me: &Self, reason: &str| me.reply(id, json!({"stopReason":reason}));
        let forever = |me: &Self, session: &str, text: &str, every: u64| {
            let start = Instant::now();
            while start.elapsed() < Duration::from_secs(20) {
                me.chunk(session, text);
                thread::sleep(Duration::from_millis(every));
            }
        };
        match text {
            "MALFORMED" => {
                println!("not json secret-token");
                std::io::stdout().flush().unwrap();
            }
            "OVERSIZE" => self.send(json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":sid,"pad":"a".repeat(32 * 1024 * 1024 + 4096)}})),
            "SILENT" => thread::sleep(Duration::from_secs(20)),
            "FOREIGN_SPAM" => forever(self, "other-session", "LEAK", 30),
            "SLOW_FOREVER" => forever(self, &sid, ".", 50),
            "SLOW_STREAM" => {
                for _ in 0..8 {
                    self.chunk(&sid, ".");
                    thread::sleep(Duration::from_millis(150));
                }
                end(self, "end_turn");
            }
            "WAIT_CANCEL" => {
                self.chunk(&sid, "부분");
                loop {
                    let m = self.next();
                    if m["method"] == "session/cancel" && m["params"]["sessionId"] == sid.as_str() {
                        let _ = std::fs::write(self.home.join("fixture-cancel-received"), b"");
                        end(self, "cancelled");
                        break;
                    }
                }
            }
            "CRASH" => {
                self.chunk(&sid, "부분");
                exit(3)
            }
            "REFUSAL" => {
                self.chunk(&sid, "no");
                end(self, "refusal");
            }
            "MAX_TOKENS" => {
                self.chunk(&sid, "long");
                end(self, "max_tokens");
            }
            "BAD_ID" => {
                self.chunk(&sid, "x");
                let wrong = id.as_u64().unwrap_or(0) + 100;
                self.send(json!({"jsonrpc":"2.0","id":wrong,"result":{"stopReason":"end_turn"}}));
            }
            "EXPIRED" => self.error(id, -32000, "Authentication required"),
            "PERMISSION" | "PERMISSION_NO_REJECT" => {
                let mut options = vec![json!({"optionId":"allow","name":"Allow","kind":"allow_once"})];
                if text == "PERMISSION" {
                    options.push(json!({"optionId":"reject","name":"Reject","kind":"reject_once"}));
                }
                self.send(json!({"jsonrpc":"2.0","id":"perm-1","method":"session/request_permission","params":{"sessionId":sid,"toolCall":{"toolCallId":"t1","title":"write file","kind":"edit"},"options":options}}));
                let r = self.next();
                let expected = if text == "PERMISSION" {
                    json!({"outcome":"selected","optionId":"reject"})
                } else {
                    json!({"outcome":"cancelled"})
                };
                if r["id"] != "perm-1" || r["result"]["outcome"] != expected {
                    let _ = std::fs::write(self.home.join("fixture-permission-unexpected"), r.to_string());
                    exit(96)
                }
                self.update(&sid, json!({"sessionUpdate":"tool_call_update","toolCallId":"t1","status":"failed"}));
                if text == "PERMISSION" {
                    self.chunk(&sid, "거절됨");
                    end(self, "end_turn");
                } else {
                    self.chunk(&sid, "멈춤");
                    end(self, "cancelled");
                }
            }
            "FS" => {
                for (rid, method) in [(77, "fs/read_text_file"), (78, "terminal/create")] {
                    self.send(json!({"jsonrpc":"2.0","id":rid,"method":method,"params":{"sessionId":sid,"path":"C:/secret.txt","command":"cmd"}}));
                    let r = self.next();
                    if r["id"] != rid || r["error"]["code"] != -32601 || !r["result"].is_null() {
                        exit(95)
                    }
                }
                self.chunk(&sid, "ok");
                end(self, "end_turn");
            }
            "FOREIGN" => {
                self.chunk("other-session", "LEAK");
                self.chunk(&sid, "mine");
                end(self, "end_turn");
            }
            "USAGE_RESULT" => {
                self.chunk(&sid, "u");
                self.reply(id, json!({"stopReason":"end_turn","usage":{"inputTokens":11,"outputTokens":0,"cachedReadTokens":3}}));
            }
            _ => {
                self.update(&sid, json!({"sessionUpdate":"tool_call","toolCallId":"t0","title":"read","kind":"read","status":"pending"}));
                self.update(&sid, json!({"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"생각"}}));
                self.update(&sid, json!({"sessionUpdate":"plan","entries":[]}));
                self.chunk(&sid, "응답: ");
                self.chunk(&sid, text);
                self.update(&sid, json!({"sessionUpdate":"response_completed","usage":{"input_tokens":5,"output_tokens":7}}));
                self.send(json!({"jsonrpc":"2.0","method":"_x.ai/session/prompt_complete","params":{"sessionId":sid,"promptId":"p1","stopReason":"end_turn"}}));
                end(self, "end_turn");
            }
        }
    }
}
