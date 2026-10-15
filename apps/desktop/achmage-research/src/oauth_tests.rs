use super::*;
use serde_json::json;
#[test]
fn pkce_rfc7636_known_vector() {
    assert_eq!(
        challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    );
}
#[test]
fn callback_state_duplicate_path_and_method_boundaries() {
    assert_eq!(
        parse_callback(
            "GET /oauth/callback?state=abc&code=owned HTTP/1.1\r\n\r\n",
            "abc"
        )
        .unwrap(),
        "owned"
    );
    for request in [
        "GET /oauth/callback?state=wrong&code=x HTTP/1.1",
        "GET /oauth/callback?state=abc&state=abc&code=x HTTP/1.1",
        "GET /oauth/callback?state=abc&code=x&code=y HTTP/1.1",
        "POST /oauth/callback?state=abc&code=x HTTP/1.1",
        "GET /wrong?state=abc&code=x HTTP/1.1",
    ] {
        assert!(parse_callback(request, "abc").is_err());
    }
}
#[test]
fn credential_binding_and_expiry_are_not_ignored() {
    let mut token = StoredToken {
        resource: "https://mcp.example/mcp".into(),
        client_id: "c".into(),
        issuer: "https://id.example".into(),
        expires_at: None,
        access_token: "synthetic-only".into(),
        refresh_token: None,
    };
    assert!(token.bearer("https://evil.example/mcp", "c").is_err());
    assert!(token.bearer("https://mcp.example/mcp", "other").is_err());
    assert_eq!(
        token
            .bearer("https://mcp.example/mcp", "c")
            .unwrap()
            .as_str(),
        "synthetic-only"
    );
    token.expires_at = Some(0);
    assert!(token.bearer("https://mcp.example/mcp", "c").is_err());
}
#[test]
fn protected_resource_challenge_and_https_boundary() {
    assert_eq!(
        challenge_metadata(
            "Bearer resource_metadata=\"https://mcp.example/.well-known/oauth-protected-resource\""
        ),
        Some("https://mcp.example/.well-known/oauth-protected-resource")
    );
    assert_eq!(
        challenge_metadata("Bearer realm=\"a\", resource_metadata=\"https://mcp.example/meta\""),
        Some("https://mcp.example/meta")
    );
    assert!(https("http://127.0.0.1/token").is_err());
    assert!(https("https://user@id.example/token").is_err());
}
fn metadata() -> Metadata {
    Metadata {
        resource: "https://mcp.example/mcp".parse().unwrap(),
        issuer: "https://id.example/tenant".parse().unwrap(),
        authorization: "https://id.example/authorize".parse().unwrap(),
        token: "https://id.example/token".parse().unwrap(),
    }
}
#[tokio::test]
async fn loopback_callback_and_actual_token_post_with_pkce_resource() {
    let token_server = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let token_addr = token_server.local_addr().unwrap();
    let mut auth = Authorization::begin(metadata(), "registered-fixture-client".into(), "read")
        .await
        .unwrap();
    let authorization: url::Url = auth.authorization_url.parse().unwrap();
    let q = authorization
        .query_pairs()
        .collect::<std::collections::HashMap<_, _>>();
    assert_eq!(q["code_challenge_method"], "S256");
    assert_eq!(q["resource"], "https://mcp.example/mcp");
    assert_eq!(q["code_challenge"], challenge(&auth.verifier));
    let redirect = q["redirect_uri"].to_string();
    let nonce = q["state"].to_string();
    let verifier = auth.verifier.to_string();
    // Private unit fixture only: production begin/discover rejects HTTP token endpoints.
    auth.metadata.token = format!("http://{token_addr}/token").parse().unwrap();
    let exchange = tokio::spawn(async move {
        let (mut stream, _) = token_server.accept().await.unwrap();
        let mut bytes = Vec::new();
        let mut chunk = [0; 2048];
        let body = loop {
            let n = stream.read(&mut chunk).await.unwrap();
            assert!(n > 0);
            bytes.extend_from_slice(&chunk[..n]);
            if let Some(at) = bytes.windows(4).position(|x| x == b"\r\n\r\n") {
                let headers = std::str::from_utf8(&bytes[..at]).unwrap();
                let length = headers
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .strip_prefix("content-length: ")
                            .and_then(|v| v.parse::<usize>().ok())
                    })
                    .unwrap();
                if bytes.len() >= at + 4 + length {
                    break bytes[at + 4..at + 4 + length].to_vec();
                }
            }
        };
        let values =
            url::form_urlencoded::parse(&body).collect::<std::collections::HashMap<_, _>>();
        assert_eq!(values["resource"], "https://mcp.example/mcp");
        assert_eq!(values["code_verifier"], verifier);
        assert_eq!(values["code"], "owned-code");
        let body =
            json!({"access_token":"synthetic-owned-token","token_type":"Bearer","expires_in":3600})
                .to_string();
        stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
    });
    let finish = tokio::spawn(async move { auth.finish(&CancellationToken::new()).await });
    let mut callback: url::Url = redirect.parse().unwrap();
    callback
        .query_pairs_mut()
        .append_pair("state", &nonce)
        .append_pair("code", "owned-code");
    assert!(reqwest::get(callback).await.unwrap().status().is_success());
    let stored = finish.await.unwrap().unwrap();
    assert_eq!(
        stored
            .bearer("https://mcp.example/mcp", "registered-fixture-client")
            .unwrap()
            .as_str(),
        "synthetic-owned-token"
    );
    exchange.await.unwrap();
}
#[tokio::test]
async fn cancellation_releases_callback_listener_without_token_exchange() {
    let auth = Authorization::begin(metadata(), "client".into(), "")
        .await
        .unwrap();
    let token = CancellationToken::new();
    token.cancel();
    assert!(auth
        .finish(&token)
        .await
        .err()
        .unwrap()
        .contains("cancelled"));
}
