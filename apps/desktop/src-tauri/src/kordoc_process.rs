//! Fixed, application-owned Node worker. No executable, argv or path from JSON.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    thread,
    time::{Duration, Instant},
};

pub const INPUT_LIMIT: usize = 16 * 1024 * 1024;
pub const OUTPUT_LIMIT: usize = 32 * 1024 * 1024;
pub const FILE_LIMIT: usize = 32 * 1024 * 1024;
const STDERR_LIMIT: usize = 1024 * 1024;
pub const ENGINE_VERSION: &str = "4.21.31";

#[derive(Clone)]
pub struct Runtime {
    pub node: PathBuf,
    pub worker: PathBuf,
}

pub fn validate_request(input: &Value) -> Result<Vec<u8>, &'static str> {
    let o = input.as_object().ok_or("invalid_request")?;
    let id = input["id"].as_str().ok_or("invalid_request")?;
    if id.is_empty() || id.len() > 100 || id.chars().any(char::is_control) {
        return Err("invalid_request");
    }
    let fields: &[&str] = match input["op"].as_str() {
        Some("capabilities") => &["id", "op"],
        Some("generate") => {
            if !input["template"].is_object() {
                return Err("invalid_request");
            }
            let text = input["markdown"].as_str().ok_or("invalid_request")?;
            if text.trim().is_empty() {
                return Err("input_limit");
            }
            &["id", "op", "template", "markdown"]
        }
        Some("render" | "validate") => {
            let data = input["hwpxBase64"].as_str().ok_or("invalid_request")?;
            if data.is_empty() || data.len() > 12 * 1024 * 1024 {
                return Err("input_limit");
            }
            &["id", "op", "hwpxBase64"]
        }
        _ => return Err("unsupported_operation"),
    };
    if o.len() != fields.len() || fields.iter().any(|key| !o.contains_key(*key)) {
        return Err("invalid_request");
    }
    let mut bytes = serde_json::to_vec(input).map_err(|_| "invalid_request")?;
    if bytes.len() > INPUT_LIMIT {
        return Err("input_limit");
    }
    bytes.push(b'\n');
    Ok(bytes)
}

pub fn decode_verified(data: &str, expected: &str) -> Result<Vec<u8>, &'static str> {
    if data.len() > FILE_LIMIT.div_ceil(3) * 4
        || expected.len() != 64
        || !expected
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err("invalid_document");
    }
    let bytes = STANDARD.decode(data).map_err(|_| "invalid_document")?;
    if bytes.len() > FILE_LIMIT || !bytes.starts_with(b"PK\x03\x04") {
        return Err("invalid_document");
    }
    if hex_sha(&bytes) != expected {
        return Err("document_hash_mismatch");
    }
    Ok(bytes)
}
pub fn hex_sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn write_generated(root: &Path, stem: &str, bytes: &[u8]) -> Result<PathBuf, &'static str> {
    if !root.is_absolute()
        || stem.len() != 32
        || !stem.bytes().all(|b| b.is_ascii_hexdigit())
        || bytes.len() > FILE_LIMIT
    {
        return Err("invalid_document");
    }
    fs::create_dir_all(root).map_err(|_| "save_failed")?;
    let path = root.join(format!("{stem}.hwpx"));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|_| "save_failed")?;
    if file.write_all(bytes).and_then(|_| file.sync_all()).is_err() {
        drop(file);
        let _ = fs::remove_file(&path);
        return Err("save_failed");
    }
    Ok(path)
}

