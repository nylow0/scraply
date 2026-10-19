import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** Preserve existing exports when either desktop host writes the same filename again. */
export function writeUniqueExportFile(directory: string, filename: string, content: string): string {
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const extension = dot > 0 ? filename.slice(dot) : "";
  for (let suffix = 0; ; suffix++) {
    const candidate = suffix ? `${stem}-${suffix + 1}${extension}` : filename;
    try {
      writeFileSync(join(directory, candidate), content, { encoding: "utf8", flag: "wx" });
      return candidate;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    }
  }
}
