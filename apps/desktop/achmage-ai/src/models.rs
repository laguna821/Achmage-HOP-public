//! Bounded official model/list catalogue. No credentials or inference calls.
use crate::{Id, process::ProcessFault};
use serde::Serialize;
use serde_json::{Value, json};
use std::{collections::HashSet, time::Instant};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningOption {
    pub reasoning_effort: String,
    pub description: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub id: Id,
    pub label: String,
    pub provider: &'static str,
    pub is_default: bool,
    pub default_reasoning_effort: String,
    pub supported_reasoning_efforts: Vec<ReasoningOption>,
}
#[derive(Debug, Clone, Serialize)]
pub struct CatalogView {
    pub status: &'static str,
    pub models: Vec<Model>,
    pub error_code: Option<&'static str>,
}
impl Default for CatalogView {
    fn default() -> Self {
        Self {
            status: "idle",
            models: vec![],
            error_code: None,
        }
    }
}
impl CatalogView {
    pub fn select(
        &self,
        model: Option<&str>,
        effort: Option<&str>,
    ) -> Result<(Id, Option<String>), &'static str> {
        if self.status != "ready" {
            return Err("모델 목록을 먼저 불러오세요.");
        }
        let selected = match model {
            Some(id) => self.models.iter().find(|m| m.id.as_str() == id),
            None => self.models.iter().find(|m| m.is_default),
        }
        .ok_or("공식 모델 목록에서 사용할 모델을 선택하세요.")?;
        if effort.is_some_and(|e| {
            !selected
                .supported_reasoning_efforts
                .iter()
                .any(|r| r.reasoning_effort == e)
        }) {
            return Err("선택한 모델이 지원하는 추론 강도를 선택하세요.");
        }
        Ok((selected.id.clone(), effort.map(str::to_owned)))
    }
}
pub(crate) struct Query {
    pub view: CatalogView,
    pub started: Instant,
    pending: Option<u64>,
    next_id: u64,
    pages: u8,
    rows: Vec<Model>,
    cursors: HashSet<String>,
    ids: HashSet<String>,
}
impl Query {
    pub fn new() -> Self {
        Self {
            view: CatalogView::default(),
            started: Instant::now(),
            pending: None,
            next_id: 100,
            pages: 0,
            rows: vec![],
            cursors: HashSet::new(),
            ids: HashSet::new(),
        }
    }
    pub fn begin(&mut self) -> Result<Value, ProcessFault> {
        let id = self.next_id;
        self.next_id = id.checked_add(1).ok_or(ProcessFault::Protocol)?;
        self.rows.clear();
        self.cursors.clear();
        self.ids.clear();
        self.pages = 0;
        self.started = Instant::now();
        self.view = CatalogView {
            status: "loading",
            models: vec![],
            error_code: None,
        };
        self.pending = Some(id);
        Ok(self.request(None))
    }
    fn request(&self, cursor: Option<&str>) -> Value {
        let mut params = json!({"limit":50,"includeHidden":false});
        if let Some(c) = cursor {
            params["cursor"] = json!(c);
        }
        json!({"id":self.pending,"method":"model/list","params":params})
    }
    pub fn fail(&mut self, code: &'static str) {
        self.pending = None;
        self.rows.clear();
        self.view = CatalogView {
            status: "error",
            models: vec![],
            error_code: Some(code),
        };
    }
    pub fn receive(&mut self, v: &Value) -> Option<Value> {
        if self.pending != v["id"].as_u64() || self.pending.is_none() {
            return None;
        }
        if v.get("error").is_some() {
            self.fail("catalog_rejected");
            return None;
        }
        match self.page(&v["result"]) {
            Ok(next) => next,
            Err(_) => {
                self.fail("catalog_protocol");
                None
            }
        }
    }
    fn page(&mut self, result: &Value) -> Result<Option<Value>, ProcessFault> {
        self.pages += 1;
        let rows = result["data"].as_array().ok_or(ProcessFault::Protocol)?;
        if rows.len() > 256 || self.ids.len() + rows.len() > 256 {
            return Err(ProcessFault::ResponseLimit);
        }
        for row in rows {
            let id = Id::new(text(&row["model"], 128)?).map_err(|_| ProcessFault::Protocol)?;
            if !self.ids.insert(id.as_str().into()) {
                return Err(ProcessFault::Protocol);
            }
            let hidden = row["hidden"].as_bool().ok_or(ProcessFault::Protocol)?;
            let options = row["supportedReasoningEfforts"]
                .as_array()
                .ok_or(ProcessFault::Protocol)?;
            if options.len() > 16 {
                return Err(ProcessFault::Protocol);
            }
            let mut efforts = HashSet::new();
            let mut supported = vec![];
            for option in options {
                let e = Id::new(text(&option["reasoningEffort"], 32)?)
                    .map_err(|_| ProcessFault::Protocol)?;
                if !efforts.insert(e.as_str().to_owned()) {
                    return Err(ProcessFault::Protocol);
                }
                supported.push(ReasoningOption {
                    reasoning_effort: e.as_str().into(),
                    description: text(&option["description"], 1024)?.into(),
                });
            }
            let default = text(&row["defaultReasoningEffort"], 32)?;
            if !efforts.contains(default) {
                return Err(ProcessFault::Protocol);
            }
            let model = Model {
                id,
                label: text(&row["displayName"], 256)?.into(),
                provider: "openai",
                is_default: row["isDefault"].as_bool().ok_or(ProcessFault::Protocol)?,
                default_reasoning_effort: default.into(),
                supported_reasoning_efforts: supported,
            };
            if !hidden {
                self.rows.push(model);
            }
        }
        if let Some(cursor) = result.get("nextCursor").filter(|v| !v.is_null()) {
            let cursor = text(cursor, 2048)?;
            if self.pages >= 16 || !self.cursors.insert(cursor.to_owned()) {
                return Err(ProcessFault::Protocol);
            }
            self.pending = Some(self.next_id);
            self.next_id = self.next_id.checked_add(1).ok_or(ProcessFault::Protocol)?;
            return Ok(Some(self.request(Some(cursor))));
        }
        if self.rows.is_empty() || self.rows.iter().filter(|m| m.is_default).count() > 1 {
            return Err(ProcessFault::Protocol);
        }
        self.pending = None;
        self.view = CatalogView {
            status: "ready",
            models: std::mem::take(&mut self.rows),
            error_code: None,
        };
        Ok(None)
    }
}
fn text(v: &Value, max: usize) -> Result<&str, ProcessFault> {
    v.as_str()
        .filter(|s| s.len() <= max && !s.chars().any(char::is_control))
        .ok_or(ProcessFault::Protocol)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn row(id: &str) -> Value {
        json!({"model":id,"displayName":id,"hidden":false,"isDefault":id=="m1","defaultReasoningEffort":"medium","supportedReasoningEfforts":[{"reasoningEffort":"medium","description":"default"},{"reasoningEffort":"high","description":"more"}]})
    }
    #[test]
    fn observed_official_empty_profile_catalog_is_accepted_without_invented_models() {
        let result: Value =
            serde_json::from_str(include_str!("../tests/schema/ObservedModelCatalog.json"))
                .unwrap();
        let mut q = Query::new();
        let request = q.begin().unwrap();
        q.receive(&json!({"id":request["id"],"result":result}));
        assert_eq!(q.view.status, "ready");
        assert_eq!(q.view.models.len(), 5);
        assert_eq!(q.view.select(None, None).unwrap().0.as_str(), "gpt-5.5");
        assert!(!q.view.models.iter().any(|m| m.id.as_str().contains("sol")));
    }
    #[test]
    fn pages_are_atomic_and_select_only_advertised_values() {
        let mut q = Query::new();
        let a = q.begin().unwrap();
        let b = q
            .receive(&json!({"id":a["id"],"result":{"data":[row("m1")],"nextCursor":"next"}}))
            .unwrap();
        assert!(q.view.models.is_empty());
        assert_eq!(q.view.status, "loading");
        q.receive(&json!({"id":b["id"],"result":{"data":[row("m2")],"nextCursor":null}}));
        assert_eq!(q.view.status, "ready");
        assert_eq!(q.view.models.len(), 2);
        assert_eq!(q.view.select(None, Some("high")).unwrap().0.as_str(), "m1");
        assert!(q.view.select(Some("not-advertised"), None).is_err());
        assert!(q.view.select(None, Some("invented-effort")).is_err());
    }
    #[test]
    fn repeated_cursor_duplicate_model_and_oversize_fail_closed() {
        for second in [
            json!({"data":[row("m1")]}),
            json!({"data":[row("m2")],"nextCursor":"loop"}),
            json!({"data":vec![row("m2");257]}),
        ] {
            let mut q = Query::new();
            let a = q.begin().unwrap();
            let b = q
                .receive(&json!({"id":a["id"],"result":{"data":[row("m1")],"nextCursor":"loop"}}))
                .unwrap();
            q.receive(&json!({"id":b["id"],"result":second}));
            assert_eq!(q.view.status, "error");
            assert!(q.view.models.is_empty());
        }
    }
    #[test]
    fn refresh_fences_late_previous_response() {
        let mut q = Query::new();
        let old = q.begin().unwrap();
        q.fail("catalog_timeout");
        let new = q.begin().unwrap();
        assert_ne!(old["id"], new["id"]);
        q.receive(&json!({"id":old["id"],"result":{"data":[row("old")]}}));
        assert_eq!(q.view.status, "loading");
        q.receive(&json!({"id":new["id"],"result":{"data":[row("m1")]}}));
        assert_eq!(q.view.models[0].id.as_str(), "m1");
    }
}
