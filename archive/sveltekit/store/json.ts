import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { KnowledgeStoreSchema, type KnowledgeStore } from "./schema";

export const emptyStore = (): KnowledgeStore => ({ version: 1, nodes: [], sources: [], claims: [], ideas: [] });

export async function loadStore(path: string): Promise<KnowledgeStore> {
  try {
    return KnowledgeStoreSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return emptyStore();
    throw error;
  }
}

export async function saveStore(path: string, store: KnowledgeStore): Promise<void> {
  const validated = KnowledgeStoreSchema.parse(store);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

