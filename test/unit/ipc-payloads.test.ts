import { describe, expect, test } from "bun:test";
import {
  toCreateBranchPayload,
  toFavoriteModelPayload,
  toProjectBriefPayload,
  toRunConfigPayload,
  toStartBriefIntakePayload,
} from "../../src/renderer/lib/ipc-payloads";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/intake";
import type { ProjectBrief } from "../../src/shared/schemas";
import { makeProjectBrief } from "../helpers/project-brief";

const brief: ProjectBrief = makeProjectBrief({
  title: "Student Income Lab",
  objective: "Student businesses",
  context: "Find practical business opportunities for students.",
  desiredOutput: { type: "ranked-shortlist", notes: "A ranked idea shortlist" },
  successCriteria: ["Evidence-backed ideas that can launch quickly"],
  hardConstraints: ["Low startup cost"],
  resources: ["Software skills"],
  antiGoals: ["Regulated markets"],
  evidenceRequirements: ["Validate demand and competition"],
  decisionToSupport: "Choose one idea to validate",
  deadline: "This semester",
  availableEffort: "10 hours per week",
});

describe("renderer IPC payloads", () => {
  test("creates a cloneable brief payload so Svelte proxies never cross Electron IPC", () => {
    const payload = toProjectBriefPayload(new Proxy(brief, {}));

    expect(payload).toEqual(brief);
    expect(payload).not.toBe(brief);
    expect(structuredClone(payload)).toEqual(brief);
  });

  test("creates a cloneable run configuration without dropping persisted limits", () => {
    const payload = toRunConfigPayload(new Proxy(DEFAULT_RUN_CONFIG, {}));

    expect(payload).toEqual(DEFAULT_RUN_CONFIG);
    expect(payload).not.toBe(DEFAULT_RUN_CONFIG);
    expect(structuredClone(payload)).toEqual(DEFAULT_RUN_CONFIG);
  });

  test("copies nested reactive values before branch and favorite IPC calls", () => {
    const branch = toCreateBranchPayload({
      parentThreadId: "thread-1",
      seedIdeaId: "idea-1",
      seedIdeaTitle: "Feedback copilot",
      explorationAngle: "Validate demand before implementation",
      selectedClaimIds: new Proxy(["claim-1"], {}),
    });
    const favorite = toFavoriteModelPayload({
      model: new Proxy({ provider: "codex" as const, id: "gpt-5.6-luna" }, {}),
      favorite: true,
    });

    expect(structuredClone(branch)).toEqual(branch);
    expect(structuredClone(favorite)).toEqual(favorite);
  });

  test("rejects malformed renderer state before invoking privileged IPC", () => {
    expect(() => toProjectBriefPayload({ ...brief, objective: "" })).toThrow();
    expect(() => toRunConfigPayload({ ...DEFAULT_RUN_CONFIG, parallelism: 0 })).toThrow();
    expect(() => toStartBriefIntakePayload({ threadId: "thread-1", text: " " })).toThrow();
  });

  test("sends the complete starter brief in one strict IPC payload", () => {
    const text = "Decide which product to build.\nConstraints: offline-first and no ads.";
    const payload = toStartBriefIntakePayload({ threadId: "thread-1", text });

    expect(payload).toEqual({ threadId: "thread-1", text });
    expect(structuredClone(payload)).toEqual(payload);
  });
});
