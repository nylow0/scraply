import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileLogger } from "../../src/main/logging";
import { createLogRecord } from "../../src/shared/logging";

describe("local application logging", () => {
  test("redacts credentials and drops unapproved diagnostic fields", () => {
    const secret = "exa-sensitive-value";
    const error = new Error(`Provider failed with Bearer abc.def and ${secret}`);
    const record = createLogRecord({
      level: "error",
      component: "backend",
      event: "provider-failed",
      message: `Could not use ${secret}`,
      context: {
        route: "/research/start",
        runId: "run-1",
        authorization: "Bearer hidden-token",
        apiKey: secret,
        prompt: "private prompt body",
        responseBody: "private provider response",
      },
      error,
    }, "0.3.0", [secret], "2026-07-25T00:00:00.000Z");

    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("abc.def");
    expect(serialized).not.toContain("hidden-token");
    expect(serialized).not.toContain("private prompt body");
    expect(serialized).not.toContain("private provider response");
    expect(record.context).toEqual({ route: "/research/start", runId: "run-1" });
  });

  test("rotates one bounded previous log before appending", () => {
    const dir = mkdtempSync(join(tmpdir(), "scraply-logging-"));
    const logsDir = join(dir, "logs");
    mkdirSync(logsDir);
    writeFileSync(join(logsDir, "scraply.log"), "x".repeat(5 * 1024 * 1024), "utf8");

    const logger = createFileLogger({ logsDir, appVersion: "0.3.0", getSecrets: () => [] });
    logger.log({ level: "info", component: "main", event: "rotation-test" });

    expect(existsSync(join(logsDir, "scraply.log.1"))).toBe(true);
    expect(readFileSync(logger.filePath, "utf8")).toContain("rotation-test");
    rmSync(dir, { recursive: true, force: true });
  });
});
