import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzeSelectedOption,
  produceDevelopmentOptions,
  type DevelopedWorkflowV2SolutionOption,
  type WorkflowV2DevelopmentDependencies,
} from "../../src/core/development";
import { harvestEvidenceFollowUp } from "../../src/core/discovery";
import {
  configurePromptPaths,
  PromptPackagingError,
  resolveWorkflowV2Prompt,
  type ResolvedWorkflowV2Prompt,
} from "../../src/core/prompts";
import {
  WORKFLOW_V2_STAGE_IDS,
  WORKFLOW_V2_STAGE_REGISTRY,
  WORKFLOW_VERSION_V2,
} from "../../src/core/stages";
import { ProviderFailure, type StructuredModelClient, type StructuredStageRequest } from "../../src/providers/structured";
import { deriveJsonSchema } from "../../src/shared/json-schema";
import { WorkflowV2SolutionOptionSchema } from "../../src/shared/structured-output-schemas";

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe("workflow v2 foundation", () => {
  test("registers exactly seven typed stages independent of config version", () => {
    expect(Object.keys(WORKFLOW_V2_STAGE_REGISTRY).sort()).toEqual([...WORKFLOW_V2_STAGE_IDS].sort());
    expect(WORKFLOW_V2_STAGE_IDS).toHaveLength(7);
    expect(WORKFLOW_VERSION_V2).toBe(2);
    expect(WORKFLOW_V2_STAGE_REGISTRY.solutions.schema).toBeDefined();
    expect(WORKFLOW_V2_STAGE_REGISTRY["factor-harvest"].deadlineMs).toBe(300_000);
    expect(WORKFLOW_V2_STAGE_REGISTRY["problem-candidates"].deadlineMs).toBe(120_000);
    expect(WORKFLOW_V2_STAGE_REGISTRY["factor-harvest"].deadlineMs).toBe(300_000);
    expect(WORKFLOW_V2_STAGE_REGISTRY["problem-candidates"].deadlineMs).toBe(120_000);
    for (const stage of Object.values(WORKFLOW_V2_STAGE_REGISTRY)) {
      expect(() => deriveJsonSchema(stage.schema)).not.toThrow();
    }
    expect(() => WorkflowV2SolutionOptionSchema.parse(option({ mechanism: " " }))).toThrow();
  });

  test("requires a bundled prompt and preserves exact override bytes without auto-copying", () => {
    const root = mkdtempSync(join(tmpdir(), "scraply-v2-prompts-"));
    directories.push(root);
    const bundledDir = join(root, "bundled");
    const overrideDir = join(root, "overrides");
    mkdirSync(bundledDir);
    mkdirSync(overrideDir);
    const filename = "workflow-v2-solutions.md";
    writeFileSync(join(bundledDir, filename), "Bundled prompt.\n", "utf8");
    writeFileSync(join(overrideDir, filename), "  Exact custom prompt.\r\n", "utf8");

    configurePromptPaths({ bundledDir, overrideDir });
    const resolved = resolveWorkflowV2Prompt("solutions");

    expect(resolved.text).toBe("  Exact custom prompt.\r\n");
    expect(resolved.source).toBe("override");
    expect(resolved.overrideBaseline).toBeNull();
    expect(() => resolveWorkflowV2Prompt("decision-analysis")).toThrow(PromptPackagingError);
  });

  test("produces unranked options from bounded labeled evidence and exposes the request before generation", async () => {
    let prepared: { request: unknown; prompt: ResolvedWorkflowV2Prompt } | undefined;
    const current = { ...context(), recordedExperiments: { results: [{ mechanism: "Manual export", userDecision: "Try another approach", observedResult: "Five exports omitted required fields." }], omittedCount: 0 } };
    const result = await produceDevelopmentOptions(current, dependencies({
      options: [option()],
    }, (request, prompt) => {
      prepared = { request, prompt };
    }));

    expect(result.options).toHaveLength(1);
    expect(result.options[0]).not.toHaveProperty("score");
    expect(prepared?.prompt.text).toBe("  exact prompt bytes\r\n");
    const request = prepared?.request as {
      workOrder: { instruction: string; inputs: Record<string, unknown> };
      evidence: Array<{ sourceId: string; content: unknown }>;
    };
    expect(request.workOrder.instruction).toBe("exact prompt bytes");
    expect(request.workOrder.inputs).toEqual({ workflowVersion: 2, problemId: "problem-1", ideaCount: 3, evidenceSourceIds: ["support-1", "contrary-1"] });
    expect(JSON.stringify(request.workOrder.inputs)).not.toContain("failed spreadsheet");
    expect(request.evidence[0]?.content).toMatchObject({ recordedExperiments: current.recordedExperiments });
    expect(request.evidence.map((item) => item.sourceId)).toEqual([
      "scraply:development-context", "support-1", "contrary-1",
    ]);
    expect(request.evidence[1]?.content).toEqual({
      categories: ["supporting"],
      evidence: { quote: "Repeated filing" },
    });
    expect(request.evidence[2]?.content).toEqual({
      categories: ["contrary"],
      evidence: { quote: "Existing tools work" },
    });
    expect(JSON.stringify(request.evidence[0]?.content)).toContain("spreadsheet failed");
  });

  test("keeps paid attempt metadata when semantic option validation fails", async () => {
    const run = produceDevelopmentOptions(context(), dependencies({
      options: Array.from({ length: 4 }, () => option()),
    }));

    await expect(run).rejects.toMatchObject({
      code: "schema",
      retryable: false,
      attempts: [{ providerRequestId: "provider-request-1" }],
    });
  });

  test("allows tentative known-problem options while excluding context IDs from the provider schema", async () => {
    const knownProblem = {
      ...context(),
      problem: { ...context().problem, verdict: "user-asserted" as const },
      supportingEvidence: [],
      contraryEvidence: [],
    };
    const tentative = option({ supportingEvidenceIds: [], contraryEvidenceIds: [] });
    const result = await produceDevelopmentOptions(knownProblem, dependencies({ options: [tentative] }, (request) => {
      expect(request.workOrder.inputs).toMatchObject({ evidenceSourceIds: [] });
      expect(request.schema.safeParse({ options: [tentative] }).success).toBe(true);
      for (const field of ["supportingEvidenceIds", "contraryEvidenceIds"] as const) {
        expect(request.schema.safeParse({ options: [{ ...tentative, [field]: ["scraply:development-context"] }] }).success).toBe(false);
      }
      expect(request.jsonSchema).toEqual(expect.objectContaining({
        properties: expect.objectContaining({ options: expect.objectContaining({
          items: expect.objectContaining({ properties: expect.objectContaining({
            supportingEvidenceIds: expect.objectContaining({ maxItems: 0 }),
          }) }),
        }) }),
      }));
    }));
    expect(result.options).toEqual([expect.objectContaining(tentative)]);
  });

  test("constrains provider citations to the supplied research sources", async () => {
    await produceDevelopmentOptions(context(), dependencies({ options: [option()] }, (request) => {
      expect(request.schema.safeParse({ options: [option()] }).success).toBe(true);
      expect(request.schema.safeParse({ options: [option({ supportingEvidenceIds: ["invented"] })] }).success).toBe(false);
    }));
  });

  test("keeps v2 requests compatible with subscription token-limit rules", async () => {
    for (const providerId of ["openai-subscription", "openrouter"]) {
      const deps = dependencies({ options: [] }, (request) => {
        if (providerId === "openai-subscription") expect(request).not.toHaveProperty("maxOutputTokens");
        else expect(request.maxOutputTokens).toBeGreaterThan(0);
        throw new Error("Request verified before provider dispatch");
      });
      deps.model = { providerId, modelId: "test" };
      await expect(produceDevelopmentOptions(context(), deps)).rejects.toThrow("Request verified");
      await expect(analyzeSelectedOption(context(), {
        ...option(), id: "solution-1", problemId: "problem-1",
      }, deps)).rejects.toThrow("Request verified");
    }
  });

  test("does not accept synthetic context or conflicting evidence IDs", async () => {
    const syntheticReference = produceDevelopmentOptions(context(), dependencies({
      options: [option({ supportingEvidenceIds: ["scraply:development-context"] })],
    }));
    await expect(syntheticReference).rejects.toBeInstanceOf(ProviderFailure);

    const duplicate = context();
    duplicate.contraryEvidence[0]!.sourceId = "support-1";
    await expect(produceDevelopmentOptions(duplicate, dependencies({ options: [] })))
      .rejects.toThrow("conflicting content");
  });

  test("lets an option use problem counterevidence as support for an existing alternative", async () => {
    const manualOption = option({
      supportingEvidenceIds: ["contrary-1"],
      contraryEvidenceIds: ["support-1"],
    });
    const result = await produceDevelopmentOptions(context(), dependencies({ options: [manualOption] }));
    expect(result.options).toEqual([expect.objectContaining(manualOption)]);
  });

  test.each(["supportingEvidenceIds", "contraryEvidenceIds"] as const)("rejects invented %s with paid attempt metadata", async (field) => {
    await expect(produceDevelopmentOptions(context(), dependencies({
      options: [option({ [field]: ["invented"] })],
    }))).rejects.toMatchObject({
      code: "schema",
      retryable: false,
      attempts: [{ providerRequestId: "provider-request-1" }],
    });
  });

  test("coalesces one source used as both support and contrary evidence", async () => {
    const shared = context();
    shared.contraryEvidence = [{ sourceId: "support-1", content: { quote: "Repeated filing" } }];
    let evidence: Array<{ sourceId: string; content: unknown }> = [];
    const result = await produceDevelopmentOptions(shared, dependencies({
      options: [option({
        supportingEvidenceIds: ["support-1"],
        contraryEvidenceIds: ["support-1"],
      })],
    }, (request) => {
      evidence = request.evidence.map((item) => ({ sourceId: item.sourceId, content: item.content }));
    }));

    expect(result.options).toHaveLength(1);
    expect(evidence).toHaveLength(2);
    expect(evidence[1]?.content).toEqual({
      categories: ["supporting", "contrary"],
      evidence: { quote: "Repeated filing" },
    });
  });

  test("analyzes only the selected full mechanism without scores or automatic selection", async () => {
    const selected: DevelopedWorkflowV2SolutionOption = {
      ...option(),
      id: "solution-1",
      problemId: "problem-1",
    };
    let capturedEvidence = "";
    const result = await analyzeSelectedOption(context(), selected, dependencies({
      consequences: [{
        description: "Fewer repeat filings",
        direction: "positive",
        affects: "operators",
        rationale: "Shared state removes duplicate entry",
      }],
      risks: [{ riskId: "risk-1", description: "The source blocks access", whyDecisive: "No state can sync" }],
      proposedResponses: [{
        riskIds: ["risk-1"],
        approach: "Test a manual export",
        cost: "One hour",
        failsIf: "Exports omit claim state",
      }],
      unknowns: ["Export completeness"],
      experiment: {
        question: "Does one export contain enough state?",
        method: "Inspect ten recent claims",
        cost: "One hour",
        passCriterion: "At least nine contain all required fields",
        failCriterion: "Two or more omit a required field",
      },
    }, (request) => {
      capturedEvidence = JSON.stringify(request.evidence);
    }));

    expect(capturedEvidence).toContain(selected.mechanism);
    expect(capturedEvidence).toContain("spreadsheet failed");
    expect(JSON.stringify(result.analysis)).not.toContain("score");
  });

  test("keeps the one follow-up question in evidence and performs one search and one harvest", async () => {
    const questions: string[] = [];
    const captured: StructuredStageRequest<unknown>[] = [];
    const result = await harvestEvidenceFollowUp(context().scope, "Does export preserve state?", {
      search: { async search(query) {
        questions.push(query);
        return [{ id: "provider-1", url: "https://example.test/export", title: "Export study", text: "Nine exports preserved state." }];
      } },
      modelClient: { async structuredCompletion<T>(request: StructuredStageRequest<T>) {
        captured.push(request as StructuredStageRequest<unknown>);
        return {
          output: request.schema.parse({ factors: [{
            subject: "Exports", behavior: "preserved state", quote: "Nine exports preserved state.",
            sourceId: "follow-source", modelConfidence: 0.8,
          }] }),
          metadata: {
            model: { providerId: "test", modelId: "test" },
            usage: { status: "unknown" }, latencyMs: 1, repairCount: 0, providerRequestIds: [], attempts: [],
          },
        };
      } },
      model: { providerId: "test", modelId: "test" },
      reasoningEffort: "medium",
      prompt: () => "Extract quote-verifiable observations.",
      depth: "quick",
      idFactory: (() => {
        const ids = ["follow-source", "follow-factor"];
        return () => ids.shift()!;
      })(),
    });

    expect(questions).toEqual(["Does export preserve state?"]);
    expect(result.factors.map((factor) => factor.id)).toEqual(["follow-factor"]);
    expect(captured[0]!.workOrder.inputs).toEqual({ harvestMode: "domain", followUp: true });
    expect(JSON.stringify(captured[0]!.workOrder.inputs)).not.toContain("Does export preserve state?");
    expect(JSON.stringify(captured[0]!.evidence)).toContain("Does export preserve state?");
  });

  test("finishes an empty follow-up after one search without spending a model call", async () => {
    let searches = 0;
    let generations = 0;
    const result = await harvestEvidenceFollowUp(context().scope, "Is there any contrary evidence?", {
      search: { async search() { searches += 1; return []; } },
      modelClient: { async structuredCompletion() {
        generations += 1;
        throw new Error("An empty search must not start factor harvest");
      } },
      model: { providerId: "test", modelId: "test" },
      reasoningEffort: "medium",
      depth: "quick",
      prompt: () => "Unused",
    });
    expect(searches).toBe(1);
    expect(generations).toBe(0);
    expect(result).toEqual(expect.objectContaining({ sources: [], factors: [], rejections: [] }));
  });
});

