import { describe, expect, test } from "bun:test";
import { AppError } from "../../../src/shared/errors";
import { CliError, createStreamWriter, errorResponse, formatResponse } from "../../../src/cli/output";

describe("CLI responses", () => {
  test("success and error each produce exactly one parseable JSON document", () => {
    const success = formatResponse({ ok: true, data: { usage: null, ideas: [] } }, true);
    expect(JSON.parse(success)).toEqual({ ok: true, data: { usage: null, ideas: [] } });
    expect(success.split("\n")).toHaveLength(2);
    const error = errorResponse(new AppError("PREVIEW_STALE", "Refresh preview.", 409, "ref-synthetic", { next: "preview" }));
    expect(error.exitCode).toBe(1);
    expect(JSON.parse(formatResponse(error.response, true))).toEqual({ ok: false, error: { code: "PREVIEW_STALE", message: "Refresh preview.", reference: "ref-synthetic", recovery: { next: "preview" } } });
  });

  test("exit codes distinguish usage, confirmation, ownership and client timeout", () => {
    for (const exit of [1, 2, 3, 4, 5] as const) expect(errorResponse(new CliError("synthetic", "Message.", exit)).exitCode).toBe(exit);
    expect(errorResponse({ code: "OWNER_BUSY", message: "Another owner." }).exitCode).toBe(4);
    expect(errorResponse({ code: "OWNER_TIMEOUT", message: "Deadline." }).exitCode).toBe(5);
    expect(errorResponse(new DOMException("Deadline", "TimeoutError")).exitCode).toBe(5);
  });

  test("unknown errors cannot copy a credential from exception messages to stdout", () => {
    const result = errorResponse(new Error("synthetic-secret-input"));
    expect(formatResponse(result.response, true)).not.toContain("synthetic-secret-input");
  });

  test("TTY text preserves nested data, empty results and unknown usage", () => {
    const response = { ok: true as const, data: { count: 0, unknownUsage: null, lines: "one\ntwo", ideas: [{ title: "Synthetic lantern", selected: false }], empty: [] } };
    expect(formatResponse(response, false)).toBe("count: 0\nunknownUsage: null\nlines:\n  one\n  two\nideas:\n  - title: Synthetic lantern\n    selected: false\nempty:\n  []\n");
    expect(JSON.parse(formatResponse(response, true))).toEqual(response);
    expect(formatResponse({ ok: true, data: { version: "0.1.2" } }, false)).toBe("version: 0.1.2\n");
    expect(formatResponse({ ok: false, error: { code: "PREVIEW_STALE", message: "Refresh preview.", recovery: { next: "preview" }, reference: "synthetic" } }, false))
      .toBe("PREVIEW_STALE: Refresh preview.\nRecovery:\n  next: preview\nReference: synthetic\n");
  });

  test("NDJSON requires explicit start and writes one item per line", () => {
    let output = "";
    const stream = createStreamWriter(text => { output += text; });
    expect(() => stream.write({ type: "event" })).toThrow();
    stream.start();
    stream.write({ type: "event", text: "one\ntwo" });
    stream.write({ type: "watch-end", state: "finished", outcome: "partial" });
    expect(output.trim().split("\n").map(line => JSON.parse(line) as unknown)).toEqual([{ type: "event", text: "one\ntwo" }, { type: "watch-end", state: "finished", outcome: "partial" }]);
  });
});
