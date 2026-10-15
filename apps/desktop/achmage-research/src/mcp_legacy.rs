//! Explicit legacy HTTP+SSE transport; no silent fallback or tool retries.
use crate::{
    http::{Http, MAX_BODY},
    mcp::{rpc_result, validate_endpoint},
};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;
pub struct LegacySession {
    http: Http,
    post: url::Url,
    stream: reqwest::Response,
    buffer: Vec<u8>,
    bearer: Option<Zeroizing<String>>,
    next: u64,
}
impl LegacySession {
    pub async fn connect(
        endpoint: &str,
        bearer: Option<String>,
        cancel: &CancellationToken,
    ) -> Result<Self, String> {
        let endpoint = validate_endpoint(endpoint)?;
        let http = Http::new()?;
        let mut get = http
            .client
            .get(endpoint.clone())
            .header("Accept", "text/event-stream");
        if let Some(b) = &bearer {
            get = get.bearer_auth(b);
        }
        let response = tokio::select! {_=cancel.cancelled()=>return Err("Cancelled before MCP SSE connection".into()),r=get.send()=>r.map_err(|_|"MCP SSE connect failed")?};
        if !response.status().is_success()
            || !response
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .is_some_and(|s| s.starts_with("text/event-stream"))
        {
            return Err("MCP legacy endpoint did not return an SSE stream".into());
        }
        let mut s = Self {
            http,
            post: endpoint.clone(),
            stream: response,
            buffer: Vec::new(),
            bearer: bearer.map(Zeroizing::new),
            next: 0,
        };
        let (kind, data) = s.event(cancel).await?;
        if kind != "endpoint" {
            return Err("MCP legacy first event must provide endpoint".into());
        }
        let post = endpoint
            .join(&data)
            .map_err(|_| "Invalid MCP legacy POST endpoint")?;
        validate_endpoint(post.as_str())?;
        if post.origin() != endpoint.origin() {
            return Err("MCP legacy POST endpoint changed origin".into());
        }
        s.post = post;
        let init=s.request("initialize",json!({"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"Achmage-HOP","version":"0.1.0"}}),cancel).await?;
        if init["protocolVersion"] != "2024-11-05" {
            return Err("Legacy MCP protocol version mismatch".into());
        }
        s.post(
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            cancel,
        )
        .await?;
        Ok(s)
    }
    async fn post(&self, v: Value, cancel: &CancellationToken) -> Result<(), String> {
        let mut r = self.http.client.post(self.post.clone()).json(&v);
        if let Some(b) = &self.bearer {
            r = r.bearer_auth(b.as_str());
        }
        let response = self.http.send(r, cancel).await?;
        if response.provenance.status != 202 && response.provenance.status != 204 {
            return Err("MCP legacy POST not accepted; do not retry automatically".into());
        }
        Ok(())
    }
    async fn event(&mut self, cancel: &CancellationToken) -> Result<(String, String), String> {
        loop {
            if let Some((end, len)) = self
                .buffer
                .windows(2)
                .position(|s| s == b"\n\n")
                .map(|i| (i, 2))
                .or_else(|| {
                    self.buffer
                        .windows(4)
                        .position(|s| s == b"\r\n\r\n")
                        .map(|i| (i, 4))
                })
            {
                let bytes: Vec<_> = self.buffer.drain(..end + len).collect();
                let raw = std::str::from_utf8(&bytes).map_err(|_| "MCP SSE invalid UTF-8")?;
                let kind = raw
                    .lines()
                    .find_map(|l| l.strip_prefix("event:"))
                    .unwrap_or("message")
                    .trim()
                    .to_owned();
                let data = raw
                    .lines()
                    .filter_map(|l| {
                        l.strip_prefix("data:")
                            .map(|x| x.strip_prefix(' ').unwrap_or(x))
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                if !data.is_empty() {
                    return Ok((kind, data));
                }
                continue;
            }
            let chunk = tokio::select! {_=cancel.cancelled()=>return Err("MCP SSE cancelled locally; remote outcome unconfirmed".into()),r=self.stream.chunk()=>r.map_err(|_|"MCP SSE disconnected; outcome unknown")?};
            let Some(chunk) = chunk else {
                return Err("MCP SSE ended without matching response".into());
            };
            self.buffer.extend_from_slice(&chunk);
            if self.buffer.len() > MAX_BODY {
                return Err("MCP SSE event exceeds 4 MiB".into());
            }
        }
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
        self.post(
            json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}),
            cancel,
        )
        .await?;
        let mut total = 0;
        loop {
            let (kind, data) = self.event(cancel).await?;
            total += data.len();
            if total > MAX_BODY {
                return Err("MCP SSE response exceeds 4 MiB".into());
            }
            if kind != "message" {
                continue;
            }
            let v: Value = serde_json::from_str(&data).map_err(|_| "Invalid MCP SSE JSON")?;
            if v.get("method").is_some() {
                if v.get("id").is_some() {
                    return Err("Server-initiated MCP requests unsupported".into());
                }
                continue;
            }
            if v["id"] != id {
                return Err("MCP legacy response ID mismatch".into());
            }
            return rpc_result(v);
        }
    }
    pub fn close(self) {
        drop(self);
    }
}
