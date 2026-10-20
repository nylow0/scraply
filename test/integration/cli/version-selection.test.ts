import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { DatabaseClient } from "../../../src/db/client";
import { WorkflowRepository } from "../../../src/db/repositories/workflows";
import { SolutionViewSchema } from "../../../src/shared/ipc";
import { IdeaConversationSchema, WorkflowAdmissionReceiptSchema, WorkflowDetailSchema } from "../../../src/shared/workflow-contracts";
import { configureCliProject, createCliFixture } from "../../fixtures/cli-process";

const fixtures: ReturnType<typeof createCliFixture>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); }, 15_000);

test("idea version select works through the CLI with and without a workflow run", async () => {
  const item = createCliFixture();
  fixtures.push(item);
  await item.start();
  const project = await configureCliProject(item, { title: "Cedar parts desk" });
  const started = await item.json(["run", "start", "--project", project.id, "--yes"], WorkflowAdmissionReceiptSchema);
  expect((await item.run(["run", "watch", started.sessionId, "--timeout", "20000"])).code).toBe(0);
  const saved = await item.json(["run", "show", started.sessionId], WorkflowDetailSchema);
  expect(saved.summary.outcome).toBe("target-met");
  const { ideas } = await item.json(["idea", "list", "--project", project.id], z.object({ ideas: z.array(SolutionViewSchema) }));
  expect(ideas).toHaveLength(1);
  const ideaId = ideas[0]!.id;
  // The deterministic worker does not generate rethink replies. Seed the saved
  // original-version metadata while the fixture owner is closed.
  await item.stop();
  const db = new DatabaseClient(item.dbPath);
  try {
    db.immediateTransaction(() => {
      const workflows = new WorkflowRepository(db);
      workflows.createSolutionLineage({ solutionId: ideaId, rootSolutionId: ideaId, changeSummary: "Original idea" });
      workflows.setSelectedVersion(ideaId, ideaId);
    });
  } finally { db.close(); }
  await item.start();
  const admissions = item.admissions();
  const standalone = await item.json(["idea", "version", "select", ideaId, ideaId, "--project", project.id], IdeaConversationSchema);
  expect(standalone.selectedVersionId).toBe(ideaId);
  const args = ["idea", "version", "select", ideaId, ideaId, "--project", project.id, "--run", started.sessionId,
    "--revision", String(saved.summary.revision), "--client-command-id", "select-saved-version"];
  const selected = await item.json(args, WorkflowAdmissionReceiptSchema);
  expect(selected.revision).toBe(saved.summary.revision + 1);
  expect((await item.json(args, WorkflowAdmissionReceiptSchema)).revision).toBe(selected.revision);
  await item.stop();
  await item.start();
  const restored = await item.json(["run", "show", started.sessionId], WorkflowDetailSchema);
  expect(restored.summary).toMatchObject({ revision: selected.revision, state: saved.summary.state,
    outcome: saved.summary.outcome, startedAt: saved.summary.startedAt, finishedAt: saved.summary.finishedAt });
  expect((await item.json(args, WorkflowAdmissionReceiptSchema)).revision).toBe(selected.revision);
  expect((await item.json(["idea", "conversation", ideaId, "--project", project.id], IdeaConversationSchema)).selectedVersionId).toBe(ideaId);
  expect(item.admissions()).toEqual(admissions);
  expect(item.backendErrors()).toBe("");
}, 30_000);
