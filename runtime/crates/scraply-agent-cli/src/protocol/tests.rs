use super::{
    CURRENT_PROTOCOL_VERSION, Capability, ClientDescriptor, ErrorCode, EventEnvelope,
    GenerationStreamEvent, InitializePayload, LEGACY_PROTOCOL_VERSION, LineFramer,
    MAX_ENVELOPE_BYTES, MAX_ERROR_DETAIL_CHARS, Operation, ProtocolError, ProtocolVersion,
    ProviderRequestId, RequestEnvelope, RequestId, RuntimeFailure, ServerEnvelope, SuccessEnvelope,
    capabilities_for, decode_json_line, encode_json_line, negotiate_protocol_version,
    operations_for, parse_request_line,
};
use serde_json::{Value, json};

fn request(operation: &str, id: Value, payload: Value) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "protocolVersion": CURRENT_PROTOCOL_VERSION,
        "id": id,
        "operation": operation,
        "payload": payload,
    }))
    .unwrap()
}

#[test]
fn protocol_1_1_gates_new_operations_and_capabilities() {
    let current = ProtocolVersion::current();
    let legacy = ProtocolVersion::new(LEGACY_PROTOCOL_VERSION).unwrap();
    assert!(operations_for(&current).contains(&Operation::AccountRefresh));
    assert!(operations_for(&current).contains(&Operation::CredentialSessionPersisted));
    assert!(!operations_for(&legacy).contains(&Operation::AccountRefresh));
    assert!(capabilities_for(&legacy).is_empty());
    assert!(capabilities_for(&current).contains(&Capability::AccountRefresh));
}

#[test]
fn operation_names_are_the_closed_published_set() {
    let names = Operation::ALL.map(Operation::as_str);
    assert_eq!(
        names,
        [
            "runtime.initialize",
            "account.list",
            "account.login.start",
            "account.login.complete",
            "account.login.cancel",
            "account.logout",
            "account.refresh",
            "credential.session.set",
            "credential.session.persisted",
            "model.list",
            "generation.start",
            "generation.cancel",
            "runtime.shutdown",
        ]
    );
    for operation in Operation::ALL {
        let encoded = serde_json::to_string(&operation).unwrap();
        let decoded: Operation = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, operation);
    }
}

#[test]
fn every_request_requires_a_bounded_string_or_integer_id() {
    let valid_integer = parse_request_line(&request("account.list", json!(7), json!({}))).unwrap();
    assert_eq!(valid_integer.id, RequestId::Integer(7));

    let valid_string =
        parse_request_line(&request("model.list", json!("models-1"), json!({}))).unwrap();
    assert_eq!(valid_string.id, RequestId::String("models-1".into()));

    for id in [json!(null), json!(true), json!(1.5), json!("")] {
        let error = parse_request_line(&request("account.list", id, json!({}))).unwrap_err();
        assert_eq!(error.kind, ProtocolError::InvalidRequestId);
    }
}

#[test]
fn provider_neutral_generation_payload_crosses_the_seam_unchanged() {
    let payload = json!({
        "generationId": "gen-42",
        "model": {"providerId": "openrouter", "modelId": "anthropic/claude"},
        "promptRevision": "scraply.stage-worker.v1",
        "workOrder": {"stage": "synthesize", "scope": {"topic": "batteries"}},
        "evidence": [{"sourceId": "src-1", "content": "untrusted"}],
        "outputSchema": {"type": "object"},
        "reasoningEffort": "high",
        "maxOutputTokens": 2400,
        "deadlineMs": 30000,
        "repairPolicy": "one_retry"
    });
    let decoded = parse_request_line(&request(
        "generation.start",
        json!("generate-42"),
        payload.clone(),
    ))
    .unwrap();

    assert_eq!(decoded.operation, Operation::GenerationStart);
    assert_eq!(decoded.payload, payload);
}

