import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { OwnerMetadataSchema, OwnerTransportError, type OwnerMetadata } from "../shared/owner-contracts";
import { writePrivateFileAtomically } from "./private-file";

export interface OwnerLock {
  readonly dataDir: string;
  readonly descriptorPath: string;
  publish(metadata: OwnerMetadata): Promise<void>;
  release(): Promise<void>;
}

export async function canonicalizeDataDir(dataDir: string): Promise<string> {
  await mkdir(resolve(dataDir), { recursive: true });
  const canonical = realpathSync.native(resolve(dataDir));
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function endpointFor(dataDir: string) {
  const id = createHash("sha256").update(dataDir).digest("hex");
  return process.platform === "win32" ? `\\\\.\\pipe\\scraply-owner-${id}`
    : process.platform === "linux" ? `\0scraply-owner-${id}` : join(tmpdir(), `scraply-owner-${id}.sock`);
}

async function readDescriptor(path: string): Promise<OwnerMetadata | null> {
  let file;
  try {
    file = await open(path, "r");
    // Bound allocation even if the descriptor is corrupt or replaced while read.
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 4096) throw new Error("Oversized descriptor");
    return OwnerMetadataSchema.parse(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw new OwnerTransportError({ code: "OWNER_DESCRIPTOR_INVALID", message: "The owner descriptor could not be read. Close Scraply and try again." });
  } finally { await file?.close(); }
}

/** Discovery reads only owner.json. Authenticate health before attaching. */
export async function readOwnerMetadata(dataDir: string): Promise<OwnerMetadata | null> {
  return readDescriptor(join(resolve(dataDir), "owner.json"));
}

async function pipeAcceptsConnections(endpoint: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect(endpoint);
    const finish = (occupied: boolean) => { socket.destroy(); resolve(occupied); };
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/** Acquire before constructing SQLite, loading credentials, or backend recovery. */
export async function acquireOwnerLock(dataDir: string): Promise<OwnerLock | null> {
  const canonical = await canonicalizeDataDir(dataDir);
  const endpoint = endpointFor(canonical);
  let bound: Server | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidate = createServer(socket => socket.destroy());
    try {
      await new Promise<void>((resolve, reject) => {
        candidate.once("error", reject);
        candidate.listen({ path: endpoint, exclusive: true }, resolve);
      });
      bound = candidate;
      break;
    } catch (error) {
      if (error instanceof Error && "code" in error) {
        if (error.code === "EADDRINUSE") return null;
        // Bun 1.3.13 mislabels occupied pipes. Only this exact bind error plus
        // a successful connection proves contention. If shutdown closes the
        // pipe between bind and probe, rebind briefly instead of guessing.
        if (process.platform === "win32" && error.code === "ERR_INVALID_ARG_TYPE"
          && error.message === `Failed to listen at ${endpoint}`) {
          if (await pipeAcceptsConnections(endpoint)) return null;
          if (attempt < 2) { await delay(10 * (attempt + 1)); continue; }
        }
      }
      throw new OwnerTransportError({ code: "OWNER_LOCK_FAILED", message: "Exclusive ownership could not be established. Close Scraply and try again." });
    }
  }
  if (!bound) throw new OwnerTransportError({ code: "OWNER_LOCK_FAILED", message: "Exclusive ownership could not be established. Close Scraply and try again." });
  const server = bound;
  const descriptorPath = join(canonical, "owner.json");
  let published: OwnerMetadata | undefined;
  let releasing: Promise<void> | undefined;
  let pendingPublication = Promise.resolve();
  return {
    dataDir: canonical, descriptorPath,
    publish(metadata) {
      if (releasing) return Promise.reject(new Error("Owner lock is closing."));
      const checked = OwnerMetadataSchema.parse(metadata);
      const publication = pendingPublication.then(() => {
        writePrivateFileAtomically(descriptorPath, JSON.stringify(checked));
        published = checked;
      });
      pendingPublication = publication.catch(() => undefined);
      return publication;
    },
    release() {
      releasing ??= (async () => {
        await pendingPublication;
        try {
          if (published) {
            const current = await readDescriptor(descriptorPath).catch(() => null);
            if (current?.token === published.token) await rm(descriptorPath, { force: true });
          }
        } finally {
          await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
      })();
      return releasing;
    },
  };
}
