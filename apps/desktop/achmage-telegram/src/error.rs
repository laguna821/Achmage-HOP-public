use std::fmt;

/// Every failure this crate reports.
///
/// No variant carries the bot token: transport errors drop their details (they embed the request
/// URL, which contains the token) and Telegram descriptions are scrubbed before they land here.
/// `Display` is Korean so the UI can show it directly.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// The token does not have BotFather's `<digits>:<secret>` shape. The input is not echoed.
    MalformedToken,
    /// No bot token has been stored yet.
    MissingToken,
    /// Telegram rejected the token (HTTP 401).
    InvalidToken,
    /// Another `getUpdates` consumer or a webhook owns this bot (HTTP 409).
    Conflict,
    /// Telegram flood control (HTTP 429).
    RateLimited {
        /// Seconds Telegram asked us to wait.
        retry_after: u64,
    },
    /// Any other Bot API error.
    Telegram {
        /// Telegram `error_code`, or the HTTP status when the body had none.
        code: u16,
        /// Telegram `description`, scrubbed of the token and truncated.
        description: String,
    },
    /// Connection failure or timeout.
    Network,
    /// The response body exceeded [`crate::api::MAX_BODY`].
    ResponseTooLarge,
    /// The response was not a Bot API envelope of the expected shape.
    InvalidResponse,
    /// The Bot API base URL is not HTTPS (plain HTTP is accepted for loopback test servers only).
    InsecureBaseUrl,
    /// There is nothing to send.
    EmptyMessage,
    /// The document exceeds [`crate::api::MAX_DOCUMENT_BYTES`]; nothing was uploaded.
    DocumentTooLarge,
    /// The document caption exceeds [`crate::api::MAX_CAPTION_LEN`]; nothing was uploaded.
    CaptionTooLong,
    /// The target user is not on the allowlist.
    NotAllowed,
    /// The gateway has no verified bot connection.
    NotRunning,
    /// The pairing code is wrong or expired.
    CodeRejected,
    /// Too many wrong pairing codes; approvals are refused until this Unix time (seconds).
    ApprovalLocked {
        /// Unix time (seconds) when approvals open again.
        until: u64,
    },
    /// The credential store failed.
    SecretStore(String),
    /// The gateway state file could not be read or written.
    State(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MalformedToken => f.write_str(
                "봇 토큰 형식이 올바르지 않습니다. BotFather가 발급한 `숫자:영문·숫자` 형식이어야 합니다.",
            ),
            Self::MissingToken => f.write_str("저장된 봇 토큰이 없습니다."),
            Self::InvalidToken => f.write_str("텔레그램이 봇 토큰을 거부했습니다."),
            Self::Conflict => f.write_str("다른 프로그램이 이 봇의 메시지를 받고 있습니다."),
            Self::RateLimited { retry_after } => write!(
                f,
                "텔레그램 요청 한도를 넘었습니다. {retry_after}초 뒤에 다시 시도하세요."
            ),
            Self::Telegram { code, description } => {
                write!(f, "텔레그램 오류 {code}: {description}")
            }
            Self::Network => f.write_str("텔레그램 서버에 연결하지 못했습니다."),
            Self::ResponseTooLarge => f.write_str("텔레그램 응답이 너무 큽니다."),
            Self::InvalidResponse => f.write_str("텔레그램 응답을 해석하지 못했습니다."),
            Self::InsecureBaseUrl => f.write_str("봇 API 주소는 HTTPS여야 합니다."),
            Self::EmptyMessage => f.write_str("보낼 내용이 비어 있습니다."),
            Self::DocumentTooLarge => f.write_str("파일이 너무 커서 보낼 수 없습니다(최대 45MiB)."),
            Self::CaptionTooLong => f.write_str("파일 설명이 너무 깁니다(최대 1024자)."),
            Self::NotAllowed => f.write_str("승인되지 않은 사용자에게는 보낼 수 없습니다."),
            Self::NotRunning => f.write_str("텔레그램 게이트웨이가 연결되어 있지 않습니다."),
            Self::CodeRejected => f.write_str("연결 코드가 맞지 않거나 만료되었습니다."),
            Self::ApprovalLocked { .. } => f.write_str(
                "잘못된 코드가 반복되어 승인이 1시간 동안 잠겼습니다. 잠시 후 다시 시도하세요.",
            ),
            Self::SecretStore(message) | Self::State(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for Error {}
