//! Kordoc engine requests from the desktop side and the two-phase window-owned generated-document handoff.
//! Document windows run the engine in their own WebView worker; the Node worker below remains only as the fallback
//! of this test build, used when a WebView worker cannot start.
use crate::{
    kordoc_process::{self as worker, Runtime},
    state::AppState,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, State, WebviewWindow};
#[derive(Default)]
pub struct KordocState(Arc<Mutex<Inner>>);
#[derive(Default)]
struct Inner {
    active: Option<Active>,
    artifacts: HashMap<String, Artifact>,
}
struct Active {
    owner: String,
    cancel: Arc<AtomicBool>,
}
struct Artifact {
    owner: String,
    path: PathBuf,
    sha256: String,
    bytes: usize,
    created: Instant,
    display_name: String,
}

/// Generated documents open as untitled documents named after their template or form; the temporary
/// file path is only how the new window receives the bytes. Path → display name, taken once on open.
static GENERATED_NAMES: std::sync::OnceLock<Mutex<std::collections::HashMap<PathBuf, String>>> =
    std::sync::OnceLock::new();

pub(crate) fn take_generated_name(path: &std::path::Path) -> Option<String> {
    GENERATED_NAMES.get()?.lock().ok()?.remove(path)
}

pub(crate) fn remember_generated_name(path: &std::path::Path, name: &str) {
    if let Ok(mut names) = GENERATED_NAMES.get_or_init(Default::default).lock() {
        names.insert(path.to_path_buf(), name.to_owned());
    }
}

