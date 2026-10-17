//! Hidden WebView window that runs the Kordoc engine for the desktop side when no document window is involved: the
//! Telegram gateway, which may run with no window at all. The engine is the same WebView worker every document window
//! runs (kordoc/engine-worker.js); this window (kordoc-host.html) only carries one job to it and the answer back. Each
//! job gets a new window, destroyed when the job ends, and a generation number: a window that is still closing, or its
//! page's request still waiting, can never take or answer the next job. It is not a document window: window lists,
//! quitting and Telegram skip it.
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::{oneshot, Notify};

pub const HOST_LABEL: &str = "kordoc-host";
/// The window, its page and the worker must be running by then; otherwise the engine cannot start here.
const PICKUP_TIMEOUT: Duration = Duration::from_secs(30);
/// How long one `achmage_kordoc_host_next` call waits before the page asks again.
const POLL: Duration = Duration::from_secs(20);
/// How long a destroyed window may take to leave the window list.
const GONE_TIMEOUT: Duration = Duration::from_secs(5);

type Answer = Result<Value, String>;

struct Job {
    id: String,
    input: Option<Value>,
    picked: Option<oneshot::Sender<()>>,
    answer: Option<oneshot::Sender<Answer>>,
}

#[derive(Default)]
struct Slot {
    generation: u64,
    job: Option<Job>,
}

enum Taken {
    /// The asking page belongs to an earlier window.
    Stale,
    Nothing,
    Job(String, Value),
}

#[derive(Default)]
pub struct KordocHost {
    slot: Mutex<Slot>,
    changed: Notify,
    /// The last window to close was the engine window: HOP had no document window before it either.
    engine_closed_last: AtomicBool,
    /// The engine window was closed because the last document window closed and HOP is not staying in the tray.
    exit_with_engine: AtomicBool,
}

impl KordocHost {
    fn slot(&self) -> std::sync::MutexGuard<'_, Slot> {
        self.slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// A new generation with its one job; returns the generation and the job's pickup and answer.
    fn post(&self, id: String, input: Value) -> (u64, oneshot::Receiver<()>, oneshot::Receiver<Answer>) {
        let (picked, was_picked) = oneshot::channel();
        let (answer, answered) = oneshot::channel();
        let generation = {
            let mut slot = self.slot();
            slot.generation += 1;
            slot.job = Some(Job {
                id,
                input: Some(input),
                picked: Some(picked),
                answer: Some(answer),
            });
            slot.generation
        };
        self.changed.notify_waiters();
        (generation, was_picked, answered)
    }

    /// The job of this generation, handed out once.
    fn take(&self, generation: u64) -> Taken {
        let mut slot = self.slot();
        if slot.generation != generation {
            return Taken::Stale;
        }
        match slot.job.as_mut() {
            Some(job) if job.input.is_some() => {
                if let Some(picked) = job.picked.take() {
                    let _ = picked.send(());
                }
                Taken::Job(job.id.clone(), job.input.take().unwrap_or_default())
            }
            _ => Taken::Nothing,
        }
    }

    fn answer(&self, generation: u64, id: &str, answer: Answer) -> bool {
        let mut slot = self.slot();
        if slot.generation != generation {
            return false;
        }
        match slot.job.as_mut().filter(|job| job.id == id).and_then(|job| job.answer.take()) {
            Some(sender) => {
                let _ = sender.send(answer);
                true
            }
            None => false,
        }
    }

    fn note_closed(&self, engine_window: bool) {
        self.engine_closed_last.store(engine_window, Ordering::SeqCst);
    }

    fn stays_after_close(&self) -> bool {
        !self.exit_with_engine.swap(false, Ordering::SeqCst) && self.engine_closed_last.load(Ordering::SeqCst)
    }

    fn clear(&self, generation: u64) {
        let mut slot = self.slot();
        if slot.generation == generation {
            slot.job = None;
        }
    }
}

/// Whether a window is a document window (anything but the engine window).
pub fn is_document_window(label: &str) -> bool {
    label != HOST_LABEL
}

