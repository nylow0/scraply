import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { CliEnvelopeSchema, configureCliProject, createCliFixture } from "../../fixtures/cli-process";
import { GetProjectResultSchema } from "../../../src/shared/cli-contracts";
import { LaunchSettingsSchema } from "../../../src/shared/launch-settings";
import { RunConfigSchema } from "../../../src/shared/schemas";
import { IPC_CHANNELS, WorkspaceStateSchema } from "../../../src/shared/ipc";
import { buildWorkflowLaunchDraft, launchDraftEstimates } from "../../../src/shared/launch-draft";
import { PreviewWorkflowResultSchema, WorkflowLaunchContractSchema } from "../../../src/shared/workflow-contracts";

const fixtures: ReturnType<typeof createCliFixture>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });

async function configuredProject() {
  const fixture = createCliFixture();
  fixtures.push(fixture);
  await fixture.start();
  const thread = await configureCliProject(fixture, { title: "Invented warehouse approval queue" });
  return { fixture, thread };
}

test("run-config JSON updates survive another invocation and control the actual launch preview", async () => {
  const { fixture, thread } = await configuredProject();
  const previous = await fixture.json(["project", "show", "--project", thread.id], GetProjectResultSchema);
  const runConfig = RunConfigSchema.parse({ ...previous.workspace.runConfig, ideaCount: 4, maxRunMinutes: 17,
    discoveryDepth: "standard", researchMode: "known-problem", knownProblem: "Invented warehouse staff wait for approvals." });
  await fixture.json(["config", "set", "--project", thread.id, "--stdin"], z.unknown(), JSON.stringify({ runConfig }));
  const saved = await fixture.json(["project", "show", "--project", thread.id], GetProjectResultSchema);
  const preview = await fixture.json(["run", "preview", "--project", thread.id], PreviewWorkflowResultSchema);
  expect(preview.fieldErrors).toEqual([]);
  expect(saved.workspace.runConfig).toMatchObject({ ideaCount: 4, maxRunMinutes: 17 });
  expect(saved.launchSettings.targets?.ideaCount).toBe(4);
  expect(saved.launchSettings.ideas).toEqual(previous.launchSettings.ideas);
  const contract = WorkflowLaunchContractSchema.parse(preview.proposal);
  expect(contract.targets.ideaCount).toBe(4);
  expect(contract.limits).toMatchObject({ maxMinutes: 17, ...launchDraftEstimates("known-problem", "standard") });
  expect(fixture.dispatches()).toMatchObject({ models: [], searches: [] });
}, 30_000);

test.each(["vibe", "babysit"] as const)("app run-config saves update separate CLI previews and preserve explicit %s launch choices", async (mode) => {
  const fixture = createCliFixture({ mode: "workflow-checkpoint-recovery" });
  fixtures.push(fixture);
  await fixture.start();
  const thread = await configureCliProject(fixture, { title: "Invented supplier credit queue" });
  const previous = await fixture.json(["project", "show", "--project", thread.id], GetProjectResultSchema);
  const launchSettings = LaunchSettingsSchema.parse({ ...previous.launchSettings, mode, automaticProblemCap: 2,
    targets: { kind: "project", ideaCount: 1, distinctBusinessCount: 5, automaticProblemCap: 2 },
    limits: { enforced: false, maxMinutes: 10, maxModelCalls: 37, maxSearches: 12 },
    ideas: { model: { providerId: "openai-subscription", modelId: "gpt-fixture" }, reasoningEffort: "xhigh",
      reviewModel: { providerId: "openai-subscription", modelId: "gpt-fixture" }, reviewReasoningEffort: "medium" },
    instructions: { research: "Keep the saved quotes", ideas: "Prefer a small pilot", review: "Check the stated risks" },
  });
  if (!launchSettings.targets || !launchSettings.ideas) throw new Error("The regression requires explicit targets and ideas choices.");
  await fixture.json(["config", "set", "--project", thread.id, "--stdin"], z.unknown(), JSON.stringify({ launchSettings }));
  const beforeSave = await fixture.json(["project", "show", "--project", thread.id], GetProjectResultSchema);
  expect(beforeSave.launchSettings).toEqual(launchSettings);
  const config = RunConfigSchema.parse({ ...beforeSave.workspace.runConfig, ideaCount: 4, maxRunMinutes: 17 });

  // App uses this shared handler to save the form's RunConfig, without saving CLI launch settings.
  const appWorkspace = WorkspaceStateSchema.parse(await (await fixture.owner()).invoke(IPC_CHANNELS.SAVE_RUN_CONFIG, { threadId: thread.id, config }));
  expect(appWorkspace.runConfig).toEqual(config);
  const saved = await fixture.json(["project", "show", "--project", thread.id], GetProjectResultSchema);
  const preview = await fixture.json(["run", "preview", "--project", thread.id], PreviewWorkflowResultSchema);
  expect(saved.launchSettings).toEqual({ ...launchSettings,
    targets: { ...launchSettings.targets, ideaCount: 4 }, limits: { ...launchSettings.limits, maxMinutes: 17 },
  });
  expect(preview.fieldErrors).toEqual([]);
  const contract = WorkflowLaunchContractSchema.parse(preview.proposal);
  expect(contract.targets).toMatchObject({ kind: "project", ideaCount: 4, distinctBusinessCount: 5, automaticProblemCap: 2 });
  expect(contract.limits).toEqual({ ...launchSettings.limits, maxMinutes: 17 });
  if (!saved.workspace.scope) throw new Error("The project must retain its saved scope.");
  const guiDraft = buildWorkflowLaunchDraft(saved.workspace.scope, config, mode === "vibe"
    ? { mode, ideas: launchSettings.ideas, limits: launchSettings.limits, instructions: launchSettings.instructions }
    : { mode, limits: launchSettings.limits, instructions: launchSettings.instructions });
  expect(contract.targets.ideaCount).toBe(guiDraft.targets.ideaCount);
  expect(contract.limits.maxMinutes).toBe(guiDraft.limits.maxMinutes);
  expect(contract.mode).toBe(mode);
  expect(contract.instructions).toEqual(launchSettings.instructions);
  if (mode === "vibe") expect(contract.ideas).toEqual(launchSettings.ideas);
  await fixture.stop();
  await fixture.start();
  const reopened = await fixture.json(["project", "show", "--project", thread.id], GetProjectResultSchema);
  expect(reopened.launchSettings).toEqual(saved.launchSettings);
  expect(reopened.draft).toEqual(saved.draft);
  expect(fixture.admissions()).toEqual({ models: [], searches: [], providerProbes: [] });
}, 30_000);

