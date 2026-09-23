import type { IncomingMessage } from "node:http";
import type { Plugin } from "vite";

const configuredPort = Number(process.env.SCRAPLY_BROWSER_UI_PORT ?? 5173);
if (!Number.isSafeInteger(configuredPort) || configuredPort < 1024 || configuredPort > 65535) {
  throw new Error("SCRAPLY_BROWSER_UI_PORT must be a valid local port.");
}
export const BROWSER_DEV_ORIGIN = `http://127.0.0.1:${configuredPort}`;

export function isBrowserDevRequestAllowed(request: Pick<IncomingMessage, "method" | "headers">): boolean {
  if (request.headers.host !== new URL(BROWSER_DEV_ORIGIN).host) return false;
  const origin = request.headers.origin;
  if (origin && origin !== BROWSER_DEV_ORIGIN) return false;
  const site = request.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return false;
  return request.method === "GET" || (request.method === "POST" && origin === BROWSER_DEV_ORIGIN);
}

export function browserDevProxy(): Plugin {
  return {
    name: "scraply-browser-dev",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith("/__scraply_dev/")) return next();
        if (!isBrowserDevRequestAllowed(request)) {
          response.writeHead(403);
          response.end("Forbidden");
          return;
        }
        next();
      });
    },
  };
}
