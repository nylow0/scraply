import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { expect, test, vi } from "vitest";
import ResearchArchive from "../../src/renderer/components/ResearchArchive.svelte";
import type { PreviewWorkflowResult } from "../../src/shared/workflow-contracts";

function fixture(blocked = false) {
  const preview: PreviewWorkflowResult = { type: "candidate-assessment", proposal: { candidateId: "candidate", sourceRunId: "run", depth: "standard", modelCalls: 6, searches: 3 },
    previewHash: "preview", capabilityFingerprint: "capabilities", minimumWork: { modelCalls: 6, searches: 3 },
    upperLimits: { maxModelCalls: 20, maxSearches: 10, maxMinutes: 30 },
    fieldErrors: blocked ? [{ path: ["candidateId"], code: "BUDGET_TOO_SMALL", message: "The candidate will stay not assessed." }] : [],
    expiresAt: "2026-09-30T12:00:00.000Z" };
  const previewCandidateAssessment = vi.fn().mockResolvedValue(preview);
  const onAssessCandidate = vi.fn().mockResolvedValue(undefined);
  const result = render(ResearchArchive, { problems: [], rejectedCandidates: [{ id: "candidate", statement: "Owners repeat filing", reason: "Depth limit", disposition: "not-assessed",
    candidate: { statement: "Owners repeat filing", whyItPersists: "Tools", affected: "Owners", scaleEstimate: "Unknown", scaleBasisFactorId: null, factorIds: [] } }],
    busy: false, onExport: vi.fn(), onOpenSource: vi.fn(), previewCandidateAssessment, onAssessCandidate });
  return { ...result, preview, previewCandidateAssessment, onAssessCandidate };
}

test("Assess shows bounded work before the explicit assessment command", async () => {
  const f = fixture();
  await fireEvent.click(f.getByText("Not assessed"));
  await fireEvent.click(f.getByRole("button", { name: "Assess" }));
  await waitFor(() => expect(f.getByText(/6 model calls and 3 searches/)).toBeTruthy());
  expect(f.previewCandidateAssessment).toHaveBeenCalledWith("candidate");
  expect(f.onAssessCandidate).not.toHaveBeenCalled();
  await fireEvent.click(f.getByRole("button", { name: "Assess candidate" }));
  await waitFor(() => expect(f.onAssessCandidate).toHaveBeenCalledWith(f.preview));
});

test("an insufficient preview keeps the candidate visible and prevents submission", async () => {
  const f = fixture(true);
  await fireEvent.click(f.getByText("Not assessed"));
  await fireEvent.click(f.getByRole("button", { name: "Assess" }));
  await waitFor(() => expect(f.getByRole("alert").textContent).toContain("stay not assessed"));
  expect((f.getByRole("button", { name: "Assess candidate" }) as HTMLButtonElement).disabled).toBe(true);
  expect(f.getByRole("heading", { name: "Owners repeat filing" })).toBeTruthy();
  expect(f.onAssessCandidate).not.toHaveBeenCalled();
});