test("contradictory JSON objects are rejected before saving either object", async () => {
  const { fixture, thread } = await configuredProject();
  const previous = await fixture.json(["project", "show", "--project", thread.id], GetProjectResultSchema);
  for (const change of [{ ideaCount: 4 }, { maxRunMinutes: 17 }]) {
    const runConfig = RunConfigSchema.parse({ ...previous.workspace.runConfig, ...change });
    const result = await fixture.run(["config", "set", "--project", thread.id, "--stdin"], JSON.stringify({ runConfig, launchSettings: previous.launchSettings }));
    expect(result.code).toBe(2);
    expect(CliEnvelopeSchema.parse(JSON.parse(result.stdout))).toMatchObject({ ok: false, error: { code: "USAGE", message: expect.stringContaining("Supply matching values") } });
  }
  const unchanged = await fixture.json(["project", "show", "--project", thread.id], GetProjectResultSchema);
  expect(unchanged.workspace.runConfig).toEqual(previous.workspace.runConfig);
  expect(unchanged.launchSettings).toEqual(previous.launchSettings);
  expect(fixture.dispatches()).toMatchObject({ models: [], searches: [] });
}, 30_000);

test("matching explicit JSON counts and duration preserve custom estimates and separate ideas/review choices", async () => {
  const { fixture, thread } = await configuredProject();
  const previous = await fixture.json(["project", "show", "--project", thread.id], GetProjectResultSchema);
  const runConfig = RunConfigSchema.parse({ ...previous.workspace.runConfig, ideaCount: 4, maxRunMinutes: 17, discoveryDepth: "standard" });
  const launchSettings = LaunchSettingsSchema.parse({ ...previous.launchSettings,
    targets: { kind: "per-problem", ideaCount: 4 }, limits: { ...previous.launchSettings.limits, maxMinutes: 17, maxModelCalls: 37, maxSearches: 12 },
    ideas: { model: { providerId: "openai-subscription", modelId: "saved-ideas-model" }, reasoningEffort: "high",
      reviewModel: { providerId: "openai-subscription", modelId: "saved-review-model" }, reviewReasoningEffort: "medium" },
  });
  await fixture.json(["config", "set", "--project", thread.id, "--stdin"], z.unknown(), JSON.stringify({ runConfig, launchSettings }));
  const saved = await fixture.json(["project", "show", "--project", thread.id], GetProjectResultSchema);
  expect(saved.launchSettings.limits).toEqual(launchSettings.limits);
  expect(saved.launchSettings.ideas).toEqual(launchSettings.ideas);
  await fixture.json(["config", "set", "--project", thread.id, "--stdin"], z.unknown(), JSON.stringify({ runConfig: { ...runConfig, ideaCount: 3 } }));
  const runOnly = await fixture.json(["project", "show", "--project", thread.id], GetProjectResultSchema);
  expect(runOnly.launchSettings.ideas).toEqual(launchSettings.ideas);
  const edited = LaunchSettingsSchema.parse({ ...saved.launchSettings, targets: { kind: "per-problem", ideaCount: 2 }, limits: { ...saved.launchSettings.limits, maxMinutes: 16 } });
  await fixture.json(["config", "set", "--project", thread.id, "--stdin"], z.unknown(), JSON.stringify({ launchSettings: edited }));
  const launchOnly = await fixture.json(["project", "show", "--project", thread.id], GetProjectResultSchema);
  expect(launchOnly.workspace.runConfig).toMatchObject({ ideaCount: 2, maxRunMinutes: 16 });
}, 30_000);

