import { describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { buildCodexExecArgs, buildCodexLaunchSpec, CodexClient, inspectCodexCli, invalidateCodexInspectionCache } from "../../src/providers/codex";
import { ProviderFailure, type StructuredStageRequest } from "../../src/providers/structured";

describe("Codex structured adapter", () => {
  test("uses the bounded read-only Luna execution contract", () => {
    const args = buildCodexExecArgs("gpt-5.6-luna", "high", "C:\\tmp\\call", "schema.json", "last.json");
    expect(args).toContain("--ephemeral");
    expect(args).toContain("--skip-git-repo-check");
    expect(args).toContain("read-only");
    expect(args).toContain("--output-schema");
    expect(args).toContain("--output-last-message");
    expect(args).toContain('model_reasoning_effort="high"');
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual(["--model", "gpt-5.6-luna"]);
    expect(args[0]).toBe("exec");
    expect(args[1]).toBe("-");
  });

  test("preserves an explicit Windows cmd path in the launcher payload", () => {
    const command = "C:\\custom tools\\codex.cmd";
    const launch = buildCodexLaunchSpec(command, ["--version"], "win32");
    const script = Buffer.from(launch.args.at(-1)!, "base64").toString("utf16le");
    const encodedPayload = script.match(/FromBase64String\('([^']+)'\)/)?.[1];
    const payload = JSON.parse(Buffer.from(encodedPayload!, "base64").toString("utf8")) as { command: string; args: string[] };
    expect(launch.command).toBe("powershell.exe");
    expect(payload).toEqual({ command, args: ["--version"] });
  });

  test("validates through app-server without ever starting a structured completion", async () => {
    const fixture = fakeCodexExecutable(`
const args = process.argv.slice(2);
if (args[0] === "exec") {
  console.error("provider validation must never generate a completion");
  process.exit(97);
} else if (args[0] === "--version") {
  console.log("codex-cli 1.2.3");
} else if (args[0] === "app-server") {
  let buffered = "";
  for await (const chunk of process.stdin) {
    buffered += String(chunk);
    const lines = buffered.split(/\\r?\\n/);
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.method === "initialize") console.log(JSON.stringify({ id: message.id, result: {} }));
      if (message.method === "account/read") console.log(JSON.stringify({ id: message.id, result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true } }));
      if (message.method === "model/list") console.log(JSON.stringify({ id: message.id, result: { data: [{ id: "fake-model", displayName: "Fake Model", defaultReasoningEffort: "medium" }], nextCursor: null } }));
    }
  }
}
`);
    const previous = process.env.CODEX_CLI_PATH;
    const completion = spyOn(CodexClient.prototype, "structuredCompletion");
    process.env.CODEX_CLI_PATH = fixture.executable;
    try {
      await expect(inspectCodexCli({ force: true })).resolves.toMatchObject({
        detected: true, compatible: true, authenticated: true, version: "codex-cli 1.2.3",
        models: [{ providerId: "legacy-codex-cli", modelId: "fake-model", displayName: "Fake Model", defaultReasoningEffort: "medium" }],
      });
      expect(completion).not.toHaveBeenCalled();
    } finally {
      completion.mockRestore();
      invalidateCodexInspectionCache();
      if (previous === undefined) delete process.env.CODEX_CLI_PATH;
      else process.env.CODEX_CLI_PATH = previous;
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  }, 10_000);

  test("force refresh bypasses the Codex inspection cache", async () => {
    const fixture = fakeCodexExecutable(inspectionProgram(true));
    const previous = process.env.CODEX_CLI_PATH;
    process.env.CODEX_CLI_PATH = fixture.executable;
    try {
      await expect(inspectCodexCli({ force: true })).resolves.toMatchObject({ authenticated: true });
      writeFileSync(fixture.script, inspectionProgram(false), "utf8");
      await expect(inspectCodexCli()).resolves.toMatchObject({ authenticated: true });
      await expect(inspectCodexCli({ force: true })).resolves.toMatchObject({
        detected: true, compatible: true, authenticated: false, error: "Codex is not signed in",
      });
    } finally {
      invalidateCodexInspectionCache();
      if (previous === undefined) delete process.env.CODEX_CLI_PATH;
      else process.env.CODEX_CLI_PATH = previous;
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  }, 10_000);

  test("exercises successful output, classified failure, and abort through a real fake executable", async () => {
    const fixture = fakeCodexExecutable(`
const args = process.argv.slice(2);
for await (const _chunk of process.stdin) { /* consume the prompt */ }
const model = args[args.indexOf("--model") + 1];
if (model === "auth-fail") {
  console.error("login required");
  process.exit(1);
}
if (model === "slow") await new Promise((resolve) => setTimeout(resolve, 30_000));
const output = args[args.indexOf("--output-last-message") + 1];
await Bun.write(output, JSON.stringify({ ok: true }));
`);
    const previous = process.env.CODEX_CLI_PATH;
    process.env.CODEX_CLI_PATH = fixture.executable;
    const client = new CodexClient();
    const schema = z.object({ ok: z.boolean() });
    const jsonSchema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
    try {
      await expect(client.structuredCompletion(stageRequest("success", schema, jsonSchema))).resolves.toMatchObject({ output: { ok: true } });
      await expect(client.structuredCompletion(stageRequest("auth-fail", schema, jsonSchema))).rejects.toMatchObject({ code: "auth", retryable: false });
      const controller = new AbortController();
      const pending = client.structuredCompletion(stageRequest("slow", schema, jsonSchema, controller.signal));
      setTimeout(() => controller.abort(new Error("test abort")), 50);
      await expect(pending).rejects.toMatchObject({ code: "cancelled", retryable: false });
    } finally {
      if (previous === undefined) delete process.env.CODEX_CLI_PATH;
      else process.env.CODEX_CLI_PATH = previous;
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  }, 10_000);

  test("waits for a timed-out Codex process to exit and removes its temp directory", async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "scraply-codex-fixture-"));
    const executable = join(fixtureDir, process.platform === "win32" ? "slow-codex.cmd" : "slow-codex");
    writeFileSync(executable, process.platform === "win32"
      ? "@echo off\r\npowershell.exe -NoLogo -NoProfile -NonInteractive -Command \"Start-Sleep -Seconds 30\"\r\n"
      : "#!/bin/sh\nsleep 30\n", "utf8");
    if (process.platform !== "win32") chmodSync(executable, 0o755);
    const previous = process.env.CODEX_CLI_PATH;
    const before = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith("scraply-codex-")));
    process.env.CODEX_CLI_PATH = executable;
    try {
      const schema = z.object({ ok: z.boolean() });
      await expect(new CodexClient().structuredCompletion(stageRequest("test", schema, {
        type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false,
      }, undefined, 25))).rejects.toMatchObject({ code: "timeout" } satisfies Partial<ProviderFailure>);
      const leftovers = readdirSync(tmpdir()).filter((name) => name.startsWith("scraply-codex-") && !before.has(name));
      expect(leftovers).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.CODEX_CLI_PATH;
      else process.env.CODEX_CLI_PATH = previous;
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  }, 5_000);
});

