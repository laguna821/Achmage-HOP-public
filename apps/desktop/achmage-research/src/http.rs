use crate::types::{timestamp, Provenance};
use reqwest::{Client, RequestBuilder};
use sha2::{Digest, Sha256};
use std::{sync::Arc, time::Duration};
use tokio::{sync::Mutex, time::Instant};
use tokio_util::sync::CancellationToken;
pub const MAX_BODY: usize = 4 * 1024 * 1024;
#[derive(Clone)]
pub struct Http {
    pub(crate) client: Client,
    pace: Arc<Mutex<Instant>>,
}
pub struct Response {
    pub text: String,
    pub provenance: Provenance,
    pub session: Option<String>,
    pub content_type: String,
}
impl Http {
    pub fn new() -> Result<Self, String> {
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(25))
            .user_agent("Achmage-HOP-Research/0.1")
            .build()
            .map_err(|_| "HTTP initialization failed")?;
        Ok(Self {
            client,
            pace: Arc::new(Mutex::new(Instant::now())),
        })
    }
    pub async fn send(
        &self,
        req: RequestBuilder,
        cancel: &CancellationToken,
    ) -> Result<Response, String> {
        // Conservative global pacing also bounds PubMed's unauthenticated two-request path.
        let mut last = self.pace.lock().await;
        tokio::select! { _=cancel.cancelled()=>return Err("Cancelled".into()), _=tokio::time::sleep_until(*last)=>{} }
        *last = Instant::now() + Duration::from_millis(1100);
        drop(last);
        let mut response = tokio::select! { _=cancel.cancelled()=>return Err("Cancelled".into()), r=req.send()=>r.map_err(|_|"Network request failed or timed out")? };
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            return Err(format!("HTTP {status}; no automatic retry"));
        }
        let mut endpoint = response.url().clone();
        endpoint.set_query(None);
        endpoint.set_fragment(None);
        let session = response
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        if response
            .content_length()
            .is_some_and(|n| n > MAX_BODY as u64)
        {
            return Err("Response exceeds 4 MiB".into());
        }
        let mut bytes = Vec::new();
        loop {
            let chunk = tokio::select! { _=cancel.cancelled()=>return Err("Cancelled".into()), r=response.chunk()=>r.map_err(|_|"Response body failed")? };
            let Some(chunk) = chunk else { break };
            if bytes.len() + chunk.len() > MAX_BODY {
                return Err("Response exceeds 4 MiB".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let hash = format!("{:x}", Sha256::digest(&bytes));
        let text = String::from_utf8(bytes).map_err(|_| "Response is not UTF-8")?;
        Ok(Response {
            text,
            session,
            content_type,
            provenance: Provenance {
                endpoint: endpoint.to_string(),
                response_sha256: hash,
                status,
                retrieved_at: timestamp(),
            },
        })
    }
}
pub fn approved_url(value: &str, domains: &[&str]) -> Result<url::Url, String> {
    let u = url::Url::parse(value).map_err(|_| "Invalid endpoint URL")?;
    if u.scheme() != "https"
        || !u.username().is_empty()
        || u.password().is_some()
        || u.fragment().is_some()
        || u.port().is_some_and(|p| p != 443)
    {
        return Err("Endpoint must be HTTPS without credentials, fragment, or custom port".into());
    }
    if !domains.iter().any(|d| {
        u.host_str()
            .is_some_and(|h| h == *d || h.ends_with(&format!(".{d}")))
    }) {
        return Err("Endpoint outside source provider domain".into());
    }
    Ok(u)
}
