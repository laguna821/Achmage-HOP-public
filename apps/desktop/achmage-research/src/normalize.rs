//! CMDS adapters' field mappings, ported with conservative missing/status handling.
use crate::types::*;
use serde_json::Value;
pub fn text(v: &Value, paths: &[&str]) -> String {
    for path in paths {
        let mut at = v;
        for part in path.split('.') {
            at = if let Ok(n) = part.parse::<usize>() {
                at.get(n)
            } else {
                at.get(part)
            }
            .unwrap_or(&Value::Null);
        }
        let s = match at {
            Value::String(s) => s.clone(),
            Value::Number(n) => n.to_string(),
            _ => String::new(),
        };
        if !s.is_empty() {
            return plain(&s);
        }
    }
    String::new()
}
pub fn plain(s: &str) -> String {
    let mut tag = false;
    let mut out = String::new();
    for c in s.chars().take(20000) {
        if c == '<' {
            tag = true
        } else if c == '>' {
            tag = false
        } else if !tag {
            out.push(c)
        }
    }
    out.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .trim()
        .chars()
        .take(8000)
        .collect()
}
pub(crate) fn opt(s: String) -> Option<String> {
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}
fn arr<'a>(v: &'a Value, k: &str) -> Vec<&'a Value> {
    v.pointer(k)
        .and_then(Value::as_array)
        .map(|a| a.iter().collect())
        .unwrap_or_default()
}
pub fn base(id: &str) -> Evidence {
    let d = definition(id).unwrap();
    Evidence {
        source_id: id.into(),
        source_name: text(&d, &["name"]),
        operator: text(&d, &["operator"]),
        role: text(&d, &["role"]),
        retrieved_at: timestamp(),
        editorial_status: "unknown".into(),
        ..Default::default()
    }
}
pub(crate) fn id(e: &mut Evidence, k: &str, v: String) {
    if !v.is_empty() {
        e.identifiers.insert(k.into(), v);
    }
}
fn generic(v: &Value) -> Vec<&Value> {
    for k in [
        "hits",
        "documents",
        "records",
        "results",
        "items",
        "data",
        "list",
    ] {
        if let Some(a) = v[k].as_array() {
            return a.iter().collect();
        }
        if v[k].is_object() {
            let a = generic(&v[k]);
            if !a.is_empty() {
                return a;
            }
        }
    }
    Vec::new()
}
pub fn json(id_: &str, v: &Value, limit: usize) -> Result<SearchResult, String> {
    let items = match id_ {
        "crossref" => {
            let m = &v["message"];
            if m["items"].is_array() {
                arr(m, "/items")
            } else if m.is_object() {
                vec![m]
            } else {
                return Err("Crossref response schema mismatch".into());
            }
        }
        "openalex" => {
            if !v["results"].is_array() {
                return Err("OpenAlex response schema mismatch".into());
            }
            arr(v, "/results")
        }
        "europe-pmc" => {
            if !v["resultList"]["result"].is_array() {
                return Err("Europe PMC response schema mismatch".into());
            }
            arr(v, "/resultList/result")
        }
        "pubmed" => {
            let r = &v["result"];
            arr(r, "/uids")
                .iter()
                .filter_map(|i| r.get(i.as_str()?))
                .collect()
        }
        "opendart" => {
            if v["status"] == "013" {
                return Ok(SearchResult::default());
            }
            if v["status"] != "000" {
                return Err("OpenDART rejected the request".into());
            }
            arr(v, "/list")
        }
        _ => generic(v),
    };
    let mut records = Vec::new();
    for i in items.into_iter().take(limit) {
        let mut e = base(id_);
        e.title = text(
            i,
            &[
                "title.0",
                "title",
                "display_name",
                "report_nm",
                "projectNm",
                "articleTitle",
                "name",
            ],
        );
        e.url = text(
            i,
            &[
                "URL",
                "url",
                "originallink",
                "link",
                "links.record",
                "primary_location.landing_page_url",
                "id",
            ],
        );
        e.published_at = opt(text(
            i,
            &[
                "publication_date",
                "firstPublicationDate",
                "pubYear",
                "pubdate",
                "pubDate",
                "postdate",
                "rcept_dt",
                "source.publishYear",
                "year",
            ],
        ));
        e.publication_name = opt(text(
            i,
            &[
                "container-title.0",
                "journalTitle",
                "fulljournalname",
                "source.sourceTitle",
                "primary_location.source.display_name",
                "journal",
                "institution",
            ],
        ));
        e.snippet = opt(text(
            i,
            &["abstract", "abstractText", "description", "summary"],
        ));
        let doi = text(i, &["DOI", "doi"])
            .trim_start_matches("https://doi.org/")
            .to_string();
        id(&mut e, "doi", doi.clone());
        id(&mut e, "pmid", text(i, &["pmid"]));
        id(&mut e, "sourceId", text(i, &["id", "uid", "rcept_no"]));
        if !doi.is_empty() && e.url.is_empty() {
            e.url = format!("https://doi.org/{doi}");
        }
        e.authors = arr(i, "/author")
            .iter()
            .map(|a| {
                format!("{} {}", text(a, &["given"]), text(a, &["family"]))
                    .trim()
                    .to_string()
            })
            .filter(|s| !s.is_empty())
            .collect();
        if e.authors.is_empty() {
            e.authors = arr(i, "/authorships")
                .iter()
                .map(|a| text(a, &["author.display_name"]))
                .collect();
        }
        if e.authors.is_empty() {
            e.authors = arr(i, "/authors")
                .iter()
                .map(|a| text(a, &["name", "displayName"]))
                .collect();
        }
        if e.authors.is_empty() {
            let names = text(i, &["authorString"]);
            if !names.is_empty() {
                e.authors = names.split(", ").map(str::to_string).collect();
            }
        }
        match id_ {
            "crossref" => {
                e.published_at = i
                    .pointer("/published/date-parts/0")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().map(Value::to_string).collect::<Vec<_>>().join("-"));
                let updates = arr(i, "/update-to");
                for update in updates {
                    e.caveats.push(format!("Deposited update relation: {} → DOI {}. This relation does not establish the current record's editorial status.", text(&update, &["type"]), text(&update, &["DOI"])));
                }
                e.caveats.push("Editorial metadata describes deposited notices; absence of a notice is not proof the work is current or unretracted.".into());
            }
            "europe-pmc" => {
                let pmid = text(i, &["pmid"]);
                if !pmid.is_empty() {
                    e.url = format!("https://europepmc.org/article/MED/{pmid}");
                } else {
                    let source = text(i, &["source"]);
                    let uid = text(i, &["id"]);
                    if !source.is_empty() && !uid.is_empty() {
                        e.url = format!("https://europepmc.org/article/{source}/{uid}");
                    }
                }
            }
            "pubmed" => {
                let uid = text(i, &["uid"]);
                e.url = format!("https://pubmed.ncbi.nlm.nih.gov/{uid}/");
                id(&mut e, "pmid", uid);
                for a in arr(i, "/articleids") {
                    if a["idtype"] == "doi" {
                        id(&mut e, "doi", text(a, &["value"]));
                    }
                }
            }
            "opendart" => {
                e.title = format!("{} — {}", text(i, &["corp_name"]), e.title);
                e.url = format!(
                    "https://dart.fss.or.kr/dsaf001/main.do?rcpNo={}",
                    text(i, &["rcept_no"])
                );
            }
            "wos" => {
                id(&mut e, "wosUid", text(i, &["uid", "UT"]));
                e.caveats
                    .push("Requested edition is not proof of returned SSCI coverage.".into());
            }
            "naver" => e
                .caveats
                .push("Discovery snippet; not article-body verification.".into()),
            "openalex" => e
                .caveats
                .push("Discovery metadata; not subscription index entitlement.".into()),
            _ => {}
        }
        if url::Url::parse(&e.url).ok().is_none_or(|u| {
            !matches!(u.scheme(), "http" | "https")
                || !u.username().is_empty()
                || u.password().is_some()
        }) {
            e.url.clear();
            e.caveats
                .push("Source did not supply a safe record URL.".into());
        }
        if !e.title.is_empty() {
            records.push(e);
        }
    }
    Ok(SearchResult {
        records,
        next_cursor: opt(text(v, &["nextCursorMark", "meta.next_cursor"])),
        ..Default::default()
    })
}

pub use crate::normalize_xml::xml;
