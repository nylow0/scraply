import type { IntakeBrief, StoredClaim, StreamRun } from "../store/schema";

export interface SynthesisInput {
  brief: IntakeBrief;
  streamRuns: StreamRun[];
  claims: StoredClaim[];
}

export interface ResearchSynthesizer {
  readonly model: string;
  synthesize(input: SynthesisInput): Promise<string>;
}

/** Deterministic fallback intended only for explicitly mocked tests. */
export class DeterministicTestSynthesizer implements ResearchSynthesizer {
  readonly model = "deterministic-test-fallback";

  constructor(scope: "mocked-tests-only") {
    void scope;
  }

  async synthesize(input: SynthesisInput): Promise<string> {
    const completed = input.streamRuns.filter((run) => run.status === "completed").length;
    return [
      `Research completed for ${completed} of ${input.streamRuns.length} streams.`,
      `${input.claims.length} grounded claims were preserved.`,
      `Objective: ${input.brief.objective}`,
    ].join(" ");
  }
}

