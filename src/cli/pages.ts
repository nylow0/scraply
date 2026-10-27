import { z } from "zod";
import { ExaClient } from "../providers/exa";
import { PerplexityClient } from "../providers/perplexity";
import type { FetchedSource } from "./ledger";
import { CliError } from "./output";

/** Enough for a long forum thread; quotes must come from text that was actually saved. */
export const MAX_SOURCE_CHARS = 30_000;
const TIMEOUT_MS = 30_000;

type Fetcher = typeof fetch;

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", euro: "€", pound: "£", copy: "©", times: "×",
};

/** Readable text from HTML: drop code and chrome, keep block boundaries as line breaks. */
export function htmlToText(html: string): { title?: string; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|head|template)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|li|ul|ol|h[1-6]|tr|td|th|table|section|article|blockquote|pre|header|footer|nav|aside|main|dd|dt)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  const decode = (value: string) => value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    if (code[0] === "#") {
      const point = code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
    }
    return ENTITIES[code.toLowerCase()] ?? entity;
  });
  const lines = decode(text).split("\n").map(line => line.replace(/[ \t ]+/g, " ").trim());
  const cleanTitle = title ? decode(title).replace(/\s+/g, " ").trim() : "";
  return { ...(cleanTitle ? { title: cleanTitle } : {}), text: lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() };
}

/** Read one page directly. Anything but a plain 200 with readable text is a failed source, not an error. */
export async function fetchDirect(url: string, fetcher: Fetcher = fetch): Promise<FetchedSource> {
  try {
    const response = await fetcher(url, {
      headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) scraply-cli", accept: "text/html,text/plain;q=0.9,*/*;q=0.1" },
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status !== 200) return { url, via: "direct", error: `HTTP ${response.status}. Try: scraply fetch <url> --via exa` };
    const type = response.headers.get("content-type") ?? "";
    const body = await response.text();
    if (type.includes("text/plain")) return { url, via: "direct", text: body.slice(0, MAX_SOURCE_CHARS) };
    if (!type.includes("html")) return { url, via: "direct", error: `Unsupported content type ${type || "(none)"}.` };
    const page = htmlToText(body);
    return { url, via: "direct", ...(page.title ? { title: page.title } : {}), text: page.text.slice(0, MAX_SOURCE_CHARS) };
  } catch (error) {
    return { url, via: "direct", error: error instanceof Error ? error.message : "The request failed." };
  }
}

const ExaContentsSchema = z.object({
  results: z.array(z.object({ url: z.string(), title: z.string().nullish(), text: z.string().nullish() }).passthrough()),
  statuses: z.array(z.object({ status: z.string(), error: z.unknown().optional() }).passthrough()).optional(),
}).passthrough();

/** Read one page through Exa's crawler, which reaches many sites that block plain scripts. */
export async function fetchViaExa(url: string, apiKey: string, fetcher: Fetcher = fetch): Promise<FetchedSource> {
  try {
    const response = await fetcher("https://api.exa.ai/contents", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ urls: [url], text: { maxCharacters: MAX_SOURCE_CHARS }, livecrawl: "fallback" }),
      signal: AbortSignal.timeout(TIMEOUT_MS * 2),
    });
    if (!response.ok) return { url, via: "exa-contents", error: `Exa contents returned HTTP ${response.status}.` };
    const parsed = ExaContentsSchema.parse(await response.json());
    const result = parsed.results[0];
    if (!result?.text?.trim()) {
      const status = parsed.statuses?.[0];
      return { url, via: "exa-contents", error: status ? `Exa could not read the page: ${JSON.stringify(status.error ?? status.status)}` : "Exa returned no text." };
    }
    return { url: result.url, via: "exa-contents", ...(result.title ? { title: result.title } : {}), text: result.text };
  } catch (error) {
    return { url, via: "exa-contents", error: error instanceof Error ? error.message : "The request failed." };
  }
}

/** Run one web search. Every result keeps its full returned text so it can be quoted later. */
export async function search(provider: "exa" | "perplexity", apiKey: string, query: string, results: number, fetcher: Fetcher = fetch): Promise<FetchedSource[]> {
  const client = provider === "exa" ? new ExaClient(apiKey, fetcher) : new PerplexityClient(apiKey, fetcher);
  try {
    const sources = await client.search(query, { numResults: results, maxCharacters: MAX_SOURCE_CHARS, timeoutMs: TIMEOUT_MS * 2 });
    return sources.map(source => ({ url: source.url, title: source.title, via: provider, query, text: source.text }));
  } catch (error) {
    throw new CliError("SEARCH_FAILED", `${provider} search failed: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}