/// A file-name-safe, readable title: no path or reserved characters, at most 60 characters.
pub(crate) fn generated_display_name(raw: Option<&str>) -> String {
    let cleaned: String = raw
        .unwrap_or_default()
        .chars()
        .map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let cleaned: String = cleaned.trim_matches('.').chars().take(60).collect();
    if cleaned.trim().is_empty() { "생성 문서".to_owned() } else { cleaned.trim().to_owned() }
}
struct Lease {
    state: Arc<Mutex<Inner>>,
    cancel: Arc<AtomicBool>,
}
impl Drop for Lease {
    fn drop(&mut self) {
        if let Ok(mut s) = self.state.lock() {
            if s.active
                .as_ref()
                .is_some_and(|a| Arc::ptr_eq(&a.cancel, &self.cancel))
            {
                s.active = None;
            }
        }
    }
}
fn prune(s: &mut Inner) {
    s.artifacts
        .retain(|_, a| a.created.elapsed() < Duration::from_secs(600));
}
fn begin(state: &KordocState, owner: &str) -> Result<Lease, String> {
    let mut s = state.0.lock().map_err(|_| message("worker_io"))?;
    prune(&mut s);
    if s.active.is_some() {
        return Err("다른 문서 생성 작업이 진행 중입니다. 완료 후 다시 시도하세요.".into());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    s.active = Some(Active {
        owner: owner.into(),
        cancel: cancel.clone(),
    });
    Ok(Lease {
        state: state.0.clone(),
        cancel,
    })
}
pub fn close(state: &KordocState, label: &str) {
    if let Ok(mut s) = state.0.lock() {
        if let Some(a) = s.active.as_ref().filter(|a| a.owner == label) {
            a.cancel.store(true, Ordering::SeqCst);
        }
        s.artifacts.retain(|_, a| a.owner != label);
    }
}
/// A long document with its page previews takes longer than a short one; this only stops a stuck worker.
const WORKER_TIMEOUT: Duration = Duration::from_secs(300);
fn message(code: &str) -> String {
    match code {
        "runtime_missing" => "문서 생성 런타임을 찾지 못했습니다. 앱 설치 구성을 확인하세요.",
        "worker_unavailable" => "앱에 들어 있는 문서 엔진을 시작하지 못했습니다. 앱 설치 구성을 확인하세요.",
        "quitting" => "앱을 종료하는 중이라 문서를 만들지 않았습니다.",
        "cancelled" => "문서창이 닫혀 생성 작업을 취소했습니다.",
        "worker_timeout" => "문서 생성이 5분 안에 끝나지 않아 멈췄습니다. 다시 시도하거나 문서를 나눠 만드세요.",
        "input_limit" | "response_limit" => "문서 요청 또는 결과가 처리 크기 제한을 넘었습니다.",
        "invalid_document" | "document_hash_mismatch" => {
            "생성 문서의 형식 또는 무결성을 확인하지 못했습니다."
        }
        "invalid_request" | "unsupported_operation" => "문서 생성 요청 형식이 올바르지 않습니다.",
        "save_failed" => "생성 문서를 앱 전용 폴더에 저장하지 못했습니다.",
        _ => "문서 생성 엔진의 응답을 확인하지 못했습니다. 요청을 다시 확인하세요.",
    }
    .into()
}
fn runtime_in(root: &Path) -> Option<Runtime> {
    let node = root
        .join("runtime")
        .join(if cfg!(windows) { "node.exe" } else { "node" })
        .canonicalize()
        .ok()?;
    let worker = root.join("kordoc-engine/worker.mjs").canonicalize().ok()?;
    (node.is_file() && worker.is_file()).then_some(Runtime { node, worker })
}
fn runtime(app: &AppHandle) -> Result<Runtime, String> {
    if let Ok(path) = app.path().resource_dir() {
        if let Some(r) = runtime_in(&path) {
            return Ok(r);
        }
    }
    if let Some(path) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
    {
        if let Some(r) = runtime_in(&path) {
            return Ok(r);
        }
    }
    #[cfg(debug_assertions)]
    {
        if let Some(node) = std::env::var_os("HOP_KORDOC_NODE")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
        {
            let source =
                Path::new(env!("CARGO_MANIFEST_DIR")).join("../../kordoc-engine/worker.mjs");
            if let (Ok(node), Ok(worker)) = (node.canonicalize(), source.canonicalize()) {
                if node.is_file()
                    && worker.is_file()
                    && node
                        .file_name()
                        .is_some_and(|n| n == "node.exe" || n == "node")
                {
                    return Ok(Runtime { node, worker });
                }
            }
        }
    }
    Err(message("runtime_missing"))
}
#[tauri::command]
pub async fn achmage_kordoc(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, KordocState>,
    input: Value,
) -> Result<Value, String> {
    worker::validate_request(&input).map_err(message)?;
    let runtime = runtime(&app)?;
    let lease = begin(&state, window.label())?;
    tauri::async_runtime::spawn_blocking(move || {
        let result =
            worker::run(&runtime, &input, &lease.cancel, WORKER_TIMEOUT).map_err(message);
        if lease.cancel.load(Ordering::SeqCst) {
            return Err(message("cancelled"));
        }
        result
    })
    .await
    .map_err(|_| message("worker_io"))?
}
/// Makes an HWPX for the Telegram gateway, which may run with no window: the engine window
/// (`kordoc_host`) runs the same WebView worker as the document windows, with the same request
/// checks and time limit, one remote job at a time. If that worker cannot start, this test build
/// falls back to the installed Node runtime; a Node job of a window in progress is waited for (up
/// to two minutes) rather than throwing away the document the model just wrote. Returns the
/// verified bytes, page count and engine warnings.
pub(crate) async fn generate_for_remote(
    app: &AppHandle,
    template: &Value,
    markdown: &str,
) -> Result<(Vec<u8>, usize, Vec<String>), String> {
    let input = json!({
        "id": uuid::Uuid::new_v4().simple().to_string(),
        "op": "generate",
        "template": template,
        "markdown": markdown,
    });
    worker::validate_request(&input).map_err(message)?;
    let waited = Instant::now();
    let lease = loop {
        match begin(&app.state::<KordocState>(), "telegram") {
            Ok(lease) => break lease,
            Err(error) if waited.elapsed() >= Duration::from_secs(120) => return Err(error),
            Err(_) => tokio::time::sleep(Duration::from_secs(1)).await,
        }
    };
    let reply = match crate::kordoc_host::request(app, input.clone(), WORKER_TIMEOUT).await {
        Err(code) if code == "worker_unavailable" => {
            let runtime = runtime(app)?;
            tauri::async_runtime::spawn_blocking(move || {
                worker::run(&runtime, &input, &lease.cancel, WORKER_TIMEOUT).map_err(message)
            })
            .await
            .map_err(|_| message("worker_io"))??
        }
        // The engine window checked the answer already; the desktop side checks it again as it would a Node line.
        reply => {
            let mut line = serde_json::to_vec(&reply.map_err(|code| message(&code))?)
                .map_err(|_| message("invalid_response"))?;
            line.push(b'\n');
            worker::parse_response(&line, &input).map_err(message)?
        }
    };
    if reply["ok"] != true {
        return Err(reply["error"]["message"]
            .as_str()
            .unwrap_or("문서 생성에 실패했습니다.")
            .to_owned());
    }
    let result = &reply["result"];
    let bytes = worker::decode_verified(
        result["hwpxBase64"].as_str().unwrap_or_default(),
        result["sha256"].as_str().unwrap_or_default(),
    )
    .map_err(message)?;
    let pages = result["pages"].as_array().map_or(0, Vec::len);
    let warnings = result["warnings"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                // Notes about the on-screen preview do not apply to a file sent to a phone.
                .filter(|warning| !warning.starts_with("미리보기"))
                .take(10)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    Ok((bytes, pages, warnings))
}
fn store_artifact(state: &KordocState, artifact: Artifact) -> Result<String, String> {
    let mut s = state.0.lock().map_err(|_| message("worker_io"))?;
    prune(&mut s);
    if s.active
        .as_ref()
        .is_some_and(|a| a.owner == artifact.owner && a.cancel.load(Ordering::SeqCst))
    {
        return Err(message("cancelled"));
    }
    if s.artifacts
        .values()
        .filter(|a| a.owner == artifact.owner)
        .count()
        >= 4
    {
        return Err(
            "이 창에 준비된 문서가 많습니다. 기존 문서를 열거나 잠시 후 다시 시도하세요.".into(),
        );
    }
    let id = uuid::Uuid::new_v4().simple().to_string();
    s.artifacts.insert(id.clone(), artifact);
    Ok(id)
}
fn take_artifact(state: &KordocState, owner: &str, id: &str) -> Result<Artifact, String> {
    let mut s = state.0.lock().map_err(|_| message("worker_io"))?;
    prune(&mut s);
    if id.len() != 32 || s.artifacts.get(id).is_none_or(|a| a.owner != owner) {
        return Err("이 문서창의 준비된 결과가 아니거나 유효 시간이 지났습니다.".into());
    }
    s.artifacts
        .remove(id)
        .ok_or_else(|| message("invalid_request"))
}
#[tauri::command]
pub async fn achmage_kordoc_prepare_generated(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, KordocState>,
    hwpx_base64: String,
    sha256: String,
    display_name: Option<String>,
) -> Result<Value, String> {
    let display_name = generated_display_name(display_name.as_deref());
    let bytes = worker::decode_verified(&hwpx_base64, &sha256).map_err(message)?;
    let owner = window.label().to_owned();
    {
        let mut s = state.0.lock().map_err(|_| message("worker_io"))?;
        prune(&mut s);
        if s.artifacts.values().filter(|a| a.owner == owner).count() >= 4 {
            return Err("이 창에 준비된 문서가 많습니다. 먼저 결과를 열어 주세요.".into());
        }
    }
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(|_| message("save_failed"))?
        .join("generated-documents");
    prune_generated(&directory, Duration::from_secs(24 * 60 * 60));
    // The engine already validated the document in the window that generated it; here it must open in the editor,
    // parsed and made editable by the same document core the new window will use.
    let (path, byte_len) = tauri::async_runtime::spawn_blocking(move || {
        crate::state::editable_core_from_bytes(&bytes, "invalid_document", "invalid_document")
            .map_err(|_| message("invalid_document"))?;
        let path = worker::write_generated(
            &directory,
            &uuid::Uuid::new_v4().simple().to_string(),
            &bytes,
        )
        .map_err(message)?;
        Ok::<_, String>((path, bytes.len()))
    })
    .await
    .map_err(|_| message("worker_io"))??;
    if app.get_webview_window(&owner).is_none() {
        return Err(message("cancelled"));
    }
    let id = store_artifact(
        &state,
        Artifact {
            owner,
            path,
            sha256: sha256.clone(),
            bytes: byte_len,
            created: Instant::now(),
            display_name,
        },
    )?;
    Ok(json!({"artifactId":id,"sha256":sha256,"bytes":byte_len}))
}
#[tauri::command]
pub async fn achmage_kordoc_open_generated(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, KordocState>,
    artifact_id: String,
) -> Result<Value, String> {
    // No long-running engine work here. The frontend rechecks document/account ownership
    // after prepare completes, immediately before invoking this one-shot window token.
    let a = take_artifact(&state, window.label(), &artifact_id)?;
    if app.get_webview_window(window.label()).is_none() {
        return Err(message("cancelled"));
    }
    let label = crate::windows::new_editor_window_label();
    let path = a
        .path
        .to_str()
        .ok_or_else(|| message("save_failed"))?
        .to_owned();
    remember_generated_name(&a.path, &a.display_name);
    app.state::<AppState>()
        .pending_open_paths
        .queue_for_window(&label, [path]);
    if crate::windows::create_editor_window_with_label(&app, &label).is_err() {
        app.state::<AppState>()
            .pending_open_paths
            .discard_for_window(&label);
        return Err("생성 문서는 보존했지만 새 문서창을 열지 못했습니다.".into());
    }
    Ok(json!({"opened":true,"windowLabel":label,"sha256":a.sha256,"bytes":a.bytes}))
}
#[cfg(test)]
mod tests {
    use super::*;
    fn artifact(owner: &str) -> Artifact {
        Artifact {
            owner: owner.into(),
            path: PathBuf::from("owned.hwpx"),
            sha256: "0".repeat(64),
            bytes: 4,
            created: Instant::now(),
            display_name: "생성 문서".into(),
        }
    }
    #[test]
    fn display_names_are_readable_and_file_safe() {
        assert_eq!(generated_display_name(Some("구매 신청서 (공용 초안)")), "구매 신청서 (공용 초안)");
        assert_eq!(generated_display_name(Some(" a/b\\c:d*e?\n ")), "a b c d e");
        assert_eq!(generated_display_name(Some("...")), "생성 문서");
        assert_eq!(generated_display_name(None), "생성 문서");
        assert_eq!(generated_display_name(Some(&"가".repeat(90))).chars().count(), 60);
    }
    #[test]
    fn window_owned_cancellation_and_busy() {
        let s = KordocState::default();
        let a = begin(&s, "one").unwrap();
        assert!(begin(&s, "two").is_err());
        close(&s, "two");
        assert!(!a.cancel.load(Ordering::SeqCst));
        close(&s, "one");
        assert!(a.cancel.load(Ordering::SeqCst));
        assert!(store_artifact(&s, artifact("one")).is_err());
        drop(a);
        assert!(begin(&s, "two").is_ok());
    }
    #[test]
    fn token_owner_once_and_close() {
        let s = KordocState::default();
        let id = store_artifact(&s, artifact("one")).unwrap();
        assert!(take_artifact(&s, "two", &id).is_err());
        assert!(take_artifact(&s, "one", &id).is_ok());
        assert!(take_artifact(&s, "one", &id).is_err());
        let id = store_artifact(&s, artifact("one")).unwrap();
        close(&s, "one");
        assert!(take_artifact(&s, "one", &id).is_err());
    }
    #[test]
    fn artifact_cap_and_ttl() {
        let s = KordocState::default();
        for _ in 0..4 {
            store_artifact(&s, artifact("one")).unwrap();
        }
        assert!(store_artifact(&s, artifact("one")).is_err());
        let mut old = artifact("two");
        old.created = Instant::now() - Duration::from_secs(601);
        let id = store_artifact(&s, old).unwrap();
        assert!(take_artifact(&s, "two", &id).is_err());
        assert!(store_artifact(&s, artifact("two")).is_ok());
    }
}

/// Removes generated `<uuid>.hwpx` files older than `age`. They were opened long ago (a window reads its
/// file when it opens) and may contain profile values; nothing else in the folder is touched.
fn prune_generated(directory: &std::path::Path, age: Duration) {
    let Ok(entries) = std::fs::read_dir(directory) else { return };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let path = entry.path();
        let generated_name = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .is_some_and(|stem| stem.len() == 32 && stem.bytes().all(|b| b.is_ascii_hexdigit()));
        let is_hwpx = path.extension().and_then(|e| e.to_str()) == Some("hwpx");
        let old = entry
            .metadata()
            .ok()
            .filter(|m| m.is_file())
            .and_then(|m| m.modified().ok())
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|elapsed| elapsed > age);
        if generated_name && is_hwpx && old {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod prune_tests {
    use super::*;
    #[test]
    fn only_old_generated_files_are_removed() {
        let dir = std::env::temp_dir().join(format!("hop-prune-generated-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let old = dir.join("0123456789abcdef0123456789abcdef.hwpx");
        let mine = dir.join("내 문서.hwpx");
        for path in [&old, &mine] {
            let file = std::fs::File::create(path).unwrap();
            file.set_modified(std::time::SystemTime::now() - Duration::from_secs(3 * 24 * 60 * 60)).unwrap();
        }
        let fresh = dir.join("fedcba9876543210fedcba9876543210.hwpx");
        std::fs::File::create(&fresh).unwrap();
        prune_generated(&dir, Duration::from_secs(24 * 60 * 60));
        assert!(!old.exists());
        assert!(mine.exists());
        assert!(fresh.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
