import { describe, expect, test } from "bun:test";
import { RESEARCH_STREAMS } from "../../src/research/streams";
import { nextIntakeQuestion } from "../../src/shared/intake";

describe("Research streams", () => {
  test("defines exactly six canonical streams", () => {
    expect(RESEARCH_STREAMS).toHaveLength(6);
    expect(RESEARCH_STREAMS.map((s) => s.id)).toEqual([
      "landscape", "exemplars", "pain-gaps", "resources", "analogies", "evaluation",
    ]);
  });
});

describe("Intake flow", () => {
  test("asks required questions before optional ones", () => {
    expect(nextIntakeQuestion(new Set())?.id).toBe("goal");
    const requiredDone = new Set(["goal", "theme", "good-idea", "output", "success-decider", "motivation", "deadline", "resources", "avoid", "final-decision"]);
    expect(nextIntakeQuestion(requiredDone)?.optional).toBe(true);
  });
});
