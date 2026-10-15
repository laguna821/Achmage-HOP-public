//! Bot token storage. The token controls the whole bot, so it lives only in the OS credential
//! store (or an explicit in-memory store in tests) and is never shown back to anyone.

use crate::Error;
use std::{collections::BTreeMap, fmt, sync::Mutex};
use zeroize::Zeroizing;

/// Keyring service name, separate from the research credentials.
pub const SERVICE: &str = "local.achmage.hop.telegram.v1";
/// Keyring account that holds the bot token.
pub const TOKEN_ACCOUNT: &str = "bot-token";

/// Secret storage keyed by account name.
pub trait SecretStore: Send + Sync {
    /// Reads a secret; `Ok(None)` when nothing is stored.
    fn get(&self, account: &str) -> Result<Option<Zeroizing<String>>, String>;
    /// Stores or replaces a secret.
    fn set(&self, account: &str, value: &str) -> Result<(), String>;
    /// Removes a secret. Removing a missing secret succeeds.
    fn delete(&self, account: &str) -> Result<(), String>;
}

/// The operating system credential store (Windows Credential Manager, macOS Keychain, Secret
/// Service on Linux).
pub struct OsSecretStore;

fn entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, account)
        .map_err(|_| "OS 자격 증명 저장소를 사용할 수 없습니다.".into())
}

impl SecretStore for OsSecretStore {
    fn get(&self, account: &str) -> Result<Option<Zeroizing<String>>, String> {
        match entry(account)?.get_password() {
            Ok(value) => Ok(Some(Zeroizing::new(value))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("OS 자격 증명 저장소가 잠겨 있거나 사용할 수 없습니다.".into()),
        }
    }
    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        entry(account)?
            .set_password(value)
            .map_err(|_| "OS 자격 증명 저장소에 쓰지 못했습니다.".into())
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        match entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("OS 자격 증명 저장소에서 지우지 못했습니다.".into()),
        }
    }
}

/// Explicit test injection only. Product code uses [`OsSecretStore`], never a silent fallback.
#[derive(Default)]
pub struct MemorySecrets(Mutex<BTreeMap<String, Zeroizing<String>>>);

impl MemorySecrets {
    fn map(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, Zeroizing<String>>> {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl SecretStore for MemorySecrets {
    fn get(&self, account: &str) -> Result<Option<Zeroizing<String>>, String> {
        Ok(self.map().get(account).cloned())
    }
    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        self.map()
            .insert(account.into(), Zeroizing::new(value.into()));
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        self.map().remove(account);
        Ok(())
    }
}

/// A bot token whose shape has been checked. `Debug` is redacted and there is no `Display`; only
/// the API client reads the raw value, and the memory is wiped on drop.
pub struct BotToken(Zeroizing<String>);

impl BotToken {
    /// Validates `<digits>:<35+ of [A-Za-z0-9_-]>` (surrounding whitespace from pasting is
    /// trimmed). Anything else is rejected with [`Error::MalformedToken`], which never echoes the
    /// input.
    pub fn parse(raw: &str) -> Result<Self, Error> {
        let raw = raw.trim();
        if valid_shape(raw) {
            Ok(Self(Zeroizing::new(raw.to_string())))
        } else {
            Err(Error::MalformedToken)
        }
    }
    /// Loads the stored token; `Ok(None)` when none is stored. A stored value that fails the
    /// shape check is reported as [`Error::MalformedToken`] rather than used.
    pub fn load(store: &dyn SecretStore) -> Result<Option<Self>, Error> {
        match store.get(TOKEN_ACCOUNT).map_err(Error::SecretStore)? {
            Some(raw) => Self::parse(&raw).map(Some),
            None => Ok(None),
        }
    }
    /// Stores this token, replacing any previous one.
    pub fn save(&self, store: &dyn SecretStore) -> Result<(), Error> {
        store
            .set(TOKEN_ACCOUNT, &self.0)
            .map_err(Error::SecretStore)
    }
    /// Deletes the stored token.
    pub fn clear(store: &dyn SecretStore) -> Result<(), Error> {
        store.delete(TOKEN_ACCOUNT).map_err(Error::SecretStore)
    }
    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for BotToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("BotToken(<redacted>)")
    }
}

fn valid_shape(token: &str) -> bool {
    let Some((id, secret)) = token.split_once(':') else {
        return false;
    };
    // Upper bounds only keep absurd pastes out; real tokens are ~10 digits and 35 characters.
    (1..=20).contains(&id.len())
        && id.bytes().all(|b| b.is_ascii_digit())
        && (35..=200).contains(&secret.len())
        && secret
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
