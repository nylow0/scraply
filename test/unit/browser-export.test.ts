import { expect, test } from "bun:test";
import { bundleBrowserIdeaExport } from "../../src/shared/browser-export";

test("bundles every browser JSON batch into one array without dropping saved fields", () => {
  const file = bundleBrowserIdeaExport({
    filename: "Repair / Project ideas.json",
    files: [
      { filename: "first.json", content: JSON.stringify([{ id: "one", problemId: "problem-one", discarded: true, decisionAnalysis: { risks: [] } }]) },
      { filename: "second.json", content: JSON.stringify([{ id: "two", problemId: "problem-two", evidenceFollowUp: { status: "completed" } }]) },
      { filename: "empty.json", content: JSON.stringify({ kind: "no-options", problemId: "problem-three", options: [] }) },
    ],
  }, "json");

  expect(file.filename).toBe("Repair---Project-ideas.json");
  expect(JSON.parse(file.content)).toEqual([
    { id: "one", problemId: "problem-one", discarded: true, decisionAnalysis: { risks: [] } },
    { id: "two", problemId: "problem-two", evidenceFollowUp: { status: "completed" } },
    { kind: "no-options", problemId: "problem-three", options: [] },
  ]);
});

test("bundles browser Markdown batches into one document with their problem headings", () => {
  const file = bundleBrowserIdeaExport({
    filename: "repair-project-ideas.md",
    files: [
      { filename: "first.md", content: "# First problem\n\n## Option one\n" },
      { filename: "second.md", content: "# Second problem\n\n## Evidence follow-up\n" },
    ],
  }, "markdown");

  expect(file.filename).toBe("repair-project-ideas.md");
  expect(file.content).toBe("# First problem\n\n## Option one\n\n---\n\n# Second problem\n\n## Evidence follow-up\n");
});