test("advertised project-target fields produce an error-free preview and reject an explicit conflicting purpose", async () => {
  const { fixture, thread } = await configuredProject();
  await fixture.json(["config", "set", "--project", thread.id, "target-kind=project", "distinct-business-count=5"], z.unknown());
  const saved = await fixture.json(["project", "show", "--project", thread.id], GetProjectResultSchema);
  const preview = await fixture.json(["run", "preview", "--project", thread.id], PreviewWorkflowResultSchema);
  expect(saved.workspace.runConfig?.explorationPurpose).toBe("startup-opportunities");
  expect(preview.fieldErrors).toEqual([]);
  expect(WorkflowLaunchContractSchema.parse(preview.proposal).targets).toMatchObject({ kind: "project", ideaCount: 1, distinctBusinessCount: 5 });
  const rejected = await fixture.run(["config", "set", "--project", thread.id, "target-kind=project", "distinct-business-count=5", "exploration-purpose=auto"]);
  expect(rejected.code).toBe(2);
  expect(CliEnvelopeSchema.parse(JSON.parse(rejected.stdout))).toMatchObject({ ok: false, error: { message: expect.stringContaining("Next command: scraply config set target-kind=project distinct-business-count=5 exploration-purpose=startup-opportunities") } });
  const unchanged = await fixture.json(["project", "show", "--project", thread.id], GetProjectResultSchema);
  expect(unchanged.workspace.runConfig).toEqual(saved.workspace.runConfig);
  expect(unchanged.launchSettings).toEqual(saved.launchSettings);
  expect(fixture.dispatches()).toMatchObject({ models: [], searches: [] });
}, 30_000);

test("supplied empty models, efforts, enums and numbers reject without saving run or launch choices", async () => {
  const { fixture, thread } = await configuredProject();
  const previous = await fixture.json(["project", "show", "--project", thread.id], GetProjectResultSchema);
  const emptyFields = ["model", "mode", "effort", "depth", "ideas-model", "ideas-effort", "review-model", "review-effort",
    "search-provider", "research-mode", "target-kind", "exploration-purpose", "searches"];
  for (const field of emptyFields) {
    const rejected = await fixture.run(["config", "set", "--project", thread.id, "minutes=17", `${field}=`]);
    expect(rejected.code).toBe(2);
    expect(CliEnvelopeSchema.parse(JSON.parse(rejected.stdout))).toMatchObject({ ok: false, error: { code: "USAGE" } });
    const unchanged = await fixture.json(["project", "show", "--project", thread.id], GetProjectResultSchema);
    expect(unchanged.workspace.runConfig).toEqual(previous.workspace.runConfig);
    expect(unchanged.launchSettings).toEqual(previous.launchSettings);
  }
  expect(fixture.dispatches()).toMatchObject({ models: [], searches: [] });
}, 30_000);

test("intentional empty known-problem and instruction assignments persist as text clears", async () => {
  const { fixture, thread } = await configuredProject();
  await fixture.json(["config", "set", "--project", thread.id, "known-problem=Invented approval delays",
    "research-instructions=Keep saved quotes", "ideas-instructions=Use the saved context", "review-instructions=Check the declared risks"], z.unknown());
  const previous = await fixture.json(["project", "show", "--project", thread.id], GetProjectResultSchema);
  await fixture.json(["config", "set", "--project", thread.id, "known-problem=", "research-instructions=", "ideas-instructions=", "review-instructions="], z.unknown());
  const cleared = await fixture.json(["project", "show", "--project", thread.id], GetProjectResultSchema);
  if (!previous.workspace.runConfig) throw new Error("The configured project must have saved run choices.");
  expect(cleared.workspace.runConfig).toEqual({ ...previous.workspace.runConfig, knownProblem: "" });
  expect(cleared.launchSettings).toEqual({ ...previous.launchSettings, instructions: { research: "", ideas: "", review: "" } });
  expect(fixture.dispatches()).toMatchObject({ models: [], searches: [] });
}, 30_000);
