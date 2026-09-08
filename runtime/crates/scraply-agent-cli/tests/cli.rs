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
fn direct_runtime_rejects_inherited_auth_settings_before_provider_access() {
    for name in [
        "CODEX_ACCESS_TOKEN",
        "CODEX_AUTHAPI_BASE_URL",
        "CODEX_REFRESH_TOKEN_URL_OVERRIDE",
        "CODEX_REVOKE_TOKEN_URL_OVERRIDE",
        "CODEX_APP_SERVER_LOGIN_CLIENT_ID",
        "CODEX_API_KEY",
        "OPENAI_API_KEY",
    ] {
        let output = binary()
            .env(name, "fixture-value-never-send")
            .arg("runtime")
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(1));
        assert!(output.stdout.is_empty());
        let error = String::from_utf8(output.stderr).unwrap();
        assert!(error.contains("must be supplied through Scraply"));
        assert!(!error.contains("fixture-value-never-send"));
    }
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
fn standalone_account_commands_never_touch_codex_credentials() {
    let directory = std::env::temp_dir().join(format!("scraply-cli-auth-{}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    let credentials = directory.join("auth.json");
    let marker = r#"{"OPENAI_API_KEY":"fixture-only-never-send"}"#;
    std::fs::write(&credentials, marker).unwrap();
    for arguments in [
        vec!["login"],
        vec!["login", "status"],
        vec!["login", "--device-auth"],
        vec!["logout"],
    ] {
        let output = binary()
            .env("CODEX_HOME", &directory)
            .args(arguments)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(2));
        assert!(output.stdout.is_empty());
        assert!(
            String::from_utf8(output.stderr)
                .unwrap()
                .contains("unsupported command")
        );
        assert_eq!(std::fs::read_to_string(&credentials).unwrap(), marker);
    }
    std::fs::remove_dir_all(directory).unwrap();
}
