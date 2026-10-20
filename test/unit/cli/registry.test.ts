import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { runCli } from "../../../src/cli/main";
import { commands, describeCommands } from "../../../src/cli/registry";
import { createCommandContext, type ContextDependencies } from "../../../src/cli/context";
import { APP_CHANNELS, appControlRegistry, operationRegistry, OperationProposalSchema } from "../../../src/shared/cli-contracts";
import { IPC_CHANNELS } from "../../../src/shared/ipc";
import { WorkspaceStateSchema } from "../../../src/shared/ipc";
import { DEFAULT_RUN_CONFIG, RunConfigSchema } from "../../../src/shared/schemas";
import { defaultLaunchSettings, buildSavedLaunchDraft } from "../../../src/shared/launch-settings";
import { AppError } from "../../../src/shared/errors";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function projectFixture() {
  const thread = { id: "project-synthetic-alpha", title: "Invented workshop queue", status: "configuring", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" };
  const scope = { title: thread.title, audience: "Workshop coordinators", domain: "Parts approval", observations: "Invented coordinators wait for parts approval.", offLimits: [] };
  const config = RunConfigSchema.parse(DEFAULT_RUN_CONFIG);
  const workspace = WorkspaceStateSchema.parse({
    validation: { exa: { valid: false }, perplexity: { valid: false }, native: { available: true, connected: true, accounts: [] }, setupComplete: true },
    threads: [thread], activeThreadId: "stable-default-project", messages: [], scope, runConfig: config,
    models: [config.model], modelOptions: [], modelCatalog: { models: [config.model], favorites: [] }, presets: [],
    problemCandidates: [], rejectedProblemCandidates: [], solutions: [], latestResearchRun: null, pendingRuns: [], researchRequests: [], researchFindings: [],
  });
  const launchSettings = defaultLaunchSettings(scope, config);
  return { thread, workspace, launchSettings, draft: buildSavedLaunchDraft(scope, config, launchSettings), resumableDevelopment: false };
}

function context(overrides: Partial<ContextDependencies> = {}) {
  return createCommandContext({
    signal: new AbortController().signal, deadline: Date.now() + 1_000,
    async invoke() { throw new Error("Unexpected owner call"); },
    async subscribe() { return { close() {}, done: Promise.resolve() }; },
    async readStdin() { return ""; }, write() {}, async openExternal() {}, async system() { return null; },
    ...overrides,
  });
}

describe("CLI registry and execution", () => {
  test("help and version never invoke owner, profile or setup adapters", async () => {
    for (const argv of [["help", "--json"], ["run", "start", "--help"], ["--version"], ["--data-dir", "synthetic-uncreated-profile", "--help"]]) {
      let output = "";
      const result = await runCli(argv, {
        isTTY: false, stdout(text) { output += text; }, stderr() {},
        async invoke() { throw new Error("Must not reach host"); },
        async system() { throw new Error("Must not touch profile/setup"); },
      });
      expect(result).toBe(0);
      expect(z.object({ ok: z.literal(true), data: z.unknown() }).parse(JSON.parse(output)).ok).toBe(true);
    }
  });

  test("setup delegates without invoking owner", async () => {
    let output = "";
    const calls: string[] = [];
    expect(await runCli(["setup", "--remove"], { isTTY: false, stdout(text) { output += text; }, async system(action, args) { calls.push(action); return { removed: args.flags.remove === true }; }, async invoke() { throw new Error("Must not connect"); } })).toBe(0);
    expect(calls).toEqual(["setup"]);
    expect(JSON.parse(output)).toEqual({ ok: true, data: { removed: true } });
  });

  test("registry is unique and help exposes arguments, flags, channel mappings and actions", () => {
    expect(new Set(commands.map(command => command.path.join(" "))).size).toBe(commands.length);
    const help = describeCommands();
    expect(help.commands.length).toBe(commands.length);
    for (const command of help.commands) {
      expect(command.flags.map(flag => flag.name)).toEqual(expect.arrayContaining(["json", "data-dir", "timeout"]));
      expect(command.channels.every(channel => channel in operationRegistry || channel in appControlRegistry || channel === IPC_CHANNELS.BACKEND_EVENT)).toBe(true);
      expect(Array.isArray(command.workflowActions)).toBe(true);
    }
    expect(help.exitCodes[3]).toContain("confirmation");
  });

  test("multiline stdin parses once and JSON source selection is exclusive", async () => {
    let reads = 0;
    const ctx = context({ async readStdin() { reads += 1; return '{\n"observations":"first\\nsecond"\n}'; } });
    const args = { positionals: [], flags: { stdin: true } };
    expect(await ctx.readJson(args)).toEqual({ observations: "first\nsecond" });
    expect(await ctx.readJson(args)).toEqual({ observations: "first\nsecond" });
    expect(reads).toBe(1);
    await expect(ctx.readJson({ positionals: [], flags: { stdin: true, file: "synthetic.json" } })).rejects.toThrow("exactly one");
  });

  test("device login returns a code without opening browser", async () => {
    const calls: string[] = [];
    const ctx = context({ async invoke(channel) { calls.push(channel); return { method: "device", providerId: "openai-subscription", loginId: "login-synthetic", verificationUrl: "https://example.com/device", userCode: "SYNTHETIC" }; }, async openExternal() { throw new Error("Must not open browser"); } });
    const command = commands.find(item => item.path.join(" ") === "login start")!;
    const result = await command.execute(ctx, { positionals: [], flags: {} });
    expect(result).toMatchObject({ userCode: "SYNTHETIC" });
    expect(calls).toEqual([IPC_CHANNELS.NATIVE_LOGIN_START]);
  });

  test("paid title previews without dispatch and --yes submits exact owner proposal", async () => {
    const payload = { threadId: "project-synthetic", context: "A synthetic brief", model: { providerId: "openai-subscription", modelId: "gpt-fixture" }, reasoningEffort: "high" };
    const proposal = OperationProposalSchema.parse({ operation: { channel: APP_CHANNELS.GENERATE_PROJECT_TITLE, payload }, previewHash: "owner-proof", expiresAt: new Date(Date.now() + 60_000).toISOString(), capabilityFingerprint: "capabilities", stateFingerprint: "saved-state", summary: "Generate title", billing: "billable" });
    const calls: { channel: string; payload: unknown }[] = [];
    const ctx = context({ async invoke(channel, body) { calls.push({ channel, payload: body }); return channel === APP_CHANNELS.PREVIEW_OPERATION ? proposal : { channel: APP_CHANNELS.GENERATE_PROJECT_TITLE, result: { threadId: "project-synthetic", title: "Invented title" } }; } });
    await expect(ctx.previewAndExecute(APP_CHANNELS.GENERATE_PROJECT_TITLE, payload, { positionals: [], flags: {} })).rejects.toMatchObject({ code: "NEEDS_CONFIRMATION", exitCode: 3, recovery: { preview: proposal } });
    expect(calls.map(call => call.channel)).toEqual([APP_CHANNELS.PREVIEW_OPERATION]);
    await ctx.previewAndExecute(APP_CHANNELS.GENERATE_PROJECT_TITLE, payload, { positionals: [], flags: { yes: true } });
    expect(calls[2]).toEqual({ channel: APP_CHANNELS.EXECUTE_OPERATION, payload: { proposal } });
  });

  test("boxed service errors preserve recovery/reference and unbox only known channels", async () => {
    const ctx = context({ async invoke() { return { ok: false, error: { code: "conflict", message: "Search key is environment-managed.", reference: "synthetic-ref", recovery: { next: "restart" } } }; } });
    await expect(ctx.invoke(IPC_CHANNELS.REMOVE_SEARCH_KEY, { provider: "exa" })).rejects.toMatchObject({ code: "conflict", reference: "synthetic-ref", recovery: { next: "restart" } });
    await expect(ctx.invoke(APP_CHANNELS.GET_PROVIDER_STATUS)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  test("project reads forward full ID, prefix and exact title without selecting the project", async () => {
    const project = projectFixture();
    const calls: { channel: string; payload: unknown }[] = [];
    const ctx = context({ async invoke(channel, payload) {
      calls.push({ channel, payload });
      if (channel !== APP_CHANNELS.GET_PROJECT) throw new Error("Read changed selection");
      return project;
    } });
    for (const selector of [project.thread.id, "project-synthetic-a", project.thread.title]) expect((await ctx.project(selector)).thread.id).toBe(project.thread.id);
    expect(calls).toEqual([project.thread.id, "project-synthetic-a", project.thread.title].map(threadId => ({ channel: APP_CHANNELS.GET_PROJECT, payload: { threadId } })));
    expect(project.workspace.activeThreadId).toBe("stable-default-project");
  });

  test("ambiguous references preserve candidate recovery and never guess or select", async () => {
    const candidates = [{ id: "project-alpha", title: "Invented duplicate" }, { id: "project-beta", title: "Invented duplicate" }];
    const calls: string[] = [];
    const ctx = context({ async invoke(channel) { calls.push(channel); throw new AppError("conflict", "Project reference is ambiguous.", 409, "synthetic-reference", { candidates }); } });
    await expect(ctx.project("Invented duplicate")).rejects.toMatchObject({ code: "conflict", recovery: { candidates }, reference: "synthetic-reference" });
    expect(calls).toEqual([APP_CHANNELS.GET_PROJECT]);
  });

  test("key stdin never reaches command output or accepts an argv key", async () => {
    const project = projectFixture();
    const calls: unknown[] = [];
    let output = "";
    const secret = "synthetic-key-stdin-only";
    const proposal = OperationProposalSchema.parse({ operation: { channel: IPC_CHANNELS.SAVE_SEARCH_KEY, payload: { provider: "exa", credentialRef: "11111111-1111-4111-8111-111111111111" } }, previewHash: "owner-proof", expiresAt: new Date(Date.now() + 60_000).toISOString(), capabilityFingerprint: "capabilities", stateFingerprint: "saved-state", summary: "Check the supplied key.", billing: "billable" });
    const result = await runCli(["key", "set", "exa", "--stdin", "--yes"], {
      isTTY: false, stdout(text) { output += text; }, async stdin() { return `${secret}\r\n`; },
      async invoke(channel, payload) { calls.push({ channel, payload }); return channel === APP_CHANNELS.PREVIEW_OPERATION ? proposal : { channel: IPC_CHANNELS.SAVE_SEARCH_KEY, result: project.workspace }; },
    });
    expect(result).toBe(0);
    expect(calls).toEqual([
      { channel: APP_CHANNELS.PREVIEW_OPERATION, payload: { channel: IPC_CHANNELS.SAVE_SEARCH_KEY, payload: { provider: "exa", apiKey: secret } } },
      { channel: APP_CHANNELS.EXECUTE_OPERATION, payload: { proposal } },
    ]);
    expect(JSON.parse(output)).toEqual({ ok: true, data: { provider: "exa", saved: true } });
    expect(output).not.toContain(secret);
    output = "";
    expect(await runCli(["key", "set", "exa", secret], { isTTY: false, stdout(text) { output += text; } })).toBe(2);
    expect(output).not.toContain(secret);
  });

  test("config assignments persist mode, models, targets and instructions without selecting", async () => {
    const project = projectFixture();
    const mutations: { channel: string; payload: unknown }[] = [];
    let output = "";
    const result = await runCli(["config", "set", "--project", project.thread.id, "mode=controlled", "depth=quick", "model=openai-subscription:unavailable-fixture", "effort=high", "ideas-model=openai-subscription:ideas-fixture", "ideas-effort=medium", "idea-count=1", "research-instructions=Keep\nnewlines", "searches=0"], {
      isTTY: false, stdout(text) { output += text; }, async invoke(channel, payload) {
        if (channel === APP_CHANNELS.GET_PROJECT) return project;
        mutations.push({ channel, payload });
        return channel === IPC_CHANNELS.SAVE_RUN_CONFIG ? project.workspace : z.object({ settings: z.unknown() }).parse(payload).settings;
      },
    });
    expect(result).toBe(0);
    expect(mutations).toEqual([
      { channel: IPC_CHANNELS.SAVE_RUN_CONFIG, payload: expect.objectContaining({ threadId: project.thread.id, config: expect.objectContaining({ discoveryDepth: "quick", model: { providerId: "openai-subscription", modelId: "unavailable-fixture" }, reasoningEffort: "high", ideaCount: 1 }) }) },
      { channel: APP_CHANNELS.SAVE_LAUNCH_SETTINGS, payload: expect.objectContaining({ threadId: project.thread.id, settings: expect.objectContaining({ mode: "babysit", ideas: expect.objectContaining({ model: { providerId: "openai-subscription", modelId: "ideas-fixture" }, reasoningEffort: "medium" }), targets: expect.objectContaining({ ideaCount: 1 }), limits: expect.objectContaining({ maxSearches: 0 }), instructions: expect.objectContaining({ research: "Keep\nnewlines" }) }) }) },
    ]);
    expect(JSON.parse(output)).toMatchObject({ ok: true });
  });

  test("watch timeout waits for its final NDJSON and never appends a response envelope", async () => {
    let output = "";
    const result = await runCli(["run", "watch", "--timeout", "20"], {
      isTTY: false, stdout(text) { output += text; }, stderr() {},
      commands: [{ path: ["run", "watch"], description: "Synthetic watch.", channels: [], async execute(ctx) {
        ctx.stream.start();
        try { await ctx.sleep(1_000); }
        finally { ctx.stream.write({ type: "watch-end", state: "running", outcome: null }); }
        return null;
      } }],
    });
    expect(result).toBe(5);
    expect(output.trim().split("\n").map(line => JSON.parse(line) as unknown)).toEqual([{ type: "watch-end", state: "running", outcome: null }]);
  });

  test("a real CLI waiting on unclosed stdin exits at its client deadline", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scraply-cli-stdin-"));
    const child = Bun.spawn([process.execPath, "--no-env-file", "run", "src/cli/main.ts", "key", "set", "exa", "--stdin", "--timeout", "30", "--data-dir", directory], {
      stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, EXA_API_KEY: "", PERPLEXITY_API_KEY: "", SCRAPLY_DEV_SHARED_CREDENTIALS: "0" },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const exited = await Promise.race([child.exited, new Promise<"still-running">((resolve) => { timer = setTimeout(() => resolve("still-running"), 2_000); })]);
      if (exited === "still-running") { child.kill(); await child.exited; }
      expect(exited).toBe(5);
      const output = await new Response(child.stdout).text();
      expect(JSON.parse(output)).toMatchObject({ ok: false, error: { code: "CLIENT_TIMEOUT" } });
    } finally {
      if (timer) clearTimeout(timer);
      child.stdin.end();
      if (child.exitCode === null) { child.kill(); await child.exited; }
      await rm(directory, { recursive: true, force: true });
    }
  });
});
