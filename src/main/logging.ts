import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { createLogRecord, type LogInput } from "../shared/logging";

const MAX_LOG_BYTES = 5 * 1024 * 1024;

export interface FileLogger {
  filePath: string;
  log: (input: LogInput) => void;
}

export function createFileLogger(options: {
  logsDir: string;
  appVersion: string;
  getSecrets: () => readonly string[];
}): FileLogger {
  mkdirSync(options.logsDir, { recursive: true });
  const filePath = join(options.logsDir, "scraply.log");
  const previousPath = join(options.logsDir, "scraply.log.1");
  if (existsSync(filePath) && statSync(filePath).size >= MAX_LOG_BYTES) {
    rmSync(previousPath, { force: true });
    renameSync(filePath, previousPath);
  }

  return {
    filePath,
    log: (input) => {
      try {
        const record = createLogRecord(input, options.appVersion, options.getSecrets());
        appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
      } catch (error) {
        console.error("Failed to write Scraply log", error);
      }
    },
  };
}
