use achmage_research::{
    action,
    http::{Http, MAX_BODY},
    mcp, normalize,
    secrets::{MemorySecrets, SecretStore},
    types::*,
    ResearchService,
};
use serde_json::json;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
#[test]
fn registry_and_pack_references() {
    let r = registry();
    let sources = r["sources"].as_array().unwrap();
    assert_eq!(sources.len(), 13);
    assert_eq!(r["packs"].as_array().unwrap().len(), 7);
    for p in r["packs"].as_array().unwrap() {
        for id in p["sourceIds"].as_array().unwrap() {
            assert!(sources.iter().any(|s| s["id"] == *id));
        }
    }
}
#[test]
fn no_false_retraction_assurance() {
    let v = json!({"message":{"items":[{"title":["한글 <b>제목</b>"],"DOI":"10.1234/a","URL":"javascript:alert(1)"}]}});
    let r = normalize::json("crossref", &v, 10).unwrap();
    assert_eq!(r.records[0].title, "한글 제목");
    assert_eq!(r.records[0].editorial_status, "unknown");
    assert!(r.records[0].url.is_empty());
}
#[test]
fn public_metadata_mapping() {
    let v = json!({"resultList":{"result":[{"title":"A","pmid":"123","doi":"10.1/x","pubYear":"2024","authorString":"A, B"}]},"nextCursorMark":"abc"});
    let r = normalize::json("europe-pmc", &v, 1).unwrap();
    assert_eq!(r.records[0].identifiers["pmid"], "123");
    assert_eq!(r.next_cursor.as_deref(), Some("abc"));
    assert_eq!(r.records[0].authors.len(), 2);
}
#[test]
fn notice_target_does_not_mark_notice_retracted() {
    let value = json!({"message":{"items":[{"title":["Retraction notice"],"update-to":[{"type":"retraction","DOI":"10.1/target"}]}]}});
    let result = normalize::json("crossref", &value, 1).unwrap();
    assert_eq!(result.records[0].editorial_status, "unknown");
    assert!(result.records[0]
        .caveats
        .iter()
        .any(|c| c.contains("10.1/target")));
}
#[test]
fn mcp_explicit_settings_and_credential_origin() {
    let service = ResearchService::with_store(Arc::new(MemorySecrets::default())).unwrap();
    assert!(service
        .start_mcp(
            "kosis".into(),
            achmage_research::mcp_jobs::Operation::List { cursor: None }
        )
        .is_err());
    let settings = |endpoint: &str| SourceSettings {
        options: [("endpoint".into(), endpoint.into())].into(),
        ..Default::default()
    };
    assert!(service
        .configure("kosis", settings("http://127.0.0.1:1234/mcp"))
        .is_ok());
    assert!(service
        .configure("korean-law", settings("https://evil.example/mcp"))
        .is_err());
    assert!(service
        .configure(
            "korean-law",
            settings("https://mcp.gomdori.app/law?oc=secret")
        )
        .is_err());
    assert!(service
        .configure("korean-law", settings("https://mcp.gomdori.app/law"))
        .is_ok());
    assert!(service
        .start_mcp(
            "korean-law".into(),
            achmage_research::mcp_jobs::Operation::List { cursor: None }
        )
        .is_err());
}
#[test]
fn xml_dtd_and_namespace() {
    assert!(normalize::xml("kci", "<!DOCTYPE a><a/>", 2).is_err());
    let r=normalize::xml("kci","<root><articleInfo><article-title>한국어 😀</article-title><doi>10.1/a</doi></articleInfo></root>",2).unwrap();
    assert_eq!(r.records[0].title, "한국어 😀");
    assert_eq!(r.records[0].url, "https://doi.org/10.1/a");
}
#[test]
fn endpoint_boundaries() {
    use achmage_research::http::approved_url;
    assert!(approved_url("https://x.kisti.re.kr/api", &["kisti.re.kr"]).is_ok());
    for u in [
        "http://x.kisti.re.kr",
        "https://kisti.re.kr.evil.com",
        "https://key@kisti.re.kr",
        "https://kisti.re.kr:8443",
    ] {
        assert!(approved_url(u, &["kisti.re.kr"]).is_err());
    }
    assert!(mcp::validate_endpoint("http://127.0.0.1:1234/mcp").is_ok());
    assert!(mcp::validate_endpoint("http://example.com/mcp").is_err());
}
#[test]
fn settings_and_secret_separation() {
    let secrets = Arc::new(MemorySecrets::default());
    let service = ResearchService::with_store(secrets.clone()).unwrap();
    assert!(service
        .configure(
            "crossref",
            SourceSettings {
                options: [("api-key".into(), "secret".into())].into(),
                ..Default::default()
            }
        )
        .is_err());
    assert!(service
        .set_secret("crossref", "api-key", Some("secret".into()))
        .is_err());
    service
        .set_secret("naver", "api-key", Some("synthetic".into()))
        .unwrap();
    assert!(!service.catalog().to_string().contains("synthetic"));
    assert_eq!(
        secrets.get("naver", "api-key").unwrap().unwrap().as_str(),
        "synthetic"
    );
    service.set_secret("naver", "api-key", None).unwrap();
    assert!(secrets.get("naver", "api-key").unwrap().is_none());
}
#[test]
fn action_unknown_fields_rejected() {
    assert!(
        serde_json::from_value::<action::Action>(json!({"op":"catalog","token":"bad"})).is_err()
    );
    assert!(serde_json::from_value::<action::Action>(
        json!({"op":"start","request":{"sourceId":"crossref","query":"test","path":"bad"}})
    )
    .is_err());
}
#[test]
fn oauth_action_state_contract_and_settings_atomic_replace() {
    assert!(serde_json::from_value::<action::Action>(
        json!({"op":"oauth_start","sourceId":"custom-mcp"})
    )
    .is_ok());
    let state = serde_json::to_value(JobState::OAuthPending {
        authorization_url: "https://id.example/authorize?state=synthetic".into(),
    })
    .unwrap();
    assert_eq!(state["status"], "oauth_pending");
    assert!(state.get("authorizationUrl").is_some());
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("settings.json");
    let service = ResearchService::with_config(path.clone()).unwrap();
    for edition in ["WOS", "WOSCC"] {
        service
            .configure(
                "wos",
                SourceSettings {
                    options: [("editions".into(), edition.into())].into(),
                    ..Default::default()
                },
            )
            .unwrap();
    }
    let value: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(value["wos"]["options"]["editions"], "WOSCC");
    assert!(ResearchService::with_config(path).is_ok());
}
#[tokio::test]
async fn cancellation_stale_job() {
    let service = ResearchService::with_store(Arc::new(MemorySecrets::default())).unwrap();
    // A turned-on connection to a closed local port: the job starts, nothing leaves the computer.
    service
        .configure(
            "kosis",
            SourceSettings {
                options: [("endpoint".into(), "http://127.0.0.1:9/mcp".into())].into(),
                ..Default::default()
            },
        )
        .unwrap();
    let id = service
        .start(SearchRequest {
            source_id: "kosis".into(),
            query: "test".into(),
            limit: 1,
            cursor: None,
        })
        .unwrap();
    service.cancel(&id).unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    assert!(matches!(service.poll(&id).unwrap(), JobState::Cancelled));
}
#[test]
fn sse_multiline_unicode_and_id() {
    let bytes="event: message\ndata: {\"jsonrpc\":\"2.0\",\ndata: \"id\":7,\"result\":{\"text\":\"한글😀\"}}\n\n".as_bytes();
    assert_eq!(
        mcp::parse_sse(bytes, 7).unwrap().unwrap()["result"]["text"],
        "한글😀"
    );
    assert!(mcp::parse_sse(bytes, 8).unwrap().is_none());
    assert!(mcp::parse_sse(
        b"data: {\"id\":9,\"method\":\"sampling/createMessage\"}\n\n",
        7
    )
    .is_err());
}
#[tokio::test]
async fn response_cap_and_cancel() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let server = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = server.local_addr().unwrap();
    tokio::spawn(async move {
        let (mut s, _) = server.accept().await.unwrap();
        let mut b = [0; 4096];
        let _ = s.read(&mut b).await;
        let _ = s
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
                    MAX_BODY + 1
                )
                .as_bytes(),
            )
            .await;
    });
    let h = Http::new().unwrap();
    let client = reqwest::Client::new();
    let err = h
        .send(
            client.get(format!("http://{addr}")),
            &CancellationToken::new(),
        )
        .await
        .err()
        .unwrap();
    assert!(err.contains("4 MiB"));
    let t = CancellationToken::new();
    t.cancel();
    assert!(h.send(client.get("http://127.0.0.1:1"), &t).await.is_err());
}
