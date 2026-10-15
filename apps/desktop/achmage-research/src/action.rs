use crate::{types::*, ResearchService};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Action {
    Catalog {},
    Configure {
        #[serde(rename = "sourceId")]
        source_id: String,
        settings: SourceSettings,
    },
    SetSecret {
        #[serde(rename = "sourceId")]
        source_id: String,
        field: String,
        value: Option<String>,
    },
    Start {
        request: SearchRequest,
    },
    McpList {
        #[serde(rename = "sourceId")]
        source_id: String,
        cursor: Option<String>,
    },
    McpCall {
        #[serde(rename = "sourceId")]
        source_id: String,
        name: String,
        arguments: Value,
    },
    #[serde(rename = "oauth_start")]
    OAuthStart {
        #[serde(rename = "sourceId")]
        source_id: String,
    },
    #[serde(rename = "oauth_disconnect")]
    OAuthDisconnect {
        #[serde(rename = "sourceId")]
        source_id: String,
    },
    Poll {
        #[serde(rename = "jobId")]
        job_id: String,
    },
    Cancel {
        #[serde(rename = "jobId")]
        job_id: String,
    },
}
impl Action {
    pub fn job_id(&self) -> Option<&str> {
        match self {
            Self::Poll { job_id } | Self::Cancel { job_id } => Some(job_id),
            _ => None,
        }
    }
}
/// Outer desktop wrapper must authorize job/window ownership before dispatching Poll/Cancel.
pub fn dispatch(service: &Arc<ResearchService>, action: Action) -> Result<Value, String> {
    match action {
        Action::Catalog {} => Ok(service.catalog()),
        Action::Configure {
            source_id,
            settings,
        } => {
            service.configure(&source_id, settings)?;
            Ok(json!({"ok":true}))
        }
        Action::SetSecret {
            source_id,
            field,
            value,
        } => {
            service.set_secret(&source_id, &field, value)?;
            Ok(json!({"ok":true}))
        }
        Action::Start { request } => Ok(json!({"jobId":service.start(request)?})),
        Action::McpList { source_id, cursor } => Ok(
            json!({"jobId":service.start_mcp(source_id, crate::mcp_jobs::Operation::List { cursor })?}),
        ),
        Action::McpCall {
            source_id,
            name,
            arguments,
        } => Ok(
            json!({"jobId":service.start_mcp(source_id, crate::mcp_jobs::Operation::Call { name, arguments })?}),
        ),
        Action::OAuthStart { source_id } => Ok(json!({"jobId":service.start_oauth(source_id)?})),
        Action::OAuthDisconnect { source_id } => {
            service.disconnect_oauth(&source_id)?;
            Ok(json!({"ok":true}))
        }
        Action::Poll { job_id } => serde_json::to_value(service.poll(&job_id)?)
            .map_err(|_| "Research response serialization failed".into()),
        Action::Cancel { job_id } => {
            service.cancel(&job_id)?;
            Ok(json!({"ok":true}))
        }
    }
}
