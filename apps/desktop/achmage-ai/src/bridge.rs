//! Desktop IPC projection. Provider credentials and login URLs never enter state JSON.
use crate::{
    Id, TurnStatus, TurnTicket,
    controller::*,
    managed::*,
    process::{LaunchConfig, TurnDiagnostic},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::time::Duration;

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Action {
    RestoreConnection {},
    RefreshModels {},
    SelectProvider {
        provider: String,
    },
    BeginLogin {},
    /// Claude only: sign in through the official CLI with an Anthropic Console account (API usage billing)
    /// instead of a Claude subscription. Other providers treat it as `BeginLogin`.
    BeginConsoleLogin {},
    CancelLogin {},
    Logout {},
    Send {
        prompt: String,
        #[serde(rename = "requestId")]
        request_id: String,
        model: Option<String>,
        #[serde(rename = "reasoningEffort")]
        reasoning_effort: Option<String>,
    },
    CancelTurn {
        #[serde(rename = "turnId")]
        turn_id: String,
    },
}

struct RequestBinding {
    id: String,
    command: u64,
    prior_ticket: Option<TurnTicket>,
    accepted_ticket: Option<TurnTicket>,
    failed: bool,
}

pub struct Host {
    config: Option<LaunchConfig>,
    controller: Option<DesktopAiController>,
    latest: Option<DesktopAiView>,
    selected: String,
    generation: u64,
    projection: Value,
    request: Option<RequestBinding>,
    login_url: Option<String>,
    notice: Option<String>,
    restoring: bool,
}

impl Host {
    /// Fence another window after an app-level account disconnect, without
    /// issuing a second provider logout or resetting the UI generation.
    pub fn disconnect_local(&mut self) {
        self.controller = None;
        self.latest = None;
        self.request = None;
        self.login_url = None;
        self.restoring = false;
        self.notice = Some("계정 연결이 해제되었습니다.".into());
    }
    pub fn new(config: Option<LaunchConfig>) -> Self {
        Self {
            config,
            controller: None,
            latest: None,
            selected: "openai".into(),
            generation: 0,
            projection: Value::Null,
            request: None,
            login_url: None,
            notice: None,
            restoring: false,
        }
    }

    pub fn state(&mut self) -> Value {
        if let Some(update) = self.controller.as_mut().and_then(|c| c.poll()) {
            if let Some(request) = &mut self.request {
                if let Some(outcome) = update.view.last_command.filter(|c| c.id == request.command)
                {
                    if outcome.result.is_err() {
                        request.failed = true;
                        request.accepted_ticket = None;
                    } else if !request.failed && request.accepted_ticket.is_none() {
                        if let Some(turn) = &update.view.coordinator.turn {
                            if request.prior_ticket.as_ref() != Some(&turn.ticket) {
                                request.accepted_ticket = Some(turn.ticket.clone());
                            }
                        }
                    }
                }
            }
            if update.view.fatal.is_some() {
                self.notice =
                    Some("AI 실행기를 시작하지 못했습니다. 실행 파일과 앱을 확인하세요.".into());
                self.login_url = None;
            }
            if let Some(prompt) = update.prompt {
                prompt.with_user_display(|method, url, _| {
                    if method == LoginMethod::Browser && valid_login_url(url) {
                        self.login_url = Some(url.to_owned());
                    } else {
                        self.notice = Some(
                            "공식 로그인 주소를 확인하지 못했습니다. 취소 후 다시 시도하세요."
                                .into(),
                        );
                    }
                });
            }
            if !matches!(
                update.view.auth.as_ref().map(|a| a.status),
                Some(AuthStatus::Starting | AuthStatus::AwaitingUser | AuthStatus::CheckingAccount)
            ) {
                self.login_url = None;
            }
            self.latest = Some(update.view);
        }
        let next = self.project();
        if self.projection != next {
            self.generation = self.generation.saturating_add(1);
            self.projection = next;
        }
        let mut state = self.projection.clone();
        state["generation"] = json!(self.generation);
        state
    }

    pub fn take_login_url(&mut self) -> Option<String> {
        self.login_url.take()
    }
    pub fn browser_failed(&mut self) {
        self.notice = Some("로그인 브라우저를 열지 못했습니다. 취소 후 다시 시도하세요.".into());
    }

    pub fn action(&mut self, expected: u64, action: Action) -> Result<Value, String> {
        // Compare the last delivered generation before polling asynchronous changes.
        if expected != self.generation {
            return Err("AI 상태가 변경되었습니다. 다시 시도하세요.".into());
        }
        match action {
            Action::RefreshModels {} => {
                self.require_openai()?;
                self.controller
                    .as_mut()
                    .ok_or("먼저 로그인하세요.")?
                    .refresh_models()
                    .map_err(safe_error)?;
            }
            Action::RestoreConnection {} => {
                self.require_openai()?;
                if self.controller.is_none() {
                    if let Some(mut config) = self.config.clone().filter(|c| c.persistent_auth) {
                        config.resume_only = true;
                        let mut controller = DesktopAiController::new(
                            Id::new("openai").unwrap(),
                            Id::new("hop-desktop").unwrap(),
                            config,
                            LoginMethod::Browser,
                            Duration::from_secs(600),
                        )
                        .map_err(safe_error)?;
                        controller.login(None).map_err(safe_error)?;
                        self.controller = Some(controller);
                        self.restoring = true;
                    }
                }
            }
            Action::SelectProvider { provider } => {
                if !["openai", "claude", "gemini", "grok"].contains(&provider.as_str()) {
                    return Err("알 수 없는 제공자입니다.".into());
                }
                if self.busy() {
                    return Err("진행 중인 로그인이나 응답을 먼저 취소하세요.".into());
                }
                self.selected = provider;
                self.notice = None;
            }
            Action::BeginLogin {} | Action::BeginConsoleLogin {} => {
                self.require_openai()?;
                if self.restoring && !self.busy() {
                    self.controller = None;
                    self.latest = None;
                    self.restoring = false;
                }
                if self.latest.as_ref().is_some_and(|v| v.fatal.is_some()) {
                    self.controller = None;
                    self.latest = None;
                }
                if self.controller.is_none() {
                    let cfg = self
                        .config
                        .clone()
                        .ok_or("Codex 실행 파일이 준비되지 않았습니다.")?;
                    self.controller = Some(
                        DesktopAiController::new(
                            Id::new("openai").unwrap(),
                            Id::new("hop-desktop").unwrap(),
                            cfg,
                            LoginMethod::Browser,
                            Duration::from_secs(600),
                        )
                        .map_err(safe_error)?,
                    );
                }
                match self.controller.as_mut().unwrap().login(None) {
                    // A worker that could not start its CLI (e.g. a missing executable) has already
                    // recorded the fatal error; the state reports it instead of a generic failure.
                    // Which side of that race a login lands on depends on scheduling.
                    Ok(_) | Err(DesktopAiError::Closed) => {}
                    Err(e) => return Err(safe_error(e)),
                }
                self.notice = None;
            }
            Action::CancelLogin {} => {
                self.require_openai()?;
                self.controller
                    .as_mut()
                    .ok_or("진행 중인 로그인이 없습니다.")?
                    .cancel_login()
                    .map_err(safe_error)?;
                self.login_url = None;
            }
            Action::Logout {} => {
                self.require_openai()?;
                self.controller
                    .as_mut()
                    .ok_or("연결된 계정이 없습니다.")?
                    .logout()
                    .map_err(safe_error)?;
                self.request = None;
                self.login_url = None;
            }
            Action::Send {
                prompt,
                request_id,
                model,
                reasoning_effort,
            } => {
                self.require_openai()?;
                Id::new(&request_id).map_err(|_| "요청 ID가 올바르지 않습니다.")?;
                let catalog = &self
                    .latest
                    .as_ref()
                    .and_then(|v| v.auth.as_ref())
                    .ok_or("먼저 로그인하세요.")?
                    .model_catalog;
                let (model, reasoning_effort) = catalog
                    .select(model.as_deref(), reasoning_effort.as_deref())
                    .map_err(str::to_owned)?;
                let prior_ticket = self
                    .latest
                    .as_ref()
                    .and_then(|v| v.coordinator.turn.as_ref())
                    .map(|t| t.ticket.clone());
                let command = self
                    .controller
                    .as_mut()
                    .ok_or("먼저 로그인하세요.")?
                    .send_with_reasoning(model, prompt, reasoning_effort)
                    .map_err(safe_error)?;
                self.request = Some(RequestBinding {
                    id: request_id,
                    command,
                    prior_ticket,
                    accepted_ticket: None,
                    failed: false,
                });
            }
            Action::CancelTurn { turn_id } => {
                self.require_openai()?;
                if self.request.as_ref().map(|r| r.id.as_str()) != Some(turn_id.as_str()) {
                    return Err("현재 응답과 취소 요청이 다릅니다.".into());
                }
                self.controller
                    .as_mut()
                    .ok_or("진행 중인 응답이 없습니다.")?
                    .cancel_turn()
                    .map_err(safe_error)?;
            }
        }
        self.generation = self.generation.saturating_add(1);
        Ok(self.state())
    }

    fn require_openai(&self) -> Result<(), String> {
        if self.selected == "openai" {
            Ok(())
        } else {
            Err("이 제공자의 연결은 아직 준비 중입니다.".into())
        }
    }
    fn busy(&self) -> bool {
        self.controller
            .as_ref()
            .is_some_and(|c| c.command_pending())
            || self.latest.as_ref().is_some_and(|v| {
                matches!(
                    v.auth.as_ref().map(|a| a.status),
                    Some(
                        AuthStatus::Starting
                            | AuthStatus::AwaitingUser
                            | AuthStatus::CheckingAccount
                            | AuthStatus::LogoutPending
                    )
                ) || v.coordinator.turn.as_ref().is_some_and(|t| {
                    matches!(t.status, TurnStatus::Started | TurnStatus::Streaming)
                })
            })
    }
    fn project(&self) -> Value {
        let openai = self.selected == "openai";
        let status = if !openai {
            "signed_out"
        } else if self.latest.as_ref().is_some_and(|v| v.fatal.is_some()) {
            "error"
        } else {
            match self
                .latest
                .as_ref()
                .and_then(|v| v.auth.as_ref())
                .map(|a| a.status)
            {
                Some(AuthStatus::Connected) => "signed_in",
                Some(
                    AuthStatus::Starting
                    | AuthStatus::AwaitingUser
                    | AuthStatus::CheckingAccount
                    | AuthStatus::LogoutPending,
                ) => "pending",
                Some(AuthStatus::Expired) => "expired",
                Some(AuthStatus::Failed | AuthStatus::LogoutUnconfirmed) => "error",
                _ => "signed_out",
            }
        };
        let mut turn = json!({"id":null,"requestId":null,"status":"idle","text":null});
        if openai && status == "signed_in" {
            if let Some(request) = &self.request {
                turn = json!({"id":request.id,"requestId":request.id,"status":"running","text":""});
                if request.failed {
                    turn["status"] = json!("error");
                    project_failure(
                        &mut turn,
                        TurnDiagnostic {
                            code: "dispatch_failed",
                            stage: "dispatch",
                        },
                    );
                } else if let Some(t) = self
                    .latest
                    .as_ref()
                    .and_then(|v| v.coordinator.turn.as_ref())
                {
                    // Once accepted, bind to the exact turn independently of subsequent
                    // command ACKs (including a cancel arriving just after completion).
                    if request.accepted_ticket.as_ref() == Some(&t.ticket)
                        && self.latest.as_ref().is_some_and(|v| {
                            t.ticket.account_generation == v.coordinator.account_generation
                                && v.coordinator.selected_account.as_ref()
                                    == Some(&t.ticket.binding)
                        })
                    {
                        turn["status"] = json!(match t.status {
                            TurnStatus::Started | TurnStatus::Streaming => "running",
                            TurnStatus::Completed => "completed",
                            TurnStatus::Failed => "error",
                            TurnStatus::Cancelled => "cancelled",
                        });
                        turn["text"] = json!(t.text);
                        if let Some(p) = self.latest.as_ref().and_then(|v| v.turn_process.as_ref())
                        {
                            turn["transport"] = json!({"fault":p.fault,"stdoutBytes":p.stdout_bytes,"stderrBytes":p.stderr_bytes,"ignoredNotifications":p.ignored_notifications,"deniedRequests":p.denied_requests,"settled":p.settled});
                        }
                        if t.status == TurnStatus::Failed {
                            let diagnostic = self
                                .latest
                                .as_ref()
                                .and_then(|v| v.turn_process.as_ref())
                                .and_then(|p| {
                                    p.diagnostic.or_else(|| {
                                        p.fault.map(|f| TurnDiagnostic::fault("response", f))
                                    })
                                })
                                .unwrap_or(TurnDiagnostic {
                                    code: match t.error {
                                        Some(crate::ProviderError::Denied) => "request_denied",
                                        Some(crate::ProviderError::Expired) => "authorization",
                                        Some(crate::ProviderError::Unavailable) => {
                                            "provider_unavailable"
                                        }
                                        Some(crate::ProviderError::Protocol) => "protocol",
                                        _ => "provider_failed",
                                    },
                                    stage: "response",
                                });
                            project_failure(&mut turn, diagnostic);
                        }
                    }
                }
            }
        }
        let auth_view = self.latest.as_ref().and_then(|v| v.auth.as_ref());
        let catalog = auth_view
            .filter(|_| openai && status == "signed_in")
            .map(|v| v.model_catalog.clone())
            .unwrap_or_default();
        let catalog_message = match catalog.status {
            "loading" => Some("공식 모델 목록을 불러오고 있습니다."),
            "error" => Some("공식 모델 목록을 불러오지 못했습니다. 목록을 다시 조회하세요."),
            _ => None,
        };
        let fault = auth_view.and_then(|v| v.fault);
        let error_code = auth_view.and_then(|v| v.error_code).or_else(|| {
            fault.map(|f| match f {
                crate::process::ProcessFault::Timeout => "timeout",
                crate::process::ProcessFault::Spawn => "runtime_start",
                _ => "provider_connection",
            })
        });
        let auth_message = error_code.map(|code| match code {
            "callback_busy" => "다른 로그인 창이 인증 연결을 사용 중입니다. 진행 중인 로그인을 마친 뒤 다시 연결하세요.",
            "credential_store" => "OS 보안 저장소를 사용할 수 없습니다. 잠금 상태를 확인한 뒤 다시 연결하세요.",
            "runtime_environment" => "AI 실행기의 운영체제 환경을 준비하지 못했습니다. 앱을 다시 열어 연결하세요.",
            "network" => "인증 서버에 연결하지 못했습니다. 네트워크를 확인한 뒤 다시 연결하세요.",
            "timeout" => "인증 응답 시간이 초과되었습니다. 다시 연결하세요.",
            _ => "AI 연결을 완료하지 못했습니다. 다시 연결하거나 계정 메뉴에서 진단을 확인하세요.",
        });
        json!({
            "providers":[
                {"id":"openai","label":"OpenAI · ChatGPT","available":self.config.is_some(),"unavailableReason":if self.config.is_some(){None}else{Some("Codex 실행 파일을 찾지 못했습니다.")},"authMethods":["subscription_browser"]},
                {"id":"claude","label":"Claude","available":false,"unavailableReason":"Claude 공식 로그인 연결 준비 중","authMethods":[]},
                {"id":"gemini","label":"Google Gemini","available":false,"unavailableReason":"Gemini 공식 로그인 연결 준비 중","authMethods":[]},
                {"id":"grok","label":"Grok · xAI","available":false,"unavailableReason":"Grok 공식 로그인 연결 준비 중","authMethods":[]}
            ],
            "models":catalog.models,"modelCatalogStatus":catalog.status,"modelCatalogErrorCode":catalog.error_code,"modelCatalogMessage":catalog_message,
            "selectedProvider":self.selected,"auth":{"status":status,"sessionGeneration":if status=="signed_in"{self.latest.as_ref().map(|v|v.coordinator.account_generation.to_string())}else{None},"accountLabel":if status=="signed_in"{Some("ChatGPT 연결됨")}else{None::<&str>},"plan":null,"phase":auth_view.map(|v|v.phase),"errorCode":error_code,"message":auth_message},
            "usage":{"inputTokens":null,"outputTokens":null,"remainingPercent":null,"source":null,"updatedAt":null},
            "turn":turn,"busy":self.busy(),"commandPending":self.controller.as_ref().is_some_and(|c| c.command_pending()),"notice":self.notice,
            "sessionPersistence":if self.config.as_ref().is_some_and(|c| c.persistent_auth){if crate::managed::PERSISTENT_CREDENTIAL_STORE=="file"{"provider_file"}else{"provider_keyring"}}else{"process_only"}
        })
    }
}

fn project_failure(turn: &mut Value, diagnostic: TurnDiagnostic) {
    turn["errorCode"] = json!(diagnostic.code);
    turn["errorStage"] = json!(diagnostic.stage);
    turn["message"] = json!(diagnostic.message());
    // The host never automatically retries an uncertain model request.
    turn["retryPolicy"] = json!("manual");
}

fn safe_error(_: DesktopAiError) -> String {
    "AI 요청을 처리하지 못했습니다. 상태를 확인하고 다시 시도하세요.".into()
}

pub fn valid_login_url(raw: &str) -> bool {
    url::Url::parse(raw).ok().is_some_and(|u| {
        u.scheme() == "https"
            && u.username().is_empty()
            && u.password().is_none()
            && u.port_or_known_default() == Some(443)
            && matches!(
                u.host_str(),
                Some("auth.openai.com" | "auth0.openai.com" | "chatgpt.com")
            )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unimplemented_providers_and_missing_usage_are_not_success() {
        let mut h = Host::new(None);
        let s = h.state();
        assert_eq!(s["providers"].as_array().unwrap().len(), 4);
        assert!(
            s["providers"]
                .as_array()
                .unwrap()
                .iter()
                .all(|p| p["available"] == false)
        );
        assert!(s["usage"]["remainingPercent"].is_null());
        let next = h
            .action(
                s["generation"].as_u64().unwrap(),
                Action::SelectProvider {
                    provider: "grok".into(),
                },
            )
            .unwrap();
        assert!(
            h.action(next["generation"].as_u64().unwrap(), Action::BeginLogin {})
                .is_err()
        );
    }
    #[test]
    fn stale_state_and_unknown_action_rejected_without_provider_io() {
        let mut h = Host::new(None);
        h.state();
        assert!(h.action(0, Action::BeginLogin {}).is_err());
        assert!(
            serde_json::from_value::<Action>(json!({"type":"begin_login","executable":"evil"}))
                .is_err()
        );
    }
    #[test]
    fn login_url_accepts_only_explicit_official_https_origins() {
        assert!(valid_login_url(
            "https://auth.openai.com/authorize?state=fixture"
        ));
        for s in [
            "http://auth.openai.com/a",
            "https://auth.openai.com.evil.test/a",
            "https://evil@auth.openai.com/a",
            "https://auth.openai.com:444/a",
            "file:///a",
        ] {
            assert!(!valid_login_url(s));
        }
    }
}
