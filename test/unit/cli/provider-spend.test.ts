import { expect, test } from "bun:test";
import { createServiceBilling } from "../../../src/app/service-billing";
import { createCommandContext } from "../../../src/cli/context";
import { runCli } from "../../../src/cli/main";
import {
  APP_CHANNELS, ExecuteOperationRequestSchema, OperationProposalSchema, SearchKeyCredentialReferenceSchema,
} from "../../../src/shared/cli-contracts";
import { IPC_CHANNELS, SaveSearchKeySchema, WorkspaceStateSchema } from "../../../src/shared/ipc";
import { z } from "zod";

function fixture() {
  const workspace = WorkspaceStateSchema.parse({
    validation: { exa: { valid: false }, perplexity: { valid: false }, native: { available: true, connected: true, accounts: [] }, setupComplete: true },
    threads: [], activeThreadId: null, messages: [], scope: null, runConfig: null, models: [], modelOptions: [], modelCatalog: { models: [], favorites: [] },
    presets: [], problemCandidates: [], rejectedProblemCandidates: [], solutions: [], latestResearchRun: null, pendingRuns: [], researchRequests: [], researchFindings: [],
  });
  const calls: { channel: string; payload: unknown }[] = [];
  const dispatches: { channel: string; payload: unknown }[] = [];
  const billing = createServiceBilling({
    async capabilities() { return workspace.validation; }, privateState() { return { revision: 1 }; }, async validate() {},
    async dispatch(channel, payload) {
      dispatches.push({ channel, payload });
      if (channel === IPC_CHANNELS.GET_VALIDATION) return workspace.validation;
      if (channel === IPC_CHANNELS.RETRY_CONNECTION) return null;
      SaveSearchKeySchema.parse(payload);
      return workspace;
    },
  });
  const owner = { owner: { pid: 100, port: 43210, kind: "cli", version: "0.1.2" } };
  async function invoke(channel: string, payload?: unknown): Promise<unknown> {
    calls.push({ channel, payload });
    if (channel === APP_CHANNELS.PREVIEW_OPERATION) return billing.preview(payload);
    if (channel === APP_CHANNELS.EXECUTE_OPERATION) return billing.execute(payload);
    if (channel === APP_CHANNELS.GET_PROVIDER_STATUS) return workspace.validation;
    if (channel === IPC_CHANNELS.GET_WORKSPACE) return workspace;
    throw new Error("Unexpected direct provider operation");
  }
  return {
    workspace, calls, dispatches, owner, billing, invoke,
    async run(args: string[], input = "") {
      let output = "";
      let reads = 0;
      const code = await runCli(args, {
        invoke, isTTY: false, stdout(text) { output += text; }, stderr() {},
        async stdin() { reads += 1; return input; }, async system() { return owner; },
      });
      return { code, output, reads, envelope: z.discriminatedUnion("ok", [
        z.object({ ok: z.literal(true), data: z.unknown() }),
        z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string(), recovery: z.unknown().optional() }) }),
      ]).parse(JSON.parse(output)) };
    },
  };
}

test("status and plain doctor read passive provider state with no billing dispatch", async () => {
  const item = fixture();
  try {
    const status = await item.run(["status"]);
    const doctor = await item.run(["doctor"]);
    expect(status.code).toBe(0);
    expect(doctor.code).toBe(0);
    expect(doctor.envelope).toEqual({ ok: true, data: { validation: item.workspace.validation, owner: item.owner } });
    expect(item.calls.map(call => call.channel)).toEqual([APP_CHANNELS.GET_PROVIDER_STATUS, IPC_CHANNELS.GET_WORKSPACE, APP_CHANNELS.GET_PROVIDER_STATUS]);
    expect(item.dispatches).toEqual([]);
  } finally { item.billing.clear(); }
});

