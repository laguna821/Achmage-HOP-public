//! Built-in document templates for documents made from Telegram, where no window is open to run the
//! panel's code. `remote-templates.json` is the panel's own template data and authoring prompt,
//! kept identical by `remote-templates.test.ts` in the studio.

use serde::Deserialize;
use serde_json::Value;
use std::sync::OnceLock;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteTemplate {
    pub id: String,
    pub name: String,
    pub description: String,
    /// The template exactly as the panel sends it to the Kordoc engine.
    pub template: Value,
    /// The panel's authoring prompt without its last line, `사용자 요청: <JSON string>`.
    pub prompt_prefix: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Catalog {
    schema_version: u32,
    templates: Vec<RemoteTemplate>,
}

pub(crate) fn all() -> &'static [RemoteTemplate] {
    static CATALOG: OnceLock<Vec<RemoteTemplate>> = OnceLock::new();
    CATALOG.get_or_init(|| {
        match serde_json::from_str::<Catalog>(include_str!("remote-templates.json")) {
            Ok(catalog) if catalog.schema_version == 1 => catalog.templates,
            _ => Vec::new(),
        }
    })
}

/// Used when the request names no document kind: Kordoc's plain document style.
pub(crate) const DEFAULT: &str = "builtin-kordoc-default";

/// Words that pick a template, most specific first. Matched without spaces.
pub(crate) const KINDS: &[(&[&str], &str)] = &[
    (&["일송", "자유교양"], "builtin-hallym-ilsong"),
    (&["ai융합연구원"], "builtin-hallym-aicr"),
    (&["언론학회"], "builtin-korean-communication"),
    (&["청소년학"], "builtin-youth-studies"),
    (&["업무보고"], "builtin-ministry"),
    (&["개조식"], "builtin-gaejosik"),
    (&["방침서"], "builtin-bangchim"),
    (&["보도자료"], "builtin-press"),
    (&["회의록"], "builtin-minutes"),
    (&["기안문", "시행문", "공문"], "builtin-government"),
    (&["통지문", "안내문", "통지서"], "builtin-notice"),
    (&["계획서", "추진계획", "계획안"], "builtin-plan"),
    (&["보고서"], "builtin-report"),
];

fn compact(text: &str) -> String {
    text.to_lowercase().split_whitespace().collect()
}

/// Whether the text names a document kind (`회의록`, `보고서` …).
pub(crate) fn names_kind(text: &str) -> bool {
    let text = compact(text);
    KINDS
        .iter()
        .any(|(words, _)| words.iter().any(|word| text.contains(word)))
}

pub(crate) fn by_id(id: &str) -> Option<&'static RemoteTemplate> {
    all().iter().find(|template| template.id == id)
}

/// The template a request asks for, else the default.
pub(crate) fn choose(request: &str) -> Option<&'static RemoteTemplate> {
    let text = compact(request);
    let id = KINDS
        .iter()
        .find(|(words, _)| words.iter().any(|word| text.contains(word)))
        .map_or(DEFAULT, |(_, id)| id);
    by_id(id).or_else(|| by_id(DEFAULT))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kordoc_process::validate_request;
    use serde_json::json;

    #[test]
    fn embedded_catalog_has_every_routed_template_and_valid_engine_requests() {
        assert!(all().len() >= 10, "embedded catalog missing");
        for (_, id) in KINDS {
            assert!(by_id(id).is_some(), "{id}");
        }
        assert!(by_id(DEFAULT).is_some());
        for template in all() {
            assert!(template.prompt_prefix.contains("Markdown"), "{}", template.id);
            assert!(!template.prompt_prefix.contains("사용자 요청:"), "{}", template.id);
            let request = json!({"id": "t", "op": "generate", "template": template.template, "markdown": "# 제목\n\n본문"});
            assert!(validate_request(&request).is_ok(), "{}", template.id);
        }
    }

    #[test]
    fn requests_pick_their_kind_or_the_default() {
        let id = |text: &str| choose(text).map(|t| t.id.as_str());
        assert_eq!(id("3월 학과 회의록 만들어 줘"), Some("builtin-minutes"));
        assert_eq!(id("일송자유교양대학 회의록"), Some("builtin-hallym-ilsong"));
        assert_eq!(id("신규 사업 추진 계획서"), Some("builtin-plan"));
        assert_eq!(id("AI 융합연구원 보고서"), Some("builtin-hallym-aicr"));
        assert_eq!(id("보도 자료 써줘"), Some("builtin-press"));
        assert_eq!(id("짧은 글"), Some(DEFAULT));
        assert!(names_kind("공문 써 줘") && !names_kind("오늘 날씨"));
    }
}
