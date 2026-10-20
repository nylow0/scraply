import { describe, expect, test } from "bun:test";
import { parseArguments } from "../../../src/cli/args";
import { CliError } from "../../../src/cli/output";
import type { CommandDefinition } from "../../../src/cli/registry";

const definitions: CommandDefinition[] = [
  { path: ["brief", "set"], description: "Save a brief.", channels: [], flags: [
    { name: "stdin", type: "boolean", description: "Read stdin." },
    { name: "file", type: "string", description: "Read a file." },
    { name: "observations", type: "string", description: "Brief text." },
    { name: "off-limits", type: "string", description: "Boundary.", multiple: true },
  ], async execute() { return null; } },
  { path: ["run", "show"], description: "Read a run.", channels: [], positionals: [{ name: "id", description: "Run ID.", required: true }], async execute() { return null; } },
];

describe("CLI arguments", () => {
  test("preserves multiline text, spaces, equals signs and repeated boundaries", () => {
    const parsed = parseArguments(["--data-dir", "C:\\synthetic profile", "brief", "set", "--observations", "line one\nline two = value", "--off-limits=first", "--off-limits", "second", "--json"], definitions);
    expect(parsed.command?.path).toEqual(["brief", "set"]);
    expect(parsed.args.flags).toEqual({ "data-dir": "C:\\synthetic profile", observations: "line one\nline two = value", "off-limits": ["first", "second"], json: true });
  });

  test("stdin is a boolean source flag and never consumes the next argument", () => {
    expect(parseArguments(["brief", "set", "--stdin"], definitions).args.flags.stdin).toBe(true);
    expect(() => parseArguments(["brief", "set", "--stdin", "secret"], definitions)).toThrow("Too many arguments");
  });

  test("unknown, misplaced and duplicate flags fail", () => {
    for (const argv of [["run", "show", "r", "--stdin"], ["brief", "set", "--made-up"], ["brief", "set", "--json", "--json"], ["brief", "set", "--stdin=false"]]) {
      expect(() => parseArguments(argv, definitions)).toThrow(CliError);
    }
  });

  test("missing argument and incomplete command give exact next command", () => {
    expect(() => parseArguments(["run", "show"], definitions)).toThrow("Next command: scraply run show <id>");
    expect(() => parseArguments(["run"], definitions)).toThrow("Next command: scraply run show <id>");
  });

  test("help bypasses required arguments and filters a command group", () => {
    expect(parseArguments(["run", "show", "--help", "--json"], definitions).help).toBe(true);
    expect(parseArguments(["help", "run", "--json"], definitions).helpPath).toEqual(["run"]);
    expect(parseArguments(["run", "show", "synthetic-id", "--help"], definitions).helpPath).toEqual(["run", "show"]);
    expect(() => parseArguments(["help", "--stdin"], definitions)).toThrow("not accepted");
  });

  test("timeout is bounded and literal IDs beginning with dashes use --", () => {
    expect(parseArguments(["run", "show", "--", "--synthetic-id"], definitions).args.positionals).toEqual(["--synthetic-id"]);
    for (const value of ["0", "-1", "1.5", "no", "2147483648"]) expect(() => parseArguments(["run", "show", "id", "--timeout", value], definitions)).toThrow(CliError);
  });
});
