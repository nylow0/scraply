import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

let bundledPromptDir = join(__dirname, "..", "..", "prompts");
let overridePromptDir: string | null = null;

export function configurePromptPaths(options: { bundledDir: string; overrideDir: string }): void {
  bundledPromptDir = options.bundledDir;
  overridePromptDir = options.overrideDir;
  mkdirSync(overridePromptDir, { recursive: true });

  if (!existsSync(bundledPromptDir)) return;
  for (const entry of readdirSync(bundledPromptDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const target = join(overridePromptDir, entry.name);
    if (!existsSync(target)) copyFileSync(join(bundledPromptDir, entry.name), target);
  }
}

export function loadPrompt(name: string, fallback: string): string {
  const filename = `${name}.md`;
  const paths = [overridePromptDir ? join(overridePromptDir, filename) : null, join(bundledPromptDir, filename)];

  for (const path of paths) {
    if (!path) continue;
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8").trim();
    if (text) return text;
  }

  return fallback.trim();
}
