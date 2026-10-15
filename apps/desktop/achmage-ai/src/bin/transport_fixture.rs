//! Controlled protocol fixture, NOT an AI provider. No network, login or document access.
use serde_json::{Value, json};
#[path = "../../tests/schema/validate.rs"]
mod schema;
use std::{
    io::{self, BufRead, Write},
    thread,
    time::Duration,
};
fn emit(v: Value, fragment: bool) {
    let mut b = serde_json::to_vec(&v).unwrap();
    b.push(b'\n');
    let mut o = io::stdout().lock();
    if fragment {
        for c in b.chunks(1) {
            o.write_all(c).unwrap();
            o.flush().unwrap();
        }
    } else {
        o.write_all(&b).unwrap();
        o.flush().unwrap();
    }
}
fn delta(text: &str) -> Value {
    json!({"method":"item/agentMessage/delta","params":{"threadId":"thread-fixture","turnId":"turn-fixture","itemId":"item-fixture","delta":text}})
}
fn done(status: &str) -> Value {
    json!({"method":"turn/completed","params":{"threadId":"thread-fixture","turn":{"id":"turn-fixture","status":status}}})
}
fn main() {
    let mode = std::env::args().nth(1).unwrap_or_else(|| "fragment".into());
    // Only the adapter's explicit non-secret environment should arrive.
    assert!(std::env::var_os("ACCESS_TOKEN").is_none());
    assert!(std::env::var_os("OPENAI_API_KEY").is_none());
    assert!(std::env::var_os("CODEX_HOME").is_some());
    if mode == "no-read" {
        thread::sleep(Duration::from_secs(20));
        return;
    }
    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let line = line.unwrap();
        let v: Value = serde_json::from_str(&line).unwrap();
        schema::request(&v);
        assert!(v.get("jsonrpc").is_none());
        match v["method"].as_str().unwrap_or("") {
            "initialize" => {
                assert_eq!(v["params"]["clientInfo"]["name"], "hangul_ai_session");
                emit(json!({"id":1,"result":{"userAgent":"fixture"}}), false);
            }
            "initialized" => {}
            "thread/start" => {
                // Enum values are independently checked from official generated schema above.
                let desktop: Value = serde_json::from_str(include_str!(
                    "../../tests/schema/DesktopThreadStartParams.json"
                ))
                .unwrap();
                assert!(schema::valid(&desktop, &v["params"], &desktop));
                let tool_config: Value = serde_json::from_str(include_str!(
                    "../../tests/schema/DocumentToolConfig.json"
                ))
                .unwrap();
                assert!(schema::valid(
                    &tool_config,
                    &v["params"]["config"],
                    &tool_config
                ));
                assert_eq!(v["params"]["ephemeral"], true);
                assert_eq!(v["params"]["sandbox"], "read-only");
                assert_eq!(v["params"]["approvalPolicy"], "untrusted");
                assert!(
                    v["params"]["baseInstructions"]
                        .as_str()
                        .unwrap()
                        .contains("drafting component")
                );
                assert!(
                    v["params"]["developerInstructions"]
                        .as_str()
                        .unwrap()
                        .contains("Do not call tools")
                );
                assert!(
                    v["params"]["developerInstructions"]
                        .as_str()
                        .unwrap()
                        .contains("Template and selected-format")
                );
                assert_eq!(v["params"]["config"]["features.shell_tool"], false);
                assert_eq!(v["params"]["config"]["features.apps"], false);
                assert_eq!(v["params"]["config"]["web_search"], "disabled");
                emit(
                    json!({"id":2,"result":{"thread":{"id":"thread-fixture"}}}),
                    false,
                );
            }
            "turn/start" => {
                assert_eq!(v["params"]["threadId"], "thread-fixture");
                assert_eq!(v["params"]["input"][0]["type"], "text");
                if mode == "early" {
                    emit(delta("선행"), true);
                }
                emit(
                    json!({"id":3,"result":{"turn":{"id":"turn-fixture","status":"inProgress"}}}),
                    false,
                );
                match mode.as_str() {
                    "burst-valid" | "burst-cancel" => {
                        for _ in 0..200 {
                            emit(delta("한"), false);
                        }
                        if mode == "burst-valid" {
                            emit(done("completed"), false);
                            return;
                        }
                    }
                    "document-draft" => {
                        emit(delta("{\"schemaVersion\":2,\"blocks\":[]}"), false);
                        emit(done("completed"), false);
                        return;
                    }
                    "slow-stream" => {
                        // Longer than the idle limit in total, but never silent for long.
                        for part in ["a", "b", "c", "d", "e", "f"] {
                            emit(delta(part), false);
                            thread::sleep(Duration::from_millis(150));
                        }
                        emit(done("completed"), false);
                        return;
                    }
                    "fragment" | "early" => {
                        eprintln!("FIXTURE_STDERR_SECRET_MUST_NOT_REACH_VIEW");
                        emit(delta("한글🦀e\u{301}"), true);
                        emit(done("completed"), true);
                        return;
                    }
                    "final-only" | "final-match" | "final-mismatch" => {
                        if mode != "final-only" {
                            emit(delta("prefix"), false);
                        }
                        emit(
                            json!({"method":"item/completed","params":{"threadId":"thread-fixture","turnId":"turn-fixture","item":{"type":"agentMessage","id":"item-fixture","text":if mode=="final-mismatch"{"different"}else{"prefix"}}}}),
                            false,
                        );
                        emit(done("completed"), false);
                        return;
                    }
                    "eof" => return,
                    "partial" => {
                        print!("{{\"method\":");
                        io::stdout().flush().unwrap();
                        return;
                    }
                    "utf8" => {
                        io::stdout().write_all(&[0xff, b'\n']).unwrap();
                        return;
                    }
                    "json" => {
                        println!("{{not-json}}");
                        return;
                    }
                    "long" => {
                        println!("{}", "x".repeat(300_000));
                        return;
                    }
                    "stderr" => {
                        let _ = io::stderr().write_all(&vec![b'e'; 100_000]);
                        thread::sleep(Duration::from_secs(20));
                        return;
                    }
                    "queue" => {
                        for _ in 0..200 {
                            emit(json!({"method":"fixture/ignored","params":{}}), false);
                        }
                        emit(done("completed"), false);
                        return;
                    }
                    "approval" => emit(
                        json!({"id":991,"method":"item/commandExecution/requestApproval","params":{"threadId":"thread-fixture","turnId":"turn-fixture"}}),
                        false,
                    ),
                    "unknown-request" => emit(
                        json!({"id":992,"method":"fixture/unknown","params":{}}),
                        false,
                    ),
                    "tool" | "mcp-tool" | "web-tool" => emit(
                        json!({"method":"item/started","params":{"threadId":"thread-fixture","turnId":"turn-fixture","item":{"type":if mode=="mcp-tool"{"mcpToolCall"}else if mode=="web-tool"{"webSearch"}else{"commandExecution"},"id":"tool"}}}),
                        false,
                    ),
                    "wrong-thread" => {
                        let mut d = delta("must-not-appear");
                        d["params"]["threadId"] = json!("other");
                        emit(d, false);
                    }
                    "multi-item" => {
                        emit(delta("first"), false);
                        let mut d = delta("second");
                        d["params"]["itemId"] = json!("other");
                        emit(d, false);
                    }
                    "failed" => {
                        emit(done("failed"), false);
                        return;
                    }
                    "interrupted" => {
                        emit(done("interrupted"), false);
                        return;
                    }
                    "cancel" | "ignore-cancel" => emit(delta("before-cancel"), false),
                    "response-limit" => {
                        // Just past MAX_RESPONSE_BYTES (32 MiB) in 1 MiB deltas.
                        for _ in 0..36 {
                            emit(delta(&"x".repeat(1_048_576)), false);
                            thread::sleep(Duration::from_millis(2));
                        }
                        return;
                    }
                    _ => thread::sleep(Duration::from_secs(20)),
                }
            }
            "turn/interrupt" => {
                if mode == "ignore-cancel" {
                    emit(delta("late-must-not-appear"), false);
                    continue;
                }
                assert_eq!(v["params"]["turnId"], "turn-fixture");
                emit(json!({"id":4,"result":{}}), false);
                emit(delta("late-must-not-appear"), false);
                emit(done("interrupted"), false);
                return;
            }
            _ => {}
        }
    }
}