/// Window lifecycle: called for every destroyed window.
pub(crate) fn window_destroyed(app: &AppHandle, label: &str) {
    let host = app.state::<KordocHost>();
    host.note_closed(!is_document_window(label));
    if !is_document_window(label) {
        return;
    }
    // The last document window closed during a Telegram job and HOP will not stay in the tray: the job ends with
    // the app, as it did with the Node runtime, instead of keeping a windowless process alive until it finishes.
    let others = crate::windows::document_windows(app).keys().any(|other| other != label);
    if let Some(engine) = app.get_webview_window(HOST_LABEL) {
        if !others && !crate::achmage_telegram::keep_running_on_exit(app, false) {
            host.exit_with_engine.store(true, Ordering::SeqCst);
            let _ = engine.destroy();
        }
    }
}

/// `ExitRequested` hook: true when the engine window was the last window and HOP was windowless before it (in the
/// tray), so closing it must not end the process.
pub(crate) fn stay_after_engine_window(app: &AppHandle) -> bool {
    app.state::<KordocHost>().stays_after_close()
}

fn open(app: &AppHandle, generation: u64) -> Result<(), String> {
    WebviewWindowBuilder::new(app, HOST_LABEL, WebviewUrl::App("kordoc-host.html".into()))
        .initialization_script(format!("window.__ACHMAGE_KORDOC_HOST_GENERATION__={generation};"))
        .title("Achmage HOP 문서 엔진")
        .visible(false)
        .focused(false)
        .skip_taskbar(true)
        // A hidden window's page would otherwise be throttled or suspended (macOS 14+; ignored elsewhere).
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .build()
        .map(|_| ())
        .map_err(|_| "worker_unavailable".to_owned())
}

/// Destroys the engine window, if there is one, and waits until it has left the window list.
async fn close(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(HOST_LABEL) {
        let _ = window.destroy();
    }
    let deadline = tokio::time::Instant::now() + GONE_TIMEOUT;
    while app.get_webview_window(HOST_LABEL).is_some() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Clears the job and destroys the window when a request ends in any way, including being dropped.
struct Finish<'a> {
    app: &'a AppHandle,
    generation: u64,
}

impl Drop for Finish<'_> {
    fn drop(&mut self) {
        self.app.state::<KordocHost>().clear(self.generation);
        if let Some(window) = self.app.get_webview_window(HOST_LABEL) {
            let _ = window.destroy();
        }
    }
}

/// Waits for `receiver` up to `limit`, giving up early if the engine window disappears (closed or destroyed by a quit).
async fn wait<T>(app: &AppHandle, mut receiver: oneshot::Receiver<T>, limit: Duration) -> Result<Option<T>, ()> {
    let deadline = tokio::time::Instant::now() + limit;
    loop {
        match tokio::time::timeout(Duration::from_secs(1), &mut receiver).await {
            Ok(Ok(value)) => return Ok(Some(value)),
            Ok(Err(_)) => return Err(()),
            Err(_) if app.get_webview_window(HOST_LABEL).is_none() => return Err(()),
            Err(_) if tokio::time::Instant::now() >= deadline => return Ok(None),
            Err(_) => {}
        }
    }
}

/// Runs one engine request in a new engine window and returns the response the window checked, or a failure code
/// (`worker_unavailable` when the window, its page or its worker did not start). Callers run one request at a time.
pub(crate) async fn request(app: &AppHandle, input: Value, limit: Duration) -> Result<Value, String> {
    if crate::achmage_telegram::quitting(app) {
        return Err("quitting".into());
    }
    close(app).await;
    let host = app.state::<KordocHost>();
    let (generation, picked, answered) = host.post(uuid::Uuid::new_v4().simple().to_string(), input);
    let _finish = Finish { app, generation };
    open(app, generation)?;
    match wait(app, picked, PICKUP_TIMEOUT).await {
        Ok(Some(())) => {}
        // The window was closed (for example by quitting): not a reason to fall back to the Node runtime.
        Err(()) if app.get_webview_window(HOST_LABEL).is_none() => return Err("worker_io".into()),
        _ => return Err("worker_unavailable".into()),
    }
    let answer = match wait(app, answered, limit).await {
        Ok(Some(answer)) => answer,
        Ok(None) => Err("worker_timeout".into()),
        Err(()) => Err("worker_io".into()),
    };
    close(app).await;
    answer
}

