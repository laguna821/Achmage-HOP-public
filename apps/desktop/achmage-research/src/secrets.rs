use std::{collections::BTreeMap, sync::Mutex};
use zeroize::Zeroizing;
pub trait SecretStore: Send + Sync {
    fn get(&self, source: &str, field: &str) -> Result<Option<Zeroizing<String>>, String>;
    fn set(&self, source: &str, field: &str, value: Option<&str>) -> Result<(), String>;
}
pub struct OsSecretStore;
const SERVICE: &str = "local.achmage.hop.research.v1";
impl SecretStore for OsSecretStore {
    fn get(&self, s: &str, f: &str) -> Result<Option<Zeroizing<String>>, String> {
        let e = keyring::Entry::new(SERVICE, &format!("{s}:{f}"))
            .map_err(|_| "OS credential store unavailable")?;
        match e.get_password() {
            Ok(v) => Ok(Some(Zeroizing::new(v))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("OS credential store locked or unavailable".into()),
        }
    }
    fn set(&self, s: &str, f: &str, v: Option<&str>) -> Result<(), String> {
        let e = keyring::Entry::new(SERVICE, &format!("{s}:{f}"))
            .map_err(|_| "OS credential store unavailable")?;
        match v {
            Some(v) => e.set_password(v),
            None => e.delete_credential(),
        }
        .or_else(|e| {
            if matches!(e, keyring::Error::NoEntry) {
                Ok(())
            } else {
                Err(e)
            }
        })
        .map_err(|_| "OS credential store write failed".into())
    }
}
/// Explicit test injection only. Product construction uses OsSecretStore, never a silent fallback.
#[derive(Default)]
pub struct MemorySecrets(Mutex<BTreeMap<String, Zeroizing<String>>>);
impl SecretStore for MemorySecrets {
    fn get(&self, s: &str, f: &str) -> Result<Option<Zeroizing<String>>, String> {
        Ok(self.0.lock().unwrap().get(&format!("{s}:{f}")).cloned())
    }
    fn set(&self, s: &str, f: &str, v: Option<&str>) -> Result<(), String> {
        let mut m = self.0.lock().unwrap();
        let k = format!("{s}:{f}");
        if let Some(v) = v {
            m.insert(k, Zeroizing::new(v.into()));
        } else {
            m.remove(&k);
        }
        Ok(())
    }
}