#[test]
fn payload_must_be_an_object_and_unknown_envelope_fields_fail_closed() {
    let scalar =
        parse_request_line(&request("runtime.shutdown", json!(1), json!(null))).unwrap_err();
    assert_eq!(scalar.kind, ProtocolError::InvalidPayload);
    assert_eq!(scalar.id, Some(RequestId::Integer(1)));
    assert_eq!(scalar.operation, Some(Operation::RuntimeShutdown));

    let with_extra = br#"{"protocolVersion":"1.0","id":2,"operation":"account.list","payload":{},"secret":"not echoed"}"#;
    let error = parse_request_line(with_extra).unwrap_err();
    assert_eq!(error.kind, ProtocolError::InvalidEnvelope);
    assert_eq!(error.id, Some(RequestId::Integer(2)));
    assert!(!error.to_string().contains("secret"));
}

#[test]
fn unknown_operations_get_a_stable_correlated_failure() {
    let error =
        parse_request_line(&request("codex.thread.start", json!(9), json!({}))).unwrap_err();
    assert_eq!(error.kind, ProtocolError::UnsupportedOperation);
    assert_eq!(error.id, Some(RequestId::Integer(9)));
    let failure = error.into_failure(ProtocolVersion::current());
    assert_eq!(failure.error.code, ErrorCode::UnsupportedOperation);
    assert!(!failure.error.retryable);
}

#[test]
fn version_negotiation_selects_only_a_shared_version() {
    let offered = [
        ProtocolVersion::new("2.0").unwrap(),
        ProtocolVersion::new("1.1").unwrap(),
        ProtocolVersion::new("1.0").unwrap(),
    ];
    assert_eq!(
        negotiate_protocol_version(&offered).unwrap().as_str(),
        CURRENT_PROTOCOL_VERSION
    );
    assert_eq!(
        negotiate_protocol_version(&[ProtocolVersion::new("2.0").unwrap()]),
        Err(ProtocolError::UnsupportedProtocolVersion)
    );
    assert_eq!(
        negotiate_protocol_version(&[ProtocolVersion::new(LEGACY_PROTOCOL_VERSION).unwrap()]),
        Err(ProtocolError::UnsupportedProtocolVersion)
    );

    let payload = InitializePayload {
        supported_protocol_versions: offered.to_vec(),
        required_capabilities: Vec::new(),
        client: ClientDescriptor {
            name: "scraply".into(),
            version: "0.3.0".into(),
        },
    };
    let envelope = RequestEnvelope::new(
        ProtocolVersion::current(),
        RequestId::String("init".into()),
        Operation::RuntimeInitialize,
        serde_json::to_value(&payload).unwrap(),
    )
    .unwrap();
    assert_eq!(envelope.payload_as::<InitializePayload>().unwrap(), payload);
}

#[test]
fn success_and_event_envelopes_keep_request_correlation() {
    let request_id = RequestId::String("request-7".into());
    let success = SuccessEnvelope::from_serializable(
        ProtocolVersion::current(),
        request_id.clone(),
        Operation::GenerationStart,
        json!({"accepted": true, "generationId": "gen-7"}),
    )
    .unwrap();
    assert_eq!(success.id, request_id);

    let event = EventEnvelope::generation(
        ProtocolVersion::current(),
        success.id.clone(),
        GenerationStreamEvent::Delta {
            generation_id: "gen-7".into(),
            sequence: 3,
            delta: json!({"outputText": "partial"}),
        },
    );
    let encoded = encode_json_line(&ServerEnvelope::Event(event.clone()), 4096).unwrap();
    let decoded: ServerEnvelope = decode_json_line(&encoded, 4096).unwrap();
    assert_eq!(decoded, ServerEnvelope::Event(event));
}