function context() {
  return {
    scope: {
      title: "Claims",
      audience: "Operators",
      domain: "Operations",
      observations: "Claims repeat",
      offLimits: ["No lending"],
    },
    problem: {
      id: "problem-1",
      statement: "Operators repeat the same claim.",
      whyItPersists: "Systems do not share state.",
      affected: "Operators",
      scaleEstimate: "Weekly",
      scaleBasisFactorId: null,
      factorIds: ["factor-1"],
      verdict: "confirmed" as const,
      verdictReason: "Supported",
      verdictSourceIds: ["support-1"],
    },
    supportingEvidence: [{ sourceId: "support-1", content: { quote: "Repeated filing" } }],
    contraryEvidence: [{ sourceId: "contrary-1", content: { quote: "Existing tools work" } }],
    priorFailedAttempts: ["A shared spreadsheet failed because updates were stale."],
  };
}

function option(overrides: Partial<ReturnType<typeof optionBase>> = {}) {
  return { ...optionBase(), ...overrides };
}

function optionBase() {
  return {
    mechanism: "Synchronize claim state before submission",
    description: "Read shared state before filing.",
    keyAssumption: "State is available before submission.",
    whyCurrentApproachMaySuffice: "Existing tools may already expose this state.",
    supportingEvidenceIds: ["support-1"],
    contraryEvidenceIds: ["contrary-1"],
    unknowns: ["Access reliability"],
    respectsOffLimits: true,
    respectsOffLimitsWhy: "No lending is involved.",
  };
}

