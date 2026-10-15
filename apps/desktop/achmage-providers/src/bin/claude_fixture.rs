//! Synthetic test child. Never used as a production CLI.
use serde_json::json;
use std::{
    io::{Read, Write},
    path::PathBuf,
    time::Duration,
};
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let p = PathBuf::from(std::env::var_os("CLAUDE_CONFIG_DIR").unwrap());
    if std::env::var_os("ANTHROPIC_API_KEY").is_some() {
        std::process::exit(98)
    }
    if args == ["auth", "status", "--json"] {
        if p.join("fixture-wrong-status").exists() {
            println!(
                "{}",
                json!({"loggedIn":true,"authMethod":"claude.ai","configDirectory":std::env::current_dir().unwrap()})
            );
            return;
        }
        if p.join("fixture-api-status").exists() {
            println!(
                "{}",
                json!({"loggedIn":true,"authMethod":"api_key","configDirectory":p})
            );
            return;
        }
        let signed = p.join("fixture-signed").exists();
        let console = signed && std::fs::read(p.join("fixture-signed")).is_ok_and(|b| b == b"console");
        println!(
            "{}",
            json!({"loggedIn":signed,"authMethod":if signed{"claude.ai"}else{"none"},"apiKeySource":console.then_some("/login managed key"),"subscriptionType":(signed && !console).then_some("pro"),"configDirectory":p})
        );
        std::process::exit(if signed { 0 } else { 1 });
    }
    if args == ["auth", "login", "--claudeai"] || args == ["auth", "login", "--console"] {
        // If stdin has been closed, login cannot remain interactive.
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut b = [0];
            let n = std::io::stdin().read(&mut b).unwrap();
            let _ = tx.send(n);
        });
        if rx.recv_timeout(Duration::from_millis(80)).is_ok() {
            std::process::exit(91)
        }
        if p.join("fixture-login-wait").exists() {
            std::thread::sleep(Duration::from_secs(30));
            return;
        }
        let kind: &[u8] = if args[2] == "--console" { b"console" } else { b"synthetic" };
        std::fs::write(p.join("fixture-signed"), kind).unwrap();
        return;
    }
    assert!(args.windows(2).any(|a| a == ["--tools", ""]));
    assert!(args.windows(2).any(|a| a == ["--setting-sources", ""]));
    assert!(args.contains(&"--restricted".into()));
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    let v: serde_json::Value = serde_json::from_str(&input).unwrap();
    let prompt = v["message"]["content"].as_str().unwrap();
    if prompt == "WAIT" {
        std::thread::sleep(Duration::from_secs(30));
        return;
    }
    if prompt == "BAD" {
        println!("not json secret-token");
        return;
    }
    if prompt == "TOOL" {
        println!(
            "{}",
            json!({"type":"control_request","request":{"subtype":"can_use_tool"}})
        );
        return;
    }
    if prompt == "TRUNCATED" {
        print!("{{\"type\":\"system\"}}");
        return;
    }
    let text = format!("응답: {prompt}");
    for e in [
        json!({"type":"system","subtype":"init"}),
        json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":text}}}),
        json!({"type":"assistant","message":{"content":[{"type":"text","text":text}],"usage":{"input_tokens":0,"output_tokens":3}}}),
        json!({"type":"result","subtype":"success","result":text}),
    ] {
        let line = format!("{e}\n");
        for b in line.as_bytes().chunks(2) {
            std::io::stdout().write_all(b).unwrap();
            std::io::stdout().flush().unwrap();
        }
    }
}
