use achmage_research::mcp::McpSession;
use serde_json::{json, Value};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};
use tokio_util::sync::CancellationToken;
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
#[tokio::test]
async fn initialize_session_sse_list_explicit_tool_and_close() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        for stage in 0..5 {
            let (mut s, _) = listener.accept().await.unwrap();
            let (h, v) = read(&mut s).await;
            if stage > 0 {
                assert!(h.to_lowercase().contains("mcp-session-id: owned-fixture"));
                assert!(h
                    .to_lowercase()
                    .contains("mcp-protocol-version: 2025-06-18"));
            }
            match stage {
                0 => {
                    assert_eq!(v["method"], "initialize");
                    send(&mut s,"200 OK","Content-Type: application/json\r\nMcp-Session-Id: owned-fixture\r\n",&json!({"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"fixture","version":"1"}}}).to_string()).await;
                }
                1 => {
                    assert_eq!(v["method"], "notifications/initialized");
                    assert!(v.get("id").is_none());
                    send(&mut s, "202 Accepted", "", "").await;
                }
                2 => {
                    assert_eq!(v["method"], "tools/list");
                    let body = format!(
                        "event: message\ndata: {}\n\n",
                        json!({"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"search","description":"한글😀","inputSchema":{"type":"object"}}]}})
                    );
                    send(
                        &mut s,
                        "200 OK",
                        "Content-Type: text/event-stream\r\n",
                        &body,
                    )
                    .await;
                }
                3 => {
                    assert_eq!(v["method"], "tools/call");
                    assert_eq!(v["params"]["arguments"]["query"], "한국어");
                    send(&mut s,"200 OK","Content-Type: application/json\r\n",&json!({"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"출처"}],"isError":false}}).to_string()).await;
                }
                4 => {
                    assert!(h.starts_with("DELETE "));
                    send(&mut s, "204 No Content", "", "").await;
                }
                _ => unreachable!(),
            }
        }
    });
    let cancel = CancellationToken::new();
    let mut c = McpSession::connect(&format!("http://{addr}/mcp"), None, &cancel)
        .await
        .unwrap();
    assert_eq!(
        c.list_tools(None, &cancel).await.unwrap()["tools"][0]["description"],
        "한글😀"
    );
    assert_eq!(
        c.call_tool("search", json!({"query":"한국어"}), &cancel)
            .await
            .unwrap()["content"][0]["text"],
        "출처"
    );
    c.close().await.unwrap();
    server.await.unwrap();
}
#[tokio::test]
async fn wrong_response_id_fails() {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let a = l.local_addr().unwrap();
    tokio::spawn(async move {
        let (mut s, _) = l.accept().await.unwrap();
        read(&mut s).await;
        send(
            &mut s,
            "200 OK",
            "Content-Type: application/json\r\n",
            r#"{"jsonrpc":"2.0","id":999,"result":{}}"#,
        )
        .await;
    });
    assert!(
        McpSession::connect(&format!("http://{a}"), None, &CancellationToken::new())
            .await
            .err()
            .unwrap()
            .contains("ID mismatch")
    );
}
#[tokio::test]
async fn legacy_sse_initialize_list_call_with_same_origin_endpoint() {
    use achmage_research::mcp_legacy::LegacySession;
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut stream, _) = l.accept().await.unwrap();
        let (h, _) = read(&mut stream).await;
        assert!(h.starts_with("GET /sse"));
        stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 999999\r\n\r\nevent: endpoint\ndata: /messages?session=owned\n\n").await.unwrap();
        for stage in 0..4 {
            let (mut post, _) = l.accept().await.unwrap();
            let (h, v) = read(&mut post).await;
            assert!(h.starts_with("POST /messages?session=owned"));
            send(&mut post, "202 Accepted", "", "").await;
            if stage == 1 {
                assert_eq!(v["method"], "notifications/initialized");
                continue;
            }
            let result = match stage {
                0 => {
                    json!({"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"owned","version":"1"}})
                }
                2 => json!({"tools":[{"name":"echo","inputSchema":{"type":"object"}}]}),
                _ => json!({"content":[{"type":"text","text":v["params"]["arguments"]["text"]}]}),
            };
            stream
                .write_all(
                    format!(
                        "event: message\ndata: {}\n\n",
                        json!({"jsonrpc":"2.0","id":v["id"],"result":result})
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        }
    });
    let cancel = CancellationToken::new();
    let mut session = LegacySession::connect(&format!("http://{addr}/sse"), None, &cancel)
        .await
        .unwrap();
    assert_eq!(
        session
            .request("tools/list", json!({}), &cancel)
            .await
            .unwrap()["tools"][0]["name"],
        "echo"
    );
    assert_eq!(
        session
            .request(
                "tools/call",
                json!({"name":"echo","arguments":{"text":"한글"}}),
                &cancel
            )
            .await
            .unwrap()["content"][0]["text"],
        "한글"
    );
    session.close();
    server.await.unwrap();
}
#[tokio::test]
async fn legacy_does_not_follow_cross_origin_post_event() {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move {
        let (mut s, _) = l.accept().await.unwrap();
        read(&mut s).await;
        send(
            &mut s,
            "200 OK",
            "Content-Type: text/event-stream\r\n",
            "event: endpoint\ndata: https://other.example/messages\n\n",
        )
        .await;
    });
    assert!(achmage_research::mcp_legacy::LegacySession::connect(
        &format!("http://{addr}/sse"),
        None,
        &CancellationToken::new()
    )
    .await
    .err()
    .unwrap()
    .contains("origin"));
}