function stageRequest<T>(
  modelId: string,
  schema: StructuredStageRequest<T>["schema"],
  jsonSchema: object,
  signal?: AbortSignal,
  deadlineMs = 5_000,
): StructuredStageRequest<T> {
  return {
    generationId: `generation-${modelId}`,
    stage: "test",
    model: { providerId: "legacy-codex-cli", modelId },
    reasoningEffort: "medium",
    workOrder: {
      stage: "test",
      instruction: "Return the requested test object.",
      goal: "Exercise the adapter.",
      inputs: {},
      definitionOfDone: ["The output matches the schema."],
    },
    evidence: [{ sourceId: "test-input", content: { value: "user" } }],
    schema,
    jsonSchema,
    repairPolicy: "disabled",
    deadlineMs,
    ...(signal ? { signal } : {}),
  };
}

function inspectionProgram(authenticated: boolean): string {
  return `
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("codex-cli 1.2.3");
} else if (args[0] === "app-server") {
  let buffered = "";
  for await (const chunk of process.stdin) {
    buffered += String(chunk);
    const lines = buffered.split(/\\r?\\n/);
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.method === "initialize") console.log(JSON.stringify({ id: message.id, result: {} }));
      if (message.method === "account/read") console.log(JSON.stringify({ id: message.id, result: { account: ${authenticated ? '{ type: "chatgpt" }' : "null"}, requiresOpenaiAuth: true } }));
      if (message.method === "model/list") console.log(JSON.stringify({ id: message.id, result: { data: [{ id: "fake-model", displayName: "Fake Model", defaultReasoningEffort: "medium" }], nextCursor: null } }));
    }
  }
}
`;
}

function fakeCodexExecutable(program: string): { directory: string; executable: string; script: string } {
  const directory = mkdtempSync(join(tmpdir(), "scraply-fake-codex-"));
  const script = join(directory, "fake-codex.js");
  const executable = join(directory, process.platform === "win32" ? "codex.cmd" : "codex");
  writeFileSync(script, program, "utf8");
  writeFileSync(executable, process.platform === "win32"
    ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, "utf8");
  if (process.platform !== "win32") chmodSync(executable, 0o755);
  return { directory, executable, script };
}
