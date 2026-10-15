//! Application-owned official Google runtime installation. No command/path arguments from IPC.
use achmage_runtime::install::{self, Platform};
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{AppHandle, Manager, State};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    generation: u64,
    phase: String,
    version: Option<String>,
    bytes: Option<u64>,
    sha512: Option<String>,
    installed: bool,
    message: String,
}
impl Default for View {
    fn default() -> Self {
        Self {
            generation: 0,
            phase: "idle".into(),
            version: None,
            bytes: None,
            sha512: None,
            installed: false,
            message:
                "공식 Google 런타임을 앱 전용 경로에 설치합니다. 기존 CLI와 PATH는 바꾸지 않습니다."
                    .into(),
        }
    }
}
#[derive(Default)]
struct Inner {
    view: View,
    cancel: Option<Arc<AtomicBool>>,
    executable: Option<PathBuf>,
    initialized: bool,
}
#[derive(Default)]
pub struct RuntimeState(Mutex<Inner>);
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Op {
    State,
    Install,
    Cancel,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    op: Op,
    expected_generation: Option<u64>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Saved {
    folder: String,
    sha512: String,
    version: String,
    bytes: u64,
}
fn root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|_| "설치 경로를 열지 못했습니다.")?
        .join("runtimes/google"))
}
fn load(app: &AppHandle, inner: &mut Inner) {
    if inner.initialized {
        return;
    }
    inner.initialized = true;
    let found = (|| {
        let root = root(app).ok()?;
        let file = root.join("active.json");
        if std::fs::metadata(&file).ok()?.len() > 4096 {
            return None;
        }
        let saved: Saved = serde_json::from_slice(&std::fs::read(file).ok()?).ok()?;
        if saved.folder.is_empty()
            || !saved
                .folder
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b".-_".contains(&b))
            || saved.folder.starts_with('.')
        {
            return None;
        }
        let executable = root
            .join(&saved.folder)
            .join(if cfg!(windows) { "agy.exe" } else { "agy" })
            .canonicalize()
            .ok()?;
        if !executable.starts_with(root.canonicalize().ok()?) {
            return None;
        }
        install::verify_installed(&executable, &saved.sha512).ok()?;
        Some((executable, saved))
    })();
    if let Some((path, saved)) = found {
        inner.executable = Some(path);
        inner.view.installed = true;
        inner.view.phase = "ready".into();
        inner.view.version = Some(saved.version);
        inner.view.sha512 = Some(saved.sha512);
        inner.view.bytes = Some(saved.bytes);
        inner.view.message = "검증된 앱 전용 Google 런타임을 사용할 수 있습니다.".into();
    }
}
/// Native discovery only, never expose this path as a client-controlled command.
pub fn installed_runtime(app: &AppHandle) -> Option<PathBuf> {
    let state = app.state::<RuntimeState>();
    let mut inner = state.0.lock().ok()?;
    load(app, &mut inner);
    inner.executable.clone()
}
fn change(inner: &mut Inner, phase: &str, message: &str) {
    inner.view.generation = inner.view.generation.saturating_add(1);
    inner.view.phase = phase.into();
    inner.view.message = message.into();
}
#[tauri::command]
pub fn achmage_runtime(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    request: Request,
) -> Result<View, String> {
    let mut inner = state
        .0
        .lock()
        .map_err(|_| "런타임 상태를 열지 못했습니다.")?;
    load(&app, &mut inner);
    if matches!(request.op, Op::State) {
        return Ok(inner.view.clone());
    }
    if request.expected_generation != Some(inner.view.generation) {
        return Err("설치 상태가 변경되었습니다. 다시 확인하세요.".into());
    }
    if matches!(request.op, Op::Cancel) {
        if let Some(cancel) = &inner.cancel {
            cancel.store(true, Ordering::SeqCst);
            change(
                &mut inner,
                "cancelling",
                "설치를 취소하고 있습니다. 진행 중인 네트워크 응답이 끝나면 정리됩니다.",
            );
            return Ok(inner.view.clone());
        }
        return Err("진행 중인 설치가 없습니다.".into());
    }
    if inner.cancel.is_some() {
        return Err("진행 중인 설치를 먼저 마치거나 취소하세요.".into());
    }
    if inner.view.generation == u64::MAX {
        return Err("설치 상태 한도에 도달했습니다. 앱을 다시 여세요.".into());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    inner.cancel = Some(cancel.clone());
    change(
        &mut inner,
        "checking",
        "공식 배포 정보를 확인하고 있습니다.",
    );
    let view = inner.view.clone();
    drop(inner);
    std::thread::spawn(move || {
        let outcome = (|| -> Result<install::Installed, &'static str> {
            let platform = Platform::current()?;
            let manifest = install::fetch_manifest(platform)?;
            if cancel.load(Ordering::SeqCst) {
                return Err("cancelled");
            }
            {
                let state = app.state::<RuntimeState>();
                let mut inner = state.0.lock().map_err(|_| "state")?;
                change(
                    &mut inner,
                    "downloading",
                    "공식 실행파일을 받고 SHA-512를 확인하고 있습니다.",
                );
            }
            let root = root(&app).map_err(|_| "directory")?;
            let installed = match install::install(&root, platform, &manifest, &cancel) {
                Err("already_installed") => install::existing(&root, platform, &manifest)?,
                result => result?,
            };
            let folder = installed
                .executable
                .parent()
                .and_then(|p| p.file_name())
                .and_then(|p| p.to_str())
                .ok_or("path")?
                .to_owned();
            let saved = Saved {
                folder,
                sha512: installed.sha512.clone(),
                version: installed.version.clone(),
                bytes: installed.bytes,
            };
            // Only this app-scoped single job writes its small, atomic selection record.
            let mut record = tempfile::NamedTempFile::new_in(&root).map_err(|_| "record")?;
            std::io::Write::write_all(
                &mut record,
                &serde_json::to_vec(&saved).map_err(|_| "record")?,
            )
            .map_err(|_| "record")?;
            record.as_file().sync_all().map_err(|_| "record")?;
            record
                .persist(root.join("active.json"))
                .map_err(|_| "record")?;
            Ok(installed)
        })();
        let state = app.state::<RuntimeState>();
        if let Ok(mut inner) = state.0.lock() {
            inner.cancel = None;
            match outcome{
            Ok(installed)=>{inner.executable=Some(installed.executable);inner.view.installed=true;inner.view.version=Some(installed.version);inner.view.bytes=Some(installed.bytes);inner.view.sha512=Some(installed.sha512);change(&mut inner,"ready","설치가 완료되었습니다. Gemini 연결 버튼에서 계정을 확인하세요.");},
            Err("cancelled")=>change(&mut inner,"cancelled","설치를 취소했습니다. 기존 런타임과 계정은 유지됩니다."),
            Err("already_installed")=>change(&mut inner,"ready","이 버전은 이미 앱 경로에 있습니다. 기존 설치를 유지했습니다."),
            Err(_)=>change(&mut inner,"error","설치를 완료하지 못했습니다. 네트워크와 설치 경로를 확인한 뒤 다시 시도하세요. 기존 설치는 유지됩니다.")
        }
        };
    });
    Ok(view)
}
