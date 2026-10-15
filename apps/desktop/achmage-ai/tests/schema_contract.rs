#[path = "schema/validate.rs"]
mod schema;
use serde_json::{Value, json};
fn check(raw: &str, v: Value) -> bool {
    let s: Value = serde_json::from_str(raw).unwrap();
    schema::valid(&s, &v, &s)
}
#[test]
fn official_thread_enums_reject_the_original_wrong_wire_values() {
    let s = include_str!("schema/ThreadStartParams.json");
    assert!(check(
        s,
        json!({"sandbox":"read-only","approvalPolicy":"untrusted","ephemeral":true})
    ));
    assert!(!check(s, json!({"sandbox":"readOnly"})));
    assert!(!check(s, json!({"approvalPolicy":"unlessTrusted"})));
    schema::request(
        &json!({"method":"thread/start","params":{"sandbox":"read-only","approvalPolicy":"untrusted","model":"fixture","ephemeral":true}}),
    );
}
#[test]
fn official_auth_variants_are_distinct_and_cancel_status_has_two_values() {
    let s = include_str!("schema/LoginAccountParams.json");
    assert!(check(s, json!({"type":"chatgpt"})));
    assert!(check(s, json!({"type":"chatgptDeviceCode"})));
    assert!(!check(s, json!({"type":"chatgptAuthTokens"})));
    let s = include_str!("schema/CancelLoginAccountResponse.json");
    assert!(check(s, json!({"status":"canceled"})));
    assert!(check(s, json!({"status":"notFound"})));
    assert!(!check(s, json!({})));
    assert!(!check(s, json!({"status":"cancelled"})));
}
#[test]
fn official_turn_text_input_and_interrupt_require_matching_fields() {
    let s = include_str!("schema/TurnStartParams.json");
    assert!(check(
        s,
        json!({"threadId":"t","input":[{"type":"text","text":"한글🦀"}]})
    ));
    assert!(!check(s, json!({"threadId":"t","input":[{"type":"text"}]})));
    assert!(!check(s, json!({"input":[]})));
    let s = include_str!("schema/TurnInterruptParams.json");
    assert!(check(s, json!({"threadId":"t","turnId":"u"})));
    assert!(!check(s, json!({"threadId":"t"})));
}
