import { randomUUID } from "node:crypto";
import { renameSync, unlinkSync, writeFileSync } from "node:fs";

interface AtomicFileOperations {
  write(path: string, contents: Uint8Array): void;
  replace(source: string, destination: string): void;
  remove(path: string): void;
}

const fileOperations: AtomicFileOperations = {
  write: (path, contents) => writeFileSync(path, contents, { flag: "wx" }),
  replace: renameSync,
  remove: unlinkSync,
};

export function writeFileAtomically(
  destination: string,
  contents: Uint8Array,
  operations: AtomicFileOperations = fileOperations,
): void {
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    operations.write(temporary, contents);
    operations.replace(temporary, destination);
  } catch (error) {
    try { operations.remove(temporary); } catch { /* a failed write may not have created the file */ }
    throw error;
  }
}
