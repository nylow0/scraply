import { describe, expect, test } from "bun:test";
import {
  classifySolutionSetReview,
  prepareSolutionSetReview,
  reviewSolutionSet,
  type SolutionSetItem,
} from "../../src/core/solution-set-review";
import type { StructuredModelClient } from "../../src/providers/structured";
import type { WorkflowV2SolutionOption } from "../../src/shared/structured-output-schemas";

function item(id: string, mechanism = id, changes: Partial<WorkflowV2SolutionOption> = {}): SolutionSetItem {
  return {
    id,
    option: {
      mechanism,
      description: `Apply ${mechanism} to the buyer workflow.`,
      keyAssumption: "The buyer can adopt this process.",
      whyCurrentApproachMaySuffice: "Existing process may already be adequate.",
      supportingEvidenceIds: ["source-1"],
      contraryEvidenceIds: [],
      unknowns: [],
      respectsOffLimits: true,
      respectsOffLimitsWhy: "No excluded actions are required.",
      ...changes,
    },
  };
}

function assessment(
  candidateId: string,
  decision: "distinct" | "duplicate" | "variant" | "insufficient-evidence" | "rejected",
  matchingSolutionId: string | null = null,
) {
  return { candidateId, decision, matchingSolutionId, reason: `${candidateId} uses a materially assessed approach.`, citedEvidenceIds: ["source-1"] };
}

