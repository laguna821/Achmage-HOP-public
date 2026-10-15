use crate::{http, types::*};
use std::collections::BTreeMap;
pub(crate) fn validate_settings(id: &str, s: &SourceSettings) -> Result<(), String> {
    let d = definition(id)?;
    let fields = d["optionFields"].as_array().unwrap();
    if s.options.len() > 16
        || s.options.iter().any(|(k, v)| {
            v.len() > 4096
                || !(fields.iter().any(|f| f["id"] == *k)
                    || (d["protocol"] == "mcp" && k == "endpoint"))
        })
    {
        return Err("Unknown or oversized source option".into());
    }
    if id == "custom-mcp" {
        match s
            .options
            .get("transport")
            .map(String::as_str)
            .unwrap_or("streamable_http")
        {
            "stdio" => {
                stdio_registration(s)?.validate()?;
                if s.options.contains_key("endpoint") {
                    return Err("stdio cannot include an HTTP endpoint".into());
                }
                return Ok(());
            }
            "streamable_http" | "legacy_sse" => {
                if ["executable", "executable_sha256", "argv"].iter().any(|k| {
                    s.options
                        .get(*k)
                        .is_some_and(|v| !v.is_empty() && v != "[]")
                }) {
                    return Err("HTTP connection cannot include executable fields".into());
                }
            }
            _ => return Err("Unknown MCP transport".into()),
        }
    }
    if let Some(v) = s.options.get("endpoint") {
        if d["protocol"] == "mcp" {
            let endpoint = crate::mcp::validate_endpoint(v)?;
            if endpoint.query().is_some() {
                return Err("Store MCP credentials separately; endpoint must omit query".into());
            }
            if d["mcpPreset"].get("secretQueryParam").is_some() {
                let preset = url::Url::parse(d["mcpPreset"]["url"].as_str().unwrap()).unwrap();
                if endpoint.origin() != preset.origin() {
                    return Err("MCP credential origin mismatch".into());
                }
            }
            return Ok(());
        }
        http::approved_url(
            v,
            if id == "scienceon" {
                &["kisti.re.kr"]
            } else if id == "ntis" {
                &["ntis.go.kr"]
            } else {
                &[]
            },
        )?;
        if url::Url::parse(v).unwrap().query().is_some() {
            return Err("Approved endpoint must exclude query credentials".into());
        }
    }
    Ok(())
}
pub(crate) fn stdio_registration(
    settings: &SourceSettings,
) -> Result<crate::mcp_stdio::Registration, String> {
    let required = |name: &str| {
        settings
            .options
            .get(name)
            .cloned()
            .ok_or_else(|| format!("Missing MCP {name}"))
    };
    Ok(crate::mcp_stdio::Registration {
        executable: required("executable")?.into(),
        sha256: required("executable_sha256")?,
        argv: serde_json::from_str(&required("argv")?)
            .map_err(|_| "MCP argv must be a JSON string array")?,
    })
}
pub(crate) fn persist(
    path: &std::path::Path,
    settings: &BTreeMap<String, SourceSettings>,
) -> Result<(), String> {
    use std::io::Write;
    let parent = path.parent().ok_or("Settings path has no parent")?;
    std::fs::create_dir_all(parent).map_err(|_| "Settings directory unavailable")?;
    let bytes = serde_json::to_vec(settings).map_err(|_| "Settings serialization failed")?;
    // Unique sibling and atomic rename; Windows rename cannot replace so use platform ReplaceFile via tempfile.
    let mut file =
        tempfile::NamedTempFile::new_in(parent).map_err(|_| "Settings temporary file failed")?;
    file.write_all(&bytes)
        .and_then(|_| file.as_file().sync_all())
        .map_err(|_| "Settings write failed")?;
    file.persist(path)
        .map_err(|_| "Settings atomic commit failed")?;
    Ok(())
}
