export interface SqlStatement {
  run(...params: unknown[]): void;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}

export function openDatabase(dbPath: string): SqlDatabase {
  if (typeof Bun !== "undefined") {
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    const db = new Database(dbPath);
    const statements = new Set<ReturnType<typeof db.prepare>>();
    // Keep native statements owned until their public wrapper is collected or the database closes.
    const statementFinalizer = new FinalizationRegistry<ReturnType<typeof db.prepare>>((statement) => {
      statement.finalize();
      statements.delete(statement);
    });
    return {
      exec: (sql) => db.exec(sql),
      prepare: (sql) => {
        const statement = db.prepare(sql);
        const sqlStatement: SqlStatement = statement;
        const trackedStatement: SqlStatement = {
          run: (...params) => sqlStatement.run(...params),
          get: (...params) => sqlStatement.get(...params),
          all: (...params) => sqlStatement.all(...params),
        };
        statements.add(statement);
        statementFinalizer.register(trackedStatement, statement, statement);
        return trackedStatement;
      },
      close: () => {
        for (const statement of statements) {
          statementFinalizer.unregister(statement);
          statement.finalize();
        }
        statements.clear();
        db.close(true);
      },
    };
  }

  // Electron / Node runtime
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(dbPath);
  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => db.prepare(sql),
    close: () => db.close(),
  };
}
