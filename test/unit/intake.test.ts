import { describe, expect, test } from "bun:test";
import { RESEARCH_STREAMS } from "../../src/research/streams";
import {
  ALL_INTAKE_QUESTIONS,
  OPTIONAL_INTAKE_QUESTIONS,
  REQUIRED_INTAKE_QUESTIONS,
  intakeProgress,
  nextIntakeQuestion,
} from "../../src/shared/intake";

describe("Research streams", () => {
  test("defines exactly six canonical streams", () => {
    expect(RESEARCH_STREAMS).toHaveLength(6);
    expect(RESEARCH_STREAMS.map((s) => s.id)).toEqual([
      "landscape", "exemplars", "pain-gaps", "resources", "analogies", "evaluation",
    ]);
  });
});

describe("Intake flow", () => {
  test("defines fifteen intake questions", () => {
    expect(REQUIRED_INTAKE_QUESTIONS).toHaveLength(10);
    expect(OPTIONAL_INTAKE_QUESTIONS).toHaveLength(5);
    expect(ALL_INTAKE_QUESTIONS).toHaveLength(15);
  });

  test("asks required questions before optional ones", () => {
    expect(nextIntakeQuestion(new Set())?.id).toBe("goal");
    const requiredDone = new Set(REQUIRED_INTAKE_QUESTIONS.map((q) => q.id));
    expect(nextIntakeQuestion(requiredDone)?.optional).toBe(true);
    expect(nextIntakeQuestion(requiredDone)?.id).toBe("style-balance");
    const allDone = new Set(ALL_INTAKE_QUESTIONS.map((q) => q.id));
    expect(nextIntakeQuestion(allDone)).toBeNull();
  });

  test("tracks intake progress", () => {
    expect(intakeProgress(new Set(["goal", "theme"]))).toEqual({
      answered: 2,
      required: 2,
      total: 15,
    });
  });
});
