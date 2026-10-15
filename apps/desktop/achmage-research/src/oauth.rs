//! MCP public-client OAuth: discovered metadata, PKCE S256, resource binding and loopback.
//! Client IDs are explicitly registered by the user; dynamic registration is not attempted.
use crate::{http::Http, mcp::validate_endpoint};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use tokio_util::sync::CancellationToken;
use zeroize::{Zeroize, Zeroizing};

#[derive(Clone)]
pub struct Metadata {
    pub resource: url::Url,
    pub issuer: url::Url,
    pub authorization: url::Url,
    pub token: url::Url,
}
fn https(value: &str) -> Result<url::Url, String> {
    let url = validate_endpoint(value)?;
    if url.scheme() != "https" || url.query().is_some() {
        return Err("OAuth metadata endpoints must use HTTPS without query".into());
    }
    Ok(url)
}
fn random() -> Result<String, String> {
    let mut bytes = [0; 32];
    getrandom::getrandom(&mut bytes).map_err(|_| "OS random generator unavailable")?;
    let out = URL_SAFE_NO_PAD.encode(bytes);
    bytes.zeroize();
    Ok(out)
}
pub fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}
fn challenge_metadata(header: &str) -> Option<&str> {
    if !header.to_ascii_lowercase().starts_with("bearer ") {
        return None;
    }
    header
        .split(',')
        .find_map(|p| {
            p.trim()
                .strip_prefix("resource_metadata=\"")
                .and_then(|v| v.strip_suffix('"'))
        })
        .or_else(|| {
            header
                .strip_prefix("Bearer resource_metadata=\"")
                .and_then(|v| v.strip_suffix('"'))
        })
}
fn well_known(base: &url::Url, name: &str) -> url::Url {
    let mut url = base.clone();
    url.set_path(&format!(
        "/.well-known/{name}{}",
        base.path().trim_end_matches('/')
    ));
    url.set_query(None);
    url
}
async fn json(http: &Http, url: url::Url, cancel: &CancellationToken) -> Result<Value, String> {
    let response = http.send(http.client.get(url), cancel).await?;
    serde_json::from_str(&response.text).map_err(|_| "OAuth metadata is not JSON".into())
}
pub async fn discover(resource: &str, cancel: &CancellationToken) -> Result<Metadata, String> {
    let resource = https(resource)?;
    let http = Http::new()?;
    let response = tokio::select! {_=cancel.cancelled()=>return Err("OAuth discovery cancelled".into()),r=http.client.get(resource.clone()).header("Accept","application/json, text/event-stream").send()=>r.map_err(|_|"OAuth resource discovery failed")?};
    let mut metadata = well_known(&resource, "oauth-protected-resource");
    if response.status().as_u16() == 401 {
        if let Some(location) = response
            .headers()
            .get("www-authenticate")
            .and_then(|v| v.to_str().ok())
            .and_then(challenge_metadata)
        {
            metadata = https(location)?;
            if metadata.origin() != resource.origin() {
                return Err(
                    "OAuth resource metadata changed origin; configure a reviewed provider instead"
                        .into(),
                );
            }
        }
    }
    drop(response);
    let protected = json(&http, metadata, cancel).await?;
    let claimed = https(
        protected["resource"]
            .as_str()
            .ok_or("OAuth resource metadata is missing resource")?,
    )?;
    if claimed != resource {
        return Err("OAuth resource metadata binding mismatch".into());
    }
    let issuer = https(
        protected["authorization_servers"]
            .as_array()
            .and_then(|a| a.first())
            .and_then(Value::as_str)
            .ok_or("OAuth authorization server missing")?,
    )?;
    let server = json(
        &http,
        well_known(&issuer, "oauth-authorization-server"),
        cancel,
    )
    .await?;
    if https(server["issuer"].as_str().ok_or("OAuth issuer missing")?)? != issuer {
        return Err("OAuth issuer mismatch".into());
    }
    if !server["code_challenge_methods_supported"]
        .as_array()
        .is_some_and(|a| a.iter().any(|v| v == "S256"))
    {
        return Err("OAuth server does not advertise PKCE S256".into());
    }
    if server
        .get("response_types_supported")
        .is_some_and(|v| !v.as_array().is_some_and(|a| a.iter().any(|v| v == "code")))
    {
        return Err("OAuth authorization-code response unsupported".into());
    }
    Ok(Metadata {
        resource,
        issuer,
        authorization: https(
            server["authorization_endpoint"]
                .as_str()
                .ok_or("OAuth authorization endpoint missing")?,
        )?,
        token: https(
            server["token_endpoint"]
                .as_str()
                .ok_or("OAuth token endpoint missing")?,
        )?,
    })
}
#[derive(Serialize, Deserialize)]
pub struct StoredToken {
    pub resource: String,
    pub client_id: String,
    pub issuer: String,
    pub expires_at: Option<i64>,
    access_token: String,
    refresh_token: Option<String>,
}
impl Drop for StoredToken {
    fn drop(&mut self) {
        self.access_token.zeroize();
        if let Some(v) = &mut self.refresh_token {
            v.zeroize();
        }
    }
}
impl StoredToken {
    pub fn bearer(&self, resource: &str, client: &str) -> Result<Zeroizing<String>, String> {
        if self.resource != resource || self.client_id != client {
            return Err(
                "OAuth token belongs to a different endpoint/client; sign in explicitly".into(),
            );
        }
        if self
            .expires_at
            .is_some_and(|t| t <= chrono::Utc::now().timestamp() + 30)
        {
            return Err("OAuth token expired; sign in again".into());
        }
        Ok(Zeroizing::new(self.access_token.clone()))
    }
}
pub struct Authorization {
    metadata: Metadata,
    client_id: String,
    redirect: String,
    verifier: Zeroizing<String>,
    state: String,
    listener: TcpListener,
    pub authorization_url: String,
}
impl Authorization {
    pub async fn begin(
        metadata: Metadata,
        client_id: String,
        scopes: &str,
    ) -> Result<Self, String> {
        for value in [
            &metadata.resource,
            &metadata.issuer,
            &metadata.authorization,
            &metadata.token,
        ] {
            https(value.as_str())?;
        }
        if client_id.is_empty()
            || client_id.len() > 4096
            || scopes.len() > 4096
            || client_id.contains(['\r', '\n'])
            || scopes.contains(['\r', '\n'])
        {
            return Err("Invalid OAuth client ID/scopes".into());
        }
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|_| "OAuth loopback port unavailable")?;
        let redirect = format!(
            "http://127.0.0.1:{}/oauth/callback",
            listener
                .local_addr()
                .map_err(|_| "OAuth loopback address unavailable")?
                .port()
        );
        let verifier = Zeroizing::new(random()?);
        let state = random()?;
        let mut url = metadata.authorization.clone();
        url.query_pairs_mut().extend_pairs([
            ("response_type", "code"),
            ("client_id", client_id.as_str()),
            ("redirect_uri", redirect.as_str()),
            ("state", state.as_str()),
            ("code_challenge", challenge(&verifier).as_str()),
            ("code_challenge_method", "S256"),
            ("resource", metadata.resource.as_str()),
            ("scope", scopes),
        ]);
        Ok(Self {
            metadata,
            client_id,
            redirect,
            verifier,
            state,
            listener,
            authorization_url: url.into(),
        })
    }
    pub async fn finish(self, cancel: &CancellationToken) -> Result<StoredToken, String> {
        let code = tokio::select! {_=cancel.cancelled()=>return Err("OAuth cancelled".into()),r=tokio::time::timeout(Duration::from_secs(600),self.callback())=>r.map_err(|_|"OAuth callback timed out")??};
        let http = Http::new()?;
        let response = http
            .send(
                http.client.post(self.metadata.token.clone()).form(&[
                    ("grant_type", "authorization_code"),
                    ("client_id", self.client_id.as_str()),
                    ("code", code.as_str()),
                    ("code_verifier", self.verifier.as_str()),
                    ("redirect_uri", self.redirect.as_str()),
                    ("resource", self.metadata.resource.as_str()),
                ]),
                cancel,
            )
            .await?;
        let text = Zeroizing::new(response.text);
        let value: Value =
            serde_json::from_str(&text).map_err(|_| "OAuth token response invalid")?;
        if !value["token_type"]
            .as_str()
            .is_some_and(|s| s.eq_ignore_ascii_case("Bearer"))
        {
            return Err("OAuth token is not Bearer".into());
        }
        let access = value["access_token"]
            .as_str()
            .ok_or("OAuth access token missing")?;
        if access.is_empty() || access.len() > 8192 || access.contains(['\r', '\n']) {
            return Err("OAuth access token invalid".into());
        }
        let expires_at = value["expires_in"]
            .as_i64()
            .map(|s| chrono::Utc::now().timestamp().saturating_add(s));
        if expires_at.is_some_and(|t| t <= chrono::Utc::now().timestamp()) {
            return Err("OAuth issued an expired token".into());
        }
        Ok(StoredToken {
            resource: self.metadata.resource.to_string(),
            client_id: self.client_id.clone(),
            issuer: self.metadata.issuer.to_string(),
            expires_at,
            access_token: access.into(),
            refresh_token: value["refresh_token"]
                .as_str()
                .filter(|s| s.len() <= 8192)
                .map(str::to_string),
        })
    }
    async fn callback(&self) -> Result<Zeroizing<String>, String> {
        for _ in 0..16 {
            let (mut stream, _) = self
                .listener
                .accept()
                .await
                .map_err(|_| "OAuth callback listener failed")?;
            let bytes = tokio::time::timeout(Duration::from_secs(5), async {
                let mut bytes = Vec::new();
                loop {
                    let mut chunk = [0; 1024];
                    let n = stream
                        .read(&mut chunk)
                        .await
                        .map_err(|_| "OAuth callback read failed")?;
                    if n == 0 {
                        return Err("OAuth callback closed");
                    }
                    bytes.extend_from_slice(&chunk[..n]);
                    if bytes.len() > 8192 {
                        return Err("OAuth callback too large");
                    }
                    if bytes.windows(4).any(|w| w == b"\r\n\r\n") {
                        return Ok(bytes);
                    }
                }
            })
            .await;
            let parsed = bytes
                .ok()
                .and_then(Result::ok)
                .and_then(|b| String::from_utf8(b).ok())
                .and_then(|s| parse_callback(&s, &self.state).ok());
            let body = if parsed.is_some() {
                "Authorization received. Return to HOP."
            } else {
                "Invalid authorization callback."
            };
            let code = if parsed.is_some() {
                "200 OK"
            } else {
                "400 Bad Request"
            };
            let _=stream.write_all(format!("HTTP/1.1 {code}\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await;
            if let Some(code) = parsed {
                return Ok(Zeroizing::new(code));
            }
        }
        Err("Too many invalid OAuth callbacks".into())
    }
}
pub fn parse_callback(request: &str, state: &str) -> Result<String, String> {
    let mut fields = request.lines().next().unwrap_or("").split_whitespace();
    if fields.next() != Some("GET") {
        return Err("OAuth callback must be GET".into());
    }
    let target = fields.next().ok_or("OAuth callback target missing")?;
    if !target.starts_with("/oauth/callback?") {
        return Err("OAuth callback path mismatch".into());
    }
    let url = url::Url::parse(&format!("http://127.0.0.1{target}"))
        .map_err(|_| "OAuth callback URL invalid")?;
    if url.path() != "/oauth/callback" {
        return Err("OAuth callback path mismatch".into());
    }
    let pairs = url.query_pairs().collect::<Vec<_>>();
    let single = |key: &str| {
        let v = pairs.iter().filter(|(k, _)| k == key).collect::<Vec<_>>();
        if v.len() == 1 {
            Some(v[0].1.as_ref())
        } else {
            None
        }
    };
    if single("state") != Some(state) || single("error").is_some() {
        return Err("OAuth state mismatch or authorization rejected".into());
    }
    let code = single("code").ok_or("OAuth code missing/duplicated")?;
    if code.is_empty() || code.len() > 4096 {
        return Err("OAuth code invalid".into());
    }
    Ok(code.into())
}
#[cfg(test)]
#[path = "oauth_tests.rs"]
mod tests;
