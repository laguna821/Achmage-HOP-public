//! Explicit pinned executable registration, without a shell or package installation.
use crate::{http::MAX_BODY, mcp::rpc_result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{io::Read, path::PathBuf, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, ChildStdin, ChildStdout, Command},
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Registration {
    pub executable: PathBuf,
    pub sha256: String,
    pub argv: Vec<String>,
}
impl Registration {
    pub fn validate(&self) -> Result<(), String> {
        if !self.executable.is_absolute()
            || self.sha256.len() != 64
            || !self.sha256.bytes().all(|b| b.is_ascii_hexdigit())
            || self.argv.len() > 64
            || self.argv.iter().any(|a| a.len() > 8192 || a.contains('\0'))
            || self.argv.iter().map(String::len).sum::<usize>() > 65536
        {
            return Err("Invalid explicit executable registration".into());
        }
        let canonical = self
            .executable
            .canonicalize()
            .map_err(|_| "MCP executable unavailable")?;
        let stem = canonical
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if [
            "cmd",
            "powershell",
            "pwsh",
            "sh",
            "bash",
            "zsh",
            "wscript",
            "cscript",
        ]
        .contains(&stem.as_str())
        {
            return Err("Shell command interpreters are not MCP executable registrations".into());
        }
        #[cfg(windows)]
        if canonical
            .extension()
            .and_then(|s| s.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref()
            != Some("exe")
        {
            return Err("Windows MCP executable must be an .exe".into());
        }
        let mut file = std::fs::File::open(canonical).map_err(|_| "MCP executable unreadable")?;
        if !file
            .metadata()
            .map_err(|_| "MCP executable metadata unavailable")?
            .is_file()
        {
            return Err("MCP executable is not a regular file".into());
        }
        let mut hash = Sha256::new();
        let mut bytes = [0; 65536];
        loop {
            let n = file
                .read(&mut bytes)
                .map_err(|_| "MCP executable hash failed")?;
            if n == 0 {
                break;
            }
            hash.update(&bytes[..n]);
        }
        if format!("{:x}", hash.finalize()) != self.sha256.to_ascii_lowercase() {
            return Err(
                "MCP executable SHA-256 changed; register the intended version again".into(),
            );
        }
        Ok(())
    }
}
pub struct StdioSession {
    child: Child,
    input: ChildStdin,
    output: ChildStdout,
    buffer: Vec<u8>,
    next: u64,
}
impl StdioSession {
    pub async fn connect(
        registration: &Registration,
        cancel: &CancellationToken,
    ) -> Result<Self, String> {
        registration.validate()?;
        if cancel.is_cancelled() {
            return Err("Cancelled before MCP process launch".into());
        }
        let mut command = Command::new(
            registration
                .executable
                .canonicalize()
                .map_err(|_| "MCP executable unavailable")?,
        );
        command
            .args(&registration.argv)
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        // Intentionally exclude inherited API keys, tokens and arbitrary environment variables.
        for key in [
            "SYSTEMROOT",
            "WINDIR",
            "PATH",
            "TEMP",
            "TMP",
            "HOME",
            "USERPROFILE",
        ] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command
            .spawn()
            .map_err(|_| "MCP registered executable failed to start")?;
        let input = child.stdin.take().ok_or("MCP stdin unavailable")?;
        let output = child.stdout.take().ok_or("MCP stdout unavailable")?;
        let mut s = Self {
            child,
            input,
            output,
            buffer: Vec::new(),
            next: 0,
        };
        let init=s.request("initialize",json!({"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"Achmage-HOP","version":"0.1.0"}}),cancel).await?;
        if !["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]
            .contains(&init["protocolVersion"].as_str().unwrap_or(""))
        {
            return Err("MCP stdio protocol version unsupported".into());
        }
        s.write(json!({"jsonrpc":"2.0","method":"notifications/initialized"}))
            .await?;
        Ok(s)
    }
    async fn write(&mut self, value: Value) -> Result<(), String> {
        let mut bytes =
            serde_json::to_vec(&value).map_err(|_| "MCP request serialization failed")?;
        bytes.push(b'\n');
        self.input
            .write_all(&bytes)
            .await
            .map_err(|_| "MCP stdin closed; outcome unknown".to_string())
    }
    pub async fn request(
        &mut self,
        method: &str,
        params: Value,
        cancel: &CancellationToken,
    ) -> Result<Value, String> {
        self.next = self
            .next
            .checked_add(1)
            .ok_or("MCP request counter exhausted")?;
        let id = self.next;
        let outcome=tokio::time::timeout(Duration::from_secs(25),async {
            tokio::select!{_=cancel.cancelled()=>return Err("MCP cancelled locally; process outcome unknown".into()),r=self.write(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))=>r?};
            let mut total=0usize;
            loop {
                if let Some(end)=self.buffer.iter().position(|b|*b==b'\n'){
                    let line:Vec<_>=self.buffer.drain(..=end).collect();total+=line.len();if total>MAX_BODY{return Err("MCP stdout exceeds 4 MiB".into());}
                    let v:Value=serde_json::from_slice(&line).map_err(|_|"MCP stdout contains invalid JSON/UTF-8")?;
                    if v.get("method").is_some(){if v.get("id").is_some(){return Err("Server-initiated MCP requests unsupported".into());}continue;}
                    if v["id"]!=id{return Err("MCP stdio response ID mismatch".into());}return rpc_result(v);
                }
                let mut chunk=[0;8192];let n=tokio::select!{_=cancel.cancelled()=>return Err("MCP cancelled locally; process outcome unknown".into()),r=self.output.read(&mut chunk)=>r.map_err(|_|"MCP stdout failed; outcome unknown")?};
                if n==0{return Err("MCP process exited without matching response".into());}self.buffer.extend_from_slice(&chunk[..n]);if self.buffer.len()+total>MAX_BODY{return Err("MCP stdout exceeds 4 MiB".into());}
            }
        }).await.map_err(|_|"MCP timed out; outcome unknown".to_string()).and_then(|r|r);
        if outcome.is_err() {
            let _ = self.child.kill().await;
        }
        outcome
    }
    pub async fn close(mut self) -> Result<(), String> {
        let _ = self.input.shutdown().await;
        if tokio::time::timeout(Duration::from_secs(2), self.child.wait())
            .await
            .is_err()
        {
            self.child
                .kill()
                .await
                .map_err(|_| "MCP owned process cleanup unconfirmed")?;
            let _ = self.child.wait().await;
        }
        Ok(())
    }
}
