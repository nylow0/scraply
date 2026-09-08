import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createEvaluationArtifacts, evaluationInputTemplate, validateEvaluationReviews } from "../../scripts/phase3-evaluation";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture(caseCount = 3) {
  const directory = mkdtempSync(join(tmpdir(), "scraply-phase3-evaluation-"));
  directories.push(directory);
  const cases = Array.from({ length: caseCount }, (_, index) => {
    const caseId = `decision-${index + 1}`;
    const decision = `Should shop ${index + 1} adopt a supplier ledger?`;
    return {
      caseId,
      variants: ([1, 2] as const).map((workflowVersion) => {
        const stem = `${caseId}-v${workflowVersion}`;
        writeFileSync(join(directory, `${stem}-ideas.json`), JSON.stringify([{
          id: `${stem}-idea`, runId: `${stem}-run`, workflowVersion, problemStatement: decision,
          mechanism: workflowVersion === 1 ? "Manual comparison" : "Ledger experiment",
          factors: [{ sourceId: "source-1", quote: "Observed evidence" }],
          usage: { latencyMs: workflowVersion * 100 },
        }]));
        writeFileSync(join(directory, `${stem}-ideas.md`), [
          `# ${workflowVersion === 1 ? "Manual comparison" : "Ledger experiment"}`,
          "",
          ...(workflowVersion === 2 ? ["Workflow: v2. Not selected. Problem evidence: weak premise.", ""] : []),
          "Readable exported analysis.",
        ].join("\n"));
        writeFileSync(join(directory, `${stem}-research.json`), JSON.stringify({
          schemaVersion: 1, exportedAt: "2026-09-06T00:00:00.000Z",
          thread: { id: `${stem}-thread`, title: `Run v${workflowVersion}` },
          scope: { title: decision },
          researchRun: { id: `${stem}-run`, config: { model: "hidden" }, usage: { latencyMs: workflowVersion * 100 } },
          sources: [{ id: "source-1", text: "Observed evidence" }],
        }));
        return {
          ideasPath: `${stem}-ideas.json`, ideasMarkdownPath: `${stem}-ideas.md`, researchPath: `${stem}-research.json`,
          origin: workflowVersion === 1 ? "generated" as const : "live" as const,
          timings: { totalMs: workflowVersion * 100 },
        };
      }),
    };
  });
  return { directory, input: { schemaVersion: 1, cases } };
}

function completeReviews(caseIds: string[], packetSha256: string) {
  return { schemaVersion: 1, packetSha256, cases: caseIds.map((caseId) => ({
    caseId,
    candidates: (["A", "B"] as const).map((candidateId) => ({
      candidateId, unsupportedClaims: [], usefulDiscoveries: [`Useful ${candidateId}`],
      readingDurationMs: 1_000, correctionDurationMs: 0,
    })),
    actionChosen: { candidateId: "A" as const, description: "Run the bounded supplier trial." },
  })) };
}

