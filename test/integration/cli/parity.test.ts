import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { commands, describeCommands } from "../../../src/cli/registry";
import { APP_CHANNELS, ExecuteOperationResultSchema, OperationProposalSchema, ProjectDetailSchema, SearchKeyCredentialReferenceSchema, isBillableOperation, operationRegistry } from "../../../src/shared/cli-contracts";
import { IPC_CHANNELS, SolutionViewSchema, ValidationStateSchema, WorkspaceStateSchema } from "../../../src/shared/ipc";
import { OpportunityMembershipCommandSchema } from "../../../src/shared/opportunity-review";
import { IdeaTurnIntentSchema, WorkflowActionSchema, WorkflowAdmissionReceiptSchema, WorkflowDetailSchema } from "../../../src/shared/workflow-contracts";
import { DatabaseClient } from "../../../src/db/client";
import { OpportunityExplorationRepository } from "../../../src/db/repositories/opportunity-exploration";
import { DEFAULT_OPPORTUNITY_EXPLORATION_CONFIG } from "../../../src/shared/opportunity-exploration";
import { CliEnvelopeSchema, configureCliProject, createCliFixture, waitForCli, type CliProcessResult } from "../../fixtures/cli-process";

const fixtures: ReturnType<typeof createCliFixture>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); }, 15_000);

// Desktop menu actions are local window adapters. Backend events are consumed
// by run watch's SSE adapter and are never invokable application requests.
const adapterOnlyChannels = new Set<string>([IPC_CHANNELS.APP_COMMAND, IPC_CHANNELS.BACKEND_EVENT]);

function privateKeyPreview(result: CliProcessResult, provider: "exa" | "perplexity", key: string) {
  expect(result.code).toBe(3);
  expect(result.stdout + result.stderr).not.toContain(key);
  const envelope = CliEnvelopeSchema.parse(JSON.parse(result.stdout));
  if (envelope.ok) throw new Error("Unapproved key save succeeded.");
  expect(envelope.error.code).toBe("NEEDS_CONFIRMATION");
  const { preview } = z.object({ preview: OperationProposalSchema }).parse(envelope.error.recovery);
  expect(preview.operation.channel).toBe(IPC_CHANNELS.SAVE_SEARCH_KEY);
  const reference = SearchKeyCredentialReferenceSchema.parse(preview.operation.payload);
  expect(reference.provider).toBe(provider);
  expect(Object.keys(reference).sort()).toEqual(["credentialRef", "provider"]);
  expect(JSON.stringify(preview)).not.toContain(key);
  return preview;
}

function providerProbes(item: ReturnType<typeof createCliFixture>) {
  return item.admissions().providerProbes.map(line => z.object({ provider: z.enum(["exa", "perplexity"]), query: z.string() }).strict().parse(JSON.parse(line)));
}