/// The engine window asks for its job; `null` after a quiet wait (the page asks again), an error to a page of an
/// earlier window.
#[tauri::command]
pub async fn achmage_kordoc_host_next(
    window: WebviewWindow,
    host: State<'_, KordocHost>,
    generation: u64,
) -> Result<Option<Value>, String> {
    if window.label() != HOST_LABEL {
        return Err("문서 엔진 창이 아닙니다.".into());
    }
    let deadline = tokio::time::Instant::now() + POLL;
    loop {
        let changed = host.changed.notified();
        let mut changed = std::pin::pin!(changed);
        changed.as_mut().enable();
        match host.take(generation) {
            Taken::Job(id, input) => return Ok(Some(json!({"id": id, "input": input}))),
            Taken::Stale => return Err("이전 문서 엔진 창입니다.".into()),
            Taken::Nothing => {}
        }
        if tokio::time::timeout_at(deadline, changed).await.is_err() {
            return Ok(None);
        }
    }
}

/// The engine window's answer to its job: `{ok:true,response}` or `{ok:false,code}`. Async, so the answer (up to
/// 32 MB with the page previews) is not deserialized on the main thread.
#[tauri::command]
pub async fn achmage_kordoc_host_reply(
    window: WebviewWindow,
    host: State<'_, KordocHost>,
    generation: u64,
    id: String,
    reply: Value,
) -> Result<(), String> {
    if window.label() != HOST_LABEL {
        return Err("문서 엔진 창이 아닙니다.".into());
    }
    if host.answer(generation, &id, answer_of(reply)) {
        Ok(())
    } else {
        Err("요청하지 않은 문서 엔진 응답입니다.".into())
    }
}

fn answer_of(reply: Value) -> Answer {
    if reply["ok"] == true {
        return Ok(reply["response"].clone());
    }
    // Only a short code name crosses back; anything else is a generic failure.
    match reply["code"].as_str() {
        Some(code)
            if !code.is_empty()
                && code.len() <= 40
                && code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_') =>
        {
            Err(code.to_owned())
        }
        _ => Err("worker_io".into()),
    }
}