describe("Phase 3 evaluation artifacts", () => {
  test("ingests representative export fields while withholding workflow, provenance, timing, and mapping from the review packet", () => {
    const { directory, input } = fixture();
    const artifacts = createEvaluationArtifacts(input, directory, () => true);
    expect(artifacts.packet.cases).toHaveLength(3);
    expect(artifacts.mapping.cases[0]!.candidates.map((candidate) => candidate.workflowVersion)).toEqual([2, 1]);
    expect(artifacts.mapping.cases[0]!.candidates[0]).toMatchObject({ origin: "live", timings: { totalMs: 200 } });
    expect(artifacts.reviewTemplate.cases[0]!.candidates[0]!.readingDurationMs).toBeNull();
    const packetText = JSON.stringify(artifacts.packet);
    expect(packetText).not.toContain("workflowVersion");
    expect(packetText).not.toContain("origin");
    expect(packetText).not.toContain("timings");
    expect(packetText).not.toContain("private-mapping");
    expect(packetText).not.toContain("hidden");
    expect(packetText).not.toContain("Run v");
    expect(packetText).toContain("Observed evidence");
    expect(artifacts.readingFiles[0]!.content).toContain("Not selected. Problem evidence: weak premise.");
    expect(artifacts.readingFiles[0]!.content).not.toContain("Workflow: v2.");
  });

  test("rejects mismatched decisions and incomplete reviewer observations", () => {
    const { directory, input } = fixture();
    const secondIdeas = join(directory, input.cases[0]!.variants[1]!.ideasPath);
    const ideas = JSON.parse(readFileSync(secondIdeas, "utf8")) as Array<Record<string, unknown>>;
    ideas[0]!.problemStatement = "A different decision";
    writeFileSync(secondIdeas, JSON.stringify(ideas));
    expect(() => createEvaluationArtifacts(input, directory, () => false)).toThrow("do not describe the same decision");

    const next = fixture();
    const artifacts = createEvaluationArtifacts(next.input, next.directory, () => false);
    const incomplete = completeReviews(next.input.cases.map(({ caseId }) => caseId), artifacts.mapping.packetSha256);
    incomplete.cases.pop();
    expect(() => validateEvaluationReviews(artifacts.packet, artifacts.mapping, incomplete)).toThrow();
  });

  test("records complete reviews without claiming the gate passed", () => {
    const { directory, input } = fixture();
    const artifacts = createEvaluationArtifacts(input, directory, () => false);
    const result = validateEvaluationReviews(artifacts.packet, artifacts.mapping, completeReviews(input.cases.map(({ caseId }) => caseId), artifacts.mapping.packetSha256));
    expect(result.gateStatus).toBe("review-recorded-not-accepted");
  });

  test("compares independent discoveries only with explicit matching research scope", () => {
    const { directory, input } = fixture();
    const firstCase = input.cases[0]!;
    for (const [index, variant] of firstCase.variants.entries()) {
      const researchPath = join(directory, variant.researchPath);
      const research = JSON.parse(readFileSync(researchPath, "utf8")) as { scope: Record<string, unknown> };
      research.scope = { title: `Run v${index + 1}`, domain: "Should we test a supplier ledger?", offLimits: ["No inventory"] };
      writeFileSync(researchPath, JSON.stringify(research));
    }
    const ideasPath = join(directory, firstCase.variants[1]!.ideasPath);
    const ideas = JSON.parse(readFileSync(ideasPath, "utf8")) as Array<Record<string, unknown>>;
    ideas[0]!.problemStatement = "Shops cannot get reliable part delivery estimates.";
    writeFileSync(ideasPath, JSON.stringify(ideas));
    expect(() => createEvaluationArtifacts(input, directory)).toThrow("same decision");
    const scopeInput = { ...input, cases: input.cases.map((item) => ({ ...item, comparison: item === firstCase ? "research-scope" : "selected-problem" })) };
    const artifacts = createEvaluationArtifacts(scopeInput, directory, () => false);
    expect(artifacts.packet.cases[0]).toMatchObject({ comparison: "research-scope", decision: "Should we test a supplier ledger?" });
    expect(JSON.stringify(artifacts.packet)).not.toContain("Run v");
    expect(JSON.stringify(artifacts.packet)).toContain("Shops cannot get reliable part delivery estimates.");

    const researchPath = join(directory, firstCase.variants[1]!.researchPath);
    const research = JSON.parse(readFileSync(researchPath, "utf8")) as { scope: Record<string, unknown> };
    research.scope.offLimits = ["Inventory allowed"];
    writeFileSync(researchPath, JSON.stringify(research));
    expect(() => createEvaluationArtifacts(scopeInput, directory)).toThrow("same archived scope and constraints");
    delete research.scope.domain;
    writeFileSync(researchPath, JSON.stringify(research));
    expect(() => createEvaluationArtifacts(scopeInput, directory)).toThrow();
  });

  test.each([1, 2] as const)("compares a completed v%s no-option result without inventing an idea", (workflowVersion) => {
    const { directory, input } = fixture();
    const variant = input.cases[0]!.variants[workflowVersion - 1]!;
    const path = join(directory, variant.ideasPath);
    const result = { kind: "no-options", status: "completed", workflowVersion,
      runId: "empty-development", discoveryRunId: `decision-1-v${workflowVersion}-run`, problemId: "problem-1",
      problemStatement: "Should shop 1 adopt a supplier ledger?", options: [] };
    writeFileSync(path, JSON.stringify(result));
    writeFileSync(join(directory, variant.ideasMarkdownPath), `# ${result.problemStatement}\n\nWorkflow: v${workflowVersion}. No options proposed.\n\nThis completed run produced no useful option. This is not evidence that the problem is solved.\n`);
    const artifacts = createEvaluationArtifacts(input, directory, () => false);
    expect(artifacts.readingFiles.every((file) => !file.content.includes("Workflow: v"))).toBe(true);
    expect(artifacts.readingFiles.some((file) => file.content.includes("No options proposed."))).toBe(true);
    const empty = artifacts.packet.cases[0]!.candidates.find((candidate) => candidate.noOptions);
    expect(empty?.ideas).toEqual([]);
    expect(empty?.noOptions).toMatchObject({ kind: "no-options", options: [] });
    expect(JSON.stringify(empty)).not.toContain("workflowVersion");
    expect(validateEvaluationReviews(artifacts.packet, artifacts.mapping,
      completeReviews(input.cases.map(({ caseId }) => caseId), artifacts.mapping.packetSha256)).gateStatus).toBe("review-recorded-not-accepted");
    writeFileSync(path, JSON.stringify({ ...result, discoveryRunId: "unrelated" }));
    expect(() => createEvaluationArtifacts(input, directory)).toThrow("different research export");
    writeFileSync(path, JSON.stringify({ ...result, status: "failed" }));
    expect(() => createEvaluationArtifacts(input, directory)).toThrow();
  });

  test("rejects changed scope context and a swapped private label mapping", () => {
    const { directory, input } = fixture();
    const researchPath = join(directory, input.cases[0]!.variants[1]!.researchPath);
    const research = JSON.parse(readFileSync(researchPath, "utf8")) as { scope: Record<string, unknown> };
    research.scope.offLimits = ["Different constraint"];
    writeFileSync(researchPath, JSON.stringify(research));
    expect(() => createEvaluationArtifacts(input, directory, () => false)).toThrow("same archived scope and constraints");

    const next = fixture();
    const artifacts = createEvaluationArtifacts(next.input, next.directory, () => false);
    const mapping = structuredClone(artifacts.mapping);
    const mappedCandidates = mapping.cases[0]!.candidates;
    mappedCandidates[0]!.candidateId = "B";
    mappedCandidates[1]!.candidateId = "A";
    expect(() => validateEvaluationReviews(
      artifacts.packet,
      mapping,
      completeReviews(next.input.cases.map(({ caseId }) => caseId), artifacts.mapping.packetSha256),
    )).toThrow("private A/B mapping does not match");
  });

  test("supports five cases when the initial result is mixed", () => {
    const { directory, input } = fixture(5);
    const artifacts = createEvaluationArtifacts(input, directory, () => false);
    const reviews = completeReviews(input.cases.map(({ caseId }) => caseId), artifacts.mapping.packetSha256);
    expect(validateEvaluationReviews(artifacts.packet, artifacts.mapping, reviews).reviews.cases).toHaveLength(5);
  });

  test("runs template, prepare, and validate through the CLI", () => {
    const { directory, input } = fixture();
    const inputPath = join(directory, "input.json");
    const templatePath = join(directory, "manifest-template.json");
    const outputDirectory = join(directory, "output");
    writeFileSync(inputPath, JSON.stringify(input));
    const script = join(process.cwd(), "scripts", "phase3-evaluation.ts");
    expect(Bun.spawnSync([process.execPath, script, "template", templatePath]).exitCode).toBe(0);
    expect(evaluationInputTemplate()).toEqual(JSON.parse(readFileSync(templatePath, "utf8")));
    expect(Bun.spawnSync([process.execPath, script, "prepare", inputPath, outputDirectory]).exitCode).toBe(0);
    const packet = JSON.parse(readFileSync(join(outputDirectory, "review-packet.json"), "utf8")) as { cases: Array<{ caseId: string }> };
    const mapping = JSON.parse(readFileSync(join(outputDirectory, "private-mapping.json"), "utf8")) as { packetSha256: string };
    const reviewsPath = join(directory, "reviews.json");
    const resultPath = join(directory, "result.json");
    writeFileSync(reviewsPath, JSON.stringify(completeReviews(packet.cases.map(({ caseId }) => caseId), mapping.packetSha256)));
    expect(Bun.spawnSync([process.execPath, script, "validate", join(outputDirectory, "review-packet.json"), join(outputDirectory, "private-mapping.json"), reviewsPath, resultPath]).exitCode).toBe(0);
    expect(JSON.parse(readFileSync(resultPath, "utf8"))).toMatchObject({ gateStatus: "review-recorded-not-accepted" });
    expect(readFileSync(join(outputDirectory, "decision-1-A.md"), "utf8")).toContain("Readable exported analysis.");
  });
});
