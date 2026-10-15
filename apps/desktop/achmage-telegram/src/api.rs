//! Minimal Telegram Bot API client: `getMe`, long-polling `getUpdates` and `sendMessage`.

use crate::{
    secrets::{BotToken, SecretStore},
    Error,
};
use reqwest::{
    multipart::{Form, Part},
    redirect::Policy,
    Client, RequestBuilder, Response, Url,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fmt, time::Duration};
use zeroize::Zeroizing;

/// Production Bot API endpoint.
pub const DEFAULT_BASE_URL: &str = "https://api.telegram.org";
/// Telegram's per-message limit. Parts are measured in UTF-16 code units, which is how Telegram
/// counts, so every part is also at most this many characters.
pub const MAX_MESSAGE_LEN: usize = 4096;
/// Largest response body accepted from the Bot API.
pub const MAX_BODY: usize = 2 * 1024 * 1024;
/// Largest document uploaded, safely under Telegram's 50 MB bot upload limit.
pub const MAX_DOCUMENT_BYTES: usize = 45 * 1024 * 1024;
/// Telegram's caption limit, in UTF-16 code units.
pub const MAX_CAPTION_LEN: usize = 1024;
/// Longest file name sent with a document, in characters.
pub const MAX_FILE_NAME_CHARS: usize = 120;
/// Telegram caps long polling at 50 seconds.
const MAX_POLL_SECS: u64 = 50;
/// Allowance on top of the long-poll wait, and the whole budget for short calls.
const REQUEST_SLACK_SECS: u64 = 10;

/// Identity of the bot behind the token, from `getMe`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BotInfo {
    /// Numeric bot id.
    pub id: i64,
    /// Bot username without the leading `@`.
    #[serde(default)]
    pub username: String,
    /// Display name set in BotFather.
    #[serde(default)]
    pub first_name: String,
}

/// One Telegram update. Only `message` updates are requested; anything else, or a message this
/// client cannot parse, leaves `message` empty so the update is still acknowledged.
#[derive(Debug, Clone, Deserialize)]
pub struct Update {
    /// Monotonic update identifier used for the polling offset.
    pub update_id: i64,
    /// The new message, if this update carries one.
    #[serde(default, deserialize_with = "lenient_message")]
    pub message: Option<Message>,
}

/// The subset of a Telegram message this gateway reads. Every field is untrusted user data.
#[derive(Debug, Clone, Deserialize)]
pub struct Message {
    /// Message id within the chat.
    pub message_id: i64,
    /// Sender; absent for channel posts.
    #[serde(default)]
    pub from: Option<User>,
    /// Chat the message was sent in.
    pub chat: Chat,
    /// Unix time the message was sent.
    #[serde(default)]
    pub date: i64,
    /// Text body; absent for photos, files, stickers and other media.
    #[serde(default)]
    pub text: Option<String>,
}

/// A Telegram user.
#[derive(Debug, Clone, Deserialize)]
pub struct User {
    /// Stable numeric user id.
    pub id: i64,
    /// True for bots.
    #[serde(default)]
    pub is_bot: bool,
    /// First name (user-controlled).
    #[serde(default)]
    pub first_name: String,
    /// Last name (user-controlled).
    #[serde(default)]
    pub last_name: Option<String>,
    /// Username without `@` (user-controlled).
    #[serde(default)]
    pub username: Option<String>,
}

/// A Telegram chat.
#[derive(Debug, Clone, Deserialize)]
pub struct Chat {
    /// Chat id; for private chats it equals the other user's id.
    pub id: i64,
    /// `private`, `group`, `supergroup` or `channel`.
    #[serde(rename = "type")]
    pub kind: String,
}

fn lenient_message<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Message>, D::Error> {
    // A malformed message must not fail the whole batch, or its update would be fetched forever.
    Ok(serde_json::from_value(Value::deserialize(d)?).ok())
}

#[derive(Deserialize)]
struct Envelope {
    ok: bool,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    error_code: Option<u16>,
    #[serde(default)]
    parameters: Option<Parameters>,
}

#[derive(Deserialize)]
struct Parameters {
    #[serde(default)]
    retry_after: Option<u64>,
}

/// Bot API client bound to one token. `Debug` shows only the base URL.
pub struct BotApi {
    client: Client,
    base: Url,
    token: BotToken,
}

impl fmt::Debug for BotApi {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BotApi")
            .field("base", &self.base.as_str())
            .finish_non_exhaustive()
    }
}

