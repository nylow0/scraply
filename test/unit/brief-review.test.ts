import { describe, expect, test } from "bun:test";
import {
  cloneBriefForReview,
  prepareBriefForSubmission,
  validateBriefForReview,
} from "../../src/renderer/lib/brief-review";
import { makeProjectBrief } from "../helpers/project-brief";

describe("brief review validation", () => {
  test("requires an objective and a decision or explicit exploratory intent", () => {
    const brief = makeProjectBrief({ objective: " ", decisionToSupport: "" });

    expect(validateBriefForReview(brief)).toEqual({
      objective: "Add the objective this research should serve.",
      decisionToSupport: "Add the decision to support or state the exploratory intent.",
    });
  });

  test("requires notes only when the output type is other", () => {
    const other = makeProjectBrief({ desiredOutput: { type: "other", notes: "" } });
    const comparison = makeProjectBrief({ desiredOutput: { type: "comparison", notes: "" } });

    expect(validateBriefForReview(other).desiredOutput).toContain("Describe the desired output");
    expect(validateBriefForReview(comparison).desiredOutput).toBeUndefined();
  });

  test("keeps unknown optional fields and an empty display title non-blocking", () => {
    const brief = makeProjectBrief({
      title: "",
      successCriteria: [],
      hardConstraints: [],
      resources: [],
      deadline: null,
      evidenceRequirements: [],
    });

    expect(validateBriefForReview(brief)).toEqual({});
  });

  test("prepares a clean deep copy without mutating the persisted brief", () => {
    const brief = makeProjectBrief({
      objective: "  Compare support tools  ",
      hardConstraints: ["  EU hosting  ", " "],
      deadline: "  ",
      desiredOutput: { type: "comparison", notes: "  Explain tradeoffs  " },
    });

    const prepared = prepareBriefForSubmission(brief);

    expect(prepared.objective).toBe("Compare support tools");
    expect(prepared.hardConstraints).toEqual(["EU hosting"]);
    expect(prepared.deadline).toBeNull();
    expect(prepared.desiredOutput.notes).toBe("Explain tradeoffs");
    expect(brief.objective).toBe("  Compare support tools  ");
    expect(brief.hardConstraints).toEqual(["  EU hosting  ", " "]);
    expect(prepared).not.toBe(brief);
    expect(prepared.desiredOutput).not.toBe(brief.desiredOutput);
  });

  test("normalizes reactive proxies before deep cloning", () => {
    const brief = makeProjectBrief();
    const proxied = new Proxy(brief, {});

    expect(() => structuredClone(proxied)).toThrow();
    const cloned = cloneBriefForReview(proxied);
    expect(cloned).toEqual(brief);
    expect(cloned).not.toBe(brief);
    expect(cloned.desiredOutput).not.toBe(brief.desiredOutput);
  });
});
