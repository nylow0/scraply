import type { ResolvedWorkflowV2Prompt } from "../core/prompts";
import type { GenerationMetadata, StructuredStageRequest } from "../providers/structured";
import type { DatabaseClient } from "./client";
import { WorkflowV2Repository } from "./repositories/workflow-v2";

/** Import the pre-migration-20 checkpoints without dispatching or rewriting their requests. */
export function migrateRiskEvaluationSnapshots(client: DatabaseClient): void {
  const rows = client.db.prepare(`
    SELECT review.research_run_id, review.snapshot_key, review.value_json, context.value_json AS context_json
    FROM workflow_snapshots review
    LEFT JOIN workflow_snapshots context ON context.research_run_id = review.research_run_id
      AND context.snapshot_key = 'development-context'
    WHERE review.snapshot_key LIKE 'risk-evaluation:%'
  `).all() as Array<{ research_run_id: string; snapshot_key: string; value_json: string; context_json: string | null }>;
  const repository = new WorkflowV2Repository(client);
  for (const row of rows) {
    if (!row.context_json) throw new Error("Saved risk evaluation is missing its development context");
    const saved = JSON.parse(row.value_json) as {
      evaluation: unknown;
      request: Pick<StructuredStageRequest<unknown>, "model" | "reasoningEffort" | "workOrder" | "evidence" | "jsonSchema" | "deadlineMs" | "repairPolicy">;
      prompt: ResolvedWorkflowV2Prompt;
      metadata: GenerationMetadata;
    };
    if (!saved.metadata.prompt) throw new Error("Saved risk evaluation is missing its runtime prompt identity");
    repository.saveStageResult({
      researchRunId: row.research_run_id,
      stageId: "risk-evaluation",
      selectionId: row.snapshot_key.slice("risk-evaluation:".length),
      context: JSON.parse(row.context_json),
      output: saved.evaluation,
      prompt: saved.prompt,
      schema: saved.request.jsonSchema,
      inputs: saved.request.workOrder.inputs,
      evidence: saved.request.evidence.map(({ sourceId, content }) => ({ sourceId, content })),
      runtimePrompt: saved.metadata.prompt,
      effectiveRequest: saved.request,
    });
  }
}
