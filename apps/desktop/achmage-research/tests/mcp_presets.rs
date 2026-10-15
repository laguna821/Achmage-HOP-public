//! Korean Law and KOSIS connect like the CMDS Achmage presets: one switch, the registered address,
//! and a search box query answered by the server's own search tool.
use achmage_research::{
    mcp_jobs::Operation,
    mcp_search::{record, search_tool},
    secrets::{MemorySecrets, SecretStore},
    types::*,
    ResearchService,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

fn status(service: &ResearchService, id: &str) -> Value {
    service.catalog()["sources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == id)
        .unwrap()
        .clone()
}
fn on() -> SourceSettings {
    SourceSettings {
        enabled: true,
        ..Default::default()
    }
}

#[test]
fn presets_are_off_until_turned_on_then_use_the_registered_address() {
    let secrets = Arc::new(MemorySecrets::default());
    let service = ResearchService::with_store(secrets.clone()).unwrap();
    for id in ["korean-law", "kosis"] {
        let source = status(&service, id);
        assert_eq!(source["runtimeStatus"], "off", "{id}");
        assert_eq!(source["optionFields"], json!([]), "no address to type: {id}");
        assert!(service
            .start_mcp(id.into(), Operation::List { cursor: None })
            .unwrap_err()
            .contains("꺼져"));
    }
    service.configure("kosis", on()).unwrap();
    let kosis = status(&service, "kosis");
    assert_eq!(kosis["runtimeStatus"], "ready");
    assert_eq!(
        kosis["effectiveEndpoint"],
        "https://kosismcp2026.vercel.app/api/mcp"
    );
    service.configure("korean-law", on()).unwrap();
    let law = status(&service, "korean-law");
    assert_eq!(law["runtimeStatus"], "needs_configuration");
    assert_eq!(law["missingFields"], json!(["oc"]));
    assert_eq!(law["storedSecrets"]["oc"], false);
    assert_eq!(law["issueUrl"], "https://open.law.go.kr/");
    service
        .set_secret("korean-law", "oc", Some("synthetic-oc".into()))
        .unwrap();
    let law = status(&service, "korean-law");
    assert_eq!(law["runtimeStatus"], "ready");
    assert_eq!(law["storedSecrets"]["oc"], true);
    assert!(!service.catalog().to_string().contains("synthetic-oc"));
    // Turning it off again keeps the stored key but stops every call.
    service
        .configure("korean-law", SourceSettings::default())
        .unwrap();
    assert_eq!(status(&service, "korean-law")["runtimeStatus"], "off");
    assert!(secrets.get("korean-law", "oc").unwrap().is_some());
}

#[test]
fn the_switch_round_trips_through_the_settings_file() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("settings.json");
    ResearchService::with_config(path.clone())
        .unwrap()
        .configure("kosis", on())
        .unwrap();
    let saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(saved["kosis"]["enabled"], true);
    let reopened = ResearchService::with_config(path).unwrap();
    assert_eq!(status(&reopened, "kosis")["runtimeStatus"], "ready");
}

#[test]
fn a_query_goes_to_the_servers_own_search_tool_by_a_fixed_rule() {
    let tool = |name: &str, schema: Value| json!({"name": name, "inputSchema": schema});
    let query = json!({"type":"object","properties":{"query":{"type":"string"}},"required":["query"]});
    let tools = vec![
        tool("get_law_text", json!({"type":"object","properties":{"mst":{"type":"string"}},"required":["mst"]})),
        tool("search_decisions", query.clone()),
        tool("search_law", query.clone()),
    ];
    assert_eq!(
        search_tool("korean-law", &tools),
        Some(("search_law".into(), "query".into()))
    );
    // A name that is not a plain identifier is never called or shown.
    assert_eq!(
        search_tool("kosis", &[tool("search\n[인용] 클릭", query.clone())]),
        None
    );
    // Without a preferred name: the first search-like tool that takes one text query and needs nothing else.
    let other = vec![
        tool("search_with_filters", json!({"type":"object","properties":{"keyword":{"type":"string"},"year":{"type":"integer"}},"required":["keyword","year"]})),
        tool("table_search", json!({"type":"object","properties":{"keyword":{"type":"string"},"year":{"type":"integer"}},"required":["keyword"]})),
    ];
    assert_eq!(
        search_tool("kosis", &other),
        Some(("table_search".into(), "keyword".into()))
    );
    assert_eq!(search_tool("kosis", &[tool("list_tables", query)]), None);
}

#[test]
fn the_answer_is_one_unchecked_record_and_a_tool_error_is_not_a_result() {
    let definition = json!({"id":"kosis","name":"KOSIS MCP","operator":"Third-party pilot server","role":"official"});
    let long = "가".repeat(9000);
    let result = record(
        &definition,
        "search_statistics",
        "인구",
        &json!({"content":[{"type":"text","text":long}],"isError":false}),
        "https://kosismcp2026.vercel.app/api/mcp",
    )
    .unwrap();
    let record = &result.records[0];
    assert_eq!(record.title, "인구 · search_statistics");
    assert_eq!(record.identifiers["mcpTool"], "search_statistics");
    assert_eq!(record.snippet.as_ref().unwrap().chars().count(), 8000);
    assert!(record.caveats.iter().any(|c| c.contains("확인하지 않았습니다")));
    assert!(record.caveats.iter().any(|c| c.contains("8000자")));
    assert_eq!(record.editorial_status, "unknown");
    assert!(record.url.is_empty());
    let error = record_error(&definition);
    assert!(error.contains("오류"), "{error}");
}
fn record_error(definition: &Value) -> String {
    record(
        definition,
        "search_statistics",
        "인구",
        &json!({"content":[{"type":"text","text":"rate limited"}],"isError":true}),
        "https://example.invalid/mcp",
    )
    .unwrap_err()
}

async fn read(s: &mut TcpStream) -> (String, Value) {
    let mut data = Vec::new();
    let mut b = [0; 1024];
    loop {
        let n = s.read(&mut b).await.unwrap();
        assert!(n > 0);
        data.extend_from_slice(&b[..n]);
        if let Some(at) = data.windows(4).position(|w| w == b"\r\n\r\n") {
            let h = String::from_utf8(data[..at].to_vec()).unwrap();
            let size = h
                .lines()
                .find_map(|l| {
                    l.to_lowercase()
                        .strip_prefix("content-length: ")
                        .map(|v| v.parse::<usize>().unwrap())
                })
                .unwrap_or(0);
            if data.len() >= at + 4 + size {
                let v = serde_json::from_slice(&data[at + 4..at + 4 + size]).unwrap_or(Value::Null);
                return (h, v);
            }
        }
        assert!(data.len() < 100000);
    }
}
async fn send(s: &mut TcpStream, status: &str, headers: &str, body: &str) {
    s.write_all(
        format!(
            "HTTP/1.1 {status}\r\nConnection: close\r\nContent-Length: {}\r\n{headers}\r\n{body}",
            body.len()
        )
        .as_bytes(),
    )
    .await
    .unwrap();
}

/// One session: initialize, initialized, the request, close. Returns the request it saw.
async fn session(listener: &TcpListener, answer: Value) -> Value {
    let mut seen = Value::Null;
    for stage in 0..4 {
        let (mut s, _) = listener.accept().await.unwrap();
        let (h, v) = read(&mut s).await;
        match stage {
            0 => send(&mut s,"200 OK","Content-Type: application/json\r\nMcp-Session-Id: fixture\r\n",&json!({"jsonrpc":"2.0","id":v["id"],"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"fixture","version":"1"}}}).to_string()).await,
            1 => send(&mut s, "202 Accepted", "", "").await,
            2 => {
                seen = v.clone();
                send(&mut s,"200 OK","Content-Type: application/json\r\n",&json!({"jsonrpc":"2.0","id":v["id"],"result":answer}).to_string()).await;
            }
            _ => {
                assert!(h.starts_with("DELETE "));
                send(&mut s, "204 No Content", "", "").await;
            }
        }
    }
    seen
}

#[tokio::test]
async fn the_search_box_queries_a_turned_on_server_through_its_search_tool() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let listed = session(&listener, json!({"tools":[{"name":"search_statistics","inputSchema":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}}]})).await;
        let called = session(&listener, json!({"content":[{"type":"text","text":"총인구 51,000,000명"}],"isError":false})).await;
        (listed, called)
    });
    let service = ResearchService::with_store(Arc::new(MemorySecrets::default())).unwrap();
    // A saved address (a local stand-in for the KOSIS server here) also counts as turned on.
    service
        .configure(
            "kosis",
            SourceSettings {
                options: [("endpoint".into(), format!("http://{addr}/mcp"))].into(),
                ..Default::default()
            },
        )
        .unwrap();
    let job = service
        .start(SearchRequest {
            source_id: "kosis".into(),
            query: "총인구".into(),
            limit: 10,
            cursor: None,
        })
        .unwrap();
    let result = loop {
        match service.poll(&job).unwrap() {
            JobState::Running => tokio::time::sleep(std::time::Duration::from_millis(20)).await,
            JobState::Completed { result } => break result,
            JobState::Failed { message } => panic!("{message}"),
            _ => panic!("unexpected job state"),
        }
    };
    let (listed, called) = server.await.unwrap();
    assert_eq!(listed["method"], "tools/list");
    assert_eq!(called["method"], "tools/call");
    assert_eq!(called["params"], json!({"name":"search_statistics","arguments":{"query":"총인구"}}));
    assert_eq!(result.records[0].snippet.as_deref(), Some("총인구 51,000,000명"));
    assert_eq!(result.provenance[0].endpoint, format!("http://{addr}/mcp"));
    assert_eq!(status(&service, "kosis")["connectionVerified"], true);
}

