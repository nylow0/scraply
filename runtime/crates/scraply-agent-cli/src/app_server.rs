use std::collections::{HashSet, VecDeque};
use std::fmt;
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicU64, Ordering},
};

use crate::protocol::{
    Capability, DEFAULT_MAX_LINE_BYTES, ErrorCode, EventEnvelope, FailureEnvelope,
    GenerationStreamEvent, InitializePayload, InitializeResult, LineFramer, Operation,
    ProtocolLimits, ProtocolVersion, RequestEnvelope, RequestId, RuntimeDescriptor, RuntimeFailure,
    ServerEnvelope, SuccessEnvelope, capabilities_for, negotiate_protocol_version, operations_for,
};
use async_trait::async_trait;
use scraply_agent_core::PromptCompiler;
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;

const MAX_REMEMBERED_REQUEST_IDS: usize = 4096;
const EVENT_CHANNEL_CAPACITY: usize = 64;
static SESSION_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone)]
pub struct RuntimeContext {
    pub session_id: String,
    pub capabilities: Vec<Capability>,
}

#[derive(Debug)]
pub enum AppServerError {
    Input,
    Output,
}

impl AppServerError {
    pub const fn sanitized_message(&self) -> &'static str {
        match self {
            Self::Input => "runtime input failed",
            Self::Output => "runtime output failed",
        }
    }
}

impl fmt::Display for AppServerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.sanitized_message())
    }
}

/// Interface at the app-server/runtime seam.
///
/// The app server owns JSON protocol framing and dispatch. Runtime adapters parse
/// operation payloads into domain types and serialize outcomes as protocol JSON.
#[async_trait]
pub trait RuntimeHandler: Send {
    /// `generation.start` receives a request-bound event sink. The handler must
    /// return `GenerationAccepted` before doing provider work, then emit later
    /// progress or terminal events from a spawned task. Other operations receive
    /// no sink, so `generation.cancel` can run while that task is pending.
    async fn handle(
        &mut self,
        context: &RuntimeContext,
        operation: Operation,
        payload: Value,
        generation_events: Option<GenerationEventSink>,
    ) -> HandlerOutcome;
}

#[derive(Debug)]
pub enum HandlerOutcome {
    Success(Value),
    Failure(RuntimeFailure),
    GenerationAccepted(Value),
}

#[derive(Debug, Clone)]
pub struct GenerationEventSink {
    protocol_version: ProtocolVersion,
    request_id: RequestId,
    sender: mpsc::Sender<EventEnvelope>,
    terminal_sent: Arc<AtomicBool>,
}