describe("standalone CLI public command and billing parity", () => {
  test("help comes from the actual registry and covers every IPC, workflow action, family operation, and idea intent", async () => {
    const item = createCliFixture();
    fixtures.push(item);
    const help = await item.json(["help"], z.unknown());
    expect(help).toEqual(describeCommands());
    expect(existsSync(join(item.profileDir, "owner.json"))).toBe(false);
    const mapped = new Set(commands.flatMap(command => [...command.channels]));
    expect(Object.values(IPC_CHANNELS).filter(channel => !adapterOnlyChannels.has(channel) && !mapped.has(channel))).toEqual([]);
    for (const command of commands) {
      expect(["free", "paid", "conditional"]).toContain(command.billing ?? "free");
      for (const channel of command.channels) {
        if (!adapterOnlyChannels.has(channel) && !Object.values(APP_CHANNELS).includes(channel as typeof APP_CHANNELS[keyof typeof APP_CHANNELS])) {
          expect(operationRegistry[channel]).toBeDefined();
        }
      }
    }
    const actions = WorkflowActionSchema.innerType().options.map(option => option.shape.type.value).sort();
    expect([...new Set(commands.flatMap(command => [...(command.workflowActions ?? [])]))].sort()).toEqual(actions);
    const membership = commands.find(command => command.path.join(" ") === "family edit");
    expect([...(membership?.variants ?? [])].sort()).toEqual(OpportunityMembershipCommandSchema.options.map(option => option.shape.operation.value).sort());
    const ask = commands.find(command => command.path.join(" ") === "idea ask");
    expect([...(ask?.flags?.find(flag => flag.name === "intent")?.choices ?? [])].sort()).toEqual([...IdeaTurnIntentSchema.options].sort());
    expect(commands.find(command => command.path.join(" ") === "status")?.channels).toContain(APP_CHANNELS.GET_PROVIDER_STATUS);
    for (const channel of [IPC_CHANNELS.GET_VALIDATION, IPC_CHANNELS.RETRY_CONNECTION]) expect(isBillableOperation(channel, {})).toBe(true);
    expect(isBillableOperation(IPC_CHANNELS.SAVE_SEARCH_KEY, { provider: "exa", apiKey: "synthetic-inventory-key" })).toBe(true);
    expect(isBillableOperation(APP_CHANNELS.GET_PROVIDER_STATUS, {})).toBe(false);
  }, 15_000);

  test("every billing command returns a real owner proposal without --yes and admits no work", async () => {
    const item = createCliFixture();
    fixtures.push(item);
    await item.start();
    const thread = await configureCliProject(item, { title: "Maple consent desk", mode: "controlled" });
    const covered = new Set<string>();
    async function noSpend(args: string[], target = item, input?: string) {
      const before = target.admissions();
      const result = await target.run(args, input);
      if (result.code !== 3) throw new Error(`Expected exit 3 for ${args.join(" ")}: ${result.code} ${result.stdout} ${result.stderr}`);
      const envelope = CliEnvelopeSchema.parse(JSON.parse(result.stdout));
      if (envelope.ok) throw new Error("Unapproved paid command succeeded.");
      expect(envelope.error.code).toBe("NEEDS_CONFIRMATION");
      const { preview } = z.object({ preview: OperationProposalSchema }).parse(envelope.error.recovery);
      expect(preview.billing).toBe("billable");
      expect(target.admissions()).toEqual(before);
      const command = [...commands].sort((left, right) => right.path.length - left.path.length)
        .find(candidate => candidate.path.every((part, index) => args[index] === part));
      if (!command) throw new Error("Paid command missing from registry.");
      covered.add(command.path.join(" "));
    }
    await noSpend(["run", "start", "--project", thread.id]);
    await noSpend(["run", "start", "--project", thread.id, "--legacy"]);
    await noSpend(["project", "title", "--project", thread.id, "--generate"]);
    await noSpend(["doctor", "--validate"]);
    await noSpend(["doctor", "--retry"]);
    for (const provider of ["exa", "perplexity"]) await noSpend(["key", "set", provider, "--stdin"], item, `synthetic-preview-${provider}-key\n`);
    const receipt = await item.json(["run", "start", "--project", thread.id, "--yes"], WorkflowAdmissionReceiptSchema);
    expect((await item.run(["run", "watch", receipt.sessionId])).code).toBe(0);
    await noSpend(["run", "frame", "approve", receipt.sessionId]);
    await noSpend(["run", "frame", "regenerate", receipt.sessionId]);
    await noSpend(["run", "extend", receipt.sessionId, "--calls", "1", "--searches", "1"]);
    await noSpend(["run", "resume", receipt.sessionId]);
    await item.json(["run", "frame", "approve", receipt.sessionId, "--yes"], WorkflowAdmissionReceiptSchema);
    expect((await item.run(["run", "watch", receipt.sessionId])).code).toBe(0);
    const project = await item.json(["project", "show", thread.id], ProjectDetailSchema);
    const research = await item.json(["run", "show", receipt.sessionId], WorkflowDetailSchema);
    const problem = project.workspace.problemCandidates[0];
    if (!problem) throw new Error("Synthetic research produced no selectable problem.");
    await noSpend(["problem", "select", problem.id, "--project", thread.id]);
    await noSpend(["problem", "select", problem.id, "--project", thread.id, "--legacy"]);
    await noSpend(["evidence", "follow-up", "Which dispatch records describe the arrival window?", "--project", thread.id]);
    const finding = project.workspace.researchFindings[0];
    if (!finding) throw new Error("Synthetic research produced no saved finding for evidence commands.");
    await noSpend(["evidence", "redo", "Recheck this synthetic finding.", "--project", thread.id, "--finding", finding.id]);
    await noSpend(["evidence", "reassess", "Reassess these saved synthetic observations.", "--project", thread.id, "--finding", finding.id]);
    const task = research.tasks.find(task => task.kind === "discovery" || task.kind === "investigate-area");
    if (!task) throw new Error("Synthetic research produced no research task.");
    await noSpend(["problem", "reassess", "--project", thread.id, "--task", task.id]);
    await item.json(["problem", "select", problem.id, "--project", thread.id, "--yes"], WorkflowAdmissionReceiptSchema);
    expect((await item.run(["run", "watch", receipt.sessionId])).code).toBe(0);
    const ideas = await item.json(["idea", "list", "--project", thread.id], z.object({ ideas: z.array(SolutionViewSchema) }));
    const idea = ideas.ideas[0];
    if (!idea) throw new Error("Synthetic workflow produced no idea for paid command checks.");
    await noSpend(["idea", "select", idea.id, "--project", thread.id]);
    for (const intent of IdeaTurnIntentSchema.options) await noSpend(["idea", "ask", idea.id, "Explain the saved pilot assumption.", "--intent", intent, "--project", thread.id]);
    await noSpend(["family", "review", "--project", thread.id]);
    await noSpend(["family", "explore", "start", "--project", thread.id]);
    await noSpend(["family", "explore", "resume", "--project", thread.id]);
    await noSpend(["experiment", "request", idea.id, "--project", thread.id]);

    // Seed a saved paused exploration and a retained unassessed candidate while
    // the owner is fully stopped. These are valid saved states, not handler mocks.
    await item.stop();
    const db = new DatabaseClient(item.dbPath);
    try {
      db.immediateTransaction(() => new OpportunityExplorationRepository(db).create(thread.id, DEFAULT_OPPORTUNITY_EXPLORATION_CONFIG));
      db.db.prepare("UPDATE opportunity_explorations SET status = 'paused' WHERE thread_id = ?").run(thread.id);
      const snapshot = z.object({ materialization_run_id: z.string() }).parse(db.db.prepare("SELECT materialization_run_id FROM evidence_snapshots WHERE id = ?").get(research.summary.activeSnapshotId));
      const candidate = { statement: "A synthetic dispatch handoff remains unassessed.", whyItPersists: "Separate delivery records.", affected: "Repair shops", scaleEstimate: "Unknown",
        scaleBasisFactorId: null, factorIds: [], alternativeExplanations: ["One supplier may explain this."], unknowns: ["Frequency"], intendedBuyerEvidenceFactorIds: [], evidenceGap: "Needs another independent observation." };
      db.db.prepare("INSERT INTO rejected_problem_candidates (id,discovery_run_id,statement,reason,disposition,candidate_json,created_at) VALUES ('synthetic-unassessed',?,?,?,'not-assessed',?,?)")
        .run(snapshot.materialization_run_id, candidate.statement, "Saved before the old review limit.", JSON.stringify(candidate), new Date().toISOString());
    } finally { db.close(); }
    await item.start();
    await noSpend(["family", "extend", "apply", "--project", thread.id, "--calls", "1"]);
    await noSpend(["problem", "assess", "synthetic-unassessed", "--project", thread.id, "--run", receipt.sessionId]);

    const interrupted = createCliFixture({ search: "none", mode: "workflow-cancel" });
    fixtures.push(interrupted);
    await interrupted.start();
    const failedThread = await configureCliProject(interrupted, { title: "Aspen retry consent", knownProblem: true });
    const failedReceipt = await interrupted.json(["run", "start", "--project", failedThread.id, "--yes"], WorkflowAdmissionReceiptSchema);
    await waitForCli(async () => interrupted.admissions().models, lines => lines.some(line => line.includes('"stage":"solutions"')));
    await interrupted.crash();
    await interrupted.start({ mode: "workflow-many" });
    const failed = await interrupted.json(["run", "show", failedReceipt.sessionId], WorkflowDetailSchema);
    const terminal = failed.tasks.find(task => task.terminalAttemptId);
    if (!terminal?.terminalAttemptId) throw new Error("Interrupted task has no saved terminal attempt.");
    await noSpend(["run", "retry", failedReceipt.sessionId, "--task", terminal.id, "--terminal-attempt", terminal.terminalAttemptId], interrupted);
    expect([...covered].sort()).toEqual(commands.filter(command => command.billing === "paid" || command.billing === "conditional").map(command => command.path.join(" ")).sort());
  }, 90_000);

  test("offline account and stdin key commands keep complete credentials out of stdout across restart", async () => {
    const item = createCliFixture();
    fixtures.push(item);
    await item.start();
    const keys = { perplexity: "synthetic-private-perplexity-key-7294", exa: "synthetic-private-exa-key-5863" };
    expect(item.admissions()).toEqual({ models: [], searches: [], providerProbes: [] });
    for (const provider of ["perplexity", "exa"] as const) {
      const key = keys[provider];
      const before = item.admissions();
      const encryptedBefore = readFileSync(join(item.profileDir, "secrets.bin"));
      privateKeyPreview(await item.run(["key", "set", provider, "--stdin"], `${key}\n`), provider, key);
      expect(readFileSync(join(item.profileDir, "secrets.bin")).equals(encryptedBefore)).toBe(true);
      expect(item.admissions()).toEqual(before);
      const set = await item.run(["key", "set", provider, "--stdin", "--yes"], `${key}\n`);
      if (set.code !== 0) throw new Error(`Synthetic key update failed: ${set.stdout} ${set.stderr}`);
      expect(CliEnvelopeSchema.parse(JSON.parse(set.stdout))).toEqual({ ok: true, data: { provider, saved: true } });
      for (const secret of [...Object.values(keys), "synthetic-cli-account"]) expect(set.stdout + set.stderr).not.toContain(secret);
      expect(item.admissions().providerProbes.slice(before.providerProbes.length).map(line => JSON.parse(line) as unknown))
        .toEqual([{ provider, query: "test connectivity" }]);
    }
    await item.stop();
    await item.start();
    const status = await item.json(["status"], z.object({ validation: ValidationStateSchema }));
    for (const provider of ["exa", "perplexity"] as const) {
      expect(status.validation[provider].valid).toBe(false);
      expect(status.validation[provider].maskedKey).toBeDefined();
      expect(status.validation[provider].maskedKey).not.toBe(keys[provider]);
    }
    const afterApprovedChecks = item.admissions();
    for (const args of [["account", "refresh"], ["key", "remove", "exa"], ["key", "remove", "perplexity"]]) {
      const result = await item.run(args);
      if (result.code !== 0) throw new Error(`Synthetic ${args.join(" ")} failed: ${result.stdout} ${result.stderr} ${item.backendErrors()}`);
      for (const secret of [...Object.values(keys), "connected-credential", "synthetic-cli-account"]) expect(result.stdout + result.stderr).not.toContain(secret);
      expect(item.admissions()).toEqual(afterApprovedChecks);
    }
    const launch = await item.json(["login", "start"], z.object({ method: z.literal("device"), loginId: z.string(), verificationUrl: z.string().url(), userCode: z.string() }));
    expect(launch.verificationUrl).toBe("https://example.test/device");
    await item.json(["login", "cancel", launch.loginId], z.unknown());
    const loggedOut = await item.run(["logout"]);
    expect(loggedOut.code).toBe(0);
    expect(loggedOut.stdout).not.toContain("connected-credential");
    const encrypted = readFileSync(join(item.profileDir, "secrets.bin"));
    for (const key of Object.values(keys)) expect(encrypted.includes(Buffer.from(key))).toBe(false);
    expect(item.admissions()).toEqual(afterApprovedChecks);
    expect(item.admissions().models).toEqual([]);
    expect(item.admissions().searches).toEqual([]);
    expect(providerProbes(item)).toEqual([{ provider: "perplexity", query: "test connectivity" }, { provider: "exa", query: "test connectivity" }]);
  }, 30_000);

  test("startup, status, plain doctor, project reads and previews never probe providers; approved doctor variants each probe once", async () => {
    const item = createCliFixture();
    fixtures.push(item);
    await item.start();
    expect(item.admissions()).toEqual({ models: [], searches: [], providerProbes: [] });
    const thread = await configureCliProject(item, { title: "Willow passive desk" });
    for (let sample = 0; sample < 2; sample += 1) {
      for (const args of [["status"], ["doctor"], ["project", "list"], ["project", "show", thread.id], ["run", "preview", "--project", thread.id]]) {
        await item.json(args, z.unknown());
        expect(item.admissions()).toEqual({ models: [], searches: [], providerProbes: [] });
      }
    }
    const owner = await item.owner();
    const passive = ValidationStateSchema.parse(await owner.invoke(APP_CHANNELS.GET_PROVIDER_STATUS));
    expect(passive.exa.maskedKey).toBeDefined();
    expect(passive.exa.valid).toBe(false);
    for (const [channel, payload] of [[IPC_CHANNELS.GET_VALIDATION, {}], [IPC_CHANNELS.RETRY_CONNECTION, {}],
      [IPC_CHANNELS.SAVE_SEARCH_KEY, { provider: "exa", apiKey: "synthetic-direct-blocked-key" }]] as const) {
      await expect(owner.invoke(channel, payload)).rejects.toMatchObject({ code: "conflict" });
    }
    expect(item.admissions()).toEqual({ models: [], searches: [], providerProbes: [] });
    const conflicting = await item.run(["doctor", "--validate", "--retry", "--yes"]);
    expect(conflicting.code).toBe(2);
    expect(item.admissions()).toEqual({ models: [], searches: [], providerProbes: [] });
    for (const flag of ["--validate", "--retry"]) {
      const before = item.admissions();
      const preview = await item.run(["doctor", flag]);
      expect(preview.code).toBe(3);
      expect(item.admissions()).toEqual(before);
      await item.json(["doctor", flag, "--yes"], z.object({ validation: ValidationStateSchema }));
      expect(item.admissions().providerProbes.slice(before.providerProbes.length).map(line => JSON.parse(line) as unknown))
        .toEqual([{ provider: "exa", query: "test connectivity" }]);
      const admitted = item.admissions();
      await item.json(["status"], z.unknown());
      await item.json(["doctor"], z.unknown());
      expect(item.admissions()).toEqual(admitted);
    }
    expect(item.admissions().models).toEqual([]);
    expect(item.admissions().searches).toEqual([]);
  }, 45_000);

  test("saved key proofs stay opaque, immutable and single-use, and cannot outlive their owner's candidates", async () => {
    const item = createCliFixture({ search: "none" });
    fixtures.push(item);
    await item.start();
    let owner = await item.owner();
    await waitForCli(async () => ValidationStateSchema.parse(await owner.invoke(APP_CHANNELS.GET_PROVIDER_STATUS)), status => status.native.connected);
    const firstKey = "fake-key-cccc";
    const key = "fake-key-aaaa";
    const encryptedBefore = readFileSync(join(item.profileDir, "secrets.bin"));
    const first = privateKeyPreview(await item.run(["key", "set", "exa", "--stdin"], firstKey), "exa", firstKey);
    const proposal = privateKeyPreview(await item.run(["key", "set", "exa", "--stdin"], key), "exa", key);
    const original = JSON.stringify(proposal);
    const proofFile = join(item.profileDir, "opaque-key-proof.json");
    writeFileSync(proofFile, original);
    for (const secret of [firstKey, key]) expect(readFileSync(proofFile, "utf8")).not.toContain(secret);
    expect(readFileSync(join(item.profileDir, "secrets.bin")).equals(encryptedBefore)).toBe(true);
    await expect(owner.invoke(APP_CHANNELS.EXECUTE_OPERATION, { proposal: first })).rejects.toMatchObject({ code: "PREVIEW_STALE" });
    const rejectedFile = await item.run(["key", "set", "exa", "--stdin", "--preview-file", proofFile, "--yes"], firstKey);
    expect(rejectedFile.code).toBe(2);
    expect(rejectedFile.stdout).toContain("key set exa --stdin");
    for (const secret of [firstKey, key]) expect(rejectedFile.stdout + rejectedFile.stderr).not.toContain(secret);
    const altered = { ...proposal, summary: `${proposal.summary} altered` };
    await expect(owner.invoke(APP_CHANNELS.EXECUTE_OPERATION, { proposal: altered })).rejects.toMatchObject({ code: "PREVIEW_STALE" });
    expect(item.admissions()).toEqual({ models: [], searches: [], providerProbes: [] });
    // Generic execution receives exactly the saved proposal, without another key.
    const executed = ExecuteOperationResultSchema.parse(await owner.invoke(APP_CHANNELS.EXECUTE_OPERATION, { proposal: JSON.parse(readFileSync(proofFile, "utf8")) as unknown }));
    expect(executed.channel).toBe(IPC_CHANNELS.SAVE_SEARCH_KEY);
    expect(WorkspaceStateSchema.parse(executed.result).validation.exa.maskedKey).toBeDefined();
    expect(JSON.stringify(executed)).not.toContain(key);
    expect(JSON.stringify(proposal)).toBe(original);
    expect(readFileSync(proofFile, "utf8")).toBe(original);
    expect(providerProbes(item)).toEqual([{ provider: "exa", query: "test connectivity" }]);
    await expect(owner.invoke(APP_CHANNELS.EXECUTE_OPERATION, { proposal })).rejects.toMatchObject({ code: "PREVIEW_STALE" });
    expect(providerProbes(item)).toHaveLength(1);

    const invalidKey = "synthetic-invalid-aaaaaaaaaaaa";
    const invalid = privateKeyPreview(await item.run(["key", "set", "exa", "--stdin"], invalidKey), "exa", invalidKey);
    let failure: unknown;
    try { await owner.invoke(APP_CHANNELS.EXECUTE_OPERATION, { proposal: invalid }); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "validation_error" });
    expect(String(failure)).not.toContain(invalidKey);
    expect(JSON.stringify(failure)).not.toContain(invalidKey);
    expect(providerProbes(item)).toHaveLength(2);
    await expect(owner.invoke(APP_CHANNELS.EXECUTE_OPERATION, { proposal: invalid })).rejects.toMatchObject({ code: "PREVIEW_STALE" });
    expect(providerProbes(item)).toHaveLength(2);

    const pendingKey = "fake-key-bbbb";
    const pending = privateKeyPreview(await item.run(["key", "set", "perplexity", "--stdin"], pendingKey), "perplexity", pendingKey);
    const beforeRestart = item.admissions();
    await item.stop();
    await item.start();
    owner = await item.owner();
    await expect(owner.invoke(APP_CHANNELS.EXECUTE_OPERATION, { proposal: pending })).rejects.toMatchObject({ code: "PREVIEW_STALE" });
    expect(item.admissions()).toEqual(beforeRestart);
    const encrypted = readFileSync(join(item.profileDir, "secrets.bin"));
    for (const secret of [firstKey, key, invalidKey, pendingKey]) expect(encrypted.includes(Buffer.from(secret))).toBe(false);
    expect(item.admissions().models).toEqual([]);
    expect(item.admissions().searches).toEqual([]);
  }, 45_000);
});
