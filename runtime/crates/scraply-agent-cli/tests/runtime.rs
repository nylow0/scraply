use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use serde_json::{Value, json};

struct RuntimeProcess {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}

fn fixture(output: Value) -> Value {
    json!({
        "account": {
            "email": "fixture@example.test",
            "account_id": "fixture-account",
            "plan": "plus"
        },
        "models": [{
            "id": "gpt-fixture",
            "display_name": "Fixture",
            "description": "offline",
            "default_reasoning_effort": "medium",
            "supported_reasoning_efforts": ["low", "medium", "high"]
        }],
        "output": output,
        "delay_ms": 0
    })
}

fn session_credential(access_token: &str) -> String {
    json!({
        "auth_mode": "chatgpt",
        "OPENAI_API_KEY": null,
        "tokens": {
            "id_token": "e30.e30.fixture-signature",
            "access_token": access_token,
            "refresh_token": "fixture-refresh-token",
            "account_id": "fixture-account"
        },
        "last_refresh": null
    })
    .to_string()
}

impl RuntimeProcess {
    fn start(delay_ms: u64) -> Self {
        let fixture = json!({
            "account": {
                "email": "fixture@example.test",
                "account_id": "fixture-account",
                "plan": "plus"
            },
            "models": [{
                "id": "gpt-fixture",
                "display_name": "Fixture",
                "description": "offline",
                "default_reasoning_effort": "medium",
                "supported_reasoning_efforts": ["low", "medium", "high"]
            }],
            "output": {"answer": "fixture"},
            "delay_ms": delay_ms
        });
        Self::start_with_fixture(fixture)
    }

    fn start_with_fixture(fixture: Value) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_scraply-agent"))
            .arg("runtime")
            .env("SCRAPLY_AGENT_TEST_FIXTURE", fixture.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        Self {
            child,
            input,
            output,
        }
    }

    fn request(&mut self, id: u64, operation: &str, payload: Value) {
        serde_json::to_writer(
            &mut self.input,
            &json!({
                "protocolVersion": "1.1",
                "id": id,
                "operation": operation,
                "payload": payload,
            }),
        )
        .unwrap();
        self.input.write_all(b"\n").unwrap();
        self.input.flush().unwrap();
    }

    fn write_raw(&mut self, bytes: &[u8]) {
        self.input.write_all(bytes).unwrap();
        self.input.flush().unwrap();
    }

    fn read(&mut self) -> Value {
        let mut line = String::new();
        assert!(self.output.read_line(&mut line).unwrap() > 0);
        serde_json::from_str(&line).unwrap()
    }

    fn initialize(&mut self) {
        self.request(
            1,
            "runtime.initialize",
            json!({
                "supportedProtocolVersions": ["1.1"],
                "requiredCapabilities": [
                    "envelope_limits",
                    "account_refresh",
                    "credential_persistence_ack",
                    "generation_attempt_metadata",
                    "exactly_one_terminal"
                ],
                "client": {"name": "runtime-test", "version": "1"}
            }),
        );
        let initialized = self.read();
        assert_eq!(initialized["id"], 1);
        assert_eq!(initialized["result"]["selectedProtocolVersion"], "1.1");
        assert_eq!(
            initialized["result"]["limits"]["maxEnvelopeBytes"],
            16 * 1024 * 1024
        );
    }

    fn start_generation(&mut self, request_id: u64, generation_id: &str) {
        self.request_generation_start(request_id, generation_id);
        let accepted = self.read();
        assert_eq!(accepted["id"], request_id);
        assert_eq!(accepted["result"]["generationId"], generation_id);
    }

    fn request_generation_start(&mut self, request_id: u64, generation_id: &str) {
        self.request_generation_start_with_policy(request_id, generation_id, "disabled");
    }

    fn request_generation_start_with_policy(
        &mut self,
        request_id: u64,
        generation_id: &str,
        repair_policy: &str,
    ) {
        self.request(
            request_id,
            "generation.start",
            json!({
                "generationId": generation_id,
                "deadlineMs": 30_000,
                "model": {
                    "providerId": "openai-subscription",
                    "modelId": "gpt-fixture"
                },
                "promptRevision": "scraply.stage-worker.v1",
                "workOrder": {
                    "stage": "synthesis",
                    "instruction": "Answer from the supplied evidence.",
                    "goal": "Produce the requested object.",
                    "inputs": {},
                    "requiredDecisions": [],
                    "definitionOfDone": ["Return a schema-valid object."],
                    "constraints": []
                },
                "evidence": [{
                    "sourceId": "source-1",
                    "content": {"text": "untrusted fixture evidence"}
                }],
                "outputSchema": {
                    "type": "object",
                    "properties": {"answer": {"type": "string"}},
                    "required": ["answer"],
                    "additionalProperties": false
                },
                "reasoningEffort": "medium",
                "repairPolicy": repair_policy
            }),
        );
    }

