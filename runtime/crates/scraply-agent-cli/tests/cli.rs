use std::process::Command;

const TEST_FIXTURE: &str = r#"{
    "account":{"email":"fixture@example.test","account_id":"fixture-account","chatgpt_user_id":"fixture-user","plan":"plus"},
    "models":[],
    "output":{"answer":"fixture"}
}"#;

fn binary() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_scraply-agent"));
    command.env("SCRAPLY_AGENT_TEST_FIXTURE", TEST_FIXTURE);
    command
}

#[test]
fn version_succeeds_with_expected_prefix() {
    let output = binary().arg("--version").output().unwrap();

    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.starts_with("scraply-agent "));
    assert_eq!(stdout.lines().count(), 1);
}

#[test]
fn removed_and_unsupported_commands_fail_closed() {
    for arguments in [["app-server", ""], ["exec", "-"], ["shell", ""]] {
        let output = binary()
            .args(
                arguments
                    .into_iter()
                    .filter(|argument| !argument.is_empty()),
            )
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
    }
}

#[test]
fn login_status_reports_subscription_account_without_secrets() {
    let output = binary().args(["login", "status"]).output().unwrap();

    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.contains("Logged in with an OpenAI account."));
    assert!(stdout.contains("fixture@example.test"));
    assert!(stdout.contains("Plan: plus"));
    assert!(!stdout.to_ascii_lowercase().contains("token"));
}
