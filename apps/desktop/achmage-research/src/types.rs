use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchRequest {
    pub source_id: String,
    pub query: String,
    #[serde(default = "ten")]
    pub limit: usize,
    #[serde(default)]
    pub cursor: Option<String>,
}
fn ten() -> usize {
    10
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceSettings {
    #[serde(default)]
    pub options: BTreeMap<String, String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    pub source_id: String,
    pub source_name: String,
    pub operator: String,
    pub role: String,
    pub title: String,
    pub url: String,
    pub retrieved_at: String,
    pub published_at: Option<String>,
    pub identifiers: BTreeMap<String, String>,
    pub snippet: Option<String>,
    pub authors: Vec<String>,
    pub publication_name: Option<String>,
    pub editorial_status: String,
    pub caveats: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provenance {
    /// Scheme/host/path only. Query credentials and search text are never exposed here.
    pub endpoint: String,
    pub response_sha256: String,
    pub status: u16,
    pub retrieved_at: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub records: Vec<Evidence>,
    pub warnings: Vec<String>,
    pub next_cursor: Option<String>,
    pub provenance: Vec<Provenance>,
    pub cache_hit: bool,
}
#[derive(Clone, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum JobState {
    Running,
    #[serde(rename = "oauth_pending")]
    OAuthPending {
        #[serde(rename = "authorizationUrl")]
        authorization_url: String,
    },
    Completed {
        result: SearchResult,
    },
    McpCompleted {
        result: serde_json::Value,
    },
    Failed {
        message: String,
    },
    Cancelled,
}
impl JobState {
    pub(crate) fn active(&self) -> bool {
        matches!(self, Self::Running | Self::OAuthPending { .. })
    }
}

pub fn registry() -> serde_json::Value {
    serde_json::from_str(include_str!("../registry.json")).expect("embedded registry")
}
pub fn definition(id: &str) -> Result<serde_json::Value, String> {
    if id == "custom-mcp" {
        return Ok(custom_mcp());
    }
    registry()["sources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == id)
        .cloned()
        .ok_or_else(|| "Unknown research source".into())
}
pub fn custom_mcp() -> serde_json::Value {
    serde_json::json!({"id":"custom-mcp","name":"사용자 MCP 연결","operator":"사용자가 지정한 서버","role":"external","protocol":"mcp","docsUrl":"https://modelcontextprotocol.io/specification/2025-06-18/basic/transports","secretFields":[],"optionFields":[
        {"id":"transport","label":"transport: streamable_http / legacy_sse / stdio","defaultValue":"streamable_http","required":true},
        {"id":"endpoint","label":"HTTP/SSE endpoint","required":false},
        {"id":"executable","label":"stdio 실행파일 절대 경로","required":false},
        {"id":"executable_sha256","label":"실행파일 SHA-256","required":false},
        {"id":"argv","label":"stdio argv JSON 배열","defaultValue":"[]","required":false},
        {"id":"oauth_client_id","label":"OAuth 공개 클라이언트 ID (직접 등록)","required":false},
        {"id":"oauth_scopes","label":"OAuth scope (공백 구분)","required":false}
    ],"mcpPreset":{}})
}
pub fn timestamp() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub fn validate(r: &SearchRequest) -> Result<(), String> {
    definition(&r.source_id)?;
    if r.query.trim().is_empty()
        || r.query.len() > 4096
        || !(1..=50).contains(&r.limit)
        || r.cursor.as_ref().is_some_and(|s| s.len() > 4096)
    {
        return Err(
            "Query must be 1–4096 UTF-8 bytes; limit 1–50; cursor at most 4096 bytes".into(),
        );
    }
    Ok(())
}
