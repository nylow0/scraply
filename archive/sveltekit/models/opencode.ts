import { Agent, OpenAIProvider, Runner } from "@openai/agents";
import { ClaimExtractionSchema, type ClaimExtraction, type Source } from "../schemas";

export interface ClaimExtractor {
  extract(query: string, sources: Source[]): Promise<ClaimExtraction>;
}

export interface OpenCodeExtractorOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

export class OpenCodeClaimExtractor implements ClaimExtractor {
  readonly model: string;
  private readonly agent: Agent<unknown, typeof ClaimExtractionSchema>;
  private readonly runner: Runner;

  constructor(options: OpenCodeExtractorOptions) {
    this.model = options.model ?? "mimo-v2.5";
    const provider = new OpenAIProvider({
      apiKey: options.apiKey,
      baseURL: options.baseUrl ?? "https://opencode.ai/zen/go/v1",
      useResponses: false,
    });
    this.runner = new Runner({ modelProvider: provider, tracingDisabled: true });

    this.agent = new Agent({
      name: "Grounded claim extractor",
      model: this.model,
      outputType: ClaimExtractionSchema,
      instructions: [
        "Extract only useful, atomic factual claims that directly answer the research query.",
        "Every claim must cite one or more provided source IDs and include short verbatim evidence quotes.",
        "Never use knowledge not present in the sources. Split compound claims. Omit unsupported or vague claims.",
        "Confidence measures how directly and unambiguously the cited evidence supports the exact claim.",
      ].join(" "),
    });
  }

  async extract(query: string, sources: Source[]): Promise<ClaimExtraction> {
    const sourceText = sources.map((source) =>
      `<source id="${source.id}" title=${JSON.stringify(source.title)} url=${JSON.stringify(source.url)}>\n${source.text}\n</source>`,
    ).join("\n\n");
    const result = await this.runner.run(this.agent, `Research query: ${query}\n\nSources:\n${sourceText}`);
    if (!result.finalOutput) throw new Error("Worker model returned no structured claim output");
    return ClaimExtractionSchema.parse(result.finalOutput);
  }
}