fn parse_response(bytes: &[u8], input: &Value) -> Result<Value, &'static str> {
    if bytes.len() > OUTPUT_LIMIT || !bytes.ends_with(b"\n") {
        return Err("invalid_response");
    }
    let v: Value = serde_json::from_slice(bytes).map_err(|_| "invalid_response")?;
    if v["id"] != input["id"] {
        return Err("response_mismatch");
    }
    if v["ok"] == false {
        // Worker/library exception strings may contain document content or paths.
        let code = match v["error"]["code"].as_str() {
            Some("input_limit") => "input_limit",
            Some("response_limit") => "response_limit",
            _ => "document_engine_rejected",
        };
        return Ok(
            json!({"id":input["id"],"ok":false,"error":{"code":code,"message":"문서 엔진이 요청을 처리하지 못했습니다. 입력 형식과 크기를 확인하세요."}}),
        );
    }
    if v["ok"] != true
        || v["result"]["engine"]["name"] != "kordoc"
        || v["result"]["engine"]["version"] != ENGINE_VERSION
    {
        return Err("invalid_response");
    }
    if matches!(input["op"].as_str(), Some("generate" | "render")) {
        decode_verified(
            v["result"]["hwpxBase64"]
                .as_str()
                .ok_or("invalid_response")?,
            v["result"]["sha256"].as_str().ok_or("invalid_response")?,
        )?;
        let pages = v["result"]["pages"].as_array().ok_or("invalid_response")?;
        if pages.is_empty() || pages.len() > 100 || v["result"]["validation"]["ok"] != true {
            return Err("invalid_document");
        }
        if pages.iter().any(|p| {
            p["svg"].as_str().is_none()
                || !p["width"].as_f64().is_some_and(|n| n > 0.0)
                || !p["height"].as_f64().is_some_and(|n| n > 0.0)
        }) {
            return Err("invalid_response");
        }
    }
    Ok(v)
}

enum Event {
    Stdout(Result<Vec<u8>, &'static str>),
    Stderr(Result<(), &'static str>),
    Written(Result<(), &'static str>),
}
fn read_bounded(mut reader: impl Read, limit: usize) -> Result<Vec<u8>, &'static str> {
    let mut bytes = Vec::new();
    let mut block = [0u8; 8192];
    loop {
        let n = reader.read(&mut block).map_err(|_| "worker_io")?;
        if n == 0 {
            return Ok(bytes);
        }
        if bytes.len() + n > limit {
            return Err("response_limit");
        }
        bytes.extend_from_slice(&block[..n]);
    }
}

// Node's Windows main-module resolver rejects canonical verbatim drive paths.
// Preserve Unicode and UNC components without lossy string conversion.
fn node_argument_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        let mut parts = path.components();
        if let Some(Component::Prefix(prefix)) = parts.next() {
            let mut result = match prefix.kind() {
                Prefix::VerbatimDisk(drive) => PathBuf::from(format!("{}:\\", drive as char)),
                Prefix::VerbatimUNC(server, share) => {
                    let mut p = std::ffi::OsString::from("\\\\");
                    p.push(server);
                    p.push("\\");
                    p.push(share);
                    PathBuf::from(p)
                }
                _ => return path.to_path_buf(),
            };
            for p in parts {
                if !matches!(p, Component::RootDir) {
                    result.push(p.as_os_str());
                }
            }
            return result;
        }
    }
    path.to_path_buf()
}

