pub mod action;
mod adapters;
pub mod http;
pub mod mcp;
pub mod mcp_jobs;
pub mod mcp_legacy;
pub mod mcp_stdio;
pub mod normalize;
mod normalize_xml;
pub mod oauth;
mod oauth_jobs;
pub mod secrets;
mod settings;
pub mod types;
use secrets::{OsSecretStore, SecretStore};
use settings::{persist, validate_settings};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;
use types::*;
struct Job {
    state: JobState,
    token: CancellationToken,
}
struct State {
    next: u64,
    generation: u64,
    settings: BTreeMap<String, SourceSettings>,
    jobs: BTreeMap<String, Job>,
    cache: BTreeMap<String, (Instant, SearchResult)>,
    verified: BTreeMap<String, bool>,
}
pub struct ResearchService {
    http: http::Http,
    secrets: Arc<dyn SecretStore>,
    state: Mutex<State>,
    config: Option<PathBuf>,
}
impl ResearchService {
    pub fn new() -> Result<Arc<Self>, String> {
        Self::create(Arc::new(OsSecretStore), None)
    }
    pub fn with_config(path: PathBuf) -> Result<Arc<Self>, String> {
        Self::create(Arc::new(OsSecretStore), Some(path))
    }
    pub fn with_store(store: Arc<dyn SecretStore>) -> Result<Arc<Self>, String> {
        Self::create(store, None)
    }
    fn create(secrets: Arc<dyn SecretStore>, config: Option<PathBuf>) -> Result<Arc<Self>, String> {
        let mut settings: BTreeMap<String, SourceSettings> = BTreeMap::new();
        if let Some(p) = &config {
            match std::fs::File::open(p) {
                Ok(file) => {
                    use std::io::Read;
                    let mut bytes = Vec::new();
                    file.take(65537)
                        .read_to_end(&mut bytes)
                        .map_err(|_| "Cannot read research settings")?;
                    if bytes.len() > 65536 {
                        return Err("Research settings exceed 64 KiB".into());
                    }
                    settings = serde_json::from_slice(&bytes)
                        .map_err(|_| "Invalid research settings JSON")?;
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err("Cannot read research settings".into()),
            }
        }
        for (id, s) in &settings {
            validate_settings(id, s)?;
        }
        Ok(Arc::new(Self {
            http: http::Http::new()?,
            secrets,
            state: Mutex::new(State {
                next: 0,
                generation: 0,
                settings,
                jobs: BTreeMap::new(),
                cache: BTreeMap::new(),
                verified: BTreeMap::new(),
            }),
            config,
        }))
    }
    pub fn catalog(&self) -> serde_json::Value {
        let mut r = registry();
        r["sources"].as_array_mut().unwrap().push(custom_mcp());
        let state = self.state.lock().unwrap();
        for source in r["sources"].as_array_mut().unwrap() {
            let id = source["id"].as_str().unwrap().to_string();
            let mut missing = Vec::new();
            let mut store_error = false;
            if let Some(fields) = source["secretFields"].as_array() {
                for f in fields {
                    let field = f["id"].as_str().unwrap();
                    if id == "openalex" {
                        continue;
                    }
                    if f["required"] == true {
                        match self.secrets.get(&id, field) {
                            Ok(Some(_)) => {}
                            Ok(None) => missing.push(field.to_string()),
                            Err(_) => store_error = true,
                        }
                    }
                }
            }
            let stdio = state
                .settings
                .get(&id)
                .is_some_and(|s| s.options.get("transport").is_some_and(|t| t == "stdio"));
            if !stdio
                && (matches!(id.as_str(), "scienceon" | "ntis") || source["protocol"] == "mcp")
                && !state
                    .settings
                    .get(&id)
                    .is_some_and(|s| s.options.contains_key("endpoint"))
            {
                missing.push("endpoint".into());
            }
            source["runtimeStatus"] = serde_json::json!(if source["protocol"] == "mcp" {
                "mcp_explicit"
            } else if store_error {
                "credential_store_unavailable"
            } else if !missing.is_empty() {
                "needs_configuration"
            } else {
                "ready"
            });
            source["missingFields"] = serde_json::json!(missing);
            if source["protocol"] == "mcp" && id != "custom-mcp" {
                source["optionFields"] = serde_json::json!([{ "id":"endpoint", "label":"MCP endpoint (명시 저장 후 연결)", "required":true }]);
            }
            source["settings"] =
                serde_json::json!(state.settings.get(&id).cloned().unwrap_or_default());
            source["connectionVerified"] =
                serde_json::json!(state.verified.get(&id).copied().unwrap_or(false));
            if id == "openalex" {
                source["secretFields"][0]["required"] = serde_json::json!(false);
                source["freeBoundary"] =
                    serde_json::json!("Optional API key; current provider budget applies");
            }
        }
        r
    }
    pub fn configure(&self, source: &str, settings: SourceSettings) -> Result<(), String> {
        validate_settings(source, &settings)?;
        let mut s = self.state.lock().unwrap();
        let mut next = s.settings.clone();
        next.insert(source.into(), settings);
        if let Some(path) = &self.config {
            persist(path, &next)?;
        }
        s.settings = next;
        invalidate(&mut s);
        Ok(())
    }
    pub fn set_secret(
        &self,
        source: &str,
        field: &str,
        value: Option<String>,
    ) -> Result<(), String> {
        let value = value.map(zeroize::Zeroizing::new);
        let d = definition(source)?;
        if !d["secretFields"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f["id"] == field)
        {
            return Err("Unknown secret field".into());
        }
        if value
            .as_ref()
            .is_some_and(|v| v.len() > 8192 || v.is_empty() || v.contains(['\r', '\n']))
        {
            return Err("Credential must be nonempty, single-line and at most 8192 bytes".into());
        }
        self.secrets
            .set(source, field, value.as_ref().map(|v| v.as_str()))?;
        invalidate(&mut self.state.lock().unwrap());
        Ok(())
    }
    pub fn start(self: &Arc<Self>, request: SearchRequest) -> Result<String, String> {
        validate(&request)?;
        let mut s = self.state.lock().unwrap();
        if s.jobs.values().filter(|j| j.state.active()).count() >= 8 {
            return Err("At most eight concurrent searches".into());
        }
        if s.jobs.len() >= 64 {
            if let Some(k) = s
                .jobs
                .iter()
                .find(|(_, j)| !j.state.active())
                .map(|(k, _)| k.clone())
            {
                s.jobs.remove(&k);
            }
        }
        s.next = s.next.checked_add(1).ok_or("Job counter exhausted")?;
        let id = s.next.to_string();
        let generation = s.generation;
        let settings = s
            .settings
            .get(&request.source_id)
            .cloned()
            .unwrap_or_default();
        let cache_key = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(generation, &request)).unwrap())
        );
        if let Some((at, result)) = s.cache.get(&cache_key) {
            if at.elapsed() < Duration::from_secs(300) {
                let mut result = result.clone();
                result.cache_hit = true;
                s.jobs.insert(
                    id.clone(),
                    Job {
                        state: JobState::Completed { result },
                        token: CancellationToken::new(),
                    },
                );
                return Ok(id);
            }
        }
        let token = CancellationToken::new();
        s.jobs.insert(
            id.clone(),
            Job {
                state: JobState::Running,
                token: token.clone(),
            },
        );
        drop(s);
        let service = self.clone();
        let job = id.clone();
        tokio::spawn(async move {
            let mut keys = BTreeMap::new();
            let def = definition(&request.source_id).unwrap();
            let mut error = None;
            for f in def["secretFields"].as_array().unwrap() {
                let k = f["id"].as_str().unwrap();
                match service.secrets.get(&request.source_id, k) {
                    Ok(Some(v)) => {
                        keys.insert(k.into(), v);
                    }
                    Ok(None) => {}
                    Err(e) => {
                        error = Some(e);
                        break;
                    }
                }
            }
            let result = if let Some(e) = error {
                Err(e)
            } else {
                adapters::search(&service.http, &request, &settings, &keys, &token).await
            };
            let mut s = service.state.lock().unwrap();
            if token.is_cancelled() || s.generation != generation {
                return;
            }
            s.verified.insert(request.source_id.clone(), result.is_ok());
            let state = match result {
                Ok(result) => {
                    if s.cache.len() >= 128 {
                        if let Some(k) = s.cache.keys().next().cloned() {
                            s.cache.remove(&k);
                        }
                    }
                    s.cache.insert(cache_key, (Instant::now(), result.clone()));
                    JobState::Completed { result }
                }
                Err(message) => JobState::Failed { message },
            };
            if let Some(j) = s.jobs.get_mut(&job) {
                j.state = state;
            }
        });
        Ok(id)
    }
    pub fn poll(&self, id: &str) -> Result<JobState, String> {
        self.state
            .lock()
            .unwrap()
            .jobs
            .get(id)
            .map(|j| j.state.clone())
            .ok_or_else(|| "Unknown or expired job".into())
    }
    pub fn cancel(&self, id: &str) -> Result<(), String> {
        let mut s = self.state.lock().unwrap();
        let j = s.jobs.get_mut(id).ok_or("Unknown job")?;
        j.token.cancel();
        j.state = JobState::Cancelled;
        Ok(())
    }
    pub fn shutdown(&self) {
        invalidate(&mut self.state.lock().unwrap());
    }
}
fn invalidate(s: &mut State) {
    s.generation = s.generation.wrapping_add(1);
    s.cache.clear();
    s.verified.clear();
    for j in s.jobs.values_mut() {
        if j.state.active() {
            j.token.cancel();
            j.state = JobState::Cancelled;
        }
    }
}
