use crate::normalize::{base, id, opt, plain};
use crate::types::*;
pub fn xml(source: &str, s: &str, limit: usize) -> Result<SearchResult, String> {
    // roxmltree does not fetch external entities; DTDs are rejected explicitly.
    if s.contains("<!DOCTYPE") || s.contains("<!ENTITY") {
        return Err("DTD/entity response unsupported".into());
    }
    let doc = roxmltree::Document::parse(s).map_err(|_| "Invalid XML response")?;
    let names = ["record", "item", "articleInfo", "result", "document"];
    let tag = names
        .iter()
        .find(|n| doc.descendants().any(|d| d.has_tag_name(**n)))
        .copied();
    let mut records = Vec::new();
    if let Some(tag) = tag {
        for n in doc
            .descendants()
            .filter(|n| n.has_tag_name(tag))
            .take(limit)
        {
            let get = |keys: &[&str]| -> String {
                for k in keys {
                    if let Some(t) = n
                        .descendants()
                        .find(|d| d.has_tag_name(*k))
                        .and_then(|d| d.text())
                    {
                        return plain(t);
                    }
                }
                String::new()
            };
            let binding = |key: &str| -> String {
                n.descendants()
                    .find(|d| {
                        d.has_tag_name("binding")
                            && d.attribute("name")
                                .is_some_and(|v| v.eq_ignore_ascii_case(key))
                    })
                    .and_then(|b| {
                        b.descendants()
                            .find_map(|c| c.text().filter(|s| !s.trim().is_empty()))
                    })
                    .unwrap_or("")
                    .trim()
                    .into()
            };
            let mut e = base(source);
            if source == "riss" {
                e.title = binding("title");
                e.url = binding("locator");
                if e.url.is_empty() {
                    e.url = binding("work");
                }
                e.authors = vec![binding("creator")];
                e.published_at = opt(binding("published"));
            } else {
                e.title = get(&[
                    "article-title",
                    "title",
                    "articleTitle",
                    "projectNm",
                    "name",
                ]);
                e.url = get(&["url", "link", "detailUrl"]);
                e.published_at = opt(get(&["pub-year", "pubYear", "year", "date"]));
                e.snippet = opt(get(&["abstract", "summary", "description"]));
                id(&mut e, "doi", get(&["doi", "DOI"]));
                id(
                    &mut e,
                    "sourceId",
                    get(&["article-id", "articleId", "projectId", "id"]),
                );
            }
            if e.url.is_empty() {
                if let Some(doi) = e.identifiers.get("doi") {
                    e.url = format!("https://doi.org/{doi}");
                }
            }
            if !matches!(
                url::Url::parse(&e.url)
                    .ok()
                    .map(|u| u.scheme().to_string())
                    .as_deref(),
                Some("http" | "https")
            ) {
                e.url.clear();
            }
            if !e.title.is_empty() {
                records.push(e);
            }
        }
    }
    let warnings = if tag.is_none() {
        vec![
            "No recognized records in XML; provider schema or empty result needs inspection."
                .into(),
        ]
    } else {
        vec![]
    };
    Ok(SearchResult {
        records,
        warnings,
        ..Default::default()
    })
}
