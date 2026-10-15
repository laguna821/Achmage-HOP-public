use achmage_research::{
    mcp_jobs::Operation,
    mcp_stdio::{Registration, StdioSession},
    secrets::MemorySecrets,
    types::{JobState, SourceSettings},
    ResearchService,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
fn registration() -> Registration {
    let path = std::path::PathBuf::from(env!("CARGO_BIN_EXE_research-mcp-fixture"));
    let sha256 = format!("{:x}", Sha256::digest(std::fs::read(&path).unwrap()));
    Registration {
        executable: path,
        sha256,
        argv: vec![],
    }
}
#[tokio::test]
async fn real_stdio_process_initialize_call_and_eof_cleanup() {
    let registration = registration();
    let token = CancellationToken::new();
    let mut session = StdioSession::connect(&registration, &token).await.unwrap();
    assert_eq!(
        session
            .request("tools/list", json!({}), &token)
            .await
            .unwrap()["tools"][0]["name"],
        "echo"
    );
    assert_eq!(
        session
            .request(
                "tools/call",
                json!({"name":"echo","arguments":{"text":"한글😀"}}),
                &token
            )
            .await
            .unwrap()["content"][0]["text"],
        "한글😀"
    );
    session.close().await.unwrap();
}
#[test]
fn mismatched_executable_and_relative_path_rejected() {
    let mut r = registration();
    r.sha256 = "0".repeat(64);
    assert!(r.validate().is_err());
    r.executable = "relative.exe".into();
    assert!(r.validate().is_err());
}
#[tokio::test]
async fn native_action_lane_stdio_configuration_and_result() {
    let r = registration();
    let service = ResearchService::with_store(Arc::new(MemorySecrets::default())).unwrap();
    service
        .configure(
            "custom-mcp",
            SourceSettings {
                options: [
                    ("transport".into(), "stdio".into()),
                    ("executable".into(), r.executable.to_str().unwrap().into()),
                    ("executable_sha256".into(), r.sha256),
                    ("argv".into(), "[]".into()),
                ]
                .into(),
            },
        )
        .unwrap();
    let id = service
        .start_mcp(
            "custom-mcp".into(),
            Operation::Call {
                name: "echo".into(),
                arguments: json!({"text":"원본 보존"}),
            },
        )
        .unwrap();
    for _ in 0..300 {
        match service.poll(&id).unwrap() {
            JobState::McpCompleted { result } => {
                assert_eq!(result["result"]["content"][0]["text"], "원본 보존");
                assert_eq!(result["transport"], "stdio");
                assert_eq!(result["untrusted"], true);
                return;
            }
            JobState::Running => tokio::time::sleep(std::time::Duration::from_millis(10)).await,
            _ => panic!("unexpected jobstate"),
        }
    }
    panic!("stdio job did not finish");
}
