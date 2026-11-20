import { createInterface } from "node:readline";
import { z } from "zod";
import { version } from "../../package.json";
import type { CommandArguments, FlagDefinition, PositionalDefinition } from "./args";
import { commandContext, commands, type Command, type ContextOptions } from "./commands";
import { CliError, errorResponse } from "./output";

/**
 * `scraply mcp`: every command as an MCP tool over stdio (newline-delimited JSON-RPC 2.0), so a model can drive
 * Scraply with typed tools instead of a shell. A tool is a command's path joined by `_` (`quote_add`); its
 * positionals and flags become named arguments. Tool calls run one at a time, each with its own ledger handle,
 * exactly as one CLI call would. `key set` and `key remove` are left out: keys are piped in at a terminal so they
 * never pass through a model's transcript.
 */

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LEFT_OUT = new Set(["mcp", "key_set", "key_remove"]);
/** Flags whose value is JSON: a model passes an object, the command gets its text. */
const JSON_FLAGS = new Set(["answer"]);

const INSTRUCTIONS = `Scraply kill-tests the owner's seed against raw evidence until an idea worth doing survives. You do the thinking; Scraply keeps the evidence and enforces its rules.
Start with project_new (the seed in the owner's words), then call next. status "think" returns a work order: follow its method and instructions, read every listed source in full with source_show, and answer with submit. A work order marked independent goes to a fresh subagent that did not do the earlier steps. status "needs-you" names what only the owner can do (answer questions, approve an experiment after reading it, pick a variant): ask them, never decide for them. status "done" means the pass is finished.`;

const RequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.record(z.unknown()).optional(),
});
const CallSchema = z.object({ name: z.string(), arguments: z.record(z.unknown()).default({}) });

const toolName = (command: Command) => command.path.join("_");

function flagSchema(flag: FlagDefinition) {
  if (JSON_FLAGS.has(flag.name)) return { type: "object", description: flag.description };
  const type = flag.type === "boolean" ? "boolean" : flag.type === "number" ? "number" : "string";
  const one = { type, ...(flag.choices ? { enum: flag.choices } : {}) };
  return flag.multiple ? { type: "array", items: one, description: flag.description } : { ...one, description: flag.description };
}

function positionalSchema(positional: PositionalDefinition) {
  return positional.variadic
    ? { type: "array", items: { type: "string" }, description: positional.description }
    : { type: "string", description: positional.description };
}

function toolFor(command: Command) {
  const positionals = command.positionals ?? [];
  const flags = command.flags ?? [];
  return {
    name: toolName(command),
    description: command.description,
    inputSchema: {
      type: "object",
      properties: Object.fromEntries([
        ...positionals.map(item => [item.name, positionalSchema(item)] as const),
        ...flags.map(item => [item.name, flagSchema(item)] as const),
      ]),
      required: [...positionals.filter(item => item.required).map(item => item.name), ...flags.filter(item => item.required).map(item => item.name)],
      additionalProperties: false,
    },
  };
}

/** Zod for one tool's arguments, built from the same definitions as its JSON Schema. */
function argumentSchema(command: Command) {
  const optional = <T extends z.ZodTypeAny>(schema: T, required: boolean | undefined) => required ? schema : schema.optional();
  const text = (choices?: readonly string[]) => choices ? z.enum(choices as [string, ...string[]]) : z.string();
  const shape: z.ZodRawShape = {};
  for (const item of command.positionals ?? []) shape[item.name] = optional(item.variadic ? z.array(z.string()).min(1) : z.string(), item.required);
  for (const item of command.flags ?? []) {
    // Some clients send a nested object as JSON text; take either.
    const value = JSON_FLAGS.has(item.name) ? z.union([z.string(), z.record(z.unknown()), z.array(z.unknown())]).transform(json => typeof json === "string" ? json : JSON.stringify(json))
      : item.type === "boolean" ? z.boolean()
        : item.type === "number" ? z.number().transform(String)
          : item.multiple ? z.array(text(item.choices)) : text(item.choices);
    shape[item.name] = optional(value, item.required);
  }
  return z.object(shape).strict();
}

/** Tool arguments as the command line would have parsed them. */
function toArguments(command: Command, raw: Record<string, unknown>): CommandArguments {
  const parsed = argumentSchema(command).parse(raw);
  const positionals = (command.positionals ?? []).flatMap(item => {
    const value = parsed[item.name];
    return value === undefined ? [] : Array.isArray(value) ? value.map(String) : [String(value)];
  });
  const flags: Record<string, string | boolean | readonly string[]> = {};
  for (const item of command.flags ?? []) {
    const value = parsed[item.name];
    if (typeof value === "string" || value === true || (Array.isArray(value) && value.every(entry => typeof entry === "string"))) flags[item.name] = value;
  }
  return { positionals, flags };
}

export interface McpOptions extends ContextOptions {
  /** Where responses go; stdout by default. */
  write?: (text: string) => void;
  /** Incoming lines; stdin by default. */
  input?: AsyncIterable<string> | Iterable<string>;
}

/** Serve until the input ends. Every response is one line on stdout; progress goes to stderr. */
export async function serveMcp(options: McpOptions) {
  const write = options.write ?? (text => { process.stdout.write(text); });
  const send = (message: unknown) => write(`${JSON.stringify(message)}\n`);
  const tools = commands.filter(command => !LEFT_OUT.has(toolName(command)));

  async function call(params: unknown) {
    const { name, arguments: raw } = CallSchema.parse(params);
    const command = tools.find(item => toolName(item) === name);
    if (!command) throw new CliError("USAGE", `No tool named ${name}.`, 2);
    const { context, close } = commandContext({
      ...options,
      readStdin: () => Promise.reject(new CliError("USAGE", "Pass the value as an argument; this tool has no stdin.", 2)),
    });
    try {
      return { content: [{ type: "text", text: JSON.stringify(await command.run(context, toArguments(command, raw))) }] };
    } catch (error) {
      return { content: [{ type: "text", text: JSON.stringify(errorResponse(error).response.error) }], isError: true };
    } finally {
      close();
    }
  }

  async function handle(line: string) {
    let request: z.infer<typeof RequestSchema>;
    try { request = RequestSchema.parse(JSON.parse(line)); }
    catch { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Expected one JSON-RPC 2.0 message per line." } }); return; }
    // Notifications (no id), such as notifications/initialized, need no answer.
    if (request.id === undefined) return;
    const reply = (result: unknown) => send({ jsonrpc: "2.0", id: request.id, result });
    switch (request.method) {
      case "initialize": {
        const asked = z.object({ protocolVersion: z.string() }).safeParse(request.params);
        return reply({
          protocolVersion: asked.success && PROTOCOL_VERSIONS.includes(asked.data.protocolVersion) ? asked.data.protocolVersion : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: "scraply", version },
          instructions: INSTRUCTIONS,
        });
      }
      case "ping": return reply({});
      case "tools/list": return reply({ tools: tools.map(toolFor) });
      case "tools/call":
        try { return reply(await call(request.params)); }
        catch (error) { return send({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: errorResponse(error).response.error.message } }); }
      default: return send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `Unknown method ${request.method}.` } });
    }
  }

  // One message at a time, so two tool calls never write the ledger at once.
  for await (const line of options.input ?? createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    if (line.trim()) await handle(line);
  }
}
