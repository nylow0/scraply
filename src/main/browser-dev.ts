import { createServer, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { ResearchEvent } from "../shared/ipc";

export type AppRequestHandler = (...args: unknown[]) => unknown;
const RequestSchema = z.object({ channel: z.string(), args: z.array(z.unknown()).max(1) }).strict();

function matchesToken(value: string | undefined, token: string): boolean {
  const actual = Buffer.from(value ?? "");
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Local development transport. The Vite proxy authenticates to this loopback-only host. */
export async function startBrowserDevHost(options: {
  port: number;
  token: string;
  sessionId: string;
  handlers: ReadonlyMap<string, AppRequestHandler>;
  shutdown: () => void;
}) {
  const clients = new Set<ServerResponse>();
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (!matchesToken(request.headers.authorization, `Bearer ${options.token}`)) {
      json(403, { error: "Forbidden" });
      return;
    }
    if (request.method === "GET" && request.url === "/health") {
      json(200, { sessionId: options.sessionId });
      return;
    }
    if (request.method === "POST" && request.url === "/shutdown") {
      const control = request.headers["x-scraply-control"];
      if (typeof control !== "string" || !matchesToken(control, options.token)) {
        json(403, { error: "Forbidden" });
        return;
      }
      json(200, { stopped: true });
      setImmediate(options.shutdown);
      return;
    }
    if (request.method === "GET" && request.url === "/events") {
      response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
      response.write(": connected\n\n");
      clients.add(response);
      request.on("close", () => clients.delete(response));
      return;
    }
    if (request.method !== "POST" || request.url !== "/invoke" || !request.headers["content-type"]?.startsWith("application/json")) {
      json(404, { error: "Unknown dev request" });
      return;
    }
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > 1024 * 1024) {
          json(413, { error: "Dev request too large" });
          return;
        }
        chunks.push(bytes);
      }
      const { channel, args } = RequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const handler = options.handlers.get(channel);
      if (!handler) {
        json(404, { error: "Unknown app request" });
        return;
      }
      json(200, { data: await handler(...args) });
    } catch (error) {
      json(400, { error: error instanceof Error ? error.message : "App request failed" });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing browser dev address");
  return {
    port: address.port,
    publish(event: ResearchEvent) {
      for (const client of clients) client.write(`data: ${JSON.stringify(event)}\n\n`);
    },
    close() {
      for (const client of clients) client.end();
      server.close();
    },
  };
}
