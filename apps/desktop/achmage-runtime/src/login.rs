use crate::Result;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::{
    io::{Read, Write},
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LoginPhase {
    Starting,
    WaitingForOfficialLogin,
    CheckingAccount,
    Stopping,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LoginOutcome {
    Connected,
    Cancelled,
    TimedOut,
    ExitedWithoutConnection,
}
#[derive(Clone, Copy, Debug)]
pub struct LoginOptions {
    pub timeout: Duration,
    pub probe_interval: Duration,
}
impl Default for LoginOptions {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(300),
            probe_interval: Duration::from_secs(3),
        }
    }
}
const MAX_OUTPUT: u64 = 8 * 1024 * 1024;

/// Run only on a host worker thread. `probe` must itself be bounded/cancellable and return true
/// only for verified official CLI account/model evidence. Raw terminal output is never exported.
/// The executable/cwd are trusted host selections, not web/MCP request parameters.
pub fn run_login(
    executable: &Path,
    cwd: &Path,
    cancel: &AtomicBool,
    options: LoginOptions,
    mut on_phase: impl FnMut(LoginPhase),
    mut probe: impl FnMut() -> Result<bool>,
) -> Result<LoginOutcome> {
    if options.timeout.is_zero()
        || options.timeout > Duration::from_secs(600)
        || options.probe_interval < Duration::from_millis(100)
        || options.probe_interval > Duration::from_secs(30)
    {
        return Err("login_options");
    }
    if cancel.load(Ordering::SeqCst) {
        return Ok(LoginOutcome::Cancelled);
    }
    let executable = executable.canonicalize().map_err(|_| "runtime_missing")?;
    let cwd = cwd.canonicalize().map_err(|_| "working_directory")?;
    if !executable.is_file() || !cwd.is_dir() {
        return Err("runtime_path");
    }
    on_phase(LoginPhase::Starting);
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 30,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|_| "pty_unavailable")?;
    let mut command = CommandBuilder::new(executable);
    command.cwd(cwd);
    // Retain OS keyring identity. Remove alternate billing and remote-login mode overrides only.
    for key in [
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE",
        "GOOGLE_GENAI_USE_VERTEXAI",
        "GOOGLE_GENAI_USE_ENTERPRISE",
        "GOOGLE_GEMINI_BASE_URL",
        "GOOGLE_CLOUD_PROJECT",
        "GOOGLE_CLOUD_LOCATION",
        "GCLOUD_PROJECT",
        "SSH_CONNECTION",
        "SSH_CLIENT",
        "SSH_TTY",
    ] {
        command.env_remove(key);
    }
    let mut reader = pair.master.try_clone_reader().map_err(|_| "pty_reader")?;
    let writer = Arc::new(Mutex::new(
        pair.master.take_writer().map_err(|_| "pty_writer")?,
    ));
    let count = Arc::new(AtomicU64::new(0));
    let reader_count = count.clone();
    let reader_writer = writer.clone();
    // ConPTY INHERIT_CURSOR can block spawn until its terminal DSR query receives a response.
    let read_thread = thread::spawn(move || {
        let mut bytes = [0u8; 4096];
        let mut tail = 0u32;
        while let Ok(n) = reader.read(&mut bytes) {
            if n == 0 {
                break;
            }
            reader_count.fetch_add(n as u64, Ordering::Relaxed);
            for b in &bytes[..n] {
                tail = (tail << 8) | u32::from(*b);
                if tail == 0x1b5b366e {
                    if let Ok(mut writer) = reader_writer.lock() {
                        let _ = writer.write_all(b"\x1b[1;1R");
                        let _ = writer.flush();
                    }
                }
            } /* all other secret-bearing PTY bytes discarded */
        }
    });
    let child = pair.slave.spawn_command(command);
    drop(pair.slave);
    let mut child = match child {
        Ok(child) => child,
        Err(_) => {
            drop(writer);
            drop(pair.master);
            let _ = read_thread.join();
            return Err("runtime_start");
        }
    };
    on_phase(LoginPhase::WaitingForOfficialLogin);
    let started = Instant::now();
    let mut last_probe = Instant::now();
    let result = loop {
        if cancel.load(Ordering::SeqCst) {
            break Ok(LoginOutcome::Cancelled);
        }
        if started.elapsed() >= options.timeout {
            break Ok(LoginOutcome::TimedOut);
        }
        if count.load(Ordering::Relaxed) > MAX_OUTPUT {
            break Err("pty_output_limit");
        }
        match child.try_wait() {
            Ok(Some(_)) => break Ok(LoginOutcome::ExitedWithoutConnection),
            Err(_) => break Err("runtime_wait"),
            Ok(None) => {}
        }
        if last_probe.elapsed() >= options.probe_interval {
            on_phase(LoginPhase::CheckingAccount);
            let verified = probe();
            last_probe = Instant::now();
            if cancel.load(Ordering::SeqCst) {
                break Ok(LoginOutcome::Cancelled);
            }
            if started.elapsed() >= options.timeout {
                break Ok(LoginOutcome::TimedOut);
            }
            match verified {
                Ok(true) => break Ok(LoginOutcome::Connected),
                Ok(false) => on_phase(LoginPhase::WaitingForOfficialLogin),
                Err(error) => break Err(error),
            }
        }
        thread::sleep(Duration::from_millis(30));
    };
    on_phase(LoginPhase::Stopping);
    let _ = child.kill();
    let _ = child.wait();
    drop(writer);
    drop(pair.master);
    // The child is settled before joining its private output-drain thread.
    let _ = read_thread.join();
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn precancel_does_not_spawn_or_probe() {
        let mut called = false;
        let result = run_login(
            Path::new("missing"),
            Path::new("missing"),
            &AtomicBool::new(true),
            LoginOptions::default(),
            |_| called = true,
            || panic!("must not probe"),
        );
        assert_eq!(result.unwrap(), LoginOutcome::Cancelled);
        assert!(!called);
    }
    #[test]
    fn invalid_options_and_paths_reject() {
        let c = AtomicBool::new(false);
        let opts = LoginOptions {
            timeout: Duration::ZERO,
            ..Default::default()
        };
        assert_eq!(
            run_login(
                Path::new("x"),
                Path::new("x"),
                &c,
                opts,
                |_| {},
                || Ok(false)
            )
            .unwrap_err(),
            "login_options"
        );
        assert_eq!(
            run_login(
                Path::new("missing-runtime"),
                Path::new("."),
                &c,
                LoginOptions::default(),
                |_| {},
                || Ok(false)
            )
            .unwrap_err(),
            "runtime_missing"
        );
    }
}
