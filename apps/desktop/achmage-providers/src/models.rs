//! Read the official CLI's initialize catalog without sending a user/inference turn.
use crate::{process, Config, Result};
use serde_json::{json, Value};
use std::{collections::HashSet, sync::atomic::AtomicBool, time::Duration};
const LIMIT: usize = 2 * 1024 * 1024;

pub(crate) fn document_args() -> Vec<String> {
    ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
     "--include-partial-messages", "--tools", "", "--strict-mcp-config", "--mcp-config",
     "{\"mcpServers\":{}}", "--disable-slash-commands", "--setting-sources", "", "--restricted",
     "--no-session-persistence"].into_iter().map(str::to_owned).collect()
}

pub(crate) fn query(cfg: &Config, cancel: &AtomicBool) -> Result<Value> {
    let frame = b"{\"type\":\"control_request\",\"request_id\":\"hop-models\",\"request\":{\"subtype\":\"initialize\",\"hooks\":{}}}\n";
    let mut bytes = Vec::new();
    let code = process::run(cfg, &document_args(), Some(frame), cancel, Duration::from_secs(30), None, |chunk| {
        if bytes.len() + chunk.len() > LIMIT { return Err("catalog_limit"); }
        bytes.extend_from_slice(chunk); Ok(())
    })?;
    if code != 0 { return Err("catalog_exit"); }
    parse(&bytes)
}
fn text<'a>(row: &'a Value, key: &str, max: usize) -> Result<&'a str> {
    row[key].as_str().filter(|s| !s.is_empty() && s.len() <= max && !s.chars().any(char::is_control)).ok_or("catalog_protocol")
}
fn parse(bytes: &[u8]) -> Result<Value> {
    if bytes.len() > LIMIT { return Err("catalog_limit"); }
    let mut found = None;
    for line in bytes.split(|b| *b == b'\n').filter(|l| !l.iter().all(u8::is_ascii_whitespace)) {
        let v: Value = serde_json::from_slice(line).map_err(|_| "catalog_protocol")?;
        if v["type"] != "control_response" { if v["type"] == "system" { continue; } return Err("catalog_protocol"); }
        let r = &v["response"];
        if r["request_id"] != "hop-models" || r["subtype"] != "success" || found.is_some() { return Err("catalog_protocol"); }
        let rows = r["response"]["models"].as_array().filter(|a| !a.is_empty() && a.len() <= 128).ok_or("catalog_protocol")?;
        let mut models = Vec::new(); let mut ids = HashSet::new();
        for row in rows {
            let id = text(row, "value", 128)?;
            if !id.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b)) || !ids.insert(id) { return Err("catalog_protocol"); }
            let name = text(row, "displayName", 256)?;
            let resolved = row.get("resolvedModel").and_then(Value::as_str).filter(|s| s.len() <= 128 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b)));
            let label = resolved.map_or_else(|| name.to_owned(), |r| format!("{name} · {r}"));
            models.push(json!({"id":id,"label":label,"provider":"claude","isDefault":id=="default","defaultReasoningEffort":"","supportedReasoningEfforts":[]}));
        }
        if !models.iter().any(|m| m["isDefault"] == true) { models[0]["isDefault"] = json!(true); }
        found = Some(json!(models));
    }
    found.ok_or("catalog_missing")
}
pub(crate) fn publish(state: &mut Value, result: Result<Value>) {
    match result {
        Ok(models) => { state["models"]=models; state["modelCatalogStatus"]=json!("ready"); state["modelCatalogMessage"]=Value::Null; }
        Err(_) => { state["models"]=json!([]); state["modelCatalogStatus"]=json!("error"); state["modelCatalogMessage"]=json!("Claude 모델 목록을 불러오지 못했습니다. CLI 업데이트 후 계정 메뉴에서 다시 불러오세요."); }
    }
}
#[cfg(test)]
mod tests {
 use super::*;
 fn frame(rows:Value)->Vec<u8>{serde_json::to_vec(&json!({"type":"control_response","response":{"request_id":"hop-models","subtype":"success","response":{"models":rows,"account":{"secret":"not exported"}}}})).unwrap()}
 #[test]fn catalog_uses_official_ids_and_drops_unrelated_account_data(){
  let models=parse(&frame(json!([{"value":"default","displayName":"Default","resolvedModel":"claude-new-model"},{"value":"opus","displayName":"Opus"}]))).unwrap();
  assert_eq!(models[0]["id"],"default");assert_eq!(models[0]["label"],"Default · claude-new-model");assert_eq!(models[0]["isDefault"],true);assert!(!models.to_string().contains("secret"));
 }
 #[test]fn rejects_duplicates_bad_ids_and_unexpected_frames(){
  for rows in [json!([]),json!([{"value":"a;bad","displayName":"A"}]),json!([{"value":"a","displayName":"A"},{"value":"a","displayName":"B"}])]{assert!(parse(&frame(rows)).is_err());}
  assert!(parse(b"{\"type\":\"control_request\"}").is_err());
 }
}