impl GenerationEventSink {
    fn new(
        protocol_version: ProtocolVersion,
        request_id: RequestId,
        sender: mpsc::Sender<EventEnvelope>,
    ) -> Self {
        Self {
            protocol_version,
            request_id,
            sender,
            terminal_sent: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Waits for capacity in the bounded event queue. A closed sink means the
    /// runtime process has stopped and the provider task should stop too.
    pub async fn send(&self, event: GenerationStreamEvent) -> Result<(), EventSinkClosed> {
        if event.is_terminal() && self.terminal_sent.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        self.sender
            .send(EventEnvelope::generation(
                self.protocol_version.clone(),
                self.request_id.clone(),
                event,
            ))
            .await
            .map_err(|_| EventSinkClosed)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EventSinkClosed;

impl fmt::Display for EventSinkClosed {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("runtime event sink is closed")
    }
}

impl std::error::Error for EventSinkClosed {}

#[derive(Debug)]
struct RuntimeDispatcher<H> {
    handler: H,
    negotiated_version: Option<ProtocolVersion>,
    seen_request_ids: HashSet<RequestId>,
    request_id_order: VecDeque<RequestId>,
    event_sender: mpsc::Sender<EventEnvelope>,
    shutdown: bool,
    session_id: String,
}

impl<H> RuntimeDispatcher<H>
where
    H: RuntimeHandler,
{
    fn new(handler: H, event_sender: mpsc::Sender<EventEnvelope>) -> Self {
        Self {
            handler,
            negotiated_version: None,
            seen_request_ids: HashSet::new(),
            request_id_order: VecDeque::new(),
            event_sender,
            shutdown: false,
            session_id: format!(
                "session-{}-{}",
                std::process::id(),
                SESSION_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ),
        }
    }

    async fn dispatch(&mut self, request: RequestEnvelope) -> Vec<ServerEnvelope> {
        let response_version = self
            .negotiated_version
            .clone()
            .unwrap_or_else(ProtocolVersion::current);

        if self.seen_request_ids.contains(&request.id) {
            return vec![self.failure(
                response_version,
                Some(request.id),
                Some(request.operation),
                RuntimeFailure::new(
                    ErrorCode::RequestConflict,
                    false,
                    "request id was already used",
                ),
            )];
        }
        if self.seen_request_ids.len() == MAX_REMEMBERED_REQUEST_IDS
            && let Some(expired) = self.request_id_order.pop_front()
        {
            self.seen_request_ids.remove(&expired);
        }
        self.seen_request_ids.insert(request.id.clone());
        self.request_id_order.push_back(request.id.clone());

        if self.shutdown {
            return vec![self.failure(
                response_version,
                Some(request.id),
                Some(request.operation),
                RuntimeFailure::new(
                    ErrorCode::OperationUnavailable,
                    false,
                    "runtime is shutting down",
                ),
            )];
        }

        if request.operation == Operation::RuntimeInitialize {
            return vec![self.initialize(request)];
        }

        let Some(negotiated_version) = self.negotiated_version.clone() else {
            return vec![self.failure(
                response_version,
                Some(request.id),
                Some(request.operation),
                RuntimeFailure::new(
                    ErrorCode::NotInitialized,
                    false,
                    "runtime.initialize must be the first request",
                ),
            )];
        };

        if request.protocol_version != negotiated_version {
            return vec![self.failure(
                negotiated_version,
                Some(request.id),
                Some(request.operation),
                RuntimeFailure::new(
                    ErrorCode::UnsupportedProtocolVersion,
                    false,
                    "request protocol version does not match the negotiated version",
                ),
            )];
        }

        if !request.operation.supported_in(&negotiated_version) {
            return vec![self.failure(
                negotiated_version,
                Some(request.id),
                Some(request.operation),
                RuntimeFailure::new(
                    ErrorCode::OperationUnavailable,
                    false,
                    "operation is unavailable for the negotiated protocol version",
                ),
            )];
        }

        let operation = request.operation;
        let request_id = request.id;
        let context = RuntimeContext {
            session_id: self.session_id.clone(),
            capabilities: capabilities_for(&negotiated_version),
        };
        let generation_events = (operation == Operation::GenerationStart).then(|| {
            GenerationEventSink::new(
                negotiated_version.clone(),
                request_id.clone(),
                self.event_sender.clone(),
            )
        });
        match self
            .handler
            .handle(&context, operation, request.payload, generation_events)
            .await
        {
            HandlerOutcome::Success(result) => {
                if operation == Operation::RuntimeShutdown {
                    self.shutdown = true;
                }
                vec![ServerEnvelope::Success(SuccessEnvelope {
                    protocol_version: negotiated_version,
                    id: request_id,
                    operation,
                    result,
                })]
            }
            HandlerOutcome::Failure(error) => {
                vec![self.failure(negotiated_version, Some(request_id), Some(operation), error)]
            }
            HandlerOutcome::GenerationAccepted(accepted)
                if operation == Operation::GenerationStart =>
            {
                vec![ServerEnvelope::Success(SuccessEnvelope {
                    protocol_version: negotiated_version.clone(),
                    id: request_id.clone(),
                    operation,
                    result: accepted,
                })]
            }
            HandlerOutcome::GenerationAccepted(_) => vec![self.failure(
                negotiated_version,
                Some(request_id),
                Some(operation),
                RuntimeFailure::new(
                    ErrorCode::Internal,
                    false,
                    "runtime returned generation events for a non-generation request",
                ),
            )],
        }
    }

    fn initialize(&mut self, request: RequestEnvelope) -> ServerEnvelope {
        if self.negotiated_version.is_some() {
            return self.failure(
                self.negotiated_version
                    .clone()
                    .unwrap_or_else(ProtocolVersion::current),
                Some(request.id),
                Some(request.operation),
                RuntimeFailure::new(
                    ErrorCode::AlreadyInitialized,
                    false,
                    "runtime is already initialized",
                ),
            );
        }

        let payload = match request.payload_as::<InitializePayload>() {
            Ok(payload) => payload,
            Err(error) => {
                return self.failure(
                    ProtocolVersion::current(),
                    Some(request.id),
                    Some(request.operation),
                    error.failure(),
                );
            }
        };
        let selected = match negotiate_protocol_version(&payload.supported_protocol_versions) {
            Ok(selected) if request.protocol_version == selected => selected,
            Ok(_) | Err(_) => {
                return self.failure(
                    ProtocolVersion::current(),
                    Some(request.id),
                    Some(request.operation),
                    RuntimeFailure::new(
                        ErrorCode::UnsupportedProtocolVersion,
                        false,
                        "runtime and client do not share the requested protocol version",
                    ),
                );
            }
        };

        let capabilities = capabilities_for(&selected);
        if payload
            .required_capabilities
            .iter()
            .any(|required| !capabilities.contains(required))
        {
            return self.failure(
                selected,
                Some(request.id),
                Some(request.operation),
                RuntimeFailure::new(
                    ErrorCode::RequiredCapabilityUnavailable,
                    false,
                    "runtime does not provide every required capability",
                ),
            );
        }

        self.negotiated_version = Some(selected.clone());
        let result = InitializeResult {
            selected_protocol_version: selected.clone(),
            session_id: self.session_id.clone(),
            runtime: RuntimeDescriptor {
                name: "scraply-agent".into(),
                version: env!("CARGO_PKG_VERSION").into(),
            },
            prompt: PromptCompiler.identity(),
            operations: operations_for(&selected),
            capabilities,
            limits: ProtocolLimits::current(),
        };
        ServerEnvelope::Success(
            SuccessEnvelope::from_serializable(selected, request.id, request.operation, result)
                .expect("initialize result serialization cannot fail"),
        )
    }

    fn failure(
        &self,
        protocol_version: ProtocolVersion,
        id: Option<RequestId>,
        operation: Option<Operation>,
        error: RuntimeFailure,
    ) -> ServerEnvelope {
        ServerEnvelope::Failure(FailureEnvelope {
            protocol_version,
            id,
            operation,
            error,
        })
    }

    fn should_shutdown(&self) -> bool {
        self.shutdown
    }

    fn response_version(&self) -> ProtocolVersion {
        self.negotiated_version
            .clone()
            .unwrap_or_else(ProtocolVersion::current)
    }
}

pub async fn run_with_handler<H>(handler: H) -> Result<(), AppServerError>
where
    H: RuntimeHandler,
{
    run_with_io(tokio::io::stdin(), tokio::io::stdout(), handler).await
}

async fn run_with_io<R, W, H>(mut input: R, mut output: W, handler: H) -> Result<(), AppServerError>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
    H: RuntimeHandler,
{
    let mut buffer = [0_u8; 8192];
    let mut framer = LineFramer::new(DEFAULT_MAX_LINE_BYTES).map_err(|_| AppServerError::Input)?;
    let (event_sender, mut event_receiver) = mpsc::channel(EVENT_CHANNEL_CAPACITY);
    let mut dispatcher = RuntimeDispatcher::new(handler, event_sender);

    'runtime: loop {
        tokio::select! {
            biased;
            read = input.read(&mut buffer) => {
                let read = read.map_err(|_| AppServerError::Input)?;
                if read == 0 {
                    break;
                }
                for frame in framer.push(&buffer[..read]) {
                    let envelopes = match frame {
                        Ok(request) => dispatcher.dispatch(request).await,
                        Err(error) => vec![ServerEnvelope::Failure(
                            error.into_failure(dispatcher.response_version()),
                        )],
                    };
                    for envelope in envelopes {
                        write_envelope(&mut output, &envelope).await?;
                    }
                    if dispatcher.should_shutdown() {
                        break 'runtime;
                    }
                }
            }
            Some(event) = event_receiver.recv() => {
                write_envelope(&mut output, &ServerEnvelope::Event(event)).await?;
            }
        }
    }

    if !dispatcher.should_shutdown()
        && let Some(frame) = framer.finish()
    {
        let envelopes = match frame {
            Ok(request) => dispatcher.dispatch(request).await,
            Err(error) => vec![ServerEnvelope::Failure(
                error.into_failure(dispatcher.response_version()),
            )],
        };
        for envelope in envelopes {
            write_envelope(&mut output, &envelope).await?;
        }
    }
    Ok(())
}

async fn write_envelope<W>(output: &mut W, envelope: &ServerEnvelope) -> Result<(), AppServerError>
where
    W: AsyncWrite + Unpin,
{
    let bytes = crate::protocol::encode_json_line(envelope, DEFAULT_MAX_LINE_BYTES)
        .map_err(|_| AppServerError::Output)?;
    output
        .write_all(&bytes)
        .await
        .map_err(|_| AppServerError::Output)?;
    output.flush().await.map_err(|_| AppServerError::Output)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::time::Duration;

    use super::*;
    use crate::protocol::{
        CURRENT_PROTOCOL_VERSION, Capability, ClientDescriptor, LEGACY_PROTOCOL_VERSION,
    };
    use serde_json::json;
    use tokio::io::{AsyncBufRead, AsyncBufReadExt, BufReader};
    use tokio::sync::watch;
    use tokio::time::{sleep, timeout};

    #[derive(Debug, Default)]
    struct RecordingHandler {
        calls: Vec<(Operation, Value)>,
    }

    #[async_trait]
    impl RuntimeHandler for RecordingHandler {
        async fn handle(
            &mut self,
            _context: &RuntimeContext,
            operation: Operation,
            payload: Value,
            generation_events: Option<GenerationEventSink>,
        ) -> HandlerOutcome {
            self.calls.push((operation, payload.clone()));
            if operation == Operation::GenerationStart {
                let generation_id = payload["generationId"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned();
                let event_sink =
                    generation_events.expect("generation start receives an event sink");
                tokio::spawn(async move {
                    event_sink
                        .send(GenerationStreamEvent::Started { generation_id })
                        .await
                        .expect("test runtime remains open");
                });
                HandlerOutcome::GenerationAccepted(json!({"accepted": true}))
            } else {
                assert!(generation_events.is_none());
                HandlerOutcome::Success(json!({"ok": true}))
            }
        }
    }

    #[derive(Debug, Default)]
    struct DelayedHandler {
        cancellations: HashMap<String, watch::Sender<bool>>,
    }

    #[async_trait]
    impl RuntimeHandler for DelayedHandler {
        async fn handle(
            &mut self,
            _context: &RuntimeContext,
            operation: Operation,
            payload: Value,
            generation_events: Option<GenerationEventSink>,
        ) -> HandlerOutcome {
            match operation {
                Operation::GenerationStart => {
                    let generation_id = payload["generationId"]
                        .as_str()
                        .expect("test generation id")
                        .to_owned();
                    let event_sink =
                        generation_events.expect("generation start receives an event sink");
                    let (cancel_sender, mut cancel_receiver) = watch::channel(false);
                    self.cancellations
                        .insert(generation_id.clone(), cancel_sender);
                    tokio::spawn(async move {
                        event_sink
                            .send(GenerationStreamEvent::Started {
                                generation_id: generation_id.clone(),
                            })
                            .await
                            .expect("test runtime remains open");
                        tokio::select! {
                            _ = sleep(Duration::from_secs(5)) => {
                                event_sink
                                    .send(GenerationStreamEvent::Completed {
                                        generation_id,
                                        result: json!({"output": {"answer": "too late"}}),
                                    })
                                    .await
                                    .expect("test runtime remains open");
                            }
                            changed = cancel_receiver.changed() => {
                                if changed.is_ok() && *cancel_receiver.borrow() {
                                    event_sink
                                    .send(GenerationStreamEvent::Cancelled {
                                        generation_id,
                                        attempts: Vec::new(),
                                    })
                                        .await
                                        .expect("test runtime remains open");
                                }
                            }
                        }
                    });
                    HandlerOutcome::GenerationAccepted(json!({
                        "accepted": true,
                        "generationId": payload["generationId"],
                    }))
                }
                Operation::GenerationCancel => {
                    assert!(generation_events.is_none());
                    let generation_id = payload["generationId"]
                        .as_str()
                        .expect("test generation id");
                    let Some(cancel_sender) = self.cancellations.remove(generation_id) else {
                        return HandlerOutcome::Failure(RuntimeFailure::new(
                            ErrorCode::GenerationNotFound,
                            false,
                            "generation was not found",
                        ));
                    };
                    let _ = cancel_sender.send(true);
                    HandlerOutcome::Success(json!({"cancelled": true}))
                }
                _ => {
                    assert!(generation_events.is_none());
                    HandlerOutcome::Success(json!({"ok": true}))
                }
            }
        }
    }

    fn envelope(id: i64, operation: Operation, payload: Value) -> RequestEnvelope {
        RequestEnvelope::new(
            ProtocolVersion::current(),
            RequestId::Integer(id),
            operation,
            payload,
        )
        .unwrap()
    }

    fn initialize(id: i64) -> RequestEnvelope {
        envelope(
            id,
            Operation::RuntimeInitialize,
            serde_json::to_value(InitializePayload {
                supported_protocol_versions: vec![
                    ProtocolVersion::new(CURRENT_PROTOCOL_VERSION).unwrap(),
                ],
                required_capabilities: Vec::new(),
                client: ClientDescriptor {
                    name: "scraply".into(),
                    version: "test".into(),
                },
            })
            .unwrap(),
        )
    }

    fn initialize_for(
        id: i64,
        version: &str,
        required_capabilities: Vec<Capability>,
    ) -> RequestEnvelope {
        let version = ProtocolVersion::new(version).unwrap();
        RequestEnvelope::new(
            version.clone(),
            RequestId::Integer(id),
            Operation::RuntimeInitialize,
            serde_json::to_value(InitializePayload {
                supported_protocol_versions: vec![version],
                required_capabilities,
                client: ClientDescriptor {
                    name: "scraply".into(),
                    version: "test".into(),
                },
            })
            .unwrap(),
        )
        .unwrap()
    }

    fn dispatcher<H>(handler: H) -> (RuntimeDispatcher<H>, mpsc::Receiver<EventEnvelope>)
    where
        H: RuntimeHandler,
    {
        let (sender, receiver) = mpsc::channel(EVENT_CHANNEL_CAPACITY);
        (RuntimeDispatcher::new(handler, sender), receiver)
    }

    async fn write_request<W>(writer: &mut W, request: &RequestEnvelope)
    where
        W: AsyncWrite + Unpin,
    {
        let line = crate::protocol::encode_json_line(request, DEFAULT_MAX_LINE_BYTES).unwrap();
        writer.write_all(&line).await.unwrap();
        writer.flush().await.unwrap();
    }

    async fn read_message<R>(reader: &mut R) -> Value
    where
        R: AsyncBufRead + Unpin,
    {
        let mut line = String::new();
        let bytes_read = timeout(Duration::from_secs(1), reader.read_line(&mut line))
            .await
            .expect("runtime response timed out")
            .unwrap();
        assert!(bytes_read > 0, "runtime closed before writing a response");
        serde_json::from_str(&line).unwrap()
    }

    #[tokio::test]
    async fn event_sink_emits_exactly_one_terminal_event() {
        let (sender, mut receiver) = mpsc::channel(EVENT_CHANNEL_CAPACITY);
        let sink =
            GenerationEventSink::new(ProtocolVersion::current(), RequestId::Integer(1), sender);
        sink.send(GenerationStreamEvent::Completed {
            generation_id: "generation-1".into(),
            result: json!({"output": {"answer": "ok"}}),
        })
        .await
        .unwrap();
        sink.send(GenerationStreamEvent::Failed {
            generation_id: "generation-1".into(),
            error: RuntimeFailure::new(ErrorCode::Internal, false, "late failure"),
            attempts: Vec::new(),
        })
        .await
        .unwrap();

        let first = receiver.recv().await.unwrap();
        assert!(first.event.is_terminal());
        assert!(receiver.try_recv().is_err());
    }

    #[tokio::test]
    async fn initialization_is_required_and_request_ids_cannot_be_reused() {
        let (mut dispatcher, _events) = dispatcher(RecordingHandler::default());
        let before_init = dispatcher
            .dispatch(envelope(1, Operation::AccountList, json!({})))
            .await;
        let ServerEnvelope::Failure(failure) = &before_init[0] else {
            panic!("expected failure")
        };
        assert_eq!(failure.error.code, ErrorCode::NotInitialized);

        let initialized = dispatcher.dispatch(initialize(2)).await;
        assert!(matches!(initialized[0], ServerEnvelope::Success(_)));

        let duplicate = dispatcher
            .dispatch(envelope(2, Operation::ModelList, json!({})))
            .await;
        let ServerEnvelope::Failure(failure) = &duplicate[0] else {
            panic!("expected failure")
        };
        assert_eq!(failure.error.code, ErrorCode::RequestConflict);
    }

    #[tokio::test]
    async fn unsupported_initial_version_and_later_version_drift_fail_closed() {
        let (mut legacy, _events) = dispatcher(RecordingHandler::default());
        let unavailable = legacy
            .dispatch(initialize_for(
                1,
                LEGACY_PROTOCOL_VERSION,
                vec![Capability::AccountRefresh],
            ))
            .await;
        let ServerEnvelope::Failure(failure) = &unavailable[0] else {
            panic!("expected version failure")
        };
        assert_eq!(failure.error.code, ErrorCode::UnsupportedProtocolVersion);

        let (mut current, _events) = dispatcher(RecordingHandler::default());
        current.dispatch(initialize(1)).await;
        let mut drift = envelope(2, Operation::AccountList, json!({}));
        drift.protocol_version = ProtocolVersion::new(LEGACY_PROTOCOL_VERSION).unwrap();
        let response = current.dispatch(drift).await;
        let ServerEnvelope::Failure(failure) = &response[0] else {
            panic!("expected version drift failure")
        };
        assert_eq!(failure.error.code, ErrorCode::UnsupportedProtocolVersion);
    }

    #[tokio::test]
    async fn generation_events_keep_the_start_request_id() {
        let (mut dispatcher, mut events) = dispatcher(RecordingHandler::default());
        dispatcher.dispatch(initialize(1)).await;
        let output = dispatcher
            .dispatch(envelope(
                7,
                Operation::GenerationStart,
                json!({"generationId": "gen-7", "workOrder": {}}),
            ))
            .await;
        assert_eq!(output.len(), 1);
        assert!(matches!(output[0], ServerEnvelope::Success(_)));
        let event = events.recv().await.expect("event sender remains open");
        assert_eq!(event.request_id, RequestId::Integer(7));
        assert_eq!(event.operation, Operation::GenerationStart);
        assert_eq!(event.event.generation_id(), "gen-7");
    }

    #[tokio::test]
    async fn cancel_is_processed_while_generation_is_running() {
        let (client, server) = tokio::io::duplex(16 * 1024);
        let (server_input, server_output) = tokio::io::split(server);
        let server_task = tokio::spawn(run_with_io(
            server_input,
            server_output,
            DelayedHandler::default(),
        ));
        let (client_input, mut client_output) = tokio::io::split(client);
        let mut client_input = BufReader::new(client_input);

        write_request(&mut client_output, &initialize(1)).await;
        let initialized = read_message(&mut client_input).await;
        assert_eq!(initialized["id"], 1);

        write_request(
            &mut client_output,
            &envelope(
                2,
                Operation::GenerationStart,
                json!({"generationId": "gen-delayed", "workOrder": {}}),
            ),
        )
        .await;
        let accepted = read_message(&mut client_input).await;
        assert_eq!(accepted["id"], 2);
        assert_eq!(accepted["result"]["accepted"], true);

        write_request(
            &mut client_output,
            &envelope(
                3,
                Operation::GenerationCancel,
                json!({"generationId": "gen-delayed"}),
            ),
        )
        .await;

        let mut saw_cancel_response = false;
        while !saw_cancel_response {
            let message = read_message(&mut client_input).await;
            assert_ne!(message["event"]["kind"], "generation.completed");
            saw_cancel_response = message["id"] == 3;
        }

        let cancelled_event = loop {
            let message = read_message(&mut client_input).await;
            assert_ne!(message["event"]["kind"], "generation.completed");
            if message["event"]["kind"] == "generation.cancelled" {
                break message;
            }
        };
        assert_eq!(cancelled_event["requestId"], 2);
        assert_eq!(cancelled_event["operation"], "generation.start");
        assert_eq!(cancelled_event["event"]["generationId"], "gen-delayed");

        write_request(
            &mut client_output,
            &envelope(4, Operation::RuntimeShutdown, json!({})),
        )
        .await;
        let shutdown = read_message(&mut client_input).await;
        assert_eq!(shutdown["id"], 4);
        timeout(Duration::from_secs(1), server_task)
            .await
            .expect("runtime did not stop")
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn shutdown_acknowledges_then_stops_dispatch() {
        let (mut dispatcher, _events) = dispatcher(RecordingHandler::default());
        dispatcher.dispatch(initialize(1)).await;
        let output = dispatcher
            .dispatch(envelope(2, Operation::RuntimeShutdown, json!({})))
            .await;
        assert!(matches!(output[0], ServerEnvelope::Success(_)));
        assert!(dispatcher.should_shutdown());
    }
}
