//! A response must belong to the accepted dispatch, not a prior completed turn.
use crate::controller::DesktopAiView;
use hangul_ai_session::{TurnStatus, TurnTicket, TurnView};
pub struct ReviewFence {
    command_id: u64,
    previous: Option<TurnTicket>,
    accepted: Option<TurnTicket>,
    failed: bool,
}
impl ReviewFence {
    pub fn new(command_id: u64, previous: Option<TurnTicket>) -> Self {
        Self {
            command_id,
            previous,
            accepted: None,
            failed: false,
        }
    }
    pub fn observe(&mut self, view: &DesktopAiView) {
        if let Some(result) = view.last_command.filter(|c| c.id == self.command_id) {
            if result.result.is_err() {
                self.failed = true;
                self.accepted = None;
                return;
            }
            if let Some(turn) = &view.coordinator.turn {
                if self.previous.as_ref() != Some(&turn.ticket) && self.accepted.is_none() {
                    self.accepted = Some(turn.ticket.clone());
                }
            }
        }
    }
    pub fn permits(&self, turn: &TurnView) -> bool {
        !self.failed
            && turn.status == TurnStatus::Completed
            && self.accepted.as_ref() == Some(&turn.ticket)
    }
}
