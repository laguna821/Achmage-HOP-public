//! A deterministic mock-only sequence. No network, browser, files or real credentials.
use hangul_ai_session::*;
fn id(s: &str) -> Id {
    Id::new(s).unwrap()
}
struct Mock {
    provider: Id,
    host: Id,
}
impl ProviderAdapter for Mock {
    fn provider_id(&self) -> &Id {
        &self.provider
    }
    fn host_id(&self) -> &Id {
        &self.host
    }
    fn start_login(&mut self, _: &LoginTicket, _: Option<&Id>) -> Result<(), ProviderError> {
        Ok(())
    }
    fn cancel_login(&mut self, _: &LoginTicket) -> Result<(), ProviderError> {
        Ok(())
    }
    fn start_turn(
        &mut self,
        _: &TurnTicket,
        _: &Secret,
        _: &TurnRequest,
    ) -> Result<(), ProviderError> {
        Ok(())
    }
    fn cancel_turn(&mut self, _: &TurnTicket) -> Result<(), ProviderError> {
        Ok(())
    }
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut adapter = Mock {
        provider: id("mock"),
        host: id("local-fixture"),
    };
    let mut c = Coordinator::new(adapter.provider.clone(), adapter.host.clone())?;
    let login = c.begin_login(&mut adapter, None)?;
    let pending = c.view();
    c.complete_login(
        &mut adapter,
        &login,
        Binding {
            provider_id: id("mock"),
            host_id: id("local-fixture"),
            account_id: id("fixture-account"),
        },
        Secret::new(b"MOCK_NOT_A_CREDENTIAL".to_vec())?,
    )?;
    let turn = c.start_turn(
        &mut adapter,
        TurnRequest {
            reasoning_effort: None,
            model_id: id("fixture-model"),
            prompt: "선택한 문단에 대한 모의 요청".into(),
        },
    )?;
    c.push_delta(&turn, 0, "모의 응답: ")?;
    c.push_delta(&turn, 1, "실제 모델을 호출하지 않았습니다.")?;
    let streaming = c.view();
    c.complete_turn(&turn, 2)?;
    let completed = c.view();
    c.logout(&mut adapter)?;
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "scenario":"mock_only","actual_login":false,"actual_inference":false,
            "pending":pending,"streaming":streaming,"completed":completed,"signed_out":c.view()
        }))?
    );
    Ok(())
}