    fn request_generation_with_repair(&mut self, request_id: u64, generation_id: &str) {
        self.request_generation_start_with_policy(request_id, generation_id, "one_retry");
    }

    fn shutdown(mut self, request_id: u64) {
        self.request(request_id, "runtime.shutdown", json!({}));
        loop {
            let response = self.read();
            if response["id"] == request_id {
                break;
            }
        }
        drop(self.input);
        let output = self.child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "stderr: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(output.stderr.is_empty());
    }
}

#[test]
fn installed_runtime_completes_a_structured_generation_with_accounting() {
    let mut runtime = RuntimeProcess::start(0);
    runtime.initialize();

    runtime.request(2, "account.list", json!({}));
    let accounts = runtime.read();
    assert_eq!(
        accounts["result"]["accounts"][0]["providerId"],
        "openai-subscription"
    );

    runtime.request(
        3,
        "model.list",
        json!({"providerId": "openai-subscription"}),
    );
    let models = runtime.read();
    assert_eq!(
        models["result"]["models"][0]["identity"]["modelId"],
        "gpt-fixture"
    );

    runtime.start_generation(4, "generation-success");
    let completed = loop {
        let message = runtime.read();
        if message["event"]["kind"] == "generation.completed" {
            break message;
        }
    };
    let result = &completed["event"]["result"];
    assert_eq!(result["output"], json!({"answer": "fixture"}));
    assert_eq!(
        result["metadata"]["model"]["providerId"],
        "openai-subscription"
    );
    assert_eq!(
        result["metadata"]["prompt"]["id"],
        "scraply.stage-worker.v1"
    );
    assert_eq!(result["metadata"]["repairCount"], 0);
    assert_eq!(
        result["metadata"]["providerRequestIds"][0],
        "fixture-initial"
    );

    runtime.shutdown(5);
}

#[test]
fn installed_runtime_routes_openai_session_credentials_to_the_openai_provider() {
    let mut runtime = RuntimeProcess::start(0);
    runtime.initialize();
    runtime.request(
        2,
        "credential.session.set",
        json!({
            "providerId": "openai-subscription",
            "credential": "not-json"
        }),
    );

    let response = runtime.read();
    assert_eq!(response["id"], 2);
    assert_eq!(response["error"]["code"], "authentication_failed");

    runtime.shutdown(3);
}

#[test]
fn installed_runtime_cancels_an_active_generation() {
    let mut runtime = RuntimeProcess::start(5_000);
    runtime.initialize();
    runtime.start_generation(2, "generation-cancel");
    runtime.request(
        3,
        "generation.cancel",
        json!({"generationId": "generation-cancel"}),
    );

    let mut saw_cancel_response = false;
    let mut cancelled = None;
    while !saw_cancel_response || cancelled.is_none() {
        let message = runtime.read();
        assert_ne!(message["event"]["kind"], "generation.completed");
        saw_cancel_response |= message["id"] == 3 && message["result"]["cancelled"] == true;
        if message["event"]["kind"] == "generation.cancelled" {
            cancelled = Some(message);
        }
    }
    let cancelled = cancelled.unwrap();
    assert_eq!(cancelled["event"]["attempts"].as_array().unwrap().len(), 1);
    assert_eq!(
        cancelled["event"]["attempts"][0]["providerCompletion"],
        "unknown"
    );
    assert_eq!(
        cancelled["event"]["attempts"][0]["usage"]["status"],
        "unknown"
    );

    runtime.shutdown(4);
}

#[test]
fn installed_runtime_preserves_an_active_generation_after_a_duplicate_start() {
    let mut runtime = RuntimeProcess::start(5_000);
    runtime.initialize();
    runtime.start_generation(2, "generation-duplicate");
    runtime.request_generation_start(3, "generation-duplicate");

    let conflict = loop {
        let message = runtime.read();
        assert_ne!(message["event"]["kind"], "generation.completed");
        if message["id"] == 3 {
            break message;
        }
    };
    assert_eq!(conflict["error"]["code"], "request_conflict");

    runtime.request(
        4,
        "generation.cancel",
        json!({"generationId": "generation-duplicate"}),
    );

    let mut saw_cancel_response = false;
    let mut saw_cancel_event = false;
    while !saw_cancel_response || !saw_cancel_event {
        let message = runtime.read();
        assert_ne!(message["event"]["kind"], "generation.completed");
        saw_cancel_response |= message["id"] == 4 && message["result"]["cancelled"] == true;
        saw_cancel_event |= message["event"]["kind"] == "generation.cancelled"
            && message["event"]["generationId"] == "generation-duplicate";
    }

    runtime.shutdown(5);
}

