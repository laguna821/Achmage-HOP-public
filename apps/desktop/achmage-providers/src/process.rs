use crate::{Config, Result};
use std::{
    io::{Read, Write},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

pub(crate) fn run(
    cfg: &Config,
    args: &[String],
    input: Option<&[u8]>,
    cancel: &AtomicBool,
    timeout: Duration,
    mut output: impl FnMut(&[u8]) -> Result<()>,
) -> Result<i32> {
    let mut command = Command::new(&cfg.executable);
    command.args(args).current_dir(&cfg.cwd).env_clear();
    // OS runtime only; never forward provider, proxy, debug or credential variables.
    for key in [
        "SystemRoot",
        "WINDIR",
        "PATH",
        "PATHEXT",
        "COMSPEC",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
        "LOCALAPPDATA",
        "APPDATA",
        "LANG",
        "LC_ALL",
        "HOME",
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
    command
        .env("CLAUDE_CONFIG_DIR", &cfg.profile)
        .env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1");
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().map_err(|_| "spawn_failed")?;
    let mut stdin = Some(child.stdin.take().ok_or("stdin_missing")?);
    let mut stdout = child.stdout.take().ok_or("stdout_missing")?;
    let (tx, rx) = mpsc::sync_channel(8);
    let reader = thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        loop {
            match stdout.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    if tx.send(Ok(chunk[..n].to_vec())).is_err() {
                        break;
                    }
                }
                Err(_) => {
                    let _ = tx.send(Err("stdout_failed"));
                    break;
                }
            }
        }
    });
    // A bounded writer thread avoids blocking the cancellation loop on a non-reading child.
    let writer = input.map(|bytes| {
        let bytes = bytes.to_vec();
        let mut pipe = stdin.take().unwrap();
        thread::spawn(move || pipe.write_all(&bytes).map_err(|_| "stdin_failed"))
    });
    // Login keeps stdin open until the child exits; print mode writer closes it after one frame.
    let start = Instant::now();
    let mut total = 0usize;
    let mut eof = false;
    let mut status = None;
    let outcome = loop {
        if cancel.load(Ordering::Acquire) {
            break Err("cancelled");
        }
        if start.elapsed() > timeout {
            break Err("timeout");
        }
        match rx.recv_timeout(Duration::from_millis(10)) {
            Ok(Ok(bytes)) => {
                total += bytes.len();
                // Partial-message deltas each carry a JSON envelope, so total output is many times the text.
                if total > 256 * 1024 * 1024 {
                    break Err("output_limit");
                };
                if let Err(e) = output(&bytes) {
                    break Err(e);
                }
            }
            Ok(Err(e)) => break Err(e),
            Err(mpsc::RecvTimeoutError::Disconnected) => eof = true,
            Err(_) => {}
        }
        match child.try_wait() {
            Ok(Some(s)) => status = Some(s.code().unwrap_or(-1)),
            Ok(None) => {}
            Err(_) => break Err("wait_failed"),
        }
        if eof {
            if let Some(code) = status {
                break Ok(code);
            }
        }
    };
    let _ = child.kill();
    let _ = child.wait();
    drop(rx);
    // Reader/writer may retain a pipe if an external child inherited it. Never block UI cleanup.
    if reader.is_finished() {
        let _ = reader.join();
    }
    if let Some(w) = writer {
        if w.is_finished() {
            if let Ok(Err(e)) = w.join() {
                if outcome.is_ok() {
                    return Err(e);
                }
            }
        }
    }
    outcome
}
