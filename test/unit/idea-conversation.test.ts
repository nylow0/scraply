import { describe, expect, test } from "bun:test";
import {
  generateIdeaFollowUp,
  prepareIdeaFollowUp,
  validateIdeaFollowUp,
  type IdeaFollowUpInput,
} from "../../src/core/idea-conversation";
import { ProviderFailure, type StructuredModelClient } from "../../src/providers/structured";

const model = { providerId: "test", modelId: "idea-model" };

function input(overrides: Partial<IdeaFollowUpInput> = {}): IdeaFollowUpInput {
  return {
    rootSolutionId: "root-1",
    baseSolutionId: "version-1",
    evidenceSnapshotId: "snapshot-1",
    intent: "explain",
    userText: "Why could this work?",
    idea: { mechanism: "Review before release", description: "Check changed dependencies." },
    problem: { statement: "Upgrades reach production without review." },
    savedInstructions: "Respect the current review workflow.",
    evidence: [{ sourceId: "source-1", content: { quote: "Release review catches issues." } }],
    history: [],
    model,
    reasoningEffort: "medium",
    allowance: { maxModelCalls: 1, maxMinutes: 2 },
    ...overrides,
  };
}

function reply(overrides: Record<string, unknown> = {}) {
  return {
    reply: "The saved source describes release review. Adoption remains uncertain.",
    citedEvidenceIds: ["source-1"],
    assumptions: ["The team reviews upgrades weekly."],
    changeSummary: null,
    candidate: null,
    ...overrides,
  };
}

const revisedCandidate = {
  mechanism: "Review changes inside the weekly release checklist",
  description: "The existing review owner sees dependency changes before approving release.",
  keyAssumption: "The owner can see a useful summary in time.",
  whyCurrentApproachMaySuffice: "The current checklist might already include this review.",
  supportingEvidenceIds: ["source-1"],
  contraryEvidenceIds: [],
  unknowns: ["Whether the owner has time for the extra review"],
  respectsOffLimits: true,
  respectsOffLimitsWhy: "The review uses the existing process.",
};

function client(output: unknown): StructuredModelClient {
  return {
    async structuredCompletion<T>() {
      return {
        output: output as T,
        metadata: {
          model,
          usage: { status: "unknown" },
          latencyMs: 1,
          repairCount: 0,
          providerRequestIds: ["request-1"],
          attempts: [{
            attempt: "initial",
            outcome: "completed",
            providerCompletion: "confirmed",
            model,
            usage: { status: "unknown" },
            cost: { status: "not_reported" },
            latencyMs: 1,
          }],
        },
      };
    },
  };
}

describe("idea follow-up", () => {
  test("freezes bounded context and never includes uncited omitted evidence", () => {
    const prepared = prepareIdeaFollowUp(input({
      evidence: Array.from({ length: 15 }, (_, index) => ({ sourceId: `source-${index}`, content: "x".repeat(5_000) })),
      history: Array.from({ length: 20 }, (_, index) => ({ id: `turn-${index}`, userText: "y".repeat(900), assistantText: "z".repeat(900) })),
      allowance: { maxModelCalls: 2, maxMinutes: 2 },
    }));
    const inputs = prepared.request.workOrder.inputs as { evidenceSourceIds: string[]; context: { omittedEvidenceCount: number; omittedTurnCount: number } };
    expect(prepared.request.evidence.length).toBeLessThanOrEqual(12);
    expect(prepared.request.evidence.map((item) => item.sourceId)).toEqual(inputs.evidenceSourceIds);
    expect(inputs.context.omittedEvidenceCount).toBeGreaterThan(0);
    expect(inputs.context.omittedTurnCount).toBeGreaterThan(0);
    expect(prepared.request.repairPolicy).toBe("one_retry");
    expect(prepared.request.deadlineMs).toBe(120_000);
    expect(JSON.parse(JSON.stringify(prepared.effectiveContext)).model).toEqual(model);
    expect(prepared.effectiveContext.evidence).toEqual(prepared.request.evidence);
  });

  test("requires explicit intent for a version and checks every cited source", () => {
    expect(() => validateIdeaFollowUp("explain", reply({ candidate: { mechanism: "new" } }), ["source-1"]))
      .toThrow();
    expect(() => validateIdeaFollowUp("explain", reply({ citedEvidenceIds: ["invented"] }), ["source-1"]))
      .toThrow("unknown evidence");
    expect(() => validateIdeaFollowUp("explain", reply({ citedEvidenceIds: [] }), ["source-1"]))
      .toThrow("must cite");
    expect(() => validateIdeaFollowUp("rethink", reply({ changeSummary: "Narrowed buyer" }), ["source-1"]))
      .toThrow("cannot claim a version change");
    expect(validateIdeaFollowUp("rethink", reply({ candidate: revisedCandidate, changeSummary: "Uses the existing release checklist" }), ["source-1"]).candidate?.mechanism)
      .toBe(revisedCandidate.mechanism);
    expect(() => validateIdeaFollowUp("rethink", reply({ candidate: { ...revisedCandidate, respectsOffLimits: false }, changeSummary: "Conflicts with constraints" }), ["source-1"]))
      .toThrow("off-limits");
  });

  test("saves the validated reply before returning it to the caller", async () => {
    const prepared = prepareIdeaFollowUp(input());
    const steps: string[] = [];
    const result = await generateIdeaFollowUp(prepared, client(reply()), async () => { steps.push("saved"); });
    steps.push("returned");
    expect(steps).toEqual(["saved", "returned"]);
    expect(result.output.citedEvidenceIds).toEqual(["source-1"]);
  });

  test("retains paid attempt metadata when a completed response fails semantic validation", async () => {
    const prepared = prepareIdeaFollowUp(input());
    let saved = false;
    try {
      await generateIdeaFollowUp(prepared, client(reply({ citedEvidenceIds: ["invented"] })), () => { saved = true; });
      throw new Error("Expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderFailure);
      expect((error as ProviderFailure).attempts).toHaveLength(1);
      expect(saved).toBe(false);
    }
  });
});