#[test]
fn installed_runtime_resynchronizes_after_malformed_oversized_and_invalid_utf8_lines() {
    let mut runtime = RuntimeProcess::start(0);
    runtime.write_raw(b"{not-json}\n");
    assert_eq!(runtime.read()["error"]["code"], "malformed_json");

    runtime.write_raw(&[0xff, b'\n']);
    assert_eq!(runtime.read()["error"]["code"], "malformed_json");

    let mut oversized = vec![b'x'; 16 * 1024 * 1024 + 1];
    oversized.push(b'\n');
    runtime.write_raw(&oversized);
    assert_eq!(runtime.read()["error"]["code"], "line_too_large");

    runtime.initialize();
    runtime.shutdown(2);
}

#[test]
fn installed_runtime_accepts_a_request_split_across_pipe_writes() {
    let mut runtime = RuntimeProcess::start(0);
    let mut initialize = serde_json::to_vec(&json!({
        "protocolVersion": "1.1",
        "id": 1,
        "operation": "runtime.initialize",
        "payload": {
            "supportedProtocolVersions": ["1.1"],
            "requiredCapabilities": ["envelope_limits"],
            "client": {"name": "split-test", "version": "1"}
        }
    }))
    .unwrap();
    initialize.push(b'\n');
    let split = initialize.len() / 2;
    runtime.write_raw(&initialize[..split]);
    runtime.write_raw(&initialize[split..]);
    assert_eq!(runtime.read()["result"]["selectedProtocolVersion"], "1.1");
    runtime.shutdown(2);
}