/// Debug builds only: with `HOP_KORDOC_HOST_SELFTEST=<file>`, runs a capabilities request and a Telegram-style
/// generation through the engine window at startup and writes what came back to that file. The path can then be
/// exercised on a real WebView without a Telegram account.
#[cfg(debug_assertions)]
pub(crate) fn install_selftest(app: &AppHandle) {
    let Some(out) = std::env::var_os("HOP_KORDOC_HOST_SELFTEST").map(std::path::PathBuf::from) else {
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let started = std::time::Instant::now();
        // Whether the engine window ever became visible or focused while the jobs ran.
        let shown = std::sync::Arc::new(AtomicBool::new(false));
        let watching = std::sync::Arc::new(AtomicBool::new(true));
        {
            let (app, shown, watching) = (app.clone(), shown.clone(), watching.clone());
            tauri::async_runtime::spawn(async move {
                while watching.load(Ordering::SeqCst) {
                    if let Some(window) = app.get_webview_window(HOST_LABEL) {
                        if window.is_visible().unwrap_or(false) || window.is_focused().unwrap_or(false) {
                            shown.store(true, Ordering::SeqCst);
                        }
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            });
        }
        let capabilities = request(
            &app,
            json!({"id": "selftest-capabilities", "op": "capabilities"}),
            Duration::from_secs(60),
        )
        .await;
        let after_capabilities = app.get_webview_window(HOST_LABEL).is_some();
        let style = |size: u32, bold: bool, alignment: &str| {
            json!({"fontFamily": "함초롬바탕", "fontSizePt": size, "bold": bold, "spacingPercent": 0, "alignment": alignment, "lineSpacingPercent": 160})
        };
        let template = json!({
            "schemaVersion": 1, "id": "host-selftest", "name": "자체 점검", "category": "general",
            "provenance": "personal", "description": "엔진 창 점검",
            "roles": {"title": style(20, true, "center"), "heading": style(14, true, "left"), "body": style(11, false, "left"),
                "tableHeader": style(12, true, "left"), "tableCell": style(10, false, "left")},
            "layout": {"enginePreset": "report", "cover": false, "toc": false, "sampleMarkdown": "# 시험", "paper": "A4", "orientation": "portrait"},
        });
        let generated = crate::kordoc::generate_for_remote(
            &app,
            &template,
            "# 자체 점검\n\n## 1. 개요\n\n숨김 엔진 창 점검 본문입니다.\n\n|항목|내용|\n|---|---|\n|일정|다음 주|",
        )
        .await;
        tokio::time::sleep(Duration::from_secs(1)).await;
        watching.store(false, Ordering::SeqCst);
        let report = json!({
            "engineWindowEverShown": shown.load(Ordering::SeqCst),
            "capabilities": match &capabilities {
                Ok(v) => json!({"ok": v["ok"], "engine": v["result"]["engine"], "presets": v["result"]["presets"]}),
                Err(code) => json!({"error": code}),
            },
            "generate": match &generated {
                Ok((bytes, pages, warnings)) => json!({"bytes": bytes.len(), "sha256": crate::kordoc_process::hex_sha(bytes), "pages": pages, "warnings": warnings}),
                Err(message) => json!({"error": message}),
            },
            "engineWindowClosedBetweenJobs": !after_capabilities,
            "engineWindowLeftOpen": app.get_webview_window(HOST_LABEL).is_some(),
            "documentWindows": crate::windows::document_windows(&app).len(),
            "ms": started.elapsed().as_millis() as u64,
        });
        let _ = std::fs::write(out, serde_json::to_vec_pretty(&report).unwrap_or_default());
    });
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_engine_window_is_not_a_document_window() {
        assert!(!is_document_window(HOST_LABEL));
        assert!(is_document_window("main"));
        assert!(is_document_window("main0123456789abcdef"));
    }

    #[test]
    fn answers_carry_the_response_or_a_bounded_code() {
        let response = json!({"id": "x", "ok": true, "result": {}});
        assert_eq!(answer_of(json!({"ok": true, "response": response})), Ok(response));
        assert_eq!(
            answer_of(json!({"ok": false, "code": "worker_unavailable"})),
            Err("worker_unavailable".into())
        );
        for code in [json!("C:/private/path"), json!(""), json!(7), json!("a".repeat(41))] {
            assert_eq!(answer_of(json!({"ok": false, "code": code})), Err("worker_io".into()));
        }
        assert_eq!(answer_of(json!({})), Err("worker_io".into()));
    }

    #[test]
    fn a_job_goes_once_to_its_own_generation_and_is_answered_once() {
        let host = KordocHost::default();
        let (first, mut first_picked, _first_answered) = host.post("a".into(), json!(1));
        let (second, mut picked, mut answered) = host.post("b".into(), json!(2));
        assert_eq!(second, first + 1);
        // The page of the earlier window is turned away and cannot answer the new job.
        assert!(matches!(host.take(first), Taken::Stale));
        assert!(first_picked.try_recv().is_err());
        assert!(!host.answer(first, "b", Ok(json!("stale"))));
        assert!(matches!(host.take(second), Taken::Job(ref id, ref input) if id == "b" && *input == json!(2)));
        assert!(picked.try_recv().is_ok());
        assert!(matches!(host.take(second), Taken::Nothing));
        assert!(!host.answer(second, "a", Ok(json!("wrong id"))));
        assert!(host.answer(second, "b", Ok(json!("done"))));
        assert_eq!(answered.try_recv().unwrap(), Ok(json!("done")));
        assert!(!host.answer(second, "b", Ok(json!("twice"))));
        host.clear(second);
        assert!(matches!(host.take(second), Taken::Nothing));
    }

    #[test]
    fn closing_the_engine_window_keeps_a_windowless_hop_as_it_was() {
        let host = KordocHost::default();
        // Tray mode: the job's engine window was the only window.
        host.note_closed(true);
        assert!(host.stays_after_close());
        // The last document window closed: the usual exit rule decides.
        host.note_closed(false);
        assert!(!host.stays_after_close());
        // The engine window was closed because the last document window went: HOP exits, once.
        host.exit_with_engine.store(true, Ordering::SeqCst);
        host.note_closed(true);
        assert!(!host.stays_after_close());
        assert!(host.stays_after_close());
    }

    #[test]
    fn clearing_ends_the_wait_of_an_unanswered_job() {
        let host = KordocHost::default();
        let (generation, _picked, mut answered) = host.post("a".into(), json!(1));
        host.clear(generation - 1);
        assert!(matches!(answered.try_recv(), Err(oneshot::error::TryRecvError::Empty)));
        host.clear(generation);
        assert!(matches!(answered.try_recv(), Err(oneshot::error::TryRecvError::Closed)));
    }
}
