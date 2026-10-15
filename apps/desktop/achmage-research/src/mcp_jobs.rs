//! User-selected MCP operations share the desktop's existing window-owned job contract.
use crate::{mcp::McpSession, types::*, Job, ResearchService};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub enum Operation {
    List { cursor: Option<String> },
    Call { name: String, arguments: Value },
}
impl ResearchService {
    pub fn start_mcp(
        self: &Arc<Self>,
        source: String,
        operation: Operation,
    ) -> Result<String, String> {
        let definition = definition(&source)?;
        if definition["protocol"] != "mcp" {
            return Err("Source is not an MCP connection".into());
        }
        match &operation {
            Operation::List { cursor } if cursor.as_ref().is_some_and(|c| c.len() > 4096) => {
                return Err("MCP cursor exceeds 4096 bytes".into())
            }
            Operation::Call { name, arguments }
                if name.is_empty()
                    || name.len() > 256
                    || !arguments.is_object()
                    || serde_json::to_vec(arguments)
                        .map_err(|_| "Invalid MCP arguments")?
                        .len()
                        > 65536 =>
            {
                return Err("Invalid or oversized MCP tool arguments".into())
            }
            _ => {}
        }
        let mut s = self.state.lock().unwrap();
        let settings = s
            .settings
            .get(&source)
            .cloned()
            .ok_or("Save an explicit MCP connection before connecting")?;
        let transport = settings
            .options
            .get("transport")
            .map(String::as_str)
            .unwrap_or("streamable_http")
            .to_owned();
        let registration = if transport == "stdio" {
            Some(crate::settings::stdio_registration(&settings)?)
        } else {
            None
        };
        let mut endpoint = if registration.is_none() {
            Some(crate::mcp::validate_endpoint(
                settings
                    .options
                    .get("endpoint")
                    .ok_or("Save an explicit MCP endpoint before connecting")?,
            )?)
        } else {
            None
        };
        if let Some(param) = definition["mcpPreset"].get("secretQueryParam") {
            // Existing credentials can never be redirected to an arbitrary changed endpoint.
            let preset = url::Url::parse(definition["mcpPreset"]["url"].as_str().unwrap()).unwrap();
            let endpoint = endpoint
                .as_mut()
                .ok_or("Credential requires HTTP transport")?;
            if endpoint.origin() != preset.origin() {
                return Err(
                    "This credential is restricted to its registered provider origin".into(),
                );
            }
            let key = self
                .secrets
                .get(&source, param["secretFieldId"].as_str().unwrap())?
                .ok_or("MCP provider credential is missing")?;
            endpoint
                .query_pairs_mut()
                .append_pair(param["name"].as_str().unwrap(), &key);
        }
        let bearer = if let Some(endpoint) = &endpoint {
            self.oauth_bearer(
                &source,
                endpoint.as_str(),
                settings
                    .options
                    .get("oauth_client_id")
                    .map(String::as_str)
                    .unwrap_or(""),
            )?
        } else {
            None
        };
        if s.jobs.values().filter(|j| j.state.active()).count() >= 8 {
            return Err("At most eight concurrent operations".into());
        }
        if s.jobs.len() >= 64 {
            if let Some(key) = s
                .jobs
                .iter()
                .find(|(_, j)| !j.state.active())
                .map(|(k, _)| k.clone())
            {
                s.jobs.remove(&key);
            }
        }
        s.next = s.next.checked_add(1).ok_or("Job counter exhausted")?;
        let id = s.next.to_string();
        let generation = s.generation;
        let token = CancellationToken::new();
        s.jobs.insert(
            id.clone(),
            Job {
                state: JobState::Running,
                token: token.clone(),
            },
        );
        drop(s);
        let service = self.clone();
        let job_id = id.clone();
        tokio::spawn(async move {
            let result = async {
                let (method,params)=match &operation {
                    Operation::List {cursor} => ("tools/list",cursor.as_ref().map(|cursor|json!({"cursor":cursor})).unwrap_or_else(||json!({}))),
                    Operation::Call {name,arguments} => ("tools/call",json!({"name":name,"arguments":arguments})),
                };
                let (result,closed)=if let Some(registration)=registration {
                    let mut session=crate::mcp_stdio::StdioSession::connect(&registration,&token).await?;
                    let result=session.request(method,params,&token).await;let closed=session.close().await.is_ok();(result,closed)
                }else if transport=="legacy_sse"{
                    let mut session=crate::mcp_legacy::LegacySession::connect(endpoint.as_ref().unwrap().as_str(),bearer.as_ref().map(|b|b.to_string()),&token).await?;
                    let result=session.request(method,params,&token).await;session.close();(result,true)
                }else{
                    let mut session = McpSession::connect(endpoint.as_ref().unwrap().as_str(), bearer.as_ref().map(|b|b.to_string()), &token).await?;
                    let result = match operation {
                        Operation::List { cursor } => session.list_tools(cursor, &token).await,
                        Operation::Call { name, arguments } => session.call_tool(&name, arguments, &token).await,
                    };let closed=session.close().await.is_ok();(result,closed)
                };
                let value = result?;
                let hash = format!("{:x}", Sha256::digest(serde_json::to_vec(&value).unwrap()));
                if let Some(endpoint)=endpoint.as_mut(){endpoint.set_query(None);}
                Ok::<_,String>(json!({"sourceId":source,"transport":transport,"endpoint":endpoint.as_ref().map(|e|e.as_str()).unwrap_or("registered-local-executable"),"retrievedAt":timestamp(),"resultSha256":hash,"result":value,"sessionCloseConfirmed":closed,"untrusted":true,"automaticRetry":false}))
            }.await;
            let mut s = service.state.lock().unwrap();
            if token.is_cancelled() || s.generation != generation {
                return;
            }
            s.verified.insert(source, result.is_ok());
            if let Some(job) = s.jobs.get_mut(&job_id) {
                job.state = match result {
                    Ok(result) => JobState::McpCompleted { result },
                    Err(message) => JobState::Failed { message },
                };
            }
        });
        Ok(id)
    }
}
