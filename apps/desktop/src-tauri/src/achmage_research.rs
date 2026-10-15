//! App-scoped configuration with window-owned search jobs.
use achmage_research::{action::{self, Action}, ResearchService};
use serde_json::Value;
use std::{collections::{HashMap,HashSet}, sync::{Arc, Mutex}};
use tauri::{AppHandle, Manager, State, WebviewWindow};

#[derive(Default)]
pub struct ResearchState(Mutex<Inner>);
#[derive(Default)]
struct Inner {
    service: Option<Arc<ResearchService>>,
    owners: HashMap<String, String>,
    opened: HashSet<String>,
}

#[tauri::command]
pub async fn achmage_research(app: AppHandle, window: WebviewWindow,
    state: State<'_, ResearchState>, action: Action) -> Result<Value, String> {
    let mut inner = state.0.lock().map_err(|_| "연구 상태를 읽지 못했습니다.")?;
    if let Some(id) = action.job_id() {
        if inner.owners.get(id).map(String::as_str) != Some(window.label()) {
            return Err("이 문서창의 연구 작업이 아닙니다.".into());
        }
    }
    if inner.service.is_none() {
        let path = app.path().app_local_data_dir().map_err(|_| "연구 저장 경로를 찾지 못했습니다.")?
            .join("achmage-research/settings.json");
        inner.service = Some(ResearchService::with_config(path)?);
    }
    let service = inner.service.as_ref().unwrap().clone();
    let polled_job=action.job_id().map(str::to_owned);
    let mut result = action::dispatch(&service, action)?;
    if let Some(id) = result["jobId"].as_str() {
        // ResearchService retains at most 64 jobs; discard expired owner records too.
        inner.owners.retain(|id, _| service.poll(id).is_ok());
        inner.owners.insert(id.to_owned(), window.label().to_owned());
    }
    if result["status"]=="oauth_pending" {
        let url=result.as_object_mut().and_then(|o|o.remove("authorizationUrl"))
            .and_then(|u|u.as_str().map(str::to_owned));
        if let Some(id)=polled_job {
            if !inner.opened.contains(&id) {
                // The service constructs this from validated issuer metadata and its own PKCE/state.
                let url=url.filter(|s|s.starts_with("https://")&&!s.contains(['\r','\n','\0'])).ok_or("인증 주소를 확인하지 못했습니다.")?;
                if open::that_detached(url).is_err(){let _=service.cancel(&id);return Err("브라우저를 열지 못했습니다. 다시 연결해 주세요.".into());}
                inner.opened.insert(id);
            }
        }
    }
    inner.opened.retain(|id|service.poll(id).is_ok());
    Ok(result)
}

pub fn close(state: &ResearchState, label: &str) {
    if let Ok(mut inner) = state.0.lock() {
        let jobs: Vec<_> = inner.owners.iter().filter(|(_, owner)| owner.as_str()==label)
            .map(|(id, _)| id.clone()).collect();
        for id in jobs {
            if let Some(service) = &inner.service { let _ = service.cancel(&id); }
            inner.owners.remove(&id);
            inner.opened.remove(&id);
        }
    }
}
