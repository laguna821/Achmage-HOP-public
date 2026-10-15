use achmage_research::secrets::{OsSecretStore, SecretStore};
fn main() {
    let store = OsSecretStore;
    let name = format!(
        "synthetic-owned-test-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_millis()
    );
    let field = "fixture";
    let result = (|| -> Result<(), String> {
        if store.get(&name, field)?.is_some() {
            return Err("Unexpected existing fixture entry".into());
        }
        store.set(&name, field, Some("synthetic-non-secret"))?;
        if store.get(&name, field)?.as_deref().map(|s| s.as_str()) != Some("synthetic-non-secret") {
            return Err("Roundtrip mismatch".into());
        }
        store.set(&name, field, None)?;
        if store.get(&name, field)?.is_some() {
            return Err("Removal not confirmed".into());
        }
        Ok(())
    })();
    let _ = store.set(&name, field, None);
    println!(
        "{}",
        serde_json::json!({"platform":std::env::consts::OS,"namespace":"local.achmage.hop.research.v1","syntheticEntry":name,"passed":result.is_ok(),"error":result.err(),"existingCredentialsRead":false})
    );
}
