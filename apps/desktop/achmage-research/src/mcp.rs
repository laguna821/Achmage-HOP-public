//! Streamable HTTP MCP client. Calls are started by the user: a tool chosen in the settings card, or a search
//! box query that mcp_search.rs sends to the server's search tool by a fixed rule. Never chosen by a model.
use crate::http::{Http, MAX_BODY};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;
pub struct McpSession {
    http: Http,
    endpoint: url::Url,
    bearer: Option<Zeroizing<String>>,
    session: Option<String>,
    version: String,
    next: u64,
}
impl McpSession {
    pub async fn connect(
        endpoint: &str,
        bearer: Option<String>,
        cancel: &CancellationToken,
    ) -> Result<Self, String> {
        let url = validate_endpoint(endpoint)?;
        let mut s = Self {
            http: Http::new()?,
            endpoint: url,
            bearer: bearer.map(Zeroizing::new),
            session: None,
            version: "2025-06-18".into(),
            next: 0,
        };
        let v=s.request("initialize",json!({"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"Achmage-HOP","version":"0.1.0"}}),cancel).await?;
        let version = v["protocolVersion"]
            .as_str()
            .ok_or("MCP initialization missing protocol version")?;
        if !["2025-03-26", "2025-06-18", "2025-11-25"].contains(&version) {
            return Err("MCP protocol version unsupported".into());
        }
        s.version = version.into();
        let resp = s
            .http
            .send(
                s.builder()
                    .json(&json!({"jsonrpc":"2.0","method":"notifications/initialized"})),
                cancel,
            )
            .await?;
        if resp.provenance.status != 202 && resp.provenance.status != 204 {
            return Err("MCP initialized notification was not accepted".into());
        }
        Ok(s)
    }
    fn builder(&self) -> reqwest::RequestBuilder {
        let mut req = self
            .http
            .client
            .post(self.endpoint.clone())
            .header("Accept", "application/json, text/event-stream")
            .header("MCP-Protocol-Version", &self.version);
        if let Some(id) = &self.session {
            req = req.header("Mcp-Session-Id", id);
        }
        if let Some(v) = &self.bearer {
            req = req.bearer_auth(v.as_str());
        }
        req
    }
    pub async fn list_tools(
        &mut self,
        cursor: Option<String>,
        cancel: &CancellationToken,
    ) -> Result<Value, String> {
        self.request(
            "tools/list",
            cursor
                .map(|cursor| json!({"cursor":cursor}))
                .unwrap_or_else(|| json!({})),
            cancel,
        )
        .await
    }
    /// The caller shows which tool was called with what; the result is untrusted source content.
    pub async fn call_tool(
        &mut self,
        name: &str,
        args: Value,
        cancel: &CancellationToken,
    ) -> Result<Value, String> {
        if name.is_empty()
            || name.len() > 256
            || !args.is_object()
            || serde_json::to_vec(&args)
                .map_err(|_| "Invalid arguments")?
                .len()
                > 65536
        {
            return Err("Invalid or oversized MCP tool arguments".into());
        }
        self.request("tools/call", json!({"name":name,"arguments":args}), cancel)
            .await
    }
    async fn request(
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
        let req = self
            .builder()
            .json(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}));
        let mut response = tokio::select! {_=cancel.cancelled()=>return Err("Cancelled before MCP send".into()),r=req.send()=>r.map_err(|_|"MCP transport failed; outcome unknown, do not automatically retry")?};
        if !response.status().is_success() {
            return Err(format!(
                "MCP HTTP {}; reconnect manually; do not retry a tool automatically",
                response.status().as_u16()
            ));
        }
        if let Some(v) = response.headers().get("mcp-session-id") {
            let v = v.to_str().map_err(|_| "Invalid MCP session")?;
            if v.is_empty() || v.len() > 1024 || !v.bytes().all(|b| (0x21..=0x7e).contains(&b)) {
                return Err("Invalid MCP session ID".into());
            }
            if let Some(old) = &self.session {
                if old != v {
                    return Err("MCP changed session unexpectedly".into());
                }
            } else {
                self.session = Some(v.into());
            }
        }
        let is_sse = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.starts_with("text/event-stream"));
        let mut bytes = Vec::new();
        loop {
            let chunk = tokio::select! {_=cancel.cancelled()=>{self.cancel_notification(id).await;return Err("Cancelled locally; server completion not confirmed".into())},r=response.chunk()=>r.map_err(|_|"MCP disconnected; outcome unknown")?};
            let Some(chunk) = chunk else { break };
            if bytes.len() + chunk.len() > MAX_BODY {
                return Err("MCP response exceeds 4 MiB; outcome may be unknown".into());
            }
            bytes.extend_from_slice(&chunk);
            if is_sse {
                if let Some(value) = parse_sse(&bytes, id)? {
                    return rpc_result(value);
                }
            }
        }
        if is_sse {
            return Err("MCP stream ended without matching response".into());
        }
        let v: Value = serde_json::from_slice(&bytes).map_err(|_| "Invalid MCP JSON")?;
        if v["id"] != id {
            return Err("MCP response ID mismatch".into());
        }
        rpc_result(v)
    }
    async fn cancel_notification(&self, id: u64) {
        let req=self.builder().json(&json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":id,"reason":"User cancelled"}}));
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), req.send()).await;
    }
    pub async fn close(self) -> Result<(), String> {
        let Some(id) = self.session else {
            return Ok(());
        };
        let mut req = self
            .http
            .client
            .delete(self.endpoint)
            .header("Mcp-Session-Id", id)
            .header("MCP-Protocol-Version", self.version);
        if let Some(v) = self.bearer {
            req = req.bearer_auth(v.as_str());
        }
        let r = req.send().await.map_err(|_| "MCP disconnect unconfirmed")?;
        if r.status().is_success() || r.status().as_u16() == 405 {
            Ok(())
        } else {
            Err("MCP disconnect rejected".into())
        }
    }
}
pub(crate) fn rpc_result(v: Value) -> Result<Value, String> {
    if v["jsonrpc"] != "2.0" {
        return Err("Invalid MCP JSON-RPC version".into());
    }
    if v.get("error").is_some() {
        return Err(format!(
            "MCP error code {}",
            v["error"]["code"].as_i64().unwrap_or(-1)
        ));
    }
    v.get("result")
        .cloned()
        .ok_or_else(|| "MCP result missing".into())
}
pub fn parse_sse(bytes: &[u8], id: u64) -> Result<Option<Value>, String> {
    let s = match std::str::from_utf8(bytes) {
        Ok(s) => s,
        Err(e) if e.error_len().is_none() => return Ok(None),
        Err(_) => return Err("MCP SSE invalid UTF-8".into()),
    };
    let normalized = s.replace("\r\n", "\n");
    let mut events = normalized.split("\n\n").collect::<Vec<_>>();
    events.pop();
    for event in events {
        let data = event
            .lines()
            .filter_map(|l| {
                l.strip_prefix("data:")
                    .map(|s| s.strip_prefix(' ').unwrap_or(s))
            })
            .collect::<Vec<_>>()
            .join("\n");
        if data.is_empty() {
            continue;
        }
        let v: Value = serde_json::from_str(&data).map_err(|_| "Invalid MCP SSE JSON")?;
        if v.get("method").is_some() && v.get("id").is_some() {
            return Err("Server-initiated MCP requests are not supported".into());
        }
        if v["id"] == id {
            return Ok(Some(v));
        }
    }
    Ok(None)
}
pub fn validate_endpoint(value: &str) -> Result<url::Url, String> {
    let u = url::Url::parse(value).map_err(|_| "Invalid MCP endpoint")?;
    let local = matches!(u.host_str(), Some("127.0.0.1" | "[::1]" | "localhost"));
    if !(u.scheme() == "https" || u.scheme() == "http" && local)
        || !u.username().is_empty()
        || u.password().is_some()
        || u.fragment().is_some()
    {
        return Err("MCP requires HTTPS or explicit loopback HTTP without URL credentials".into());
    }
    Ok(u)
}