impl BotApi {
    /// Client for the production Bot API at [`DEFAULT_BASE_URL`].
    pub fn new(token: BotToken) -> Result<Self, Error> {
        Self::with_base_url(token, DEFAULT_BASE_URL)
    }
    /// Client for the stored token (see [`BotToken::load`]).
    pub fn from_store(store: &dyn SecretStore) -> Result<Self, Error> {
        Self::new(BotToken::load(store)?.ok_or(Error::MissingToken)?)
    }
    /// Client for another Bot API server. **For tests only**: it exists so tests can point the
    /// client at a loopback emulator; product code must use [`BotApi::new`]. HTTPS is required
    /// unless the host is `127.0.0.1`, `localhost` or `[::1]`, and URLs with credentials, a query
    /// or a fragment are refused, so the token can never travel in cleartext off the machine.
    pub fn with_base_url(token: BotToken, base: &str) -> Result<Self, Error> {
        let base = checked_base(base)?;
        // No redirects: following one would resend the token-bearing path to another origin.
        let client = Client::builder()
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(REQUEST_SLACK_SECS))
            .user_agent("Achmage-HOP-Telegram/0.1")
            .build()
            .map_err(|_| Error::Network)?;
        Ok(Self {
            client,
            base,
            token,
        })
    }
    /// Verifies the token and returns the bot identity.
    pub async fn get_me(&self) -> Result<BotInfo, Error> {
        let result = self
            .call("getMe", &json!({}), Duration::from_secs(REQUEST_SLACK_SECS))
            .await?;
        serde_json::from_value(result).map_err(|_| Error::InvalidResponse)
    }
    /// Long-polls for new messages starting at `offset` (the last processed `update_id + 1`),
    /// waiting up to `timeout_secs` (capped at 50). Updates come back sorted by `update_id`.
    pub async fn get_updates(&self, offset: i64, timeout_secs: u64) -> Result<Vec<Update>, Error> {
        let wait = timeout_secs.min(MAX_POLL_SECS);
        let body = json!({"offset": offset, "timeout": wait, "allowed_updates": ["message"]});
        let result = self
            .call(
                "getUpdates",
                &body,
                Duration::from_secs(wait + REQUEST_SLACK_SECS),
            )
            .await?;
        let items: Vec<Value> =
            serde_json::from_value(result).map_err(|_| Error::InvalidResponse)?;
        let mut updates: Vec<Update> = items
            .into_iter()
            .filter_map(|item| serde_json::from_value(item).ok())
            .collect();
        updates.sort_by_key(|update| update.update_id);
        Ok(updates)
    }
    /// Sends plain text to a chat, split into parts of at most [`MAX_MESSAGE_LEN`]. No
    /// `parse_mode` is set, so the text is delivered verbatim and never interpreted as markup.
    /// Link previews are off: Telegram's servers would otherwise fetch any URL in a reply by
    /// themselves, so a model tricked into writing a URL could leak data without a click.
    pub async fn send_message(&self, chat_id: i64, text: &str) -> Result<(), Error> {
        let parts: Vec<String> = split_message(text)
            .into_iter()
            .filter(|part| !part.trim().is_empty())
            .collect();
        if parts.is_empty() {
            return Err(Error::EmptyMessage);
        }
        for part in parts {
            self.call(
                "sendMessage",
                &json!({
                    "chat_id": chat_id,
                    "text": part,
                    "link_preview_options": {"is_disabled": true},
                }),
                Duration::from_secs(REQUEST_SLACK_SECS),
            )
            .await?;
        }
        Ok(())
    }
    /// Uploads a generated document to a chat as `multipart/form-data` (`sendDocument`). The
    /// size and caption limits are checked before any request is made, and the file name is
    /// reduced with [`sanitize_file_name`]. The upload timeout grows with the size, assuming at
    /// least ~1 Mbit/s of upstream bandwidth.
    pub async fn send_document(
        &self,
        chat_id: i64,
        file_name: &str,
        bytes: Vec<u8>,
        caption: Option<&str>,
    ) -> Result<(), Error> {
        if bytes.is_empty() {
            return Err(Error::EmptyMessage);
        }
        if bytes.len() > MAX_DOCUMENT_BYTES {
            return Err(Error::DocumentTooLarge);
        }
        if caption.is_some_and(|c| c.encode_utf16().count() > MAX_CAPTION_LEN) {
            return Err(Error::CaptionTooLong);
        }
        let timeout = Duration::from_secs(30 + bytes.len() as u64 / (128 * 1024));
        let document = Part::bytes(bytes).file_name(sanitize_file_name(file_name));
        let mut form = Form::new()
            .text("chat_id", chat_id.to_string())
            .part("document", document);
        if let Some(caption) = caption.filter(|c| !c.trim().is_empty()) {
            form = form.text("caption", caption.to_string());
        }
        let request = self
            .client
            .post(self.method_url("sendDocument")?)
            .multipart(form);
        self.execute(request, timeout).await.map(|_| ())
    }
    async fn call(&self, method: &str, body: &Value, timeout: Duration) -> Result<Value, Error> {
        let request = self.client.post(self.method_url(method)?).json(body);
        self.execute(request, timeout).await
    }
    async fn execute(&self, request: RequestBuilder, timeout: Duration) -> Result<Value, Error> {
        let response = request
            .timeout(timeout)
            .send()
            .await
            // reqwest errors embed the URL, and the URL contains the token: drop the details.
            .map_err(|_| Error::Network)?;
        let status = response.status().as_u16();
        let body = read_capped(response).await?;
        self.unwrap_envelope(status, &body)
    }
    fn method_url(&self, method: &str) -> Result<Url, Error> {
        let mut url = self.base.clone();
        let segment = Zeroizing::new(format!("bot{}", self.token.expose()));
        url.path_segments_mut()
            .map_err(|_| Error::InsecureBaseUrl)?
            .pop_if_empty()
            .push(&segment)
            .push(method);
        Ok(url)
    }
    fn unwrap_envelope(&self, status: u16, body: &[u8]) -> Result<Value, Error> {
        let envelope: Option<Envelope> = serde_json::from_slice(body).ok();
        let code = envelope
            .as_ref()
            .and_then(|e| e.error_code)
            .unwrap_or(status);
        let is = |expected: u16| status == expected || code == expected;
        match envelope {
            Some(e) if e.ok && (200..300).contains(&status) => {
                e.result.ok_or(Error::InvalidResponse)
            }
            _ if is(401) => Err(Error::InvalidToken),
            _ if is(409) => Err(Error::Conflict),
            Some(e) if is(429) => Err(Error::RateLimited {
                retry_after: e.parameters.and_then(|p| p.retry_after).unwrap_or(1),
            }),
            None if is(429) => Err(Error::RateLimited { retry_after: 1 }),
            Some(e) => Err(Error::Telegram {
                code,
                description: self.scrub(e.description.as_deref().unwrap_or_default()),
            }),
            None => Err(Error::InvalidResponse),
        }
    }
    /// Telegram should never echo the token, but a description is shown in the UI, so make sure.
    fn scrub(&self, text: &str) -> String {
        let token = self.token.expose();
        let secret = token.split_once(':').map_or(token, |(_, secret)| secret);
        text.replace(token, "<redacted>")
            .replace(secret, "<redacted>")
            .chars()
            .filter(|c| !c.is_control())
            .take(200)
            .collect()
    }
}

