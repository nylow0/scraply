import { describe, expect, test } from "bun:test";
import { AppError, normalizeAppError } from "../../src/shared/errors";
import { isAllowedRendererUrl, parseExternalHttpsUrl } from "../../src/main/security";

describe("Electron URL boundary", () => {
  test("accepts public HTTPS URLs", () => {
    expect(parseExternalHttpsUrl({ url: "https://example.com/report?id=1" })).toBe("https://example.com/report?id=1");
  });

  test.each([
    "http://example.com",
    "file:///C:/secrets.txt",
    "https://user:password@example.com",
    "https://localhost/report",
    "https://research.localhost/report",
    "https://127.0.0.1/report",
    "https://127.1/report",
    "https://[::1]/report",
    "not a url",
  ])("rejects unsafe external URL %s", (url) => {
    expect(() => parseExternalHttpsUrl({ url })).toThrow(AppError);
  });

  test("allows only the packaged renderer file", () => {
    const entry = "file:///C:/Program%20Files/Scraply/resources/app.asar/renderer/index.html";
    expect(isAllowedRendererUrl(`${entry}#report`, entry)).toBe(true);
    expect(isAllowedRendererUrl("file:///C:/Windows/System32/drivers/etc/hosts", entry)).toBe(false);
    expect(isAllowedRendererUrl("https://example.com", entry)).toBe(false);
  });

  test("allows only the configured development origin", () => {
    const entry = "http://127.0.0.1:5173/";
    expect(isAllowedRendererUrl("http://127.0.0.1:5173/assets/app.js", entry)).toBe(true);
    expect(isAllowedRendererUrl("http://localhost:5173/", entry)).toBe(false);
  });
});

describe("safe errors", () => {
  test("does not expose unexpected exception text", () => {
    const error = normalizeAppError(new Error("provider secret: abc123"));
    expect(error.code).toBe("internal_error");
    expect(error.message).not.toContain("abc123");
  });
});
