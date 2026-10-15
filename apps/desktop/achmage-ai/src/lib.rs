//! Provider-neutral state coordination, with an optional explicitly constructed process adapter.
//! The coordinator itself performs no OAuth, network, filesystem or OS keychain operations.
//! A provider adapter must validate OAuth identity/permissions before returning a login.
//! Secret values cannot be serialized; only explicit trusted adapter access exposes bytes.
extern crate self as hangul_ai_session;
pub mod bridge;
pub mod cli;
pub mod controller;
pub mod review;
use serde::{Deserialize, Serialize};
use std::{
    fmt,
    sync::atomic::{AtomicU64, Ordering},
};
use zeroize::Zeroizing;

pub mod managed;
pub mod models;
pub mod process;

const MAX_ID: usize = 128;
const MAX_SECRET: usize = 65_536;
pub const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;
static NEXT_INSTANCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct Id(String);
impl Id {
    pub fn new(value: impl Into<String>) -> Result<Self, Error> {
        let value = value.into();
        if value.is_empty()
            || value.len() > MAX_ID
            || !value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
            || value == "."
            || value == ".."
        {
            return Err(Error::InvalidId);
        }
        Ok(Self(value))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
impl fmt::Debug for Id {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("Id").field(&self.0).finish()
    }
}
impl<'de> Deserialize<'de> for Id {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Self::new(String::deserialize(d)?).map_err(serde::de::Error::custom)
    }
}

