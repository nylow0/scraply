import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export function loadPrompt(name: string, fallback: string): string {
  const paths = [
    resolve(process.cwd(), "prompts", `${name}.md`),
    join(__dirname, "..", "..", "prompts", `${name}.md`),
  ];

  for (const path of paths) {
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8").trim();
    if (text) return text;
  }

  return fallback.trim();
}