describe("practical solution collection review", () => {
  test("sends all accepted roots and exact candidate IDs in a bounded reviewer request", () => {
    const candidates = [item("new-a"), item("new-b")];
    const existingSolutions = [item("root-a"), item("root-b")];
    const prepared = prepareSolutionSetReview({
      candidates, existingSolutions, problem: { id: "problem-1", statement: "Manual reconciliation" },
      projectConstraints: { offLimits: ["scraping"] }, savedInstructions: "Prefer local workflows.",
      evidence: [{ sourceId: "source-1", content: "Buyer interview" }],
      model: { providerId: "test", modelId: "reviewer" }, reasoningEffort: "medium",
    });
    expect(prepared.request.stage).toBe("solution-set-review");
    expect(prepared.request.repairPolicy).toBe("disabled");
    expect(prepared.request.workOrder.inputs).toMatchObject({
      candidateIds: ["new-a", "new-b"], existingSolutions, evidenceSourceIds: ["source-1"],
    });
    expect(prepared.request.workOrder.instruction).toContain("Prefer local workflows.");
    expect(prepared.request.evidence).toEqual([{ sourceId: "source-1", content: "Buyer interview" }]);
    expect(() => prepareSolutionSetReview({
      candidates: Array.from({ length: 6 }, (_, index) => item(`new-${index}`)), existingSolutions,
      problem: null, projectConstraints: null, savedInstructions: "", evidence: [],
      model: { providerId: "test", modelId: "reviewer" }, reasoningEffort: "medium",
    })).toThrow("1 to 5");
  });

  test("counts only accepted distinct mechanisms and resolves earlier-candidate matches to accepted roots", () => {
    const candidates = [item("new-a"), item("new-b"), item("new-c"), item("new-d"), item("new-e")];
    const result = classifySolutionSetReview(candidates, [item("root-a")], ["source-1"], {
      assessments: [
        assessment("new-a", "distinct"),
        assessment("new-b", "duplicate", "new-a"),
        assessment("new-c", "variant", "new-b"),
        assessment("new-d", "insufficient-evidence"),
        assessment("new-e", "rejected"),
      ],
    });
    expect(result.decisions.map((decision) => decision.status)).toEqual([
      "accepted", "duplicate", "variant", "unresolved", "rejected",
    ]);
    expect(result.decisions[2]?.matchingSolutionId).toBe("new-a");
    expect(result.decisions[2]?.reason).toContain("materially assessed");
    expect(result.addedDistinctCount).toBe(1);
    expect(result.acceptedDistinctCount).toBe(2);
    expect(result.coverageErrors).toEqual([]);
  });

  test("missing, repeated, and unknown candidate IDs cannot create a count", () => {
    const result = classifySolutionSetReview([item("a"), item("b")], [], ["source-1"], {
      assessments: [assessment("a", "distinct"), assessment("a", "distinct"), assessment("ghost", "distinct")],
    });
    expect(result.decisions.map((decision) => decision.status)).toEqual(["unresolved", "unresolved"]);
    expect(result.coverageErrors).toEqual([
      "Unknown candidate ID ghost", "Repeated assessment for a", "Missing assessment for b",
    ]);
    expect(result.acceptedDistinctCount).toBe(0);
  });

  test("unknown citations, impossible matches, and contradictory match fields stay unresolved", () => {
    const result = classifySolutionSetReview([item("a"), item("b"), item("c")], [item("root")], ["source-1"], {
      assessments: [
        { ...assessment("a", "distinct"), citedEvidenceIds: ["invented"] },
        assessment("b", "variant", "c"),
        assessment("c", "distinct", "root"),
      ],
    });
    expect(result.decisions.map((decision) => decision.status)).toEqual(["unresolved", "unresolved", "unresolved"]);
    expect(result.decisions[0]?.reason).toContain("not supplied");
    expect(result.coverageErrors).toHaveLength(3);
    expect(result.addedDistinctCount).toBe(0);
  });

  test("project limits and verbatim repeats override an optimistic distinct assessment", () => {
    const original = item("root", "Shared method");
    const copy = item("copy", "  shared  method  ", { description: "Apply shared method to the buyer workflow." });
    const offLimits = item("off-limits", "Forbidden method", {
      respectsOffLimits: false, respectsOffLimitsWhy: "Requires scraping a prohibited source.",
    });
    const result = classifySolutionSetReview([copy, offLimits], [original], ["source-1"], {
      assessments: [assessment("copy", "distinct"), assessment("off-limits", "distinct")],
    });
    expect(result.decisions.map((decision) => decision.status)).toEqual(["duplicate", "rejected"]);
    expect(result.decisions[0]?.matchingSolutionId).toBe("root");
    expect(result.decisions[1]?.reason).toContain("Requires scraping");
    expect(result.addedDistinctCount).toBe(0);
  });

  test("legacy saved solutions prevent repeats without inflating the credited existing count", () => {
    const result = classifySolutionSetReview([item("new")], [], ["source-1"], {
      assessments: [assessment("new", "duplicate", "legacy")],
    }, { otherExistingSolutions: [item("legacy")] });
    expect(result.decisions[0]).toMatchObject({ status: "duplicate", matchingSolutionId: "legacy" });
    expect(result.acceptedDistinctCount).toBe(0);
  });

  test("an omitted inventory root makes apparent distinctness unresolved while retaining prior credit", () => {
    const result = classifySolutionSetReview([item("new")], [item("included")], ["source-1"], {
      assessments: [assessment("new", "distinct")],
    }, { omittedSolutionIds: ["older-root"], acceptedInventoryCount: 2 });
    expect(result.decisions[0]?.status).toBe("unresolved");
    expect(result.decisions[0]?.reason).toContain("omitted from the bounded review context");
    expect(result.addedDistinctCount).toBe(0);
    expect(result.acceptedDistinctCount).toBe(2);
  });

  test("returns only after the caller's checkpoint callback has saved the classified review", async () => {
    const prepared = prepareSolutionSetReview({
      candidates: [item("new")], existingSolutions: [item("root")],
      problem: { id: "problem" }, projectConstraints: {}, savedInstructions: "",
      evidence: [{ sourceId: "source-1", content: "Observation" }],
      model: { providerId: "test", modelId: "reviewer" }, reasoningEffort: "medium",
    });
    const client: StructuredModelClient = {
      structuredCompletion: async (request) => ({
        output: request.schema.parse({ assessments: [assessment("new", "distinct")] }),
        metadata: {
          model: request.model,
          usage: { status: "unknown" },
          latencyMs: 1,
          repairCount: 0,
          providerRequestIds: [],
          attempts: [{
            attempt: "initial", outcome: "completed", providerCompletion: "confirmed",
            model: request.model, usage: { status: "unknown" }, cost: { status: "unknown" }, latencyMs: 1,
          }],
        },
      }),
    };
    let checkpointed = false;
    const result = await reviewSolutionSet(prepared, client, async (completed) => {
      expect(completed.decisions[0]).toMatchObject({ candidateId: "new", status: "accepted" });
      expect(completed.request.stage).toBe("solution-set-review");
      checkpointed = true;
    });
    expect(checkpointed).toBe(true);
    expect(result.acceptedDistinctCount).toBe(2);
  });
});
