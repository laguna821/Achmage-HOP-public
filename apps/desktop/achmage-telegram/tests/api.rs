mod common;

use achmage_telegram::{
    api::{MAX_BODY, MAX_FILE_NAME_CHARS},
    sanitize_file_name,
    secrets::TOKEN_ACCOUNT,
    split_message, BotApi, BotToken, Error, MemorySecrets, SecretStore, MAX_MESSAGE_LEN,
};
use common::*;
use serde_json::json;

fn token() -> BotToken {
    BotToken::parse(TOKEN).unwrap()
}

#[test]
fn token_shape_is_validated_without_echoing_input() {
    assert!(BotToken::parse(TOKEN).is_ok());
    assert!(BotToken::parse(&format!("  {TOKEN}\n")).is_ok());
    let secret = "A".repeat(35);
    let bad = [
        String::new(),
        "no-colon-here".into(),
        format!("1234:{}", "A".repeat(34)),
        format!(":{secret}"),
        format!("12a4:{secret}"),
        format!("1234:{secret}!"),
        format!("1234:B {secret}"),
        format!("1234:{secret}:extra"),
        format!("1234:{}é", "A".repeat(40)),
    ];
    for raw in &bad {
        let error = BotToken::parse(raw).unwrap_err();
        assert_eq!(error, Error::MalformedToken);
        let shown = format!("{error} {error:?}");
        assert!(raw.is_empty() || !shown.contains(raw.as_str()));
        assert!(!shown.contains(&secret));
    }
}

#[test]
fn debug_output_never_contains_the_token() {
    let shown = format!("{:?}", token());
    assert_no_token(&shown);
    assert!(!shown.contains("1234567890"));
    let api = BotApi::with_base_url(token(), "http://127.0.0.1:9").unwrap();
    let shown = format!("{api:?}");
    assert_no_token(&shown);
    assert!(shown.contains("127.0.0.1"));
}

#[test]
fn token_round_trips_through_the_secret_store() {
    let store = MemorySecrets::default();
    assert!(BotToken::load(&store).unwrap().is_none());
    assert_eq!(BotApi::from_store(&store).unwrap_err(), Error::MissingToken);
    token().save(&store).unwrap();
    assert!(BotToken::load(&store).unwrap().is_some());
    assert!(BotApi::from_store(&store).is_ok());
    store.set(TOKEN_ACCOUNT, "tampered").unwrap();
    assert_eq!(BotToken::load(&store).unwrap_err(), Error::MalformedToken);
    BotToken::clear(&store).unwrap();
    assert!(store.get(TOKEN_ACCOUNT).unwrap().is_none());
    BotToken::clear(&store).unwrap();
}

#[test]
fn plain_http_is_refused_except_on_loopback() {
    for base in [
        "http://api.telegram.org",
        "http://192.168.0.10:8081",
        "ftp://127.0.0.1",
        "https://user:pw@api.telegram.org",
        "https://api.telegram.org/?x=1",
        "https://api.telegram.org/#frag",
        "not a url",
    ] {
        assert_eq!(
            BotApi::with_base_url(token(), base).unwrap_err(),
            Error::InsecureBaseUrl,
            "{base}"
        );
    }
    for base in [
        "https://api.telegram.org",
        "http://127.0.0.1:8081",
        "http://localhost:8081",
        "http://[::1]:8081",
    ] {
        assert!(BotApi::with_base_url(token(), base).is_ok(), "{base}");
    }
    assert!(BotApi::new(token()).is_ok());
}

#[tokio::test]
async fn get_me_returns_the_bot_identity() {
    let mock = MockTelegram::start().await;
    let me = mock.api().get_me().await.unwrap();
    assert_eq!(me.id, 42);
    assert_eq!(me.username, "hop_test_bot");
    assert_eq!(me.first_name, "HOP");
    assert_eq!(mock.requests("getMe")[0].path, format!("/bot{TOKEN}/getMe"));
}