#[test]
fn generation_terminal_events_carry_normalized_results_or_safe_failures() {
    let completed = GenerationStreamEvent::Completed {
        generation_id: "gen-1".into(),
        result: json!({
            "output": {"answer": "ok"},
            "model": {"providerId": "openai", "modelId": "gpt-5"},
            "promptHash": "sha256:abc",
            "usage": {"inputTokens": 10, "outputTokens": 2},
            "cost": null,
            "finishReason": "stop",
            "latencyMs": 120,
            "repairCount": 0
        }),
    };
    assert_eq!(completed.generation_id(), "gen-1");

    let failed = GenerationStreamEvent::Failed {
        generation_id: "gen-2".into(),
        error: RuntimeFailure::new(
            ErrorCode::RateLimited,
            true,
            "provider rate limited request",
        )
        .with_provider_request_id(ProviderRequestId::new("req_provider_12").unwrap()),
        attempts: Vec::new(),
    };
    let value = serde_json::to_value(failed).unwrap();
    assert_eq!(value["error"]["code"], "rate_limited");
    assert_eq!(value["error"]["retryable"], true);
    assert_eq!(value["error"]["providerRequestId"], "req_provider_12");
}

#[test]
fn failure_details_are_single_line_bounded_and_do_not_capture_parser_input() {
    let detail = format!("safe\n{}", "x".repeat(MAX_ERROR_DETAIL_CHARS * 2));
    let failure = RuntimeFailure::new(ErrorCode::Internal, false, detail);
    assert!(!failure.detail.as_str().contains('\n'));
    assert!(failure.detail.as_str().chars().count() <= MAX_ERROR_DETAIL_CHARS);

    let malformed = parse_request_line(br#"{"credential":"top-secret""#).unwrap_err();
    assert_eq!(malformed.kind, ProtocolError::MalformedJson);
    assert!(!malformed.to_string().contains("top-secret"));
}

#[test]
fn framer_handles_fragmentation_multiple_lines_and_crlf() {
    let first = request("account.list", json!(1), json!({}));
    let second = request("model.list", json!(2), json!({"providerId": "openai"}));
    let mut wire = Vec::new();
    wire.extend_from_slice(&first);
    wire.extend_from_slice(b"\r\n");
    wire.extend_from_slice(&second);
    wire.push(b'\n');

    let split = first.len() / 2;
    let mut framer = LineFramer::new(4096).unwrap();
    assert!(framer.push(&wire[..split]).is_empty());
    let frames = framer.push(&wire[split..]);
    assert_eq!(frames.len(), 2);
    assert_eq!(frames[0].as_ref().unwrap().id, RequestId::Integer(1));
    assert_eq!(frames[1].as_ref().unwrap().id, RequestId::Integer(2));
}

#[test]
fn framer_reports_one_oversize_error_then_resynchronizes_at_newline() {
    let valid = request("runtime.shutdown", json!(3), json!({}));
    let mut wire = vec![b'x'; valid.len() + 1];
    wire.push(b'\n');
    wire.extend_from_slice(&valid);
    wire.push(b'\n');

    let mut framer = LineFramer::new(10).unwrap();
    let first = framer.push(&wire);
    assert_eq!(first.len(), 2);
    assert_eq!(
        first[0].as_ref().unwrap_err().kind,
        ProtocolError::LineTooLarge
    );
    assert_eq!(
        first[1].as_ref().unwrap_err().kind,
        ProtocolError::LineTooLarge
    );

    let mut framer = LineFramer::new(valid.len()).unwrap();
    let frames = framer.push(&wire);
    assert_eq!(frames.len(), 2);
    assert_eq!(
        frames[0].as_ref().unwrap_err().kind,
        ProtocolError::LineTooLarge
    );
    assert_eq!(
        frames[1].as_ref().unwrap().operation,
        Operation::RuntimeShutdown
    );
}

#[test]
fn codecs_enforce_the_same_line_limit() {
    let envelope = SuccessEnvelope::from_serializable(
        ProtocolVersion::current(),
        RequestId::Integer(1),
        Operation::RuntimeShutdown,
        json!({}),
    )
    .unwrap();
    let encoded = encode_json_line(&envelope, 1024).unwrap();
    let decoded: SuccessEnvelope = decode_json_line(&encoded, 1024).unwrap();
    assert_eq!(decoded, envelope);
    assert_eq!(
        encode_json_line(&envelope, 2),
        Err(ProtocolError::LineTooLarge)
    );
}

#[test]
fn codecs_measure_serialized_bytes_after_json_escape_expansion() {
    let envelope = SuccessEnvelope::from_serializable(
        ProtocolVersion::current(),
        RequestId::Integer(1),
        Operation::GenerationStart,
        json!({"content": "\0".repeat(100)}),
    )
    .unwrap();
    assert!(serde_json::to_vec(&envelope).unwrap().len() > 500);
    assert_eq!(
        encode_json_line(&envelope, 256),
        Err(ProtocolError::LineTooLarge)
    );
    assert!(encode_json_line(&envelope, MAX_ENVELOPE_BYTES).is_ok());
}

#[test]
fn invalid_utf8_is_a_sanitized_malformed_json_failure() {
    let error = parse_request_line(&[0xff, b'\n']).unwrap_err();
    assert_eq!(error.kind, ProtocolError::MalformedJson);
    assert_eq!(error.id, None);
}

#[test]
fn unfinished_input_at_eof_is_rejected_without_echoing_content() {
    let mut framer = LineFramer::new(4096).unwrap();
    assert!(framer.push(br#"{"credential":"top-secret""#).is_empty());
    let error = framer.finish().unwrap().unwrap_err();
    assert_eq!(error.kind, ProtocolError::MalformedJson);
    assert!(!error.to_string().contains("top-secret"));
}

#[test]
fn frozen_protocol_1_1_fixtures_deserialize_and_pin_identity() {
    let request_fixtures = [
        include_str!("../../../../contracts/runtime/v1.1/initialize.request.json"),
        include_str!("../../../../contracts/runtime/v1.1/generation.start.request.json"),
        include_str!(
            "../../../../contracts/runtime/v1.1/credential.session.persisted.request.json"
        ),
        include_str!("../../../../contracts/runtime/v1.1/generation.cancel.request.json"),
        include_str!("../../../../contracts/runtime/v1.1/runtime.shutdown.request.json"),
    ];
    for fixture in request_fixtures {
        let request: RequestEnvelope = serde_json::from_str(fixture).unwrap();
        assert_eq!(request.protocol_version.as_str(), CURRENT_PROTOCOL_VERSION);
    }

    let server_fixtures = [
        include_str!("../../../../contracts/runtime/v1.1/initialize.response.json"),
        include_str!("../../../../contracts/runtime/v1.1/account.refresh.response.json"),
        include_str!("../../../../contracts/runtime/v1.1/generation.completed.event.json"),
        include_str!("../../../../contracts/runtime/v1.1/generation.repair-failed.event.json"),
        include_str!("../../../../contracts/runtime/v1.1/generation.accepted.response.json"),
        include_str!("../../../../contracts/runtime/v1.1/account.list.response.json"),
        include_str!("../../../../contracts/runtime/v1.1/model.list.response.json"),
        include_str!("../../../../contracts/runtime/v1.1/generation.cancel.response.json"),
        include_str!("../../../../contracts/runtime/v1.1/runtime.shutdown.response.json"),
    ];
    for fixture in server_fixtures {
        let _: ServerEnvelope = serde_json::from_str(fixture).unwrap();
    }

    let initialize: ServerEnvelope = serde_json::from_str(server_fixtures[0]).unwrap();
    let ServerEnvelope::Success(initialize) = initialize else {
        panic!("initialize fixture must be a success envelope");
    };
    let result: super::InitializeResult = serde_json::from_value(initialize.result).unwrap();
    assert_eq!(result.prompt.id, "scraply.stage-worker.v1");
    assert_eq!(
        result.prompt.sha256,
        "277d724f20acb1f32fa0a8b7c454c670971e3c40bfc921db40c044caa760e6f1"
    );
    assert_eq!(result.limits, super::ProtocolLimits::current());
    assert_eq!(result.capabilities, Capability::V1_1);
}
