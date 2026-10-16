use crate::Result;
use serde_json::{json, Value};
#[derive(Default)]
pub(crate) struct Stream {
    buffer: Vec<u8>,
    pub text: String,
    pub usage: Value,
    pub completed: bool,
}
/// One stream-json line (an `assistant`/`result` frame holds the whole answer) and the answer text.
/// Memory bounds only: a 25-page Korean report must fit with room to spare.
pub(crate) const FRAME_LIMIT: usize = 32 * 1024 * 1024;
pub(crate) const TEXT_LIMIT: usize = 32 * 1024 * 1024;

impl Stream {
    pub fn push(&mut self, bytes: &[u8]) -> Result<()> {
        self.buffer.extend_from_slice(bytes);
        while let Some(i) = self.buffer.iter().position(|b| *b == b'\n') {
            if i > FRAME_LIMIT {
                return Err("frame_limit");
            }
            let line: Vec<_> = self.buffer.drain(..=i).collect();
            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            let value: Value = serde_json::from_slice(&line).map_err(|_| "invalid_stream")?;
            self.event(&value)?;
        }
        if self.buffer.len() > FRAME_LIMIT {
            return Err("frame_limit");
        };
        Ok(())
    }
    pub fn finish(&self) -> Result<()> {
        if !self.buffer.iter().all(u8::is_ascii_whitespace) {
            return Err("truncated_stream");
        }
        if !self.completed {
            return Err("missing_result");
        };
        Ok(())
    }
    fn event(&mut self, v: &Value) -> Result<()> {
        if self.completed {
            return Err("event_after_result");
        }
        match v["type"].as_str().ok_or("missing_event_type")? {
            "system" | "user" | "rate_limit_event" => {}
            "stream_event" => {
                let e = &v["event"];
                if e["type"] == "content_block_start" && e["content_block"]["type"] == "tool_use" {
                    return Err("tools_forbidden");
                }
                if e["type"] == "content_block_delta" && e["delta"]["type"] == "text_delta" {
                    let s = e["delta"]["text"].as_str().ok_or("invalid_delta")?;
                    if self.text.len() + s.len() > TEXT_LIMIT {
                        return Err("text_limit");
                    };
                    self.text.push_str(s);
                }
            }
            "assistant" => {
                let content = v["message"]["content"]
                    .as_array()
                    .ok_or("invalid_assistant")?;
                let mut snapshot = String::new();
                for block in content {
                    match block["type"].as_str() {
                        Some("text") => {
                            snapshot.push_str(block["text"].as_str().ok_or("invalid_text")?)
                        }
                        Some("thinking") | Some("redacted_thinking") => {}
                        _ => return Err("tools_forbidden"),
                    }
                }
                if snapshot.len() > TEXT_LIMIT {
                    return Err("text_limit");
                }
                // Snapshot is authoritative and prevents delta + assistant duplication.
                self.text = snapshot;
                self.usage = usage(&v["message"]["usage"])?;
            }
            "result" => {
                if v["subtype"] != "success" || v["is_error"].as_bool() == Some(true) {
                    return Err("provider_result_error");
                }
                if let Some(s) = v["result"].as_str() {
                    if s.len() > TEXT_LIMIT {
                        return Err("text_limit");
                    };
                    self.text = s.into();
                }
                if self.text.is_empty() {
                    return Err("empty_result");
                }
                if !v["usage"].is_null() {
                    self.usage = usage(&v["usage"])?
                }
                self.completed = true;
            }
            "control_request" | "control_response" => return Err("control_forbidden"),
            "auth_status" => {
                if v["error"].is_string() {
                    return Err("authentication_failed");
                }
            }
            _ => return Err("unknown_event"),
        };
        Ok(())
    }
}
fn usage(v: &Value) -> Result<Value> {
    fn n(v: &Value, key: &str) -> Result<Value> {
        match v.get(key) {
            None | Some(Value::Null) => Ok(Value::Null),
            Some(x) => x.as_u64().map(Value::from).ok_or("invalid_usage"),
        }
    }
    Ok(
        json!({"inputTokens":n(v,"input_tokens")?,"outputTokens":n(v,"output_tokens")?,"cacheReadTokens":n(v,"cache_read_input_tokens")?,"cacheCreationTokens":n(v,"cache_creation_input_tokens")?,"remainingPercent":null,"source":"official_cli_response"}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn chunked_unicode_and_snapshot() {
        let mut s = Stream::default();
        let b="{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"한글\"}}}\n{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"한글\"}],\"usage\":{\"input_tokens\":0}}}\n{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"한글\"}\n";
        for byte in b.as_bytes() {
            s.push(&[*byte]).unwrap()
        }
        s.finish().unwrap();
        assert_eq!(s.text, "한글");
        assert_eq!(s.usage["inputTokens"], 0);
        assert!(s.usage["outputTokens"].is_null());
    }
    #[test]
    fn malformed_tool_and_terminal() {
        for b in [
            b"notjson\n".as_slice(),
            b"{\"type\":\"control_request\"}\n",
            b"{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\"}]}}\n",
        ] {
            assert!(Stream::default().push(b).is_err())
        }
        let mut s = Stream::default();
        s.push(b"{\"type\":\"system\"}").unwrap();
        assert_eq!(s.finish(), Err("truncated_stream"));
    }
    #[test]
    fn rate_limit_notice_does_not_complete_or_fail_a_turn() {
        let mut s=Stream::default();
        s.push(b"{\"type\":\"rate_limit_event\",\"rate_limit_info\":{\"status\":\"allowed\"}}\n").unwrap();
        assert_eq!(s.finish(),Err("missing_result"));
        s.push(b"{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"OK\"}\n").unwrap();
        s.finish().unwrap();assert_eq!(s.text,"OK");
        let mut failed=Stream::default();
        assert_eq!(failed.push(b"{\"type\":\"result\",\"subtype\":\"error_during_execution\",\"is_error\":true}\n"),Err("provider_result_error"));
    }
    #[test]
    fn limits() {
        assert_eq!(
            Stream::default().push(&vec![b'a'; FRAME_LIMIT + 1]),
            Err("frame_limit")
        );
        assert!(usage(&json!({"input_tokens":-1})).is_err());
    }
}
