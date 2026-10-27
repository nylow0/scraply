import { CliError } from "./output";

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
}

export interface CommandArguments {
  positionals: readonly string[];
  flags: Readonly<Record<string, string | boolean | readonly string[]>>;
}

/** The shape every command shares; `run` receives already validated arguments. */
export interface CommandShape {
  path: readonly string[];
  flags?: readonly FlagDefinition[];
  positionals?: readonly PositionalDefinition[];
}

export const globalFlags: readonly FlagDefinition[] = [
  { name: "json", type: "boolean", description: "Write the JSON envelope even in a terminal. Piped output is always JSON." },
  { name: "data-dir", type: "string", description: "Use this folder for the ledger instead of SCRAPLY_DATA_DIR or %APPDATA%\\scraply\\cli." },
  { name: "help", type: "boolean", description: "Describe commands instead of running one." },
];

export function stringFlag(args: CommandArguments, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === "string" ? value : undefined;
}

export function requiredFlag(args: CommandArguments, name: string): string {
  const value = stringFlag(args, name);
  if (value === undefined) throw new CliError("USAGE", `Missing --${name}.`, 2);
  return value;
}

export function listFlag(args: CommandArguments, name: string): string[] {
  const value = args.flags[name];
  return typeof value === "string" ? [value] : Array.isArray(value) ? [...value] : [];
}

export function commandUsage(command: CommandShape): string {
  return ["scraply", ...command.path,
    ...(command.positionals ?? []).map(arg => arg.required ? `<${arg.name}>` : `[${arg.name}]`),
    ...(command.flags ?? []).filter(flag => flag.required).map(flag => `--${flag.name} <${flag.name}>`)].join(" ");
}

/** Match the longest command path, then validate flags and positionals against that command only. */
export function parseArguments<T extends CommandShape>(argv: readonly string[], commands: readonly T[]) {
  const words: string[] = [];
  const raw: { name: string; value: string | true; token: string }[] = [];
  let literal = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (literal || !token.startsWith("-") || token === "-") { words.push(token); continue; }
    if (token === "--") { literal = true; continue; }
    if (token === "-h") { raw.push({ name: "help", value: true, token }); continue; }
    const equals = token.indexOf("=");
    const name = token.slice(2, equals < 0 ? undefined : equals);
    if (!token.startsWith("--") || !name) throw new CliError("USAGE", `Unknown flag ${token}. Run: scraply help`, 2);
    const known = [...globalFlags, ...commands.flatMap(command => command.flags ?? [])].find(flag => flag.name === name);
    if (known?.type === "boolean") {
      if (equals >= 0) throw new CliError("USAGE", `--${name} does not take a value.`, 2);
      raw.push({ name, value: true, token });
      continue;
    }
    const next = argv[index + 1];
    if (equals >= 0) raw.push({ name, value: token.slice(equals + 1), token });
    else if (next !== undefined && !next.startsWith("--")) { raw.push({ name, value: next, token }); index += 1; }
    else throw new CliError("USAGE", `--${name} needs a value.`, 2);
  }

  const help = raw.some(flag => flag.name === "help") || words[0] === "help" || words.length === 0;
  const path = words[0] === "help" ? words.slice(1) : words;
  const command = commands
    .filter(item => item.path.every((part, index) => part === path[index]))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (!command && !help) throw new CliError("USAGE", `Unknown command "${path.join(" ")}". Run: scraply help`, 2);
  // `scraply source show S1 --help` describes `source show`, not commands starting with `S1`.
  if (help) return { command, help, helpPath: command?.path ?? path, args: { positionals: [], flags: {} } };

  const allowed = [...globalFlags, ...(command!.flags ?? [])];
  const flags: Record<string, string | boolean | string[]> = {};
  for (const { name, value, token } of raw) {
    const flag = allowed.find(item => item.name === name);
    if (!flag) throw new CliError("USAGE", `${token} is not accepted by "${command!.path.join(" ")}". Run: scraply help ${command!.path.join(" ")}`, 2);
    if (typeof value === "string" && !value.trim()) throw new CliError("USAGE", `--${name} needs a nonempty value.`, 2);
    if (flag.type === "number" && !Number.isFinite(Number(value))) throw new CliError("USAGE", `--${name} needs a number.`, 2);
    if (flag.choices && (typeof value !== "string" || !flag.choices.includes(value))) {
      throw new CliError("USAGE", `--${name} must be one of: ${flag.choices.join(", ")}.`, 2);
    }
    const previous = flags[name];
    if (previous === undefined) flags[name] = value;
    else if (flag.multiple && typeof value === "string") flags[name] = [...(Array.isArray(previous) ? previous : [String(previous)]), value];
    else throw new CliError("USAGE", `--${name} may only appear once.`, 2);
  }
  for (const flag of command!.flags ?? []) {
    if (flag.required && flags[flag.name] === undefined) throw new CliError("USAGE", `Missing --${flag.name}. Usage: ${commandUsage(command!)}`, 2);
  }
  const positionals = path.slice(command!.path.length);
  const expected = command!.positionals ?? [];
  if (positionals.length > expected.length) throw new CliError("USAGE", `Too many arguments. Usage: ${commandUsage(command!)}`, 2);
  expected.forEach((arg, index) => {
    if (arg.required && !positionals[index]) throw new CliError("USAGE", `Missing ${arg.name}. Usage: ${commandUsage(command!)}`, 2);
  });
  return { command, help, helpPath: path, args: { positionals, flags } satisfies CommandArguments };
}
