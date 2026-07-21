import { isIP } from "node:net";
import { pathToFileURL } from "node:url";
import { AppError } from "../shared/errors";
import { OpenExternalUrlRequestSchema } from "../shared/ipc";

export function rendererEntryUrl(rendererPath: string, developmentUrl?: string): string {
  if (developmentUrl) return new URL(developmentUrl).href;
  return pathToFileURL(rendererPath).href;
}

export function isAllowedRendererUrl(candidate: string, expectedEntry: string): boolean {
  try {
    const actual = new URL(candidate);
    const expected = new URL(expectedEntry);
    if (expected.protocol === "file:") {
      actual.hash = "";
      expected.hash = "";
      return actual.href.toLowerCase() === expected.href.toLowerCase();
    }
    return actual.origin === expected.origin;
  } catch {
    return false;
  }
}

export function parseExternalHttpsUrl(input: unknown): string {
  const { url: rawUrl } = OpenExternalUrlRequestSchema.parse(input);
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AppError("validation_error", "Enter a valid HTTPS URL.");
  }

  if (url.protocol !== "https:" || url.username || url.password || isLoopbackHostname(url.hostname)) {
    throw new AppError("validation_error", "Only public HTTPS links can be opened.");
  }
  return url.href;
}

function isLoopbackHostname(input: string): boolean {
  const hostname = input.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "::1" || hostname === "0:0:0:0:0:0:0:1") {
    return true;
  }
  if (hostname === "0.0.0.0" || hostname === "::") return true;
  if (isIP(hostname) === 4) return hostname.split(".")[0] === "127";
  return hostname.startsWith("::ffff:127.");
}