fn checked_base(raw: &str) -> Result<Url, Error> {
    let url = Url::parse(raw).map_err(|_| Error::InsecureBaseUrl)?;
    let loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    let scheme_ok = url.scheme() == "https" || (url.scheme() == "http" && loopback);
    if !scheme_ok
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(Error::InsecureBaseUrl);
    }
    Ok(url)
}

async fn read_capped(mut response: Response) -> Result<Vec<u8>, Error> {
    if response
        .content_length()
        .is_some_and(|n| n > MAX_BODY as u64)
    {
        return Err(Error::ResponseTooLarge);
    }
    // Enforced while reading too: a close-delimited or chunked body has no declared length.
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| Error::Network)? {
        if body.len() + chunk.len() > MAX_BODY {
            return Err(Error::ResponseTooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// Reduces a file name to something safe to show and save on the phone: only the last path
/// component, no control, invisible or reserved characters (`/ \ : * ? " < > |`), at most
/// [`MAX_FILE_NAME_CHARS`] characters with the extension kept. Falls back to `document`.
pub fn sanitize_file_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or_default();
    let clean: String = base
        .chars()
        .filter(|c| {
            !c.is_control()
                && !crate::access::is_invisible(*c)
                && !matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|')
        })
        .collect();
    // Leading/trailing dots and spaces make hidden or invalid names on some systems.
    let clean = clean.trim_matches(|c: char| c == '.' || c.is_whitespace());
    if clean.is_empty() {
        return "document".into();
    }
    if clean.chars().count() <= MAX_FILE_NAME_CHARS {
        return clean.into();
    }
    let (stem, extension) = match clean.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && (1..=16).contains(&ext.chars().count()) => {
            (stem, Some(ext))
        }
        _ => (clean, None),
    };
    let keep = MAX_FILE_NAME_CHARS - extension.map_or(0, |ext| ext.chars().count() + 1);
    let mut out: String = stem.chars().take(keep).collect();
    if let Some(ext) = extension {
        out.push('.');
        out.push_str(ext);
    }
    out
}

/// Splits `text` into Telegram-sized parts on character boundaries, cutting after the last line
/// break that fits when there is one. The parts concatenate back to `text` exactly.
pub fn split_message(text: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut rest = text;
    while !rest.is_empty() {
        let mut units = 0;
        let mut end = rest.len();
        let mut after_newline = None;
        for (at, c) in rest.char_indices() {
            units += c.len_utf16();
            if units > MAX_MESSAGE_LEN {
                end = at;
                break;
            }
            if c == '\n' {
                after_newline = Some(at + 1);
            }
        }
        if end < rest.len() {
            end = after_newline.unwrap_or(end);
        }
        let (part, tail) = rest.split_at(end);
        parts.push(part.to_string());
        rest = tail;
    }
    parts
}
