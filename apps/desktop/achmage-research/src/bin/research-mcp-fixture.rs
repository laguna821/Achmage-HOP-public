//! Owned protocol fixture, not a production server preset.
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
fn main() {
    for line in io::stdin().lock().lines() {
        let value: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let Some(id) = value.get("id") else { continue };
        let result = match value["method"].as_str().unwrap() {
            "initialize" => {
                json!({"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"owned-fixture","version":"1"}})
            }
            "tools/list" => json!({"tools":[{"name":"echo","inputSchema":{"type":"object"}}]}),
            "tools/call" => {
                json!({"content":[{"type":"text","text":value["params"]["arguments"]["text"]}],"isError":false})
            }
            _ => json!({}),
        };
        println!("{}", json!({"jsonrpc":"2.0","id":id,"result":result}));
        io::stdout().flush().unwrap();
    }
}
