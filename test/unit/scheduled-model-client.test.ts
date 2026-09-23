import { expect, test } from "bun:test";
import { z } from "zod";
import { scheduledModelClient } from "../../src/core/scheduled-model-client";
import { WorkflowModelScheduler } from "../../src/core/workflow-scheduler";
import { ProviderFailure, type GenerationAttemptMetadata, type StructuredModelClient,
  type StructuredStageRequest } from "../../src/providers/structured";

const model = { providerId: "fixture", modelId: "fixture" };
const schema = z.object({ answer: z.string() });
type Answer = z.infer<typeof schema>;
const attempt = (kind: GenerationAttemptMetadata["attempt"]): GenerationAttemptMetadata => ({
  attempt: kind, outcome: "completed", providerCompletion: "confirmed", model,
  usage: { status: "known", value: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
  cost: { status: "reported", value: { amount: 0.01, currency: "USD" } },
  latencyMs: 3,
});
function request(stage: string, repairPolicy: "disabled" | "one_retry"): StructuredStageRequest<Answer> {
  return {
    generationId: `${stage}-generation`, stage, model, reasoningEffort: "low",
    workOrder: { stage, instruction: "Answer the question", goal: "Answer clearly",
      definitionOfDone: ["Return an answer"] },
    evidence: [], schema, jsonSchema: { type: "object" }, repairPolicy, deadlineMs: 30_000,
  };
}

test("two projects alternate at native attempts, including a schema retry", async () => {
  const scheduler = new WorkflowModelScheduler();
  const order: string[] = [];
  let active = 0;
  let peak = 0;
  const raw: StructuredModelClient = {
    async structuredCompletion<T>(input: StructuredStageRequest<T>) {
      active += 1;
      peak = Math.max(peak, active);
      const retry = input.workOrder.constraints?.some((item) => item.includes("prior response")) ?? false;
      order.push(`${input.stage}:${retry ? "repair" : "initial"}`);
      expect(input.repairPolicy).toBe("disabled");
      await Bun.sleep(2);
      active -= 1;
      if (input.stage === "project-a" && !retry) {
        throw new ProviderFailure("schema", "The first output did not match the schema", false,
          { attempts: [attempt("initial")] });
      }
      return {
        output: input.schema.parse({ answer: `${input.stage} answered` }),
        metadata: {
          model, usage: attempt("initial").usage, providerCosts: [{ amount: 0.01, currency: "USD" }],
          latencyMs: 3, repairCount: 0, providerRequestIds: [], attempts: [attempt("initial")],
        },
      };
    },
  };
  const a = scheduledModelClient(raw, scheduler, "project-a").structuredCompletion(request("project-a", "one_retry"));
  const b = scheduledModelClient(raw, scheduler, "project-b").structuredCompletion(request("project-b", "disabled"));
  const [aResult, bResult] = await Promise.all([a, b]);
  expect(order).toEqual(["project-a:initial", "project-b:initial", "project-a:repair"]);
  expect(peak).toBe(1);
  expect(aResult.output.answer).toBe("project-a answered");
  expect(bResult.output.answer).toBe("project-b answered");
  expect(aResult.metadata.repairCount).toBe(1);
  expect(aResult.metadata.attempts.map((item) => item.attempt)).toEqual(["initial", "schema_repair"]);
  expect(aResult.metadata.usage).toEqual({ status: "known", value: {
    inputTokens: 20, outputTokens: 10, totalTokens: 30,
  } });
  expect(aResult.metadata.providerCosts).toEqual([
    { amount: 0.01, currency: "USD" }, { amount: 0.01, currency: "USD" },
  ]);
});

test("a queued project deadline expires without dispatching a native attempt", async () => {
  const scheduler = new WorkflowModelScheduler();
  const seen: string[] = [];
  let releaseFirst: () => void = () => {};
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const raw: StructuredModelClient = {
    async structuredCompletion<T>(input: StructuredStageRequest<T>) {
      seen.push(input.stage);
      if (input.stage === "first") await firstGate;
      return { output: input.schema.parse({ answer: "ok" }), metadata: {
        model, usage: { status: "unknown" }, latencyMs: 1, repairCount: 0,
        providerRequestIds: [], attempts: [attempt("initial")],
      } };
    },
  };
  const first = scheduledModelClient(raw, scheduler, "first").structuredCompletion(request("first", "disabled"));
  const second = scheduledModelClient(raw, scheduler, "second").structuredCompletion({
    ...request("second", "disabled"), deadlineMs: 15,
  });
  await expect(second).rejects.toMatchObject({ code: "timeout" });
  releaseFirst();
  await first;
  expect(seen).toEqual(["first"]);
});
