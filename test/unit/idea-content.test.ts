import { describe, expect, test } from "bun:test";
import { ideaContent, mechanismSteps } from "../../src/renderer/lib/idea-content";
import { HISTORY_MECHANISM } from "../ui/ideas-fixture";

describe("saved idea content", () => {
  test.each(["Energy log: Caretakers record weekend use.", "Energy log. Caretakers record weekend use."])("separates the name and reading text: %s", description => {
    expect(ideaContent(description)).toEqual({ name: "Energy log", summary: "Caretakers record weekend use." });
  });
  test("leaves a name-only idea without a summary", () => {
    expect(ideaContent("Energy log.")).toEqual({ name: "Energy log", summary: "" });
    expect(ideaContent("Energy log. The input is simple: an approved export.")).toEqual({
      name: "Energy log", summary: "The input is simple: an approved export.",
    });
  });
  test("turns the real school's mechanism into its nine steps", () => {
    const steps = mechanismSteps(HISTORY_MECHANISM);
    expect(steps).toHaveLength(9);
    expect(steps?.[0]).toBe("With school approval, obtain one existing meter-export format or manually entered billing history from its authorized holder.");
    expect(steps?.[8]).toBe("If enabling an existing account provides equally usable evidence, the additional software has not demonstrated value.");
  });
  test("preserves abbreviations and decimals inside steps", () => {
    expect(mechanismSteps("Ask Dr. Smith for a 1.5 kWh reading, e.g. One approved meter export. Preserve the file. Compare the same interval.")).toEqual([
      "Ask Dr. Smith for a 1.5 kWh reading, e.g. One approved meter export.", "Preserve the file.", "Compare the same interval.",
    ]);
  });
  test("uses explicit line breaks before sentences, and falls back for short prose", () => {
    expect(mechanismSteps("1. Obtain the file. Keep its date.\n2. Check the units.\n3. Share the pack.")).toEqual([
      "Obtain the file. Keep its date.", "Check the units.", "Share the pack.",
    ]);
    expect(mechanismSteps("Obtain a file. Share it.")).toBeNull();
    expect(mechanismSteps("Obtain the file.\nShare it.")).toBeNull();
  });
});
