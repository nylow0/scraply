import { Agent, OpenAIProvider, Runner } from "@openai/agents";
import { z } from "zod";
import type { ResearchReasoner } from "../research/loop";
import type { ResearchSynthesizer, SynthesisInput } from "../research/synthesis";
import type { IntakeBrief, ResearchStream } from "../store/schema";

const ResearchPlanSchema = z.object({ queries: z.array(z.string().min(1)).min(1).max(10) });
const ResearchReflectionSchema = z.object({
  coverage: z.number().min(0).max(1),
  gaps: z.array(z.string().min(1)),
  followUpQueries: z.array(z.string().min(1)).max(10),
});
const ResearchSynthesisOutputSchema = z.object({ summary: z.string().min(1) });

export class OpenCodeResearchReasoner implements ResearchReasoner {
  private readonly runner: Runner;
  private readonly planner: Agent<unknown, typeof ResearchPlanSchema>;
  private readonly reflector: Agent<unknown, typeof ResearchReflectionSchema>;

  constructor(options: { apiKey: string; baseUrl?: string; model?: string }) {
    const model = options.model ?? "glm-5.2";
    const provider = new OpenAIProvider({
      apiKey: options.apiKey,
      baseURL: options.baseUrl ?? "https://opencode.ai/zen/go/v1",
      useResponses: false,
    });
    this.runner = new Runner({ modelProvider: provider, tracingDisabled: true });
    this.planner = new Agent({
      name: "Research planner",
      model,
      outputType: ResearchPlanSchema,
      instructions: "Produce answerable web-search queries for only the configured research stream. Respect the brief, constraints, and query limit. Do not generate final ideas.",
    });
    this.reflector = new Agent({
      name: "Research coverage reflector",
      model,
      outputType: ResearchReflectionSchema,
      instructions: "Assess evidence coverage for the configured stream. Return calibrated coverage from 0 to 1, explicit gaps, and only queries that close those gaps. Do not generate final ideas.",
    });
  }

  async plan(brief: IntakeBrief, stream: ResearchStream) {
    const result = await this.runner.run(this.planner, JSON.stringify({ brief, stream }));
    if (!result.finalOutput) throw new Error("Research planner returned no structured output");
    return ResearchPlanSchema.parse(result.finalOutput);
  }

  async reflect(input: Parameters<ResearchReasoner["reflect"]>[0]) {
    const result = await this.runner.run(this.reflector, JSON.stringify({
      ...input,
      claims: input.claims.map(({ embedding: _embedding, ...claim }) => claim),
    }));
    if (!result.finalOutput) throw new Error("Research reflector returned no structured output");
    return ResearchReflectionSchema.parse(result.finalOutput);
  }
}

export class OpenCodeResearchSynthesizer implements ResearchSynthesizer {
  readonly model: string;
  private readonly runner: Runner;
  private readonly agent: Agent<unknown, typeof ResearchSynthesisOutputSchema>;

  constructor(options: { apiKey: string; baseUrl?: string; model?: string }) {
    this.model = options.model ?? "glm-5.2";
    const provider = new OpenAIProvider({
      apiKey: options.apiKey,
      baseURL: options.baseUrl ?? "https://opencode.ai/zen/go/v1",
      useResponses: false,
    });
    this.runner = new Runner({ modelProvider: provider, tracingDisabled: true });
    this.agent = new Agent({
      name: "Research synthesizer",
      model: this.model,
      outputType: ResearchSynthesisOutputSchema,
      instructions: "Synthesize the six research streams into a concise, decision-useful Markdown summary. Reconcile cross-stream evidence, name uncertainties and failures, cite claim IDs inline, and recommend concrete next validation steps. Do not invent evidence or product ideas.",
    });
  }

  async synthesize(input: SynthesisInput): Promise<string> {
    const result = await this.runner.run(this.agent, JSON.stringify({
      ...input,
      claims: input.claims.map(({ embedding: _embedding, ...claim }) => claim),
    }));
    if (!result.finalOutput) throw new Error("Research synthesizer returned no structured output");
    return ResearchSynthesisOutputSchema.parse(result.finalOutput).summary;
  }
}
