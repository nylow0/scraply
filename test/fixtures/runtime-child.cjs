/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const readline = require("node:readline");

if (process.argv[2] === "--version") {
  process.stdout.write("scraply-agent 0.1.0\n");
  process.exit(0);
}

const mode = process.env.SCRAPLY_RUNTIME_CHILD_MODE || "normal";
const workflow = mode.startsWith("workflow");
let connected = false;
let credential;
let pendingLogin;
let loginSequence = 0;
let heldGeneration;
if (process.env.SCRAPLY_RUNTIME_PID_CAPTURE) fs.appendFileSync(process.env.SCRAPLY_RUNTIME_PID_CAPTURE, `${process.pid}\n`);
const prompt = { id: "scraply.stage-worker.v1", sha256: "277d724f20acb1f32fa0a8b7c454c670971e3c40bfc921db40c044caa760e6f1" };
const model = { providerId: "openai-subscription", modelId: "gpt-fixture" };
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const reply = (request, result) => send({ protocolVersion: "1.1", id: request.id, operation: request.operation, result });

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (process.env.SCRAPLY_RUNTIME_OPERATIONS_CAPTURE) {
    fs.appendFileSync(process.env.SCRAPLY_RUNTIME_OPERATIONS_CAPTURE, `${request.operation}\n`);
  }
  if (request.operation === "runtime.initialize") {
    if (mode === "malformed-once" && process.env.SCRAPLY_RUNTIME_MARKER && !fs.existsSync(process.env.SCRAPLY_RUNTIME_MARKER)) {
      fs.writeFileSync(process.env.SCRAPLY_RUNTIME_MARKER, "seen");
      process.stdout.write(Buffer.from([0xc3, 0x28, 0x0a]));
      return;
    }
    const incompatibleOnce = mode === "incompatible-once" && process.env.SCRAPLY_RUNTIME_MARKER
      && !fs.existsSync(process.env.SCRAPLY_RUNTIME_MARKER);
    if (incompatibleOnce) fs.writeFileSync(process.env.SCRAPLY_RUNTIME_MARKER, "seen");
    reply(request, {
      selectedProtocolVersion: "1.1", sessionId: "fixture-session",
      runtime: { name: "scraply-agent", version: incompatibleOnce ? "9.9.9" : "0.1.0" }, prompt,
      operations: ["runtime.initialize", "account.list", "account.login.start", "account.login.complete", "account.login.cancel", "account.logout", "account.refresh", "credential.session.set", "credential.session.persisted", "model.list", "generation.start", "generation.cancel", "runtime.shutdown"],
      capabilities: ["envelope_limits", "account_refresh", "credential_persistence_ack", "generation_attempt_metadata", "exactly_one_terminal"],
      limits: { maxEnvelopeBytes: 16777216, maxInputBytes: 2097152, maxSchemaBytes: 262144, maxOutputBytes: 2097152 },
    });
    return;
  }
  if (request.operation === "credential.session.set") {
    credential = request.payload.credential;
    connected = true;
    reply(request, {});
    return;
  }
  if (request.operation === "account.logout") { connected = false; reply(request, {}); return; }
  if (request.operation === "account.list") { reply(request, { accounts: workflow && connected ? [{ providerId: model.providerId, accountId: "synthetic-account" }] : [] }); return; }
  if (request.operation === "model.list") {
    if (mode === "workflow-auth" && credential === "rejected-credential") {
      send({ protocolVersion: "1.1", id: request.id, operation: request.operation,
        error: { code: "authentication_failed", retryable: false, detail: "provider request failed with HTTP 401" } });
      return;
    }
    if (mode === "wrong-operation") {
      send({ protocolVersion: "1.1", id: request.id, operation: "account.list", error: { code: "operation_unavailable", retryable: true, detail: "wrong operation" } });
      return;
    }
    const bytes = Buffer.from(`${JSON.stringify({ protocolVersion: "1.1", id: request.id, operation: request.operation, result: { models: [{ identity: model, displayName: "Modèle", supportsStructuredOutput: true }] } })}\n`);
    const split = bytes.indexOf(Buffer.from([0xc3, 0xa8])) + 1;
    process.stdout.write(bytes.subarray(0, split));
    setTimeout(() => process.stdout.write(bytes.subarray(split)), 5);
    return;
  }
  if (request.operation === "account.refresh") {
    if (mode === "workflow-auth" && credential === "rejected-credential") {
      send({ protocolVersion: "1.1", id: request.id, operation: request.operation,
        error: { code: "authentication_failed", retryable: false, detail: "provider request failed with HTTP 401" } });
      return;
    }
    reply(request, {
      account: { providerId: model.providerId, accountId: "synthetic-account" }, credential: "connected-credential",
      persistence: { providerId: model.providerId, sessionId: "fixture-session", rotationId: "fixture-refresh" },
    });
    return;
  }
  if (request.operation === "account.login.start") {
    const loginId = `fixture-login-${++loginSequence}`;
    pendingLogin = { loginId, method: request.payload.method };
    reply(request, request.payload.method === "device"
      ? { loginId, providerId: model.providerId, method: "device", verificationUrl: "https://example.test/device", userCode: "FIXTURE-CODE" }
      : { loginId, providerId: model.providerId, method: "browser", authorizationUrl: "https://example.test/login", callbackPort: 1455 });
    return;
  }
  if (request.operation === "account.login.complete") {
    if (!pendingLogin || pendingLogin.loginId !== request.payload.loginId || pendingLogin.method === "device") {
      send({ protocolVersion: "1.1", id: request.id, operation: request.operation,
        error: { code: "operation_unavailable", retryable: true, detail: "Sign-in is still pending" } });
      return;
    }
    pendingLogin = undefined;
    credential = "connected-credential";
    connected = true;
    reply(request, {
      account: { providerId: model.providerId, accountId: "synthetic-account" }, credential,
      persistence: { providerId: model.providerId, sessionId: "fixture-session", rotationId: "fixture-login" },
    });
    return;
  }
  if (request.operation === "credential.session.persisted") { reply(request, { ...request.payload, ready: true }); return; }
  if (request.operation === "account.login.cancel") {
    pendingLogin = undefined;
    reply(request, { cancelled: true });
    return;
  }
  if (request.operation === "generation.start") {
    if (process.env.SCRAPLY_RUNTIME_CAPTURE) fs.appendFileSync(process.env.SCRAPLY_RUNTIME_CAPTURE, `${JSON.stringify(request)}\n`);
    if (mode === "exit-before-acceptance") { process.exit(7); return; }
    reply(request, {
      generationId: request.payload.generationId,
      prompt: mode === "prompt-mismatch" ? { ...prompt, sha256: "f".repeat(64) } : prompt,
    });
    if (workflow && !connected) throw new Error("Workflow generation arrived before session restoration");
    if (mode === "workflow-crash" && request.payload.workOrder.stage.startsWith("outcomes:")) {
      process.exit(7);
      return;
    }
    if (mode === "workflow-cancel" && request.payload.workOrder.stage === "solutions") {
      heldGeneration = request;
      return;
    }
    if (mode === "hang-cancel") return;
    const metadata = {
      model, prompt, usage: { status: "unknown" }, finishReason: "stop", latencyMs: 1,
      repairCount: 0, providerRequestIds: ["fixture-provider-request"],
      attempts: [{ attempt: "initial", outcome: "completed", providerCompletion: "confirmed", model, usage: { status: "unknown" }, cost: { status: "not_reported" }, finishReason: "stop", latencyMs: 1, providerRequestId: "fixture-provider-request" }],
    };
    const output = workflow ? require("./runtime-workflow.cjs")(request.payload)
      : mode === "invalid-output" ? { invalid: true } : request.payload.workOrder.stage.startsWith("query-plan")
      ? { queries: ["one", "two", "three"] }
      : request.payload.workOrder.stage.startsWith("factor-harvest") ? { factors: [] } : { answer: "right" };
    const wrong = { protocolVersion: "1.1", requestId: "unrelated-request", operation: "generation.start", event: { kind: "generation.completed", generationId: request.payload.generationId, result: { output: { answer: "wrong" }, metadata } } };
    const correct = { protocolVersion: "1.1", requestId: request.id, operation: "generation.start", event: { kind: "generation.completed", generationId: request.payload.generationId, result: { output, metadata } } };
    const writeTerminal = () => process.stdout.write(`${JSON.stringify(wrong)}\n${JSON.stringify(correct)}\n${JSON.stringify(correct)}\n`);
    if (mode === "prompt-mismatch") setTimeout(writeTerminal, 75);
    else writeTerminal();
    return;
  }
  if (request.operation === "generation.cancel") {
    reply(request, { generationId: request.payload.generationId, cancelled: true });
    if (heldGeneration) {
      send({ protocolVersion: "1.1", requestId: heldGeneration.id, operation: "generation.start", event: {
        kind: "generation.cancelled", generationId: heldGeneration.payload.generationId,
        attempts: [],
      } });
      heldGeneration = undefined;
    }
    return;
  }
  if (request.operation === "runtime.shutdown") {
    if (mode === "hang-shutdown") return;
    reply(request, {});
    setTimeout(() => process.exit(0), 5);
    return;
  }
  reply(request, {});
});