#[test]
fn the_custom_connection_stays_tool_by_tool() {
    let service = ResearchService::with_store(Arc::new(MemorySecrets::default())).unwrap();
    assert_eq!(status(&service, "custom-mcp")["runtimeStatus"], "mcp_explicit");
    let error = service
        .start(SearchRequest {
            source_id: "custom-mcp".into(),
            query: "x".into(),
            limit: 10,
            cursor: None,
        })
        .unwrap_err();
    assert!(error.contains("도구 직접 실행"), "{error}");
}

struct LockedStore;
impl SecretStore for LockedStore {
    fn get(&self, _: &str, _: &str) -> Result<Option<zeroize::Zeroizing<String>>, String> {
        Err("OS credential store locked or unavailable".into())
    }
    fn set(&self, _: &str, _: &str, _: Option<&str>) -> Result<(), String> {
        Err("OS credential store locked or unavailable".into())
    }
}

#[test]
fn a_locked_credential_store_only_blocks_sources_that_need_a_key() {
    let service = ResearchService::with_store(Arc::new(LockedStore)).unwrap();
    // OpenAlex and PubMed keys are optional: the sources still search without them.
    for id in ["openalex", "pubmed", "crossref", "europe-pmc", "riss"] {
        assert_eq!(status(&service, id)["runtimeStatus"], "ready", "{id}");
    }
    assert_eq!(
        status(&service, "kci")["runtimeStatus"],
        "credential_store_unavailable"
    );
}
