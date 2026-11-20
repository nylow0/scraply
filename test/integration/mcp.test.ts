import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveMcp } from "../../src/cli/mcp";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "scraply-mcp-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

interface Reply { id: number; result?: { tools?: { name: string; inputSchema: { required: string[] } }[]; content?: { text: string }[]; isError?: boolean; protocolVersion?: string; instructions?: string }; error?: { code: number; message: string } }

/** Send JSON-RPC messages to the server the way an MCP client does over stdio, and collect its replies by ID. */
async function session(messages: readonly unknown[]) {
  const lines: string[] = [];
  // No search keys and an empty profile, so nothing real is read.
  const env = { APPDATA: join(root, "appdata"), SCRAPLY_DATA_DIR: join(root, "ledger"), EXA_API_KEY: "", PERPLEXITY_API_KEY: "" };
  await serveMcp({ env, notify: () => undefined, write: text => { lines.push(text); }, input: messages.map(message => JSON.stringify(message)) });
  return new Map(lines.map(line => JSON.parse(line) as Reply).map(reply => [reply.id, reply]));
}

const call = (id: number, name: string, args: Record<string, unknown>) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const data = (reply: Reply | undefined) => JSON.parse(reply!.result!.content![0]!.text) as Record<string, unknown>;

test("a model drives a project through MCP tools: work orders out, typed answers in, and refusals as tool errors", async () => {
  const replies = await session([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    call(3, "project_new", { name: "gardens", seed: "Community gardens struggle to coordinate watering in summer." }),
    call(4, "next", { project: "P1" }),
    // The answer is a JSON object, not a string; this one breaks the schema.
    call(5, "submit", { project: "P1", order: "frame-00000000", answer: { framing: "x" } }),
    call(6, "quote_add", { source: "S9", speaker: "nobody", kind: "other", text: "Not a saved source at all." }),
    call(7, "key_set", { provider: "exa" }),
    call(8, "project_new", { name: "gardens", seed: "x", stray: true }),
    // Blank text is refused, as on the command line, so it cannot pass for the owner's answer.
    call(9, "note_add", { project: "P1", kind: "constraint", text: "   " }),
    // A command keeps empty arguments, as on the command line, but needs a program name.
    call(10, "experiment_run", { test: "T1", command: ["  ", "x"] }),
    call(11, "experiment_run", { test: "T1", command: ["bun", "-e", ""] }),
    call(12, "experiment_run", { test: "T1", command: [] }),
  ]);
  expect(replies.get(1)?.result).toMatchObject({ protocolVersion: "2025-06-18", instructions: expect.stringContaining("work order") });

  // Every command but the key commands is a tool, with its required arguments marked.
  const tools = replies.get(2)!.result!.tools!;
  const names = tools.map(tool => tool.name);
  for (const name of ["next", "submit", "search", "fetch", "source_show", "quote_add", "show", "experiment_approve", "variant_accept"]) expect(names).toContain(name);
  for (const name of ["key_set", "key_remove", "mcp"]) expect(names).not.toContain(name);
  expect(tools.find(tool => tool.name === "submit")!.inputSchema.required).toEqual(["project", "order", "answer"]);

  expect(data(replies.get(3))).toMatchObject({ id: "P1" });
  const order = data(replies.get(4)) as { status: string; workOrder: { step: string; order: string } };
  expect(order).toMatchObject({ status: "think", workOrder: { step: "frame" } });

  // An answer to an order nobody asked for, a ledger refusal, and an unknown argument come back as tool errors.
  expect(replies.get(5)!.result).toMatchObject({ isError: true });
  expect(data(replies.get(5))).toMatchObject({ code: "STALE_ORDER" });
  expect(replies.get(6)!.result).toMatchObject({ isError: true });
  // An unknown tool is a protocol error, as MCP asks.
  expect(replies.get(7)).toMatchObject({ error: { code: -32602, message: "No tool named key_set." } });
  expect(replies.get(8)!.result).toMatchObject({ isError: true });
  expect(replies.get(9)!.result).toMatchObject({ isError: true });
  expect(data(replies.get(9))).toMatchObject({ message: expect.stringContaining("nonempty") });
  expect(data(replies.get(10))).toMatchObject({ code: "USAGE", message: expect.stringContaining("program name") });
  // The empty argument passes validation and reaches the command, which refuses the missing test instead.
  expect(data(replies.get(11))).not.toMatchObject({ code: "USAGE" });
  expect(data(replies.get(12))).toMatchObject({ code: "USAGE", message: expect.stringContaining("program name") });
});

test("a submitted answer object is checked against the work order's schema and moves the loop on", async () => {
  const first = await session([call(1, "project_new", { name: "gardens", seed: "Community gardens struggle to coordinate watering in summer." }), call(2, "next", { project: "P1" })]);
  const order = (data(first.get(2)) as { workOrder: { order: string } }).workOrder.order;
  const replies = await session([
    call(1, "submit", { project: "P1", order, answer: { framing: "A coordinator would read garden club forums." } }),
    // Some clients send the object as JSON text; that works too.
    call(2, "submit", { project: "P1", order, answer: JSON.stringify({ framing: "A coordinator would read garden club forums.", surveyQueries: [], questions: [{ question: "How many plots?", assumption: "About twenty." }] }) }),
  ]);
  expect(data(replies.get(1))).toMatchObject({ code: "BAD_ANSWER", message: expect.stringContaining("surveyQueries") });
  // With no search key the survey is skipped, and the framing question stops the loop for the owner.
  expect(data(replies.get(2))).toMatchObject({ status: "needs-you", steps: [{ step: "frame" }, { step: "survey" }, { step: "survey", did: expect.stringContaining("no search key") }, { step: "questions" }] });
});
