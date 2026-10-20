import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { APP_CHANNELS, OperationProposalSchema, ProjectDetailSchema } from "../../../src/shared/cli-contracts";
import { IPC_CHANNELS, ResearchEventSchema, SolutionViewSchema } from "../../../src/shared/ipc";
import { RunTraceSchema } from "../../../src/shared/run-trace";
import { PreviewWorkflowResultSchema, WorkflowAdmissionReceiptSchema, WorkflowDetailSchema } from "../../../src/shared/workflow-contracts";
import { CliEnvelopeSchema, configureCliProject, createCliFixture, waitForCli } from "../../fixtures/cli-process";

const fixtures: ReturnType<typeof createCliFixture>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });
const WatchEndSchema = z.object({ type: z.literal("watch-end"), state: z.string(), outcome: z.string().nullable() }).strict();

function watchResult(stdout: string) {
  const values: unknown[] = stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  const end = WatchEndSchema.parse(values.at(-1));
  for (const value of values.slice(0, -1)) ResearchEventSchema.parse(value);
  expect(values.filter(value => WatchEndSchema.safeParse(value).success)).toHaveLength(1);
  return { end, events: values.slice(0, -1) };
}

async function fixture(options: Parameters<typeof createCliFixture>[0] = {}) {
  const item = createCliFixture(options);
  fixtures.push(item);
  await item.start();
  return item;
}

async function detail(item: ReturnType<typeof createCliFixture>, sessionId: string) {
  const owner = await item.owner();
  const boxed = z.object({ ok: z.literal(true), data: WorkflowDetailSchema }).parse(await owner.invoke(IPC_CHANNELS.GET_WORKFLOW, { sessionId }));
  return boxed.data;
}

async function requireTargetMet(item: ReturnType<typeof createCliFixture>, sessionId: string, stdout: string) {
  const result = watchResult(stdout);
  if (result.end.outcome !== "target-met") {
    const saved = await detail(item, sessionId);
    throw new Error(`Unexpected workflow outcome: ${JSON.stringify({ end: result.end, summary: saved.summary, tasks: saved.tasks })}`);
  }
  return result;
}

