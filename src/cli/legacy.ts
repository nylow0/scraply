import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import { CliError } from "./output";

const ThreadsSchema = z.object({
  threads: z.array(z.object({ id: z.string(), title: z.string(), status: z.string(), archivedAt: z.string().nullable(), createdAt: z.string(), updatedAt: z.string() }).passthrough()),
}).passthrough();
const FileSchema = z.object({ filename: z.string(), content: z.string() });
const IdeasSchema = z.object({ files: z.array(FileSchema) }).passthrough();
const EnvelopeSchema = z.union([
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.object({ message: z.string() }).passthrough() }),
]);

function slug(text: string) {
  return text.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "project";
}

/** A file name from the backend, kept inside its folder. */
function safeName(filename: string) {
  return basename(filename).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-") || "export";
}

/** The desktop app keeps its data in a `scraply` folder inside its Electron profile. */
export function desktopDatabasePath(profileDir: string) {
  return join(profileDir, "scraply", "scraply.db");
}

/**
 * Export every project in the desktop app's database, for retiring the app. The original is opened
 * read-only and snapshotted with VACUUM INTO `<out>/scraply-snapshot.db`, which keeps everything,
 * including interrupted runs. The app's own backend then runs on a throwaway copy of the snapshot,
 * with no keys and no model runtime, and its export routes write each project's research JSON and
 * its ideas as JSON and Markdown, exactly as the app would. `<out>/index.json` lists the projects.
 */
export async function exportDesktopProjects(profileDir: string, outDir: string) {
  const dbPath = desktopDatabasePath(profileDir);
  if (!existsSync(dbPath)) throw new CliError("NO_DESKTOP_DATA", `No desktop database at ${dbPath}.`);
  if (existsSync(outDir) && readdirSync(outDir).length) throw new CliError("OUT_NOT_EMPTY", `${outDir} is not empty. Pass a new folder with --out.`);
  mkdirSync(outDir, { recursive: true });
  const snapshot = join(outDir, "scraply-snapshot.db");
  const original = new Database(dbPath, { readonly: true });
  try {
    original.run("VACUUM INTO ?", [snapshot]);
  } finally {
    original.close();
  }

  const work = mkdtempSync(join(tmpdir(), "scraply-desktop-export-"));
  copyFileSync(snapshot, join(work, "scraply.db"));
  // Loaded here so ordinary commands never pay for the desktop backend. Its diagnostics, such as the
  // pre-migration backup notice, go to stderr so stdout stays one JSON envelope.
  const { startBackend } = await import("../backend/server");
  const [info, log] = [console.info, console.log];
  console.info = console.log = console.error;
  const backend = await startBackend({
    dataDir: work, dbPath: join(work, "scraply.db"),
    bundledPromptsDir: join(import.meta.dir, "..", "..", "prompts"), promptOverridesDir: join(work, "prompts"),
    appVersion: "cli-desktop-export", getSecrets: () => ({ exaApiKey: null, perplexityApiKey: null }),
    providerValidation: { inspectNative: async () => ({ available: false, connected: false, accounts: [], models: [] }) },
  }, () => undefined).catch((error: unknown) => {
    [console.info, console.log] = [info, log];
    throw error;
  });
  try {
    const call = async (path: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${backend.port}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${backend.token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const envelope = EnvelopeSchema.parse(await response.json());
      return envelope.ok ? { data: envelope.data } : { error: envelope.error.message };
    };
    const workspace = await call("/workspace");
    if ("error" in workspace) throw new CliError("DESKTOP_EXPORT_FAILED", `The desktop backend could not list projects: ${workspace.error}`);
    const threads = ThreadsSchema.parse(workspace.data).threads;

    const index = [];
    for (const [position, thread] of threads.entries()) {
      const folder = `${String(position + 1).padStart(3, "0")}-${slug(thread.title)}`;
      mkdirSync(join(outDir, folder), { recursive: true });
      const problems: string[] = [];
      const research = await call("/research/export", { threadId: thread.id });
      if ("error" in research) problems.push(`research: ${research.error}`);
      else writeFileSync(join(outDir, folder, "research.json"), FileSchema.parse(research.data).content);
      let ideaFiles = 0;
      for (const format of ["markdown", "json"] as const) {
        const ideas = await call("/ideas/export", { threadId: thread.id, format });
        if ("error" in ideas) { problems.push(`ideas ${format}: ${ideas.error}`); continue; }
        const directory = join(outDir, folder, `ideas-${format === "json" ? "json" : "md"}`);
        mkdirSync(directory, { recursive: true });
        for (const file of IdeasSchema.parse(ideas.data).files) writeFileSync(join(directory, safeName(file.filename)), file.content);
        ideaFiles += IdeasSchema.parse(ideas.data).files.length;
      }
      index.push({
        folder, title: thread.title, status: thread.status, archivedAt: thread.archivedAt, createdAt: thread.createdAt, updatedAt: thread.updatedAt,
        research: !problems.some(problem => problem.startsWith("research")), ideaFiles, ...(problems.length ? { problems } : {}),
      });
    }
    writeFileSync(join(outDir, "index.json"), JSON.stringify(index, null, 2));
    return { outDir, snapshot, projects: index.length, withResearch: index.filter(item => item.research).length, index: join(outDir, "index.json") };
  } finally {
    [console.info, console.log] = [info, log];
    await backend.close();
    rmSync(work, { recursive: true, force: true, maxRetries: 5 });
  }
}
