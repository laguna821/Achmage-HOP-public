use crate::{
    http::{approved_url, Http},
    normalize,
    types::*,
};
use std::collections::BTreeMap;
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;
type Secrets = BTreeMap<String, Zeroizing<String>>;
fn key<'a>(s: &'a Secrets, k: &str) -> Result<&'a str, String> {
    s.get(k)
        .map(|v| v.as_str())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| format!("Missing credential: {k}"))
}
fn option<'a>(s: &'a SourceSettings, k: &str, d: &'a str) -> &'a str {
    s.options.get(k).map(String::as_str).unwrap_or(d)
}
pub async fn search(
    http: &Http,
    r: &SearchRequest,
    s: &SourceSettings,
    keys: &Secrets,
    cancel: &CancellationToken,
) -> Result<SearchResult, String> {
    let d = definition(&r.source_id)?;
    let source = r.source_id.as_str();
    if d["protocol"] == "mcp" {
        return Err(
            "This source requires an explicit MCP tool call; generic search is not inferred".into(),
        );
    }
    let raw = if matches!(source, "scienceon" | "ntis") {
        option(s, "endpoint", "")
    } else {
        d["endpoint"].as_str().unwrap_or("")
    };
    // Keep owned endpoint domain separate from the temporary URL above.
    let endpoint_host = url::Url::parse(raw)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_default();
    let allowed = if source == "scienceon" {
        vec!["kisti.re.kr"]
    } else if source == "ntis" {
        vec!["ntis.go.kr"]
    } else {
        vec![endpoint_host.as_str()]
    };
    let mut u = approved_url(raw, &allowed)?;
    let mut q: Vec<(String, String)> = Vec::new();
    let mut headers = Vec::new();
    let mut add = |k: &str, v: &str| {
        if !v.is_empty() {
            q.push((k.into(), v.into()));
        }
    };
    let limit = r.limit.to_string();
    match source {
        "crossref" => {
            let query = r.query.trim().trim_start_matches("https://doi.org/");
            if query.starts_with("10.")
                && query.contains('/')
                && !query.chars().any(char::is_whitespace)
            {
                u.path_segments_mut()
                    .map_err(|_| "DOI URL failed")?
                    .push(query);
            } else {
                add("query.bibliographic", &r.query);
                add("rows", &limit);
            }
            add("mailto", option(s, "mailto", ""));
        }
        "openalex" => {
            add("search", &r.query);
            add("per-page", &limit);
            add("cursor", r.cursor.as_deref().unwrap_or("*"));
            if let Some(k) = keys.get("api-key") {
                headers.push(("Authorization", format!("Bearer {}", k.as_str())));
            }
        }
        "europe-pmc" => {
            add("query", &r.query);
            add("format", "json");
            add("pageSize", &limit);
            add("cursorMark", r.cursor.as_deref().unwrap_or("*"));
        }
        "pubmed" => {
            add("db", "pubmed");
            add("term", &r.query);
            add("retmode", "json");
            add("retmax", &limit);
            add("tool", "AchmageHOP");
            add("email", option(s, "email", ""));
            if let Some(k) = keys.get("api-key") {
                add("api_key", k.as_str());
            }
        }
        "wos" => {
            add("db", "WOS");
            add("edition", option(s, "editions", "WOS+SSCI"));
            add(
                "q",
                &format!("TS=(\"{}\")", r.query.replace(['"', '\\'], " ")),
            );
            add("limit", &limit);
            add("page", r.cursor.as_deref().unwrap_or("1"));
            headers.push(("X-ApiKey", key(keys, "api-key")?.to_string()));
        }
        "kci" => {
            add("apiCode", "articleSearch");
            add("key", key(keys, "api-key")?);
            add("title", &r.query);
            add("displayCount", &limit);
        }
        "scienceon" | "ntis" => {
            add(
                option(
                    s,
                    "query-param",
                    if source == "ntis" {
                        "searchWord"
                    } else {
                        "query"
                    },
                ),
                &r.query,
            );
            add(
                option(
                    s,
                    "key-param",
                    if source == "ntis" { "apprvKey" } else { "key" },
                ),
                key(keys, "api-key")?,
            );
            add("displayCount", &limit);
        }
        "riss" => {
            let terms: Vec<_> = r
                .query
                .split(|c: char| !c.is_alphanumeric())
                .filter(|s| !s.is_empty())
                .take(6)
                .collect();
            if terms.is_empty() {
                return Err("RISS query needs letters or digits".into());
            }
            let filter = terms
                .iter()
                .map(|s| {
                    format!(
                        "regex(?title, \"{}\")",
                        s.chars()
                            .map(|c| if c.is_ascii_alphabetic() {
                                format!("[{}{}]", c.to_ascii_lowercase(), c.to_ascii_uppercase())
                            } else {
                                c.to_string()
                            })
                            .collect::<String>()
                    )
                })
                .collect::<Vec<_>>()
                .join(" || ");
            add("query",&format!("SELECT ?work ?title ?creator ?published ?locator WHERE {{ ?work <http://purl.org/dc/elements/1.1/title> ?title . ?work <http://schema.org/author> ?creator . ?work <http://purl.org/dc/terms/date> ?published . ?work <http://purl.org/ontology/bibo/locator> ?locator . FILTER ({filter}) . }} LIMIT {}",r.limit.min(20)));
            add("type", "Xml");
            add("flag", "none");
        }
        "opendart" => {
            if r.query.len() != 8 || !r.query.bytes().all(|c| c.is_ascii_digit()) {
                return Err("OpenDART requires an 8-digit corporation code; unrestricted name search is not supported".into());
            }
            add("crtfc_key", key(keys, "api-key")?);
            add("corp_code", &r.query);
            add(
                "bgn_de",
                &(chrono::Utc::now() - chrono::Duration::days(365))
                    .format("%Y%m%d")
                    .to_string(),
            );
            add("end_de", &chrono::Utc::now().format("%Y%m%d").to_string());
            add("page_count", &limit);
        }
        "naver" => {
            let vertical = option(s, "vertical", "news");
            if !["news", "webkr", "blog"].contains(&vertical) {
                return Err("Unknown NAVER vertical".into());
            }
            let legacy = option(s, "credential-service", "api-hub") == "legacy-developers";
            u = if legacy {
                url::Url::parse(&format!(
                    "https://openapi.naver.com/v1/search/{vertical}.json"
                ))
                .unwrap()
            } else {
                url::Url::parse(&format!("{raw}/{vertical}")).unwrap()
            };
            add("query", &r.query);
            add("display", &limit);
            add("start", r.cursor.as_deref().unwrap_or("1"));
            add("sort", "sim");
            if !legacy {
                add("format", "json");
            }
            headers.push((
                if legacy {
                    "X-Naver-Client-Id"
                } else {
                    "X-NCP-APIGW-API-KEY-ID"
                },
                key(keys, "key-id")?.into(),
            ));
            headers.push((
                if legacy {
                    "X-Naver-Client-Secret"
                } else {
                    "X-NCP-APIGW-API-KEY"
                },
                key(keys, "api-key")?.into(),
            ));
        }
        _ => return Err("Unsupported source".into()),
    }
    u.query_pairs_mut()
        .extend_pairs(q.iter().map(|(k, v)| (k, v)));
    let mut req = http.client.get(u);
    for (k, v) in headers {
        req = req.header(k, v);
    }
    let first = http.send(req, cancel).await?;
    let mut provenance = vec![first.provenance];
    let mut body = first.text;
    if source == "pubmed" {
        let v: serde_json::Value =
            serde_json::from_str(&body).map_err(|_| "Invalid PubMed search JSON")?;
        let ids = v
            .pointer("/esearchresult/idlist")
            .and_then(|v| v.as_array())
            .ok_or("PubMed search schema mismatch")?
            .iter()
            .filter_map(|v| v.as_str())
            .take(r.limit)
            .collect::<Vec<_>>();
        if ids.is_empty() {
            return Ok(SearchResult {
                provenance,
                ..Default::default()
            });
        }
        if ids.iter().any(|s| !s.bytes().all(|c| c.is_ascii_digit())) {
            return Err("Invalid PubMed ID".into());
        }
        let mut u =
            url::Url::parse("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi").unwrap();
        u.query_pairs_mut().extend_pairs([
            ("db", "pubmed"),
            ("retmode", "json"),
            ("id", &ids.join(",")),
            ("tool", "AchmageHOP"),
        ]);
        if let Some(k) = keys.get("api-key") {
            u.query_pairs_mut().append_pair("api_key", k.as_str());
        }
        let second = http.send(http.client.get(u), cancel).await?;
        provenance.push(second.provenance);
        body = second.text;
    }
    let mut result = if body.trim_start().starts_with('<') {
        normalize::xml(source, &body, r.limit)?
    } else {
        normalize::json(
            source,
            &serde_json::from_str(&body).map_err(|_| "Invalid JSON response")?,
            r.limit,
        )?
    };
    result.provenance = provenance;
    Ok(result)
}