function dependencies(
  output: unknown,
  beforeGeneration?: WorkflowV2DevelopmentDependencies["beforeGeneration"],
): WorkflowV2DevelopmentDependencies {
  const modelClient: StructuredModelClient = {
    async structuredCompletion<T>() {
      return {
        output: output as T,
        metadata: {
          model: { providerId: "test", modelId: "test" },
          usage: { status: "unknown" },
          latencyMs: 1,
          repairCount: 0,
          providerRequestIds: ["provider-request-1"],
          attempts: [{
            attempt: "initial",
            outcome: "completed",
            providerCompletion: "confirmed",
            model: { providerId: "test", modelId: "test" },
            usage: { status: "unknown" },
            cost: { status: "not_reported" },
            latencyMs: 1,
            providerRequestId: "provider-request-1",
          }],
        },
      };
    },
  };
  return {
    modelClient,
    model: { providerId: "test", modelId: "test" },
    reasoningEffort: "medium",
    resolvePrompt: (stageId) => ({
      stageId,
      filename: `workflow-v2-${stageId}.md`,
      revision: 1,
      source: "override",
      currentBundledSha256: hash("bundled prompt\n"),
      resolvedSha256: hash("  exact prompt bytes\r\n"),
      overrideBaseline: null,
      text: "  exact prompt bytes\r\n",
    }),
    ...(beforeGeneration ? { beforeGeneration } : {}),
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