/// Deliberately has no Serialize, Deserialize, Display, Clone or public inner field.
/// ```compile_fail
/// use hangul_ai_session::Secret;
/// let secret = Secret::new(b"fixture".to_vec()).unwrap();
/// serde_json::to_string(&secret).unwrap();
/// ```
pub struct Secret(Zeroizing<Vec<u8>>);
impl Secret {
    pub fn new(bytes: Vec<u8>) -> Result<Self, Error> {
        // Own even rejected input in a zeroizing buffer.
        let bytes = Zeroizing::new(bytes);
        if bytes.is_empty() || bytes.len() > MAX_SECRET {
            return Err(Error::InvalidSecret);
        }
        Ok(Self(bytes))
    }
    /// Explicit trust boundary. An adapter must not log, persist or return these bytes to UI.
    /// This cannot prevent a malicious adapter from copying bytes.
    pub fn with_transport_bytes<R>(&self, consume: impl FnOnce(&[u8]) -> R) -> R {
        consume(&self.0)
    }
}
impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret([REDACTED])")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    pub provider_id: Id,
    pub host_id: Id,
    pub account_id: Id,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Error {
    InvalidId,
    InvalidSecret,
    GenerationExhausted,
    LoginInProgress,
    NoLogin,
    StaleLogin,
    BindingMismatch,
    AccountMismatch,
    NoAccount,
    TurnInProgress,
    NoTurn,
    StaleTurn,
    OutOfOrder,
    TerminalTurn,
    InvalidPrompt,
    ResponseLimit,
    ProviderDispatch,
    InvalidCancellationAck,
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for Error {}

/// Safe codes only. Never store provider error strings, URLs or token-bearing responses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderError {
    Unavailable,
    Denied,
    Expired,
    Protocol,
    Transport,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
/// Process-local ticket; untrusted JSON cannot construct a callback identity.
/// ```compile_fail
/// use hangul_ai_session::LoginTicket;
/// let _: LoginTicket = serde_json::from_str("{}").unwrap();
/// ```
pub struct LoginTicket {
    instance: u64,
    generation: u64,
    provider_id: Id,
    host_id: Id,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TurnTicket {
    instance: u64,
    generation: u64,
    account_generation: u64,
    binding: Binding,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LoginStatus {
    Idle,
    Pending,
    Connected,
    Failed,
    Cancelled,
    Expired,
    SignedOut,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LoginView {
    pub status: LoginStatus,
    pub generation: u64,
    pub expected_account_id: Option<Id>,
    pub error: Option<ProviderError>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnStatus {
    Started,
    Streaming,
    Completed,
    Failed,
    Cancelled,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CancelReason {
    User,
    Logout,
    AccountChanged,
    Provider,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Cancellation {
    NotRequested,
    Requested,
    DispatchFailed,
    Acknowledged,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TurnView {
    pub ticket: TurnTicket,
    pub model_id: Id,
    pub reasoning_effort: Option<String>,
    pub status: TurnStatus,
    pub next_sequence: u64,
    pub text: String,
    pub error: Option<ProviderError>,
    pub cancel_reason: Option<CancelReason>,
    pub cancellation: Cancellation,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Persistence {
    MemoryOnly,
    ProviderManaged,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Implementation {
    CoordinatorOnly,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct View {
    pub schema_version: u32,
    pub implementation: Implementation,
    pub credential_persistence: Persistence,
    pub provider_id: Id,
    pub host_id: Id,
    pub selected_account: Option<Binding>,
    pub account_generation: u64,
    pub login: LoginView,
    pub turn: Option<TurnView>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TurnRequest {
    pub model_id: Id,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    pub prompt: String,
}

/// Nonblocking dispatch boundary: Ok means accepted by the adapter, not authenticated,
/// inferred successfully, nor an observed process exit. Completion arrives using tickets.
/// Implementations must bind provider/host exactly, protect bytes and validate provider identity.
pub trait ProviderAdapter {
    fn provider_id(&self) -> &Id;
    fn host_id(&self) -> &Id;
    fn start_login(
        &mut self,
        ticket: &LoginTicket,
        expected_account: Option<&Id>,
    ) -> Result<(), ProviderError>;
    fn cancel_login(&mut self, ticket: &LoginTicket) -> Result<(), ProviderError>;
    fn start_turn(
        &mut self,
        ticket: &TurnTicket,
        credential: &Secret,
        request: &TurnRequest,
    ) -> Result<(), ProviderError>;
    fn cancel_turn(&mut self, ticket: &TurnTicket) -> Result<(), ProviderError>;
    /// A provider-owned session without exporting a token into this coordinator.
    fn start_managed_turn(&mut self, _: &TurnTicket, _: &TurnRequest) -> Result<(), ProviderError> {
        Err(ProviderError::Unavailable)
    }
}

enum CredentialData {
    Secret(Secret),
    ProviderManaged,
}
struct Credential {
    binding: Binding,
    data: CredentialData,
}
struct PendingLogin {
    ticket: LoginTicket,
    expected: Option<Id>,
}
pub struct Coordinator {
    instance: u64,
    provider: Id,
    host: Id,
    generation: u64,
    account_generation: u64,
    credential: Option<Credential>,
    pending: Option<PendingLogin>,
    login: LoginView,
    turn: Option<TurnView>,
}
impl fmt::Debug for Coordinator {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("Coordinator").field(&self.view()).finish()
    }
}
impl Coordinator {
    pub fn new(provider_id: Id, host_id: Id) -> Result<Self, Error> {
        let mut instance = NEXT_INSTANCE.load(Ordering::Relaxed);
        loop {
            let next = instance.checked_add(1).ok_or(Error::GenerationExhausted)?;
            match NEXT_INSTANCE.compare_exchange_weak(
                instance,
                next,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => break,
                Err(observed) => instance = observed,
            }
        }
        Ok(Self {
            instance,
            provider: provider_id,
            host: host_id,
            generation: 0,
            account_generation: 0,
            credential: None,
            pending: None,
            turn: None,
            login: LoginView {
                status: LoginStatus::Idle,
                generation: 0,
                expected_account_id: None,
                error: None,
            },
        })
    }
    pub fn view(&self) -> View {
        View {
            schema_version: 1,
            implementation: Implementation::CoordinatorOnly,
            credential_persistence: if self
                .credential
                .as_ref()
                .is_some_and(|c| matches!(c.data, CredentialData::ProviderManaged))
            {
                Persistence::ProviderManaged
            } else {
                Persistence::MemoryOnly
            },
            provider_id: self.provider.clone(),
            host_id: self.host.clone(),
            selected_account: self.credential.as_ref().map(|c| c.binding.clone()),
            account_generation: self.account_generation,
            login: self.login.clone(),
            turn: self.turn.clone(),
        }
    }
    fn check_adapter(&self, a: &impl ProviderAdapter) -> Result<(), Error> {
        if a.provider_id() != &self.provider || a.host_id() != &self.host {
            Err(Error::BindingMismatch)
        } else {
            Ok(())
        }
    }
    fn next_generation(&mut self) -> Result<u64, Error> {
        self.generation = self
            .generation
            .checked_add(1)
            .ok_or(Error::GenerationExhausted)?;
        Ok(self.generation)
    }
    fn check_login(&self, ticket: &LoginTicket) -> Result<&PendingLogin, Error> {
        let pending = self.pending.as_ref().ok_or(Error::StaleLogin)?;
        if &pending.ticket != ticket {
            return Err(Error::StaleLogin);
        }
        Ok(pending)
    }
    pub fn begin_login(
        &mut self,
        adapter: &mut impl ProviderAdapter,
        expected: Option<Id>,
    ) -> Result<LoginTicket, Error> {
        self.check_adapter(adapter)?;
        if self.pending.is_some() {
            return Err(Error::LoginInProgress);
        }
        let ticket = LoginTicket {
            instance: self.instance,
            generation: self.next_generation()?,
            provider_id: self.provider.clone(),
            host_id: self.host.clone(),
        };
        self.login = LoginView {
            status: LoginStatus::Pending,
            generation: ticket.generation,
            expected_account_id: expected.clone(),
            error: None,
        };
        self.pending = Some(PendingLogin {
            ticket: ticket.clone(),
            expected: expected.clone(),
        });
        if let Err(error) = adapter.start_login(&ticket, expected.as_ref()) {
            self.fail_login(&ticket, error)?;
            return Err(Error::ProviderDispatch);
        }
        Ok(ticket)
    }
    /// Called only after the adapter has validated its provider's identity, token and scopes.
    /// The coordinator validates binding/attempt continuity, not cryptography.
    pub fn complete_login(
        &mut self,
        adapter: &mut impl ProviderAdapter,
        ticket: &LoginTicket,
        binding: Binding,
        secret: Secret,
    ) -> Result<(), Error> {
        self.complete_credential(adapter, ticket, binding, CredentialData::Secret(secret))
    }
    /// Trusts the adapter's verified managed-session account metadata, not a dummy secret.
    /// Tokens remain owned by the provider process/storage and are never imported here.
    pub fn complete_managed_login(
        &mut self,
        adapter: &mut impl ProviderAdapter,
        ticket: &LoginTicket,
        binding: Binding,
    ) -> Result<(), Error> {
        self.complete_credential(adapter, ticket, binding, CredentialData::ProviderManaged)
    }
    fn complete_credential(
        &mut self,
        adapter: &mut impl ProviderAdapter,
        ticket: &LoginTicket,
        binding: Binding,
        data: CredentialData,
    ) -> Result<(), Error> {
        self.check_adapter(adapter)?;
        let pending = self.check_login(ticket)?;
        if binding.provider_id != self.provider || binding.host_id != self.host {
            return Err(Error::BindingMismatch);
        }
        if pending
            .expected
            .as_ref()
            .is_some_and(|id| id != &binding.account_id)
        {
            return Err(Error::AccountMismatch);
        }
        let new_generation = self
            .account_generation
            .checked_add(1)
            .ok_or(Error::GenerationExhausted)?;
        // Retire old events before replacing credentials, even when cancellation dispatch fails.
        self.cancel_active_turn(adapter, CancelReason::AccountChanged);
        self.credential = Some(Credential { binding, data });
        self.account_generation = new_generation;
        self.pending = None;
        self.login.status = LoginStatus::Connected;
        self.login.error = None;
        Ok(())
    }
    pub fn fail_login(&mut self, ticket: &LoginTicket, error: ProviderError) -> Result<(), Error> {
        self.check_login(ticket)?;
        self.pending = None;
        self.login.status = LoginStatus::Failed;
        self.login.error = Some(error);
        Ok(())
    }
    pub fn expire_login(
        &mut self,
        adapter: &mut impl ProviderAdapter,
        ticket: &LoginTicket,
    ) -> Result<Cancellation, Error> {
        self.finish_pending(adapter, ticket, LoginStatus::Expired)
    }
    pub fn cancel_login(
        &mut self,
        adapter: &mut impl ProviderAdapter,
        ticket: &LoginTicket,
    ) -> Result<Cancellation, Error> {
        self.finish_pending(adapter, ticket, LoginStatus::Cancelled)
    }
    fn finish_pending(
        &mut self,
        adapter: &mut impl ProviderAdapter,
        ticket: &LoginTicket,
        status: LoginStatus,
    ) -> Result<Cancellation, Error> {
        self.check_adapter(adapter)?;
        self.check_login(ticket)?;
        self.pending = None;
        self.login.status = status;
        self.login.error = None;
        Ok(if adapter.cancel_login(ticket).is_ok() {
            Cancellation::Requested
        } else {
            Cancellation::DispatchFailed
        })
    }
    /// Clears only this coordinator's in-memory credential; no provider revocation is implied.
    pub fn logout(&mut self, adapter: &mut impl ProviderAdapter) -> Result<LogoutReport, Error> {
        self.check_adapter(adapter)?;
        let new_generation = self
            .account_generation
            .checked_add(1)
            .ok_or(Error::GenerationExhausted)?;
        let pending = self.pending.take();
        let login_cancel = pending.as_ref().map(|p| {
            if adapter.cancel_login(&p.ticket).is_ok() {
                Cancellation::Requested
            } else {
                Cancellation::DispatchFailed
            }
        });
        let turn_cancel = self.cancel_active_turn(adapter, CancelReason::Logout);
        self.credential = None;
        self.account_generation = new_generation;
        self.login.status = LoginStatus::SignedOut;
        self.login.error = None;
        self.login.expected_account_id = None;
        Ok(LogoutReport {
            login_cancel,
            turn_cancel,
            provider_revocation_implemented: false,
        })
    }
    pub fn start_turn(
        &mut self,
        adapter: &mut impl ProviderAdapter,
        request: TurnRequest,
    ) -> Result<TurnTicket, Error> {
        self.check_adapter(adapter)?;
        if let Some(effort) = &request.reasoning_effort {
            Id::new(effort)?;
        }
        if request.prompt.is_empty() {
            return Err(Error::InvalidPrompt);
        }
        if self
            .turn
            .as_ref()
            .is_some_and(|t| matches!(t.status, TurnStatus::Started | TurnStatus::Streaming))
        {
            return Err(Error::TurnInProgress);
        }
        let binding = self
            .credential
            .as_ref()
            .ok_or(Error::NoAccount)?
            .binding
            .clone();
        let ticket = TurnTicket {
            instance: self.instance,
            generation: self.next_generation()?,
            account_generation: self.account_generation,
            binding,
        };
        self.turn = Some(TurnView {
            ticket: ticket.clone(),
            model_id: request.model_id.clone(),
            reasoning_effort: request.reasoning_effort.clone(),
            status: TurnStatus::Started,
            next_sequence: 0,
            text: String::new(),
            error: None,
            cancel_reason: None,
            cancellation: Cancellation::NotRequested,
        });
        let credential = &self.credential.as_ref().ok_or(Error::NoAccount)?.data;
        let dispatch = match credential {
            CredentialData::Secret(secret) => adapter.start_turn(&ticket, secret, &request),
            CredentialData::ProviderManaged => adapter.start_managed_turn(&ticket, &request),
        };
        if let Err(error) = dispatch {
            self.fail_turn(&ticket, 0, error)?;
            return Err(Error::ProviderDispatch);
        }
        Ok(ticket)
    }
    fn current_turn(&mut self, ticket: &TurnTicket) -> Result<&mut TurnView, Error> {
        if ticket.instance != self.instance || ticket.account_generation != self.account_generation
        {
            return Err(Error::StaleTurn);
        }
        let turn = self.turn.as_mut().ok_or(Error::NoTurn)?;
        if &turn.ticket != ticket {
            return Err(Error::StaleTurn);
        }
        Ok(turn)
    }
    fn accepting_turn(
        &mut self,
        ticket: &TurnTicket,
        sequence: u64,
    ) -> Result<&mut TurnView, Error> {
        let turn = self.current_turn(ticket)?;
        if !matches!(turn.status, TurnStatus::Started | TurnStatus::Streaming) {
            return Err(Error::TerminalTurn);
        }
        if turn.next_sequence != sequence {
            return Err(Error::OutOfOrder);
        }
        Ok(turn)
    }
    pub fn push_delta(
        &mut self,
        ticket: &TurnTicket,
        sequence: u64,
        text: &str,
    ) -> Result<(), Error> {
        let turn = self.accepting_turn(ticket, sequence)?;
        if turn
            .text
            .len()
            .checked_add(text.len())
            .is_none_or(|n| n > MAX_RESPONSE_BYTES)
        {
            return Err(Error::ResponseLimit);
        }
        let next = sequence.checked_add(1).ok_or(Error::GenerationExhausted)?;
        turn.text.push_str(text);
        turn.next_sequence = next;
        turn.status = TurnStatus::Streaming;
        Ok(())
    }
    pub fn complete_turn(&mut self, ticket: &TurnTicket, sequence: u64) -> Result<(), Error> {
        self.accepting_turn(ticket, sequence)?.status = TurnStatus::Completed;
        Ok(())
    }
    pub fn fail_turn(
        &mut self,
        ticket: &TurnTicket,
        sequence: u64,
        error: ProviderError,
    ) -> Result<(), Error> {
        let turn = self.accepting_turn(ticket, sequence)?;
        turn.status = TurnStatus::Failed;
        turn.error = Some(error);
        Ok(())
    }
    pub fn provider_cancelled_turn(
        &mut self,
        ticket: &TurnTicket,
        sequence: u64,
    ) -> Result<(), Error> {
        let turn = self.accepting_turn(ticket, sequence)?;
        turn.status = TurnStatus::Cancelled;
        turn.cancel_reason = Some(CancelReason::Provider);
        turn.cancellation = Cancellation::Acknowledged;
        Ok(())
    }
    pub fn cancel_turn(
        &mut self,
        adapter: &mut impl ProviderAdapter,
        ticket: &TurnTicket,
    ) -> Result<Cancellation, Error> {
        self.check_adapter(adapter)?;
        let turn = self.current_turn(ticket)?;
        if !matches!(turn.status, TurnStatus::Started | TurnStatus::Streaming) {
            return Err(Error::TerminalTurn);
        }
        self.cancel_active_turn(adapter, CancelReason::User);
        Ok(self.turn.as_ref().ok_or(Error::NoTurn)?.cancellation)
    }
    fn cancel_active_turn(
        &mut self,
        adapter: &mut impl ProviderAdapter,
        reason: CancelReason,
    ) -> Option<Cancellation> {
        if let Some(turn) = &mut self.turn {
            if matches!(turn.status, TurnStatus::Started | TurnStatus::Streaming) {
                // Fence output before invoking cancellation; no successful process exit claim.
                turn.status = TurnStatus::Cancelled;
                turn.cancel_reason = Some(reason);
                turn.cancellation = if adapter.cancel_turn(&turn.ticket).is_ok() {
                    Cancellation::Requested
                } else {
                    Cancellation::DispatchFailed
                };
                return Some(turn.cancellation);
            }
        }
        None
    }
    pub fn acknowledge_cancellation(&mut self, ticket: &TurnTicket) -> Result<(), Error> {
        // A retired account cannot emit output, but its exact cancelled process can
        // still acknowledge shutdown. This updates metadata only and never revives it.
        let turn = self.turn.as_mut().ok_or(Error::NoTurn)?;
        if ticket.instance != self.instance || &turn.ticket != ticket {
            return Err(Error::StaleTurn);
        }
        if turn.status != TurnStatus::Cancelled
            || !matches!(
                turn.cancellation,
                Cancellation::Requested | Cancellation::DispatchFailed
            )
        {
            return Err(Error::InvalidCancellationAck);
        }
        turn.cancellation = Cancellation::Acknowledged;
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LogoutReport {
    pub login_cancel: Option<Cancellation>,
    pub turn_cancel: Option<Cancellation>,
    pub provider_revocation_implemented: bool,
}
