import { describe, expect, test } from "bun:test";
import { RESEARCH_STREAMS } from "../../src/research/streams";
import {
  buildBriefFromAnswers,
  intakeAssistantMessage,
  newThreadTitle,
} from "../../src/core/intake";
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

describe("Intake brief assembly", () => {
  test("buildBriefFromAnswers maps answers into a validated brief", () => {
    const brief = buildBriefFromAnswers([
      { questionId: "goal", answer: "Find AI dev tools for solo founders.", skipped: false },
      { questionId: "theme", answer: "Developer productivity", skipped: false },
      { questionId: "good-idea", answer: "Buildable in a weekend", skipped: false },
      { questionId: "output", answer: "Top 5 ideas", skipped: false },
      { questionId: "success-decider", answer: "Founder", skipped: false },
      { questionId: "motivation", answer: "Ship faster", skipped: false },
      { questionId: "resources", answer: "TypeScript\nOpenAI API", skipped: false },
      { questionId: "avoid", answer: "crypto; ads", skipped: false },
      { questionId: "final-decision", answer: "Pick one MVP", skipped: false },
      { questionId: "deadline", answer: "Q3", skipped: false },
      { questionId: "style-balance", answer: "Balanced", skipped: false },
      { questionId: "examples", answer: "Cursor, Copilot", skipped: false },
      { questionId: "scoring-criteria", answer: "Feasibility first", skipped: false },
    ]);

    expect(brief.projectName).toBe("Find AI dev tools for solo founders");
    expect(brief.goal).toBe("Find AI dev tools for solo founders.");
    expect(brief.theme).toBe("Developer productivity");
    expect(brief.successDefinition).toBe("Buildable in a weekend");
    expect(brief.successDecider).toBe("Founder");
    expect(brief.resources).toEqual(["TypeScript", "OpenAI API"]);
    expect(brief.avoidList).toEqual(["crypto", "ads"]);
    expect(brief.examples).toBe("Cursor, Copilot");
    expect(brief.scoringCriteria).toBe("Feasibility first");
  });

  test("buildBriefFromAnswers ignores skipped answers and applies defaults", () => {
    const brief = buildBriefFromAnswers([
      { questionId: "goal", answer: "", skipped: true },
      { questionId: "theme", answer: "Widgets", skipped: false },
    ]);

    expect(brief.projectName).toBe("Untitled project");
    expect(brief.theme).toBe("Widgets");
    expect(brief.finalDecision).toBe("Choose the best next idea to pursue");
  });

  test("intakeAssistantMessage marks optional questions", () => {
    const requiredDone = new Set(REQUIRED_INTAKE_QUESTIONS.map((q) => q.id));
    expect(intakeAssistantMessage(requiredDone)).toContain("optional");
    expect(intakeAssistantMessage(new Set(ALL_INTAKE_QUESTIONS.map((q) => q.id)))).toBeNull();
  });

  test("newThreadTitle truncates long goals", () => {
    expect(newThreadTitle()).toBe("New research");
    expect(newThreadTitle("  Solo founder tools  ")).toBe("Solo founder tools");
    expect(newThreadTitle("x".repeat(80))).toHaveLength(60);
  });
});