for (const action of ["validate", "retry"] as const) {
  test(`doctor --${action} requires a proposal and --yes dispatches its probe once`, async () => {
    const item = fixture();
    const channel = action === "validate" ? IPC_CHANNELS.GET_VALIDATION : IPC_CHANNELS.RETRY_CONNECTION;
    try {
      const proposed = await item.run(["doctor", `--${action}`]);
      expect(proposed.code).toBe(3);
      expect(proposed.envelope).toMatchObject({ ok: false, error: { code: "NEEDS_CONFIRMATION", recovery: { preview: { operation: { channel, payload: {} } } } } });
      expect(item.dispatches).toEqual([]);
      item.calls.length = 0;
      const confirmed = await item.run(["doctor", `--${action}`, "--yes"]);
      expect(confirmed.code).toBe(0);
      expect(confirmed.envelope).toEqual({ ok: true, data: { validation: item.workspace.validation, owner: item.owner } });
      expect(item.dispatches).toEqual([{ channel, payload: {} }]);
      expect(item.calls.map(call => call.channel)).toEqual([APP_CHANNELS.PREVIEW_OPERATION, APP_CHANNELS.EXECUTE_OPERATION, ...(action === "retry" ? [APP_CHANNELS.GET_PROVIDER_STATUS] : [])]);
    } finally { item.billing.clear(); }
  });
}

test("doctor rejects two probes or an unaddressed saved proof before any owner call", async () => {
  const item = fixture();
  try {
    expect((await item.run(["doctor", "--validate", "--retry", "--yes"])).code).toBe(2);
    expect((await item.run(["doctor", "--preview-file", "synthetic-preview.json"])).code).toBe(2);
    expect(item.calls).toEqual([]);
    expect(item.dispatches).toEqual([]);
  } finally { item.billing.clear(); }
});

test("key preview returns only an opaque reference and fresh --yes executes the exact newly supplied key", async () => {
  const item = fixture();
  const firstKey = "synthetic-first-stdin-key";
  const secondKey = "synthetic-second-stdin-key";
  try {
    const previewed = await item.run(["key", "set", "exa", "--stdin"], `${firstKey}\n`);
    expect(previewed.code).toBe(3);
    if (previewed.envelope.ok) throw new Error("Expected confirmation.");
    const proposal = z.object({ preview: OperationProposalSchema }).parse(previewed.envelope.error.recovery).preview;
    const reference = SearchKeyCredentialReferenceSchema.parse(proposal.operation.payload);
    expect(reference.provider).toBe("exa");
    expect(previewed.output).not.toContain(firstKey);
    expect(item.dispatches).toEqual([]);
    const confirmed = await item.run(["key", "set", "exa", "--stdin", "--yes"], `${secondKey}\r\n`);
    expect(confirmed.code).toBe(0);
    expect(confirmed.envelope).toEqual({ ok: true, data: { provider: "exa", saved: true } });
    expect(confirmed.output).not.toContain(secondKey);
    expect(item.dispatches).toEqual([{ channel: IPC_CHANNELS.SAVE_SEARCH_KEY, payload: { provider: "exa", apiKey: secondKey } }]);
    const submitted = ExecuteOperationRequestSchema.parse(item.calls.at(-1)!.payload).proposal;
    expect(JSON.stringify(submitted)).not.toContain(firstKey);
    expect(JSON.stringify(submitted)).not.toContain(secondKey);
    expect(SearchKeyCredentialReferenceSchema.parse(submitted.operation.payload).credentialRef).not.toBe(reference.credentialRef);
  } finally { item.billing.clear(); }
});

test("key preview-file is rejected without reading a supplied key, file, or owner", async () => {
  const item = fixture();
  try {
    const result = await item.run(["key", "set", "exa", "--stdin", "--yes", "--preview-file", "not-read.json"], "synthetic-ignored-key");
    expect(result.code).toBe(2);
    expect(result.envelope).toMatchObject({ ok: false, error: { message: expect.stringContaining("Next command: scraply key set exa --stdin --yes") } });
    expect(result.reads).toBe(0);
    expect(item.calls).toEqual([]);
    expect(result.output).not.toContain("synthetic-ignored-key");
  } finally { item.billing.clear(); }
});

test("context rejects a key's saved proof instead of accepting unrelated stdin", async () => {
  let calls = 0;
  const ctx = createCommandContext({ signal: new AbortController().signal, deadline: Date.now() + 1_000,
    async invoke() { calls += 1; return null; }, async subscribe() { return { close() {}, done: Promise.resolve() }; },
    async readStdin() { return ""; }, write() {}, async openExternal() {}, async system() { return null; },
  });
  await expect(ctx.previewAndExecute(IPC_CHANNELS.SAVE_SEARCH_KEY, { provider: "exa", apiKey: "synthetic-unmatched-key" }, { positionals: [], flags: { yes: true, "preview-file": "not-read.json" } })).rejects.toMatchObject({ code: "USAGE", exitCode: 2 });
  expect(calls).toBe(0);
});
