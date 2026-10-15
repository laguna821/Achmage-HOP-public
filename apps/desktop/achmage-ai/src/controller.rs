//! Native UI-independent AI controller. All provider IO and child cleanup belong
//! to one worker. This module never opens a browser or reads credential files.
use hangul_ai_session::{
    Coordinator, Error, Id, LoginStatus, LoginTicket, TurnRequest, View,
    managed::{AuthStatus, AuthView, LoginMethod, LoginPrompt, ManagedCodexAdapter},
    process::{LaunchConfig, ProcessFault, ProcessView},
};
use std::{
    fmt,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DesktopAiError {
    Busy,
    Closed,
    WorkerStart,
    InvalidPrompt,
    SequenceExhausted,
    Session(Error),
    Process(ProcessFault),
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandKind {
    Login,
    CancelLogin,
    Logout,
    Send,
    CancelTurn,
    RefreshModels,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CommandOutcome {
    pub id: u64,
    pub kind: CommandKind,
    /// Dispatch result only; successful authentication/inference is in the views.
    pub result: Result<(), DesktopAiError>,
}
#[derive(Clone)]
pub struct DesktopAiView {
    pub coordinator: View,
    /// None only before worker initialization, or after invalid configuration.
    pub auth: Option<AuthView>,
    pub turn_process: Option<ProcessView>,
    pub last_command: Option<CommandOutcome>,
    pub fatal: Option<DesktopAiError>,
    pub worker_running: bool,
}
// Even model text may contain document data: do not include it in Debug logs.
impl fmt::Debug for DesktopAiView {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DesktopAiView")
            .field("login_status", &self.coordinator.login.status)
            .field("auth", &self.auth)
            .field("last_command", &self.last_command)
            .field("fatal", &self.fatal)
            .field("worker_running", &self.worker_running)
            .finish()
    }
}
/// Not serializable. Prompt is delivered once, and must be discarded by the UI
/// when login generation changes or login leaves Pending/AwaitingUser.
#[derive(Debug)]
pub struct DesktopAiUpdate {
    pub view: DesktopAiView,
    pub prompt: Option<LoginPrompt>,
}
enum Command {
    Login(Option<Id>),
    CancelLogin,
    Logout,
    Send(TurnRequest),
    CancelTurn,
    RefreshModels,
}
impl Command {
    fn kind(&self) -> CommandKind {
        match self {
            Self::Login(_) => CommandKind::Login,
            Self::CancelLogin => CommandKind::CancelLogin,
            Self::Logout => CommandKind::Logout,
            Self::Send(_) => CommandKind::Send,
            Self::CancelTurn => CommandKind::CancelTurn,
            Self::RefreshModels => CommandKind::RefreshModels,
        }
    }
}
struct Shared {
    latest: Mutex<Option<DesktopAiUpdate>>,
    stop: AtomicBool,
    alive: AtomicBool,
}
/// Call poll() from the native frame and request another frame after ~20 ms.
/// Only one unacknowledged command is accepted: poll its outcome before sending
/// another. Slow UI frames coalesce snapshots, never a queue of model responses.
pub struct DesktopAiController {
    commands: mpsc::SyncSender<(u64, Command)>,
    shared: Arc<Shared>,
    next_id: u64,
    pending: Option<u64>,
}
impl fmt::Debug for DesktopAiController {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DesktopAiController")
            .field("pending", &self.pending)
            .field("worker_running", &self.worker_running())
            .finish()
    }
}
impl DesktopAiController {
    /// No provider launch/validation on caller thread; initialization errors
    /// arrive as view.fatal. Trusted host supplies executable/args/private home.
    pub fn new(
        provider: Id,
        host: Id,
        config: LaunchConfig,
        method: LoginMethod,
        login_timeout: Duration,
    ) -> Result<Self, DesktopAiError> {
        let c =
            Coordinator::new(provider.clone(), host.clone()).map_err(DesktopAiError::Session)?;
        let view = DesktopAiView {
            coordinator: c.view(),
            auth: None,
            turn_process: None,
            last_command: None,
            fatal: None,
            worker_running: true,
        };
        let shared = Arc::new(Shared {
            latest: Mutex::new(Some(DesktopAiUpdate { view, prompt: None })),
            stop: AtomicBool::new(false),
            alive: AtomicBool::new(true),
        });
        let (commands, receive) = mpsc::sync_channel(1);
        let worker_shared = shared.clone();
        thread::Builder::new()
            .name("desktop-ai".into())
            .spawn(move || {
                // The guard runs even on worker panic; no panic payload enters UI.
                struct Guard(Arc<Shared>);
                impl Drop for Guard {
                    fn drop(&mut self) {
                        self.0.alive.store(false, Ordering::Release);
                    }
                }
                let _guard = Guard(worker_shared.clone());
                run(
                    c,
                    provider,
                    host,
                    config,
                    method,
                    login_timeout,
                    receive,
                    &worker_shared,
                );
            })
            .map_err(|_| DesktopAiError::WorkerStart)?;
        Ok(Self {
            commands,
            shared,
            next_id: 1,
            pending: None,
        })
    }
    pub fn worker_running(&self) -> bool {
        self.shared.alive.load(Ordering::Acquire)
    }
    pub fn command_pending(&self) -> bool {
        self.pending.is_some()
    }
    pub fn login(&mut self, expected_account: Option<Id>) -> Result<u64, DesktopAiError> {
        self.dispatch(Command::Login(expected_account))
    }
    pub fn cancel_login(&mut self) -> Result<u64, DesktopAiError> {
        self.dispatch(Command::CancelLogin)
    }
    pub fn logout(&mut self) -> Result<u64, DesktopAiError> {
        self.dispatch(Command::Logout)
    }
    pub fn refresh_models(&mut self) -> Result<u64, DesktopAiError> {
        self.dispatch(Command::RefreshModels)
    }
    pub fn send(&mut self, model: Id, prompt: String) -> Result<u64, DesktopAiError> {
        self.send_with_reasoning(model, prompt, None)
    }
    pub fn send_with_reasoning(
        &mut self,
        model: Id,
        prompt: String,
        reasoning_effort: Option<String>,
    ) -> Result<u64, DesktopAiError> {
        if prompt.is_empty() {
            return Err(DesktopAiError::InvalidPrompt);
        }
        self.dispatch(Command::Send(TurnRequest {
            model_id: model,
            reasoning_effort,
            prompt,
        }))
    }
    pub fn cancel_turn(&mut self) -> Result<u64, DesktopAiError> {
        self.dispatch(Command::CancelTurn)
    }
    fn dispatch(&mut self, cmd: Command) -> Result<u64, DesktopAiError> {
        if !self.worker_running() || self.shared.stop.load(Ordering::Acquire) {
            return Err(DesktopAiError::Closed);
        }
        if self.pending.is_some() {
            return Err(DesktopAiError::Busy);
        }
        let id = self.next_id;
        let next = id.checked_add(1).ok_or(DesktopAiError::SequenceExhausted)?;
        self.commands.try_send((id, cmd)).map_err(|e| match e {
            mpsc::TrySendError::Full(_) => DesktopAiError::Busy,
            mpsc::TrySendError::Disconnected(_) => DesktopAiError::Closed,
        })?;
        self.next_id = next;
        self.pending = Some(id);
        Ok(id)
    }
    /// Never waits for the worker mutex. None means no new snapshot or contention.
    pub fn poll(&mut self) -> Option<DesktopAiUpdate> {
        let mut lock = self.shared.latest.try_lock().ok()?;
        let mut update = lock.take()?;
        update.view.worker_running = self.worker_running();
        if update
            .view
            .last_command
            .is_some_and(|o| Some(o.id) == self.pending)
            || !update.view.worker_running
        {
            self.pending = None;
        }
        Some(update)
    }
    /// Nonblocking local shutdown. Does not claim provider logout/revocation.
    pub fn shutdown(&mut self) {
        self.shared.stop.store(true, Ordering::Release);
    }
}
impl Drop for DesktopAiController {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn publish(shared: &Shared, view: DesktopAiView, prompt: &mut Option<LoginPrompt>) {
    // Worker may wait for this tiny critical section; GUI only uses try_lock.
    if let Ok(mut slot) = shared.latest.lock() {
        let awaiting = view.coordinator.login.status == LoginStatus::Pending
            && view
                .auth
                .as_ref()
                .is_some_and(|a| a.status == AuthStatus::AwaitingUser);
        let previous = slot.take();
        let retained = previous.and_then(|p| {
            if awaiting && p.view.coordinator.login.generation == view.coordinator.login.generation
            {
                p.prompt
            } else {
                None
            }
        });
        let action = if awaiting {
            prompt.take().or(retained)
        } else {
            prompt.take();
            None
        };
        *slot = Some(DesktopAiUpdate {
            view,
            prompt: action,
        });
    }
}
#[allow(clippy::too_many_arguments)]
fn run(
    mut c: Coordinator,
    provider: Id,
    host: Id,
    config: LaunchConfig,
    method: LoginMethod,
    timeout: Duration,
    rx: mpsc::Receiver<(u64, Command)>,
    shared: &Shared,
) {
    let mut a = match ManagedCodexAdapter::new(provider, host, config, method, timeout) {
        Ok(a) => a,
        Err(e) => {
            publish(
                shared,
                DesktopAiView {
                    coordinator: c.view(),
                    auth: None,
                    turn_process: None,
                    last_command: None,
                    fatal: Some(DesktopAiError::Process(e)),
                    worker_running: false,
                },
                &mut None,
            );
            return;
        }
    };
    let mut login_ticket: Option<LoginTicket> = None;
    let mut last = None;
    let mut prompt = None;
    while !shared.stop.load(Ordering::Acquire) {
        match rx.recv_timeout(Duration::from_millis(10)) {
            Ok((id, cmd)) => {
                let kind = cmd.kind();
                let result = match cmd {
                    Command::Login(expected) => c.begin_login(&mut a, expected).map(|t| {
                        login_ticket = Some(t);
                    }),
                    Command::CancelLogin => match login_ticket.as_ref() {
                        Some(t) => c.cancel_login(&mut a, t).map(|_| ()),
                        None => Err(Error::NoLogin),
                    },
                    Command::Logout => a.logout(&mut c).map(|_| ()),
                    Command::Send(r) => c.start_turn(&mut a, r).map(|_| ()),
                    Command::RefreshModels => {
                        a.refresh_models().map_err(|_| Error::ProviderDispatch)
                    }
                    Command::CancelTurn => match c.view().turn {
                        Some(t) => c.cancel_turn(&mut a, &t.ticket).map(|_| ()),
                        None => Err(Error::NoTurn),
                    },
                }
                .map_err(DesktopAiError::Session);
                last = Some(CommandOutcome { id, kind, result });
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        // Bounded work per iteration; transport state machines retain excess events.
        for _ in 0..8 {
            a.pump(&mut c, Duration::ZERO);
        }
        if let Some(p) = a.take_prompt() {
            prompt = Some(p);
        }
        let view = DesktopAiView {
            coordinator: c.view(),
            auth: Some(a.auth_view()),
            turn_process: a.turn_process_view(),
            last_command: last,
            fatal: None,
            worker_running: true,
        };
        if view.coordinator.login.status != LoginStatus::Pending {
            login_ticket = None;
        }
        publish(shared, view, &mut prompt);
    }
    // Never block GUI waiting for provider IO or child Drop. Only this worker does so.
    drop(a);
    publish(
        shared,
        DesktopAiView {
            coordinator: c.view(),
            auth: None,
            turn_process: None,
            last_command: last,
            fatal: None,
            worker_running: false,
        },
        &mut None,
    );
}