#[tokio::test]
async fn http_errors_map_to_distinct_variants() {
    let mock = MockTelegram::start().await;
    let api = mock.api();

    mock.respond(
        "getMe",
        401,
        r#"{"ok":false,"error_code":401,"description":"Unauthorized"}"#,
    );
    let error = api.get_me().await.unwrap_err();
    assert_eq!(error, Error::InvalidToken);
    assert_no_token(&format!("{error} {error:?}"));

    mock.respond("getMe", 409, r#"{"ok":false,"error_code":409,"description":"Conflict: terminated by other getUpdates request"}"#);
    assert_eq!(api.get_me().await.unwrap_err(), Error::Conflict);

    mock.respond("getMe", 429, r#"{"ok":false,"error_code":429,"description":"Too Many Requests: retry after 7","parameters":{"retry_after":7}}"#);
    assert_eq!(
        api.get_me().await.unwrap_err(),
        Error::RateLimited { retry_after: 7 }
    );

    // Even if Telegram echoed the token, the description shown to the UI must not carry it.
    let echo = json!({"ok": false, "error_code": 400, "description": format!("Bad Request: bot{TOKEN} rejected")});
    mock.respond("getMe", 400, &echo.to_string());
    let error = api.get_me().await.unwrap_err();
    assert!(matches!(error, Error::Telegram { code: 400, .. }));
    assert_no_token(&format!("{error} {error:?}"));

    mock.respond("getMe", 502, "<html>bad gateway</html>");
    assert_eq!(api.get_me().await.unwrap_err(), Error::InvalidResponse);
}

#[tokio::test]
async fn oversized_bodies_are_rejected() {
    let mock = MockTelegram::start().await;
    let api = mock.api();
    let big = format!(r#"{{"ok":true,"result":"{}"}}"#, "x".repeat(MAX_BODY + 1));
    mock.respond("getMe", 200, &big);
    assert_eq!(api.get_me().await.unwrap_err(), Error::ResponseTooLarge);
    // Without Content-Length the cap is enforced while streaming.
    mock.respond_unbounded("getMe", 200, &big);
    assert_eq!(api.get_me().await.unwrap_err(), Error::ResponseTooLarge);
}

#[tokio::test]
async fn get_updates_asks_only_for_messages_and_tolerates_odd_payloads() {
    let mock = MockTelegram::start().await;
    mock.push_updates(vec![
        json!({"update_id": 7, "edited_message": {"message_id": 1}}),
        json!({"update_id": 6, "message": {"unexpected": true}}),
        private_text(5, OWNER, "안녕"),
    ]);
    let updates = mock.api().get_updates(5, 0).await.unwrap();
    let ids: Vec<i64> = updates.iter().map(|u| u.update_id).collect();
    assert_eq!(ids, [5, 6, 7]);
    assert_eq!(
        updates[0].message.as_ref().unwrap().text.as_deref(),
        Some("안녕")
    );
    assert!(updates[1].message.is_none() && updates[2].message.is_none());
    let body = &mock.requests("getUpdates")[0].body;
    assert_eq!(body["allowed_updates"], json!(["message"]));
    assert_eq!(body["offset"], 5);
    assert_eq!(body["timeout"], 0);
}

#[test]
fn long_text_is_split_on_character_boundaries_preferring_line_breaks() {
    let short = "짧은 답변";
    assert_eq!(split_message(short), vec![short.to_string()]);
    assert!(split_message("").is_empty());

    let flat = "가".repeat(10_000);
    let sizes: Vec<usize> = split_message(&flat)
        .iter()
        .map(|p| p.chars().count())
        .collect();
    assert_eq!(sizes, [4096, 4096, 1808]);

    let lines: String = (0..200)
        .map(|i| format!("{i:03} {}\n", "나".repeat(60)))
        .collect();
    let parts = split_message(&lines);
    assert!(parts.len() > 1);
    for part in &parts {
        assert!(part.chars().count() <= MAX_MESSAGE_LEN);
        assert!(part.ends_with('\n'));
    }
    assert_eq!(parts.concat(), lines);

    // Astral characters count twice in Telegram's UTF-16 limit and are never cut in half.
    let emoji = "😀".repeat(5000);
    let parts = split_message(&emoji);
    assert!(parts
        .iter()
        .all(|p| p.encode_utf16().count() <= MAX_MESSAGE_LEN));
    assert_eq!(parts.concat(), emoji);
}

#[tokio::test]
async fn empty_text_is_not_sent() {
    let mock = MockTelegram::start().await;
    assert_eq!(
        mock.api().send_message(OWNER, " \n ").await.unwrap_err(),
        Error::EmptyMessage
    );
    assert!(mock.requests("sendMessage").is_empty());
}

#[test]
fn file_names_are_sanitized_and_keep_their_extension() {
    assert_eq!(sanitize_file_name("report.pdf"), "report.pdf");
    assert_eq!(sanitize_file_name("../../etc/passwd"), "passwd");
    assert_eq!(sanitize_file_name(r"C:\Users\me\보고서.hwpx"), "보고서.hwpx");
    assert_eq!(
        sanitize_file_name("a\u{0}b\r\n\u{202E}fdp.exe"),
        "abfdp.exe"
    );
    assert_eq!(sanitize_file_name(r#"x:"y"<z>|?*.txt"#), "xyz.txt");
    assert_eq!(sanitize_file_name(".."), "document");
    assert_eq!(sanitize_file_name("dir/"), "document");
    let long = format!("{}.docx", "긴".repeat(300));
    let short = sanitize_file_name(&long);
    assert_eq!(short.chars().count(), MAX_FILE_NAME_CHARS);
    assert!(short.ends_with(".docx"));
}
