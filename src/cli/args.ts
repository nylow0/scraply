import { CliError } from "./output";
import type { CommandDefinition } from "./registry";

export interface FlagDefinition {
  name: string;
  type: "boolean" | "string" | "number";
  description: string;
  required?: boolean;
  multiple?: boolean;
  choices?: readonly string[];
}

export interface PositionalDefinition {
  name: string;
  description: string;
  required?: boolean;
  multiple?: boolean;
}

export interface CommandArguments {
  positionals: readonly string[];
  flags: Readonly<Record<string, string | boolean | readonly string[]>>;
}

export function stringFlag(args: CommandArguments, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === "string" ? value : undefined;
}

export function booleanFlag(args: CommandArguments, name: string): boolean {
  return args.flags[name] === true;
}

export function requirePositional(args: CommandArguments, index: number, nextCommand: string): string {
  const value = args.positionals[index];
  if (!value) throw new CliError("USAGE", `Missing argument. Next command: ${nextCommand}`, 2);
  return value;
}

export function numberFlag(args: CommandArguments, name: string): number | undefined {
  const value = stringFlag(args, name);
  if (value === undefined) return undefined;
  const result = Number(value);
  if (!Number.isFinite(result)) throw new CliError("USAGE", `--${name} requires a number.`, 2);
  return result;
}

export const globalFlags: readonly FlagDefinition[] = [
  { name: "json", type: "boolean", description: "Write the JSON response envelope." },
  { name: "data-dir", type: "string", description: "Use this profile root." },
  { name: "timeout", type: "number", description: "Client deadline in milliseconds, default 120000. Timeout detaches without cancelling work." },
  { name: "help", type: "boolean", description: "Describe the command without starting a host." },
  { name: "version", type: "boolean", description: "Print the package version without starting a host." },
];

export function commandUsage(command: CommandDefinition): string {
  return ["scraply", ...command.path, ...(command.positionals ?? []).map(arg => arg.required ? `<${arg.name}${arg.multiple ? "..." : ""}>` : `[${arg.name}${arg.multiple ? "..." : ""}]`),
    ...(command.flags ?? []).filter(flag => flag.required).map(flag => `--${flag.name}${flag.type === "boolean" ? "" : " <value>"}`)].join(" ");
}

/** Parse metadata once, then use the matched command's metadata for validation and help. */
export function parseArguments(argv: readonly string[], commands: readonly CommandDefinition[]) {
  const knownFlags = new Map([...globalFlags, ...commands.flatMap(command => command.flags ?? [])].map(flag => [flag.name, flag]));
  const flags: Record<string, string | boolean | string[]> = {};
  const words: string[] = [];
  let literal = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (literal) { words.push(token); continue; }
    if (token === "--") { literal = true; continue; }
    if (token === "-h") { flags.help = true; continue; }
    if (token === "-v") { flags.version = true; continue; }
    if (!token.startsWith("-")) { words.push(token); continue; }
    const equals = token.indexOf("=");
    const name = token.slice(2, equals < 0 ? undefined : equals);
    const flag = token.startsWith("--") ? knownFlags.get(name) : undefined;
    if (!flag) throw new CliError("USAGE", `Unknown flag ${token.split("=")[0]}. Next command: scraply help --json`, 2);
    let value: string | boolean;
    if (flag.type === "boolean") {
      if (equals >= 0) throw new CliError("USAGE", `--${name} does not take a value.`, 2);
      value = true;
    } else {
      const next = argv[index + 1];
      if (equals >= 0) value = token.slice(equals + 1);
      else if (next !== undefined && (!next.startsWith("--") && next !== "-h" && next !== "-v")) { value = next; index += 1; }
      else throw new CliError("USAGE", `Missing --${name} value. Next command: scraply ${words.join(" ")} --${name} <value>`, 2);
      if (value === "") throw new CliError("USAGE", `--${name} needs a nonempty value.`, 2);
    }
    if (flags[name] !== undefined) {
      if (!flag.multiple || typeof value !== "string") throw new CliError("USAGE", `--${name} may only appear once.`, 2);
      const previous = flags[name];
      flags[name] = typeof previous === "string" ? [previous, value] : [...(Array.isArray(previous) ? previous : []), value];
    } else flags[name] = value;
  }
  const help = flags.help === true || words[0] === "help" || words.length === 0;
  const pathWords = words[0] === "help" ? words.slice(1) : words;
  const version = flags.version === true;
  const matches = commands.filter(command => command.path.every((part, index) => part === pathWords[index]));
  const command = matches.sort((a, b) => b.path.length - a.path.length)[0];
  if (!command && pathWords.length && !help && !version) {
    const children = commands.filter(item => pathWords.every((word, index) => item.path[index] === word));
    const next = children[0];
    throw new CliError("USAGE", `Unknown or incomplete command. Next command: ${next ? commandUsage(next) : "scraply help --json"}`, 2);
  }
  if (help && pathWords.length && !command && !commands.some(item => pathWords.every((word, index) => item.path[index] === word))) {
    throw new CliError("USAGE", "Unknown help topic. Next command: scraply help --json", 2);
  }
  const allowed = new Map([...globalFlags, ...(command?.flags ?? [])].map(flag => [flag.name, flag]));
  for (const [name, value] of Object.entries(flags)) {
    const metadata = allowed.get(name);
    if (!metadata) throw new CliError("USAGE", `--${name} is not accepted here. Next command: scraply ${command ? `${command.path.join(" ")} --help` : "help --json"}`, 2);
    if (metadata?.type === "number" && (typeof value !== "string" || !Number.isFinite(Number(value)))) throw new CliError("USAGE", `--${name} requires a number.`, 2);
    if (metadata?.choices && (typeof value !== "string" || !metadata.choices.includes(value))) throw new CliError("USAGE", `--${name} must be ${metadata.choices.join(" | ")}.`, 2);
  }
  const timeout = flags.timeout;
  if (typeof timeout === "string" && (!Number.isSafeInteger(Number(timeout)) || Number(timeout) <= 0 || Number(timeout) > 2_147_483_647)) {
    throw new CliError("USAGE", "--timeout requires a positive integer up to 2147483647 milliseconds.", 2);
  }
  const positionals = command ? pathWords.slice(command.path.length) : [];
  if (command && !help && !version) {
    const metadata = command.positionals ?? [];
    for (let index = 0; index < metadata.length; index += 1) {
      if (metadata[index]?.required && !positionals[index]) throw new CliError("USAGE", `Missing ${metadata[index]!.name}. Next command: ${commandUsage(command)}`, 2);
    }
    if (!metadata.some(arg => arg.multiple) && positionals.length > metadata.length) throw new CliError("USAGE", `Too many arguments. Next command: ${commandUsage(command)}`, 2);
    for (const flag of command.flags ?? []) {
      if (flag.required && flags[flag.name] === undefined) throw new CliError("USAGE", `Missing --${flag.name}. Next command: ${commandUsage(command)}`, 2);
    }
  }
  return { command, args: { flags, positionals } satisfies CommandArguments, help, version, helpPath: help && command ? command.path : pathWords };
}
