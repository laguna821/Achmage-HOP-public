//! Owned deterministic app-server auth protocol fixture. NO login, network or credential files.
use serde_json::{Value, json};
#[path = "../../tests/schema/validate.rs"]
mod schema;
use std::io::{self, BufRead, Write};
fn emit(v: Value) {
    let b = serde_json::to_vec(&v).unwrap();
    let mut o = io::stdout().lock();
    for x in b.chunks(3) {
        o.write_all(x).unwrap();
    }
    o.write_all(b"\n").unwrap();
    o.flush().unwrap();
}
fn complete(id: &str, success: bool) {
    emit(
        json!({"method":"account/login/completed","params":{"loginId":id,"success":success,"error":if success{Value::Null}else{json!("FIXTURE_ERROR_SECRET")}}}),
    );
}
fn main() {
    assert!(std::env::args().any(|a| a == "cli_auth_credentials_store=\"file\"" || a == "cli_auth_credentials_store=\"keyring\""));
    let mode = std::env::args().nth(1).unwrap_or_else(|| "success".into());
    assert!(std::env::var_os("ACCESS_TOKEN").is_none());
    assert!(std::env::var_os("OPENAI_API_KEY").is_none());
    let home = std::env::var("CODEX_HOME").unwrap();
    let first = home.ends_with("-1");
    let mut logged_out = false;
    for line in io::stdin().lock().lines() {
        let v: Value = serde_json::from_str(&line.unwrap()).unwrap();
        if mode=="desktop-catalog-ultra" {schema::desktop_request(&v);} else {schema::request(&v);}
        match v["method"].as_str().unwrap_or("") {
            "initialize" => emit(json!({"id":1,"result":{"userAgent":"fixture"}})),
            "initialized" => {}
            "model/list" => {
                if mode=="desktop-catalog-ultra" {
                    let result:Value=serde_json::from_str(include_str!("../../tests/schema/ObservedDesktopModelCatalog.json")).unwrap();
                    emit(json!({"id":v["id"],"result":result}));continue;
                }
                if mode=="catalog-error" {emit(json!({"id":v["id"],"error":{"code":-1,"message":"FIXTURE_ERROR_SECRET"}}));continue;}
                emit(json!({"id":v["id"],"result":{"data":[{"id":"fixture-picker-id","model":"fixture-model","displayName":"Fixture default","hidden":false,"isDefault":true,"defaultReasoningEffort":"medium","supportedReasoningEfforts":[{"reasoningEffort":"medium","description":"Fixture medium"},{"reasoningEffort":"high","description":"Fixture high"}]}],"nextCursor":null}}));
            }
            "account/login/start" => {
                if mode == "existing-session" { panic!("restored account must not log in again"); }
                if mode == "environment-error" {
                    emit(json!({"id":2,"error":{"code":-32603,"message":"os error FIXTURE_ERROR_SECRET"}}));
                    continue;
                }
                if mode == "eof" {
                    return;
                }
                if mode == "early" {
                    complete("fixture-login", true);
                }
                let method = v["params"]["type"].as_str().unwrap();
                assert!(matches!(method, "chatgpt" | "chatgptDeviceCode"));
                let url = match mode.as_str() {
                    "url-http" => "http://auth.openai.com/x",
                    "url-evil" => "https://auth.openai.com.evil.test/x",
                    "url-userinfo" => "https://auth.openai.com@evil.test/x",
                    "url-backslash" => "https://auth.openai.com/\\evil.test",
                    "url-javascript" => "javascript:alert(1)",
                    _ => "https://auth.openai.com/codex/device?state=FIXTURE_DISPLAY_SECRET",
                };
                emit(if method == "chatgpt" {
                    json!({"id":2,"result":{"type":method,"loginId":"fixture-login","authUrl":url}})
                } else {
                    json!({"id":2,"result":{"type":method,"loginId":"fixture-login","verificationUrl":url,"userCode":"ABCD-1234"}})
                });
                if mode == "request" {
                    emit(json!({"id":91,"method":"item/tool/requestUserInput","params":{}}));
                } else if !matches!(
                    mode.as_str(),
                    "await"
                        | "late-success"
                        | "early"
                        | "cancel-malformed"
                        | "cancel-notfound"
                        | "cancel-empty"
                ) {
                    complete(
                        if mode == "wrong-id" {
                            "different-id"
                        } else {
                            "fixture-login"
                        },
                        mode != "failed" && !(mode == "second-fails" && !first),
                    );
                }
            }
            "account/login/cancel" => {
                assert_eq!(v["params"]["loginId"], "fixture-login");
                if mode == "cancel-notfound" || mode == "cancel-empty" {
                    emit(
                        json!({"id":4,"result":if mode=="cancel-notfound"{json!({"status":"notFound"})}else{json!({})}}),
                    );
                    continue;
                }
                if mode == "cancel-malformed" {
                    emit(json!({"id":4,"result":null,"error":{"code":-1,"message":"fixture"}}));
                    continue;
                }
                emit(json!({"id":4,"result":{"status":"canceled"}}));
                complete("fixture-login", mode == "late-success");
            }
            "account/read" => {
                assert_eq!(v["params"]["refreshToken"], false);
                let account = if mode == "account-null" || mode == "signed-out-resume"
                    || (logged_out && mode != "logout-still-account")
                {
                    Value::Null
                } else {
                    json!({"type":"chatgpt","email":if mode=="second-different"&&!first{"other@example.invalid"}else{"fixture@example.invalid"},"planType":"fixture"})
                };
                emit(json!({"id":v["id"],"result":{"account":account,"requiresOpenaiAuth":true}}));
                if mode == "auth-dies-after-login" {
                    std::thread::spawn(|| {
                        std::thread::sleep(std::time::Duration::from_millis(700));
                        std::process::exit(0);
                    });
                }
            }
            "account/logout" => {
                assert_eq!(v["id"], 20);
                if mode == "logout-fail" {
                    emit(json!({"id":20,"error":{"code":-1,"message":"FIXTURE_ERROR_SECRET"}}));
                } else {
                    logged_out = true;
                    emit(json!({"method":"account/updated","params":{"authMode":null}}));
                    emit(json!({"id":20,"result":{}}));
                }
            }
            "thread/start" => {
                if mode=="desktop-catalog-ultra" {assert_eq!(v["params"]["model"],"gpt-6.1-sol");}
                if mode == "thread-rejected" {
                    emit(json!({"id":2,"error":{"code":-32602,"message":"FIXTURE_ERROR_SECRET","data":{"private":"FIXTURE_DISPLAY_SECRET"}}}));
                } else { emit(json!({"id":2,"result":{"thread":{"id":"thread-fixture"}}})); }
            },
            "turn/start" => {
                if mode == "long-prompt" {
                    assert_eq!(v["params"]["input"][0]["text"], "한글 원문\n".repeat(50_000));
                }
                if mode=="desktop-catalog-ultra" {assert_eq!(v["params"]["effort"],"ultra");}
                if mode=="effort-high" {assert_eq!(v["params"]["effort"],"high");}
                emit(json!({"id":3,"result":{"turn":{"id":"turn-fixture","status":"inProgress"}}}));
                if matches!(mode.as_str(), "turn-failed" | "turn-unknown-failed" | "turn-notice-failed" | "turn-notice-recovered") {
                    if mode.starts_with("turn-notice") {
                        emit(json!({"method":"error","params":{"threadId":"thread-fixture","turnId":"turn-fixture","willRetry":true,"error":{"message":"FIXTURE_ERROR_SECRET","codexErrorInfo":"rateLimitExceeded"}}}));
                    }
                    if mode != "turn-notice-recovered" {
                        let error = if mode == "turn-failed" { json!({"message":"FIXTURE_ERROR_SECRET","additionalDetails":"FIXTURE_DISPLAY_SECRET","codexErrorInfo":"contextWindowExceeded"}) } else { Value::Null };
                        emit(json!({"method":"turn/completed","params":{"threadId":"thread-fixture","turn":{"id":"turn-fixture","status":"failed","error":error}}}));
                        return;
                    }
                }
                if mode == "turn-await" {
                    emit(
                        json!({"method":"item/agentMessage/delta","params":{"threadId":"thread-fixture","turnId":"turn-fixture","itemId":"item-fixture","delta":"대기"}}),
                    );
                    continue;
                }
                emit(
                    json!({"method":"item/agentMessage/delta","params":{"threadId":"thread-fixture","turnId":"turn-fixture","itemId":"item-fixture","delta":"시험 프로세스 응답"}}),
                );
                emit(
                    json!({"method":"turn/completed","params":{"threadId":"thread-fixture","turn":{"id":"turn-fixture","status":"completed"}}}),
                );
                return;
            }
            "turn/interrupt" if mode == "turn-await" => {
                emit(json!({"id":4,"result":{}}));
                emit(
                    json!({"method":"item/agentMessage/delta","params":{"threadId":"thread-fixture","turnId":"turn-fixture","itemId":"item-fixture","delta":"취소 후 숨겨야 함"}}),
                );
                emit(
                    json!({"method":"turn/completed","params":{"threadId":"thread-fixture","turn":{"id":"turn-fixture","status":"interrupted"}}}),
                );
                return;
            }
            _ => panic!("unexpected fixture request"),
        }
    }
}