pub fn run(
    runtime: &Runtime,
    input: &Value,
    cancel: &Arc<AtomicBool>,
    timeout: Duration,
) -> Result<Value, &'static str> {
    let payload = validate_request(input)?;
    if cancel.load(Ordering::SeqCst) {
        return Err("cancelled");
    }
    if !runtime.node.is_absolute()
        || !runtime.worker.is_absolute()
        || !runtime.node.is_file()
        || !runtime.worker.is_file()
    {
        return Err("runtime_missing");
    }
    let mut command = Command::new(&runtime.node);
    command
        .arg(node_argument_path(&runtime.worker))
        .arg("--once")
        .current_dir(runtime.worker.parent().ok_or("runtime_missing")?)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for name in ["SystemRoot", "WINDIR", "TEMP", "TMP", "LANG", "LC_ALL"] {
        if let Some(v) = std::env::var_os(name) {
            command.env(name, v);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().map_err(|_| "worker_start")?;
    let mut stdin = child.stdin.take().ok_or("worker_io")?;
    let stdout = child.stdout.take().ok_or("worker_io")?;
    let stderr = child.stderr.take().ok_or("worker_io")?;
    let (tx, rx) = mpsc::channel();
    let a = tx.clone();
    let b = tx.clone();
    let writer = thread::spawn(move || {
        let result = stdin.write_all(&payload).map_err(|_| "worker_io");
        drop(stdin);
        let _ = a.send(Event::Written(result));
    });
    let output = thread::spawn(move || {
        let _ = b.send(Event::Stdout(read_bounded(stdout, OUTPUT_LIMIT)));
    });
    let errors = thread::spawn(move || {
        let result = read_bounded(stderr, STDERR_LIMIT).map(|_| ());
        let _ = tx.send(Event::Stderr(result));
    });
    let start = Instant::now();
    let mut out = None;
    let mut ended = 0;
    let mut status = None;
    let result = (|| loop {
        if cancel.load(Ordering::SeqCst) {
            return Err("cancelled");
        }
        if start.elapsed() >= timeout {
            return Err("worker_timeout");
        }
        if let Some(s) = child.try_wait().map_err(|_| "worker_io")? {
            status = Some(s);
        }
        match rx.recv_timeout(Duration::from_millis(10)) {
            Ok(Event::Stdout(r)) => {
                out = Some(r?);
                ended += 1
            }
            Ok(Event::Stderr(r)) => {
                r?;
                ended += 1
            }
            Ok(Event::Written(r)) => {
                r?;
                ended += 1
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) if ended == 3 => {}
            Err(_) => return Err("worker_io"),
        }
        if ended == 3 {
            if let Some(s) = status {
                if !s.success() {
                    return Err("worker_failed");
                }
                return parse_response(out.as_deref().ok_or("invalid_response")?, input);
            }
        }
    })();
    if status.is_none() {
        let _ = child.kill();
    }
    let _ = child.wait();
    // The fixed worker never spawns subprocesses. Do not let an unexpected inherited
    // pipe extend the caller's timeout; completed reader threads can be joined.
    for worker in [writer, output, errors] {
        if worker.is_finished() {
            let _ = worker.join();
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn request_allowlist() {
        assert!(validate_request(&json!({"id":"한글","op":"capabilities"})).is_ok());
        for bad in [
            json!({"id":"x","op":"exec","command":"x"}),
            json!({"id":"x","op":"capabilities","path":"x"}),
            json!({"id":"x","op":"generate","template":{},"markdown":""}),
            json!({"id":"x","op":"render","hwpxBase64":"","argv":[]}),
        ] {
            assert!(validate_request(&bad).is_err());
        }
    }
    #[test]
    fn long_markdown_roundtrips_without_content_cap() {
        let markdown = "한글 원문\n".repeat(50_000) + "END";
        let input = json!({"id":"long","op":"generate","template":{},"markdown":markdown});
        let bytes = validate_request(&input).unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), input);
    }
    #[test]
    fn hashes_and_zip_header() {
        let b = b"PK\x03\x04owned";
        assert_eq!(
            decode_verified(&STANDARD.encode(b), &hex_sha(b)).unwrap(),
            b
        );
        assert!(decode_verified(&STANDARD.encode(b), &"0".repeat(64)).is_err());
        assert!(decode_verified("!!!!", &hex_sha(b)).is_err());
        assert!(decode_verified(&STANDARD.encode(b"plain"), &hex_sha(b"plain")).is_err());
    }
    #[test]
    fn responses_are_bound_and_sanitized() {
        let q = json!({"id":"x","op":"capabilities"});
        let e = parse_response(
            b"{\"id\":\"x\",\"ok\":false,\"error\":{\"message\":\"PRIVATE_DOCUMENT_SECRET\"}}\n",
            &q,
        )
        .unwrap();
        assert!(!e.to_string().contains("SECRET"));
        assert!(parse_response(b"{}\n{}\n", &q).is_err());
        assert!(parse_response(b"{\"id\":\"y\"}\n", &q).is_err());
        assert!(parse_response(b"\xff\n", &q).is_err());
    }
    #[test]
    fn bounded_reader() {
        assert_eq!(read_bounded(&b"abc"[..], 3).unwrap(), b"abc");
        assert!(read_bounded(&b"abcd"[..], 3).is_err());
    }
}