describe("standalone CLI workflows through the real service and backend", () => {
  test("creates a Vibe discovery, previews without dispatch, watches reviewed ideas, and parses both export formats", async () => {
    const item = await fixture();
    const thread = await configureCliProject(item, { title: "Clockwork parts desk" });
    const preview = await item.json(["run", "preview", "--project", thread.id], PreviewWorkflowResultSchema);
    expect(preview.fieldErrors).toEqual([]);
    expect(item.admissions()).toEqual({ models: [], searches: [], providerProbes: [] });

    const refused = await item.run(["run", "start", "--project", thread.id]);
    expect(refused.code).toBe(3);
    const envelope = CliEnvelopeSchema.parse(JSON.parse(refused.stdout));
    if (envelope.ok) throw new Error("Starting without --yes unexpectedly succeeded.");
    expect(envelope.error.code).toBe("NEEDS_CONFIRMATION");
    const recovery = z.object({ preview: OperationProposalSchema }).parse(envelope.error.recovery);
    expect(recovery.preview.operation.channel).toBe(IPC_CHANNELS.START_WORKFLOW);
    expect(item.admissions()).toEqual({ models: [], searches: [], providerProbes: [] });

    const receipt = await item.json(["run", "start", "--project", thread.id, "--yes"], WorkflowAdmissionReceiptSchema);
    const watched = await item.run(["run", "watch", receipt.sessionId, "--timeout", "20000"]);
    expect(watched.code).toBe(0);
    expect((await requireTargetMet(item, receipt.sessionId, watched.stdout)).end.state).toBe("finished");
    const { ideas } = await item.json(["idea", "list", "--project", thread.id], z.object({ ideas: z.array(SolutionViewSchema) }));
    expect(ideas).toHaveLength(1);
    expect((await item.json(["run", "show", receipt.sessionId], WorkflowDetailSchema)).summary.counts.accepted).toBe(1);
    expect(item.admissions().models.length).toBeGreaterThan(0);
    expect(item.admissions().searches.length).toBeGreaterThan(0);
    expect(item.admissions().providerProbes).toEqual([]);

    const jsonDirectory = join(item.profileDir, "json-export");
    const mdDirectory = join(item.profileDir, "md-export");
    await item.json(["export", "ideas", "--project", thread.id, "--format", "json", "--out", jsonDirectory], z.unknown());
    await item.json(["export", "ideas", "--project", thread.id, "--format", "md", "--out", mdDirectory], z.unknown());
    const jsonFiles = readdirSync(jsonDirectory).filter(file => file.endsWith(".json"));
    const mdFiles = readdirSync(mdDirectory).filter(file => file.endsWith(".md"));
    expect(jsonFiles.length).toBeGreaterThan(0);
    expect(mdFiles).toHaveLength(jsonFiles.length);
    const exported = jsonFiles.map(file => JSON.parse(readFileSync(join(jsonDirectory, file), "utf8")) as unknown);
    const markdown = mdFiles.map(file => readFileSync(join(mdDirectory, file), "utf8")).join("\n");
    expect(JSON.stringify(exported)).toContain(ideas[0]!.description);
    expect(markdown).toContain(ideas[0]!.description);
    expect(markdown).toMatch(/^#/m);
    const researchPath = join(item.profileDir, "research.json");
    await item.json(["export", "research", "--project", thread.id, "--out", researchPath], z.unknown());
    const research: unknown = JSON.parse(readFileSync(researchPath, "utf8"));
    expect(JSON.stringify(research)).toContain("Parts delivery windows are uncertain.");

    const traces = await item.json(["run", "trace", receipt.sessionId], z.object({ traces: z.array(RunTraceSchema) }));
    const attempts = traces.traces.flatMap(trace => trace.steps.flatMap(step => step.attempts));
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts.every(attempt => attempt.inputTokens === null && attempt.outputTokens === null && attempt.costUsd === null)).toBe(true);
    const beforeReads = item.admissions();
    const owner = await item.owner();
    const project = ProjectDetailSchema.parse(await owner.invoke(APP_CHANNELS.GET_PROJECT, { threadId: thread.id }));
    expect(project.workspace.latestResearchRun?.usage?.unknownAttemptCount).toBeGreaterThan(0);
    expect(item.admissions()).toEqual(beforeReads);
  }, 60_000);

  test("Controlled requires frame approval, stops for research review, then generates only selected problems", async () => {
    const item = await fixture();
    const thread = await configureCliProject(item, { title: "Lantern repair review", mode: "controlled" });
    // Exercise the desktop's admission path with choices changed only in its preview,
    // then confirm both clients and a restarted owner restore the admitted settings.
    const preview = await item.json(["run", "preview", "--project", thread.id], PreviewWorkflowResultSchema);
    const owner = await item.owner();
    const savedProject = ProjectDetailSchema.parse(await owner.invoke(APP_CHANNELS.GET_PROJECT, { threadId: thread.id }));
    const desktopDraft = { ...savedProject.draft!,
      instructions: { research: "Check the synthetic supplier desk.", ideas: "Prefer a small pilot.", review: "Check firsthand evidence." } };
    const desktopPreview = z.object({ ok: z.literal(true), data: PreviewWorkflowResultSchema }).parse(await owner.invoke(IPC_CHANNELS.PREVIEW_WORKFLOW, { type: "launch", threadId: thread.id, draft: desktopDraft })).data;
    expect(preview.fieldErrors).toEqual([]);
    expect(desktopPreview.fieldErrors).toEqual([]);
    const proposal = OperationProposalSchema.parse(await owner.invoke(APP_CHANNELS.PREVIEW_OPERATION, {
      channel: IPC_CHANNELS.START_WORKFLOW, payload: { threadId: thread.id, clientCommandId: "synthetic-desktop-launch",
        contract: desktopPreview.proposal, previewHash: desktopPreview.previewHash,
        capabilityFingerprint: desktopPreview.capabilityFingerprint, previewExpiresAt: desktopPreview.expiresAt },
    }));
    const executed = z.object({ result: WorkflowAdmissionReceiptSchema }).parse(await owner.invoke(APP_CHANNELS.EXECUTE_OPERATION, { proposal }));
    const receipt = executed.result;
    const framed = await item.run(["run", "watch", receipt.sessionId]);
    expect(framed.code).toBe(0);
    expect(watchResult(framed.stdout).end.state).toBe("waiting-for-review");
    const frame = await item.json(["run", "show", receipt.sessionId], WorkflowDetailSchema);
    expect(frame.summary).toMatchObject({ mode: "babysit", reviewKind: "frame" });
    expect(frame.tasks.some(task => task.kind === "discovery")).toBe(false);
    const dispatchesBefore = item.admissions();
    const refused = await item.run(["run", "frame", "approve", receipt.sessionId]);
    expect(refused.code).toBe(3);
    expect(item.admissions()).toEqual(dispatchesBefore);
    const approvedFrame = { ...frame.researchFrame!.draft,
      openQuestions: frame.researchFrame!.draft.openQuestions.map(question => ({ ...question, answer: "One supplier" })) };
    await item.json(["run", "frame", "approve", receipt.sessionId, "--stdin", "--yes"], WorkflowAdmissionReceiptSchema, JSON.stringify(approvedFrame));
    const reviewed = await item.run(["run", "watch", receipt.sessionId]);
    expect(reviewed.code).toBe(0);
    expect(watchResult(reviewed.stdout).end.state).toBe("waiting-for-review");
    const research = await item.json(["run", "show", receipt.sessionId], WorkflowDetailSchema);
    expect(research.summary.reviewKind).toBe("research");
    const problems = await item.json(["problem", "list", "--project", thread.id], z.object({ problems: z.array(z.object({ id: z.string() })) }));
    expect(problems.problems).toHaveLength(1);
    const beforeSelection = item.admissions();
    const refusedSelection = await item.run(["problem", "select", problems.problems[0]!.id, "--project", thread.id]);
    expect(refusedSelection.code).toBe(3);
    expect(item.admissions()).toEqual(beforeSelection);
    await item.json(["problem", "select", problems.problems[0]!.id, "--project", thread.id, "--yes"], WorkflowAdmissionReceiptSchema);
    const generated = await item.run(["run", "watch", receipt.sessionId]);
    expect(generated.code).toBe(0);
    await requireTargetMet(item, receipt.sessionId, generated.stdout);
    const final = await item.json(["run", "show", receipt.sessionId], WorkflowDetailSchema);
    expect(final.summary.selectedProblemIds).toHaveLength(1);
    const selectedIdeas = await item.json(["idea", "list", "--project", thread.id], z.object({ ideas: z.array(SolutionViewSchema) }));
    expect(selectedIdeas.ideas.every(idea => final.summary.selectedProblemIds.includes(idea.problemId))).toBe(true);
    expect(final.summary.counts.accepted).toBe(1);
    await item.stop();
    await item.start();
    const reopened = await item.json(["project", "show", thread.id], ProjectDetailSchema);
    expect(reopened.workspace.launchSettings).toMatchObject({ mode: "babysit", instructions: desktopDraft.instructions });
    expect(reopened.workspace.launchSettings?.ideas).toEqual(savedProject.launchSettings.ideas);
    expect(reopened.draft?.instructions).toEqual(desktopDraft.instructions);
  }, 60_000);

  test("known-problem runs need no search and an explicit saved proposal survives separate CLI invocations", async () => {
    const item = await fixture({ search: "none" });
    const thread = await configureCliProject(item, { title: "Cobalt arrival pilot", knownProblem: true });
    const missing = await item.run(["run", "start", "--project", thread.id, "--client-command-id", "synthetic-known-launch"]);
    expect(missing.code).toBe(3);
    const response = CliEnvelopeSchema.parse(JSON.parse(missing.stdout));
    if (response.ok) throw new Error("Expected confirmation.");
    const { preview } = z.object({ preview: OperationProposalSchema }).parse(response.error.recovery);
    const proofFile = join(item.profileDir, "proposal.json");
    writeFileSync(proofFile, JSON.stringify(preview));
    expect(item.admissions()).toEqual({ models: [], searches: [], providerProbes: [] });
    const receipt = await item.json(["run", "start", "--project", thread.id, "--client-command-id", "synthetic-known-launch", "--preview-file", proofFile, "--yes"], WorkflowAdmissionReceiptSchema);
    const watched = await item.run(["run", "watch", receipt.sessionId]);
    expect(watched.code).toBe(0);
    await requireTargetMet(item, receipt.sessionId, watched.stdout);
    expect(item.admissions().searches).toEqual([]);
    expect(item.admissions().providerProbes).toEqual([]);
    expect(item.admissions().models.length).toBeGreaterThan(0);
  }, 45_000);

  test("a timed-out watcher detaches and another process watches the same work finish without replay", async () => {
    const item = await fixture({ search: "none", gateIdeas: true });
    const thread = await configureCliProject(item, { title: "Juniper dispatch window", knownProblem: true });
    const receipt = await item.json(["run", "start", "--project", thread.id, "--yes"], WorkflowAdmissionReceiptSchema);
    await waitForCli(async () => existsSync(join(item.dataDir, "release-ideas.waiting")), Boolean);
    const detached = await item.run(["run", "watch", receipt.sessionId, "--timeout", "5000"]);
    expect(detached.code).toBe(5);
    expect(watchResult(detached.stdout).end.state).toBe("running");
    expect((await detail(item, receipt.sessionId)).summary.state).toBe("running");
    writeFileSync(join(item.dataDir, "release-ideas"), "continue");
    const reattached = await item.run(["run", "watch", receipt.sessionId, "--timeout", "15000"]);
    expect(reattached.code).toBe(0);
    await requireTargetMet(item, receipt.sessionId, reattached.stdout);
    const requests = item.admissions().models.map(line => z.object({ payload: z.object({ generationId: z.string() }) }).parse(JSON.parse(line)).payload.generationId);
    expect(new Set(requests).size).toBe(requests.length);
  }, 45_000);

  test("an abruptly killed real host restarts into interrupted review and never replays admitted work on reads", async () => {
    const item = await fixture({ search: "none", mode: "workflow-cancel" });
    const thread = await configureCliProject(item, { title: "Copper delivery recovery", knownProblem: true });
    const receipt = await item.json(["run", "start", "--project", thread.id, "--yes"], WorkflowAdmissionReceiptSchema);
    await waitForCli(async () => item.admissions().models,
      lines => lines.some(line => z.object({ payload: z.object({ workOrder: z.object({ stage: z.string() }) }) }).parse(JSON.parse(line)).payload.workOrder.stage === "solutions"));
    const admitted = item.admissions();
    await item.crash();
    await item.start({ mode: "workflow" });
    const recovered = await item.json(["run", "show", receipt.sessionId], WorkflowDetailSchema);
    expect(["waiting-for-review", "paused", "finished"]).toContain(recovered.summary.state);
    expect(recovered.tasks.some(task => task.state === "unknown" || task.state === "failed")).toBe(true);
    // Four independent reads over at least 600ms cover startup recovery and queued
    // coordinator work. Each must preserve admission counts and the interrupted task.
    for (let sample = 0; sample < 4; sample += 1) {
      await new Promise(resolve => setTimeout(resolve, 150));
      const saved = await item.json(["project", "show", thread.id], ProjectDetailSchema);
      expect(saved.workspace.activeWorkflow?.sessionId).toBe(receipt.sessionId);
      expect(item.admissions()).toEqual(admitted);
    }
  }, 45_000);
});
