import { describe, expect, test } from "bun:test";
import { buildCodexExecArgs } from "../../src/providers/codex";

describe("Codex structured adapter", () => {
  test("uses the bounded read-only Luna execution contract", () => {
    const args = buildCodexExecArgs("gpt-5.6-luna", "high", "C:\\tmp\\call", "schema.json", "last.json");
    expect(args).toContain("--ephemeral");
    expect(args).toContain("--skip-git-repo-check");
    expect(args).toContain("read-only");
    expect(args).toContain("--output-schema");
    expect(args).toContain("--output-last-message");
    expect(args).toContain('model_reasoning_effort="high"');
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual(["--model", "gpt-5.6-luna"]);
    expect(args[0]).toBe("exec");
    expect(args[1]).toBe("-");
  });
});
