//! Telegram bot gateway that lets one owner talk to the HOP desktop app from a phone.
//!
//! # Security model
//! - The bot token is stored only through a [`SecretStore`] (the OS credential store in
//!   production) and never appears in `Debug` output, errors or [`GatewayStatus`].
//! - Only private chats are processed. Messages from allowlisted users become
//!   [`InboundRequest`]s; anyone else can only receive a pairing code, which the owner must type
//!   into the desktop app ([`Gateway::approve`]). Nothing sent over Telegram can approve a user.
//! - Text in; text and generated documents out. No webhooks, inbound file downloads, groups or
//!   command execution. Inbound text is data for the app to show or answer, never an instruction
//!   to this crate.
//! - No UI framework dependency: the caller injects the state file path and the secret store, so
//!   the gateway runs inside the desktop app or a plain background binary alike.
//!
//! # Wiring
//! ```no_run
//! # async fn wire(state: std::path::PathBuf) -> Result<(), achmage_telegram::Error> {
//! use achmage_telegram::{BotApi, BotToken, Gateway, OsSecretStore};
//! // Settings screen: validate and store the token once.
//! BotToken::parse("<token from BotFather>")?.save(&OsSecretStore)?;
//! // App start or "enable" toggle.
//! let gateway = Gateway::open(state)?;
//! gateway.start(BotApi::from_store(&OsSecretStore)?).await?;
//! loop {
//!     gateway.wait_for_requests().await;
//!     for request in gateway.take_requests() {
//!         // Hand `request.text` to the app as user content, then answer the same user.
//!         gateway.reply(request.user_id, "받았습니다.").await?;
//!     }
//! }
//! # }
//! ```
#![warn(missing_docs)]

pub mod access;
pub mod api;
mod error;
pub mod gateway;
pub mod secrets;

pub use access::{AccessControl, AllowedUser, Clock, InboundRequest, PendingRequest, SystemClock};
pub use api::{
    sanitize_file_name, split_message, BotApi, BotInfo, Update, MAX_DOCUMENT_BYTES, MAX_MESSAGE_LEN,
};
pub use error::Error;
pub use gateway::{Gateway, GatewayStatus};
pub use secrets::{BotToken, MemorySecrets, OsSecretStore, SecretStore};
