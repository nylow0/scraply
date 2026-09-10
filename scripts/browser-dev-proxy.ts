import type { IncomingMessage } from "node:http";
import type { Plugin } from "vite";

export const BROWSER_DEV_ORIGIN = "http://127.0.0.1:5173";

export function isBrowserDevRequestAllowed(request: Pick<IncomingMessage, "method" | "headers">): boolean {
  if (request.headers.host !== "127.0.0.1:5173") return false;
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
