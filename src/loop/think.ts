import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CliError } from "../cli/output";
import type { Ledger } from "../cli/ledger";
import { deriveJsonSchema } from "../shared/json-schema";

/**
 * The thinking in a loop step is done by the agent that calls Scraply, not by Scraply. A step asks for it with
 * `context.think(request)`. `agentThinker` answers with the one answer the agent submitted for that request, or
 * stops the loop with `ThinkNeeded`, which `scraply next` turns into a work order: the shared method
 * (`prompts/loop/method.md`), the step's own instructions (`prompts/loop/<step>.md`), its inputs, the sources to
 * read, and the JSON schema of the answer. `scraply submit` hands the answer back and the step finishes.
 */

const PROMPTS = join(import.meta.dir, "..", "..", "prompts", "loop");
export const STEPS = ["frame", "survey", "split", "design", "script", "read", "verdict", "review", "findings"] as const;
export type Step = (typeof STEPS)[number];

export interface ThinkRequest<T> {
  step: Step;
  goal: string;
  inputs: unknown;
  /** Saved sources the step must read in full, by source ID. Their text is untrusted data. */
  sources?: readonly string[];
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  /** Steps that must be thought by someone who did not do the work, such as a review. */
  independent?: boolean;
}
export type Think = <T>(request: ThinkRequest<T>) => Promise<T>;

/** Thrown by a step that needs thinking nobody has submitted yet; carries what to ask for. */
export class ThinkNeeded extends Error {
  constructor(readonly request: ThinkRequest<unknown>) {
    super(`The ${request.step} step needs an answer.`);
  }
}

/** The newest step-log entry of a project, 0 before the first; an order names it, so it goes stale once anything is logged. */
export function headStep(ledger: Ledger, projectId: number) {
  return ledger.steps(projectId).at(-1)?.id ?? 0;
}

/**
 * Names one request in one project at one point of its step log, as `<step>-<head step>-<hash>`. The hash covers
 * the project (its number and creation time, so a P1 in another ledger differs), the goal, inputs, and sources, so
 * an answer is only ever applied to the work order it was written for: not to another project or ledger, another
 * pass, or one whose inputs changed since, such as by a new constraint from the owner.
 */
export function orderId(request: ThinkRequest<unknown>, ledger: Ledger, projectId: number) {
  const content = JSON.stringify([`P${projectId}`, ledger.requireProject(projectId).createdAt, request.goal, request.inputs, request.sources ?? []]);
  return `${request.step}-${headStep(ledger, projectId)}-${createHash("sha256").update(content).digest("hex").slice(0, 8)}`;
}

/** The start and the end of a long text within `max` characters; programs usually print their results last. */
export function headAndTail(text: string, max: number) {
  if (text.length <= max) return text;
  const head = Math.floor(max / 4);
  return `${text.slice(0, head)}\n[... ${text.length - max} characters left out ...]\n${text.slice(text.length - (max - head))}`;
}

/**
 * A thinker that uses `answer` for the request it was written for and stops at any other. `used` tells the caller
 * whether the answer was applied, so an answer to a stale work order is refused instead of silently dropped.
 */
export function agentThinker(ledger: Ledger, projectId: number, answer?: { order: string; value: unknown }) {
  const state = { used: false };
  const think: Think = async request => {
    if (answer && !state.used && orderId(request, ledger, projectId) === answer.order) {
      state.used = true;
      const parsed = request.schema.safeParse(answer.value);
      if (!parsed.success) {
        throw new CliError("BAD_ANSWER", `The answer does not match the ${request.step} schema: ${parsed.error.issues.map(issue => `${issue.path.join(".") || "answer"}: ${issue.message}`).join("; ")}. Fix it and submit again.`, 2);
      }
      return parsed.data;
    }
    throw new ThinkNeeded(request);
  };
  return { think, state };
}

/** Everything the calling agent needs to do one step's thinking, with sources by reference rather than inline. */
export function workOrder(request: ThinkRequest<unknown>, ledger: Ledger, projectId: number) {
  const order = orderId(request, ledger, projectId);
  const saved = ledger.show(projectId).sources;
  return {
    order,
    step: request.step,
    goal: request.goal,
    ...(request.independent ? {
      independent: "Do not answer this yourself if you did any earlier step of this project. Give this whole work order to a fresh subagent that did not, have it return only the answer, and submit that.",
    } : {}),
    method: readFileSync(join(PROMPTS, "method.md"), "utf8"),
    instructions: readFileSync(join(PROMPTS, `${request.step}.md`), "utf8"),
    inputs: request.inputs,
    sources: (request.sources ?? []).map(id => saved.find(source => source.id === id)),
    answerSchema: deriveJsonSchema(request.schema),
    next: `Read every source in full (scraply source show <id>, repeating with --offset <nextOffset> until it is gone), then submit: scraply submit --project P${projectId} --order ${order} --answer '<JSON matching answerSchema>'`,
  };
}
