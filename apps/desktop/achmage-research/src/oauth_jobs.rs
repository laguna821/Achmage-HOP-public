use crate::{
    invalidate,
    oauth::{self, StoredToken},
    types::*,
    Job, ResearchService,
};
use serde_json::json;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;
impl ResearchService {
    pub fn start_oauth(self: &Arc<Self>, source: String) -> Result<String, String> {
        if source != "custom-mcp" {
            return Err(
                "OAuth is available for the explicitly configured custom MCP connection".into(),
            );
        }
        let mut s = self.state.lock().unwrap();
        let settings = s
            .settings
            .get(&source)
            .cloned()
            .ok_or("Save MCP settings before signing in")?;
        if settings
            .options
            .get("transport")
            .is_some_and(|t| t == "stdio")
        {
            return Err("stdio does not use HTTP OAuth".into());
        }
        let endpoint = settings
            .options
            .get("endpoint")
            .cloned()
            .ok_or("OAuth MCP endpoint missing")?;
        let client = settings
            .options
            .get("oauth_client_id")
            .filter(|s| !s.is_empty())
            .cloned()
            .ok_or("Register and save an OAuth public client ID first")?;
        let scopes = settings
            .options
            .get("oauth_scopes")
            .cloned()
            .unwrap_or_default();
        if s.jobs.values().filter(|j| j.state.active()).count() >= 8 {
            return Err("At most eight concurrent operations".into());
        }
        if s.jobs.len() >= 64 {
            if let Some(key) = s
                .jobs
                .iter()
                .find(|(_, j)| !j.state.active())
                .map(|(k, _)| k.clone())
            {
                s.jobs.remove(&key);
            }
        }
        s.next = s.next.checked_add(1).ok_or("Job counter exhausted")?;
        let id = s.next.to_string();
        let generation = s.generation;
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
        let job_id = id.clone();
        tokio::spawn(async move {
            let result = async {
                let metadata = oauth::discover(&endpoint, &token).await?;
                let authorization = oauth::Authorization::begin(metadata, client, &scopes).await?;
                {
                    let mut state = service.state.lock().unwrap();
                    if token.is_cancelled() || state.generation != generation {
                        return Err("OAuth cancelled before browser authorization".into());
                    }
                    if let Some(job) = state.jobs.get_mut(&job_id) {
                        job.state = JobState::OAuthPending {
                            authorization_url: authorization.authorization_url.clone(),
                        };
                    }
                }
                authorization.finish(&token).await
            }
            .await;
            let mut state = service.state.lock().unwrap();
            if token.is_cancelled() || state.generation != generation {
                return;
            }
            let result=result.and_then(|stored|{
                let encoded=Zeroizing::new(serde_json::to_string(&stored).map_err(|_|"OAuth token serialization failed")?);
                service.secrets.set(&source,"oauth-token",Some(&encoded))?;
                Ok(json!({"sourceId":source,"authenticated":true,"resource":stored.resource,"expiresAt":stored.expires_at,"tokenStored":"os-keyring","refreshPolicy":"explicit-sign-in-on-expiry"}))
            });
            if let Some(job) = state.jobs.get_mut(&job_id) {
                job.state = match result {
                    Ok(result) => JobState::McpCompleted { result },
                    Err(message) => JobState::Failed { message },
                };
            }
        });
        Ok(id)
    }
    pub fn disconnect_oauth(&self, source: &str) -> Result<(), String> {
        if source != "custom-mcp" {
            return Err("Unknown OAuth connection".into());
        }
        let mut state = self.state.lock().unwrap();
        invalidate(&mut state);
        self.secrets.set(source, "oauth-token", None)
    }
    pub(crate) fn oauth_bearer(
        &self,
        source: &str,
        resource: &str,
        client: &str,
    ) -> Result<Option<Zeroizing<String>>, String> {
        if source != "custom-mcp" || client.is_empty() {
            return Ok(None);
        }
        let Some(secret) = self.secrets.get(source, "oauth-token")? else {
            return Ok(None);
        };
        let stored: StoredToken = serde_json::from_str(&secret)
            .map_err(|_| "Stored OAuth token is invalid; disconnect and sign in again")?;
        stored.bearer(resource, client).map(Some)
    }
}
