//! A query typed into the research box, answered by a turned-on MCP server's own search tool. The user
//! starts every call; the tool is chosen by the fixed rule below (never by a model) and is named in the result.
use crate::{
    mcp_jobs::{Operation, Target},
    types::*,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

/// Names a search tool's text query usually has.
const QUERY_NAMES: [&str; 9] = [
    "query",
    "keyword",
    "keywords",
    "q",
    "search",
    "searchTerm",
    "search_term",
    "term",
    "text",
];
/// The longest tool answer shown in one record; the whole answer stays available through a direct tool call.
const SHOWN_CHARS: usize = 8000;

/// The search tool a preset server is known for, tried before the general rule.
fn preferred(source: &str) -> &'static [&'static str] {
    match source {
        "korean-law" => &["search_law", "search_laws", "law_search"],
        "kosis" => &["search_statistics", "search_kosis", "search_tables"],
        _ => &[],
    }
}

/// The text parameter a plain query goes to, when the tool needs nothing else.
fn query_argument(tool: &Value) -> Option<String> {
    let schema = &tool["inputSchema"];
    let properties = schema["properties"].as_object()?;
    let argument = QUERY_NAMES
        .iter()
        .find(|name| properties.get(**name).is_some_and(|p| p["type"] == "string"))?;
    let other_required = schema["required"]
        .as_array()
        .is_some_and(|required| required.iter().any(|r| r.as_str() != Some(argument)));
    (!other_required).then(|| argument.to_string())
}

/// A tool name the app will call and show: letters, digits and `_ . -`, at most 64 characters.
fn plain_name(name: &str) -> bool {
    (1..=64).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
}

/// The tool and argument for a query: a preferred name first, else the first tool named like a search
/// that takes one text query. None when the server offers no such tool.
pub fn search_tool(source: &str, tools: &[Value]) -> Option<(String, String)> {
    let tools: Vec<&Value> = tools
        .iter()
        .filter(|t| t["name"].as_str().is_some_and(plain_name))
        .collect();
    for name in preferred(source) {
        if let Some(argument) = tools
            .iter()
            .find(|t| t["name"] == *name)
            .and_then(|t| query_argument(t))
        {
            return Some((name.to_string(), argument));
        }
    }
    tools
        .iter()
        .filter(|t| {
            t["name"]
                .as_str()
                .is_some_and(|n| n.to_ascii_lowercase().contains("search"))
        })
        .find_map(|t| Some((t["name"].as_str()?.to_string(), query_argument(t)?)))
}

/// The tool's answer as one record: its text as written, marked as an unchecked third-party result.
pub fn record(
    definition: &Value,
    tool: &str,
    query: &str,
    result: &Value,
    endpoint: &str,
) -> Result<SearchResult, String> {
    let text = result["content"]
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter(|p| p["type"] == "text")
                .filter_map(|p| p["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
        .trim()
        .to_string();
    if result["isError"] == true {
        let reason: String = text.chars().take(300).collect();
        return Err(format!("MCP 도구가 오류로 답했습니다: {reason}"));
    }
    let now = timestamp();
    let provenance = Provenance {
        endpoint: endpoint.into(),
        response_sha256: format!("{:x}", Sha256::digest(serde_json::to_vec(result).unwrap())),
        status: 200,
        retrieved_at: now.clone(),
    };
    if text.is_empty() {
        return Ok(SearchResult {
            warnings: vec![format!("'{tool}' 도구가 결과 없이 답했습니다.")],
            provenance: vec![provenance],
            ..Default::default()
        });
    }
    let shown: String = text.chars().take(SHOWN_CHARS).collect();
    let name = definition["name"].as_str().unwrap_or_default().to_string();
    let operator = definition["operator"].as_str().unwrap_or_default().to_string();
    let mut caveats = vec![format!(
        "운영: {operator}. 이 서버의 '{tool}' 도구가 돌려준 글이며, 앱은 내용을 확인하지 않았습니다."
    )];
    if shown.len() < text.len() {
        caveats.push(format!(
            "앞의 {SHOWN_CHARS}자만 보였습니다. 전체는 연결 설정의 도구 직접 실행으로 볼 수 있습니다."
        ));
    }
    Ok(SearchResult {
        records: vec![Evidence {
            source_id: definition["id"].as_str().unwrap_or_default().into(),
            source_name: name.clone(),
            operator,
            // A third-party server's answer, whatever the data it is built on.
            role: "external".into(),
            title: format!("{query} · {tool}"),
            url: String::new(),
            retrieved_at: now,
            published_at: None,
            identifiers: [("mcpTool".to_string(), tool.to_string())].into(),
            snippet: Some(shown),
            authors: Vec::new(),
            publication_name: Some(name),
            editorial_status: "unknown".into(),
            caveats,
        }],
        warnings: Vec::new(),
        next_cursor: None,
        provenance: vec![provenance],
        cache_hit: false,
    })
}

/// Lists the server's tools, calls its search tool with the query, and returns the answer as a record.
pub(crate) async fn search(
    target: &Target,
    definition: &Value,
    request: &SearchRequest,
    token: &CancellationToken,
) -> Result<SearchResult, String> {
    let (listed, _) = target.run(Operation::List { cursor: None }, token).await?;
    let tools = listed["tools"].as_array().cloned().unwrap_or_default();
    let (tool, argument) = search_tool(&request.source_id, &tools).ok_or(
        "이 서버에서 검색어 하나로 쓰는 검색 도구를 찾지 못했습니다. 연결 설정의 도구 직접 실행을 쓰세요.",
    )?;
    let (answer, _) = target
        .run(
            Operation::Call {
                name: tool.clone(),
                arguments: json!({ argument: request.query }),
            },
            token,
        )
        .await?;
    record(
        definition,
        &tool,
        &request.query,
        &answer,
        &target.shown_endpoint(),
    )
}
