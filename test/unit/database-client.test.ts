import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseClient } from "../../src/db/client";

test("closing a database releases its files while prepared statements remain referenced", () => {
  const directory = mkdtempSync(join(tmpdir(), "scraply-database-close-"));
  const client = new DatabaseClient(join(directory, "scraply.db"));
  const statement = client.db.prepare("SELECT 1 AS value");

  try {
    expect(statement.get()).toEqual({ value: 1 });
    client.close();
    rmSync(directory, { recursive: true, force: true });

    // The reference deliberately stays live through removal. DatabaseClient owns
    // the native statement lifecycle and must not depend on garbage collection.
    expect(statement).toBeDefined();
  } finally {
    expect(() => client.close()).not.toThrow();
    rmSync(directory, { recursive: true, force: true });
  }
});
