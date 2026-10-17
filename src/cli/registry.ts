import type { CommandContext } from "./context";
import type { CommandArguments, FlagDefinition, PositionalDefinition } from "./args";
import { globalFlags, commandUsage } from "./args";
import { workspaceCommands } from "./commands/workspace";
import { accountCommands } from "./commands/accounts";
import { systemCommands } from "./commands/system";
import { workflows } from "./commands/workflows";
import { evidence } from "./commands/evidence";
import { ideas } from "./commands/ideas";
import { families } from "./commands/families";

export interface CommandDefinition {
  path: readonly string[];
  description: string;
  positionals?: readonly PositionalDefinition[];
  flags?: readonly FlagDefinition[];
  channels: readonly string[];
  billing?: "free" | "paid" | "conditional";
  workflowActions?: readonly string[];
  variants?: readonly string[];
  execute(context: CommandContext, args: CommandArguments): Promise<unknown>;
}

export const commands: readonly CommandDefinition[] = [
  ...systemCommands, ...accountCommands, ...workspaceCommands, ...workflows, ...evidence, ...ideas, ...families,
];

export const exitCodes = {
  0: "Success", 1: "Application error", 2: "Usage error", 3: "Preview or confirmation required", 4: "Owner unavailable or ownership conflict", 5: "Client timeout",
} as const;

export function describeCommands(definitions: readonly CommandDefinition[] = commands, prefix: readonly string[] = []) {
  return {
    commands: definitions.filter(command => prefix.every((part, index) => command.path[index] === part)).map(command => ({
      path: [...command.path], description: command.description, usage: commandUsage(command),
      positionals: command.positionals ?? [], flags: [...globalFlags, ...(command.flags ?? [])],
      channels: command.channels, billing: command.billing ?? "free", workflowActions: command.workflowActions ?? [], variants: command.variants ?? [],
    })),
    exitCodes,
    output: { envelope: "{ok:true,data} | {ok:false,error:{code,message,recovery?,reference?}}", default: "JSON when stdout is not a TTY", streaming: "run watch emits NDJSON events and final watch-end; timeout/Ctrl+C detach only" },
  };
}
