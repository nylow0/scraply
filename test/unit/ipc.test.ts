import { describe, expect, test } from "bun:test";
import { formatZodError, SelectThreadRequestSchema } from "../../src/shared/ipc";
import { ipcPayload } from "../../src/renderer/lib/ipc-payload";

describe("formatZodError", () => {
  test("joins issue paths and messages", () => {
    const result = SelectThreadRequestSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(formatZodError(result.error)).toContain("threadId");
    }
  });
});

describe("ipcPayload", () => {
  test("returns primitives unchanged", () => {
    expect(ipcPayload(42)).toBe(42);
    expect(ipcPayload("hello")).toBe("hello");
    expect(ipcPayload(null)).toBe(null);
  });

  test("clones objects for structured clone safety", () => {
    const source = { nested: { value: 1 }, list: [1, 2] };
    const cloned = ipcPayload(source);
    expect(cloned).toEqual(source);
    expect(cloned).not.toBe(source);
    cloned.nested.value = 99;
    expect(source.nested.value).toBe(1);
  });
});