#[test]
fn installed_runtime_reports_successful_repair_attempts() {
    let mut data = fixture(json!({"answer": 42}));
    data["repair_output"] = json!({"answer": "repaired"});
    let mut runtime = RuntimeProcess::start_with_fixture(data);
    runtime.initialize();
    runtime.request_generation_with_repair(2, "generation-repair");
    assert_eq!(runtime.read()["id"], 2);
    let completed = loop {
        let message = runtime.read();
        if message["event"]["kind"] == "generation.completed" {
            break message;
        }
    };
    assert_eq!(completed["event"]["result"]["output"]["answer"], "repaired");
    assert_eq!(
        completed["event"]["result"]["metadata"]["attempts"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    runtime.shutdown(3);
}

#[test]
fn installed_runtime_keeps_initial_accounting_when_repair_fails() {
    let mut data = fixture(json!({"answer": 42}));
    data["repair_failure"] = json!(true);
    let mut runtime = RuntimeProcess::start_with_fixture(data);
    runtime.initialize();
    runtime.request_generation_with_repair(2, "generation-repair-failure");
    assert_eq!(runtime.read()["id"], 2);
    let failed = loop {
        let message = runtime.read();
        if message["event"]["kind"] == "generation.failed" {
            break message;
        }
    };
    assert_eq!(failed["event"]["error"]["code"], "output_invalid");
    let attempts = failed["event"]["attempts"].as_array().unwrap();
    assert_eq!(attempts.len(), 2);
    assert_eq!(attempts[0]["attempt"], "initial");
    assert_eq!(attempts[0]["usage"]["status"], "known");
    assert_eq!(attempts[1]["attempt"], "schema_repair");
    assert_eq!(attempts[1]["usage"]["status"], "unknown");
    runtime.shutdown(3);
}

#[test]
fn refreshed_session_requires_exact_persistence_ack_and_restores_after_restart() {
    let credential = session_credential("rotated-access-token");
    let mut data = fixture(json!({"answer": "fixture"}));
    data["refresh_credential"] = json!(credential.clone());
    let mut runtime = RuntimeProcess::start_with_fixture(data.clone());
    runtime.initialize();
    runtime.request(
        2,
        "account.refresh",
        json!({"providerId": "openai-subscription"}),
    );
    let refresh = runtime.read();
    assert_eq!(refresh["result"]["credential"], credential);
    let marker = refresh["result"]["persistence"].clone();

    runtime.request(
        3,
        "model.list",
        json!({"providerId": "openai-subscription"}),
    );
    assert_eq!(
        runtime.read()["error"]["code"],
        "credential_persistence_required"
    );

    let mut wrong_session = marker.clone();
    wrong_session["sessionId"] = json!("session-stale");
    runtime.request(4, "credential.session.persisted", wrong_session);
    assert_eq!(
        runtime.read()["error"]["code"],
        "credential_persistence_required"
    );

    let mut wrong_rotation = marker.clone();
    wrong_rotation["rotationId"] = json!("rotation-stale");
    runtime.request(5, "credential.session.persisted", wrong_rotation);
    assert_eq!(
        runtime.read()["error"]["code"],
        "credential_persistence_required"
    );

    runtime.request(6, "credential.session.persisted", marker.clone());
    assert_eq!(runtime.read()["result"]["ready"], true);
    runtime.request(
        7,
        "model.list",
        json!({"providerId": "openai-subscription"}),
    );
    assert_eq!(
        runtime.read()["result"]["models"][0]["identity"]["modelId"],
        "gpt-fixture"
    );

    runtime.request(
        8,
        "account.refresh",
        json!({"providerId": "openai-subscription"}),
    );
    let next_marker = runtime.read()["result"]["persistence"].clone();
    assert_ne!(next_marker["rotationId"], marker["rotationId"]);
    runtime.request(9, "credential.session.persisted", marker);
    assert_eq!(
        runtime.read()["error"]["code"],
        "credential_persistence_required"
    );
    runtime.request(10, "credential.session.persisted", next_marker);
    assert_eq!(runtime.read()["result"]["ready"], true);
    runtime.request(
        11,
        "model.list",
        json!({"providerId": "openai-subscription"}),
    );
    assert_eq!(
        runtime.read()["result"]["models"][0]["identity"]["modelId"],
        "gpt-fixture"
    );
    runtime.shutdown(12);

    let mut restored = RuntimeProcess::start_with_fixture(data);
    restored.initialize();
    restored.request(
        2,
        "credential.session.set",
        json!({
            "providerId": "openai-subscription",
            "credential": credential
        }),
    );
    assert_eq!(
        restored.read()["result"]["providerId"],
        "openai-subscription"
    );
    restored.request(
        3,
        "model.list",
        json!({"providerId": "openai-subscription"}),
    );
    assert_eq!(
        restored.read()["result"]["models"][0]["identity"]["modelId"],
        "gpt-fixture"
    );
    restored.shutdown(4);
}

#[test]
fn failed_refresh_and_logout_invalidate_model_availability() {
    let mut runtime = RuntimeProcess::start_with_fixture(fixture(json!({"answer": "fixture"})));
    runtime.initialize();
    runtime.request(
        2,
        "account.refresh",
        json!({"providerId": "openai-subscription"}),
    );
    assert_eq!(runtime.read()["error"]["code"], "reconnect_required");
    runtime.request(
        3,
        "model.list",
        json!({"providerId": "openai-subscription"}),
    );
    assert_eq!(runtime.read()["error"]["code"], "authentication_failed");

    let credential = session_credential("restored-after-refresh-failure");
    runtime.request(
        4,
        "credential.session.set",
        json!({"providerId": "openai-subscription", "credential": credential}),
    );
    assert_eq!(
        runtime.read()["result"]["providerId"],
        "openai-subscription"
    );
    runtime.request(
        5,
        "account.logout",
        json!({"providerId": "openai-subscription"}),
    );
    assert_eq!(runtime.read()["result"]["loggedOut"], true);
    runtime.request(
        6,
        "model.list",
        json!({"providerId": "openai-subscription"}),
    );
    assert_eq!(runtime.read()["error"]["code"], "authentication_failed");
    runtime.shutdown(7);
}

#[test]
fn shutdown_cancels_active_generation_and_exits() {
    let mut runtime = RuntimeProcess::start(5_000);
    runtime.initialize();
    runtime.start_generation(2, "generation-shutdown");
    runtime.shutdown(3);
}

#[test]
fn pending_browser_login_can_be_cancelled_or_interrupted_by_shutdown() {
    let mut runtime = RuntimeProcess::start(0);
    runtime.initialize();
    runtime.request(
        2,
        "account.login.start",
        json!({"providerId": "openai-subscription", "method": "browser"}),
    );
    let started = runtime.read();
    let login_id = started["result"]["loginId"].as_str().unwrap().to_owned();
    runtime.request(3, "account.login.complete", json!({"loginId": login_id}));
    let pending = runtime.read();
    assert_eq!(pending["error"]["code"], "operation_unavailable");
    assert_eq!(pending["error"]["retryable"], true);
    runtime.request(4, "account.login.cancel", json!({"loginId": login_id}));
    assert_eq!(runtime.read()["result"]["cancelled"], true);

    runtime.request(
        5,
        "account.login.start",
        json!({"providerId": "openai-subscription", "method": "browser"}),
    );
    assert!(runtime.read()["result"]["loginId"].is_string());
    runtime.shutdown(6);
}
