import { z } from "zod";

const EnvSchema = z.object({
  EXA_API_KEY: z.string().min(1),
  OPENCODE_API_KEY: z.string().min(1),
  OPENCODE_BASE_URL: z.string().url().default("https://opencode.ai/zen/go/v1"),
  WORKER_MODEL: z.string().min(1).default("mimo-v2.5"),
  SMART_MODEL: z.string().min(1).default("glm-5.2"),
  EMBEDDINGS_PROVIDER: z.literal("google").default("google"),
  GOOGLE_API_KEY: z.string().min(1),
  GOOGLE_EMBEDDING_MODEL: z.string().min(1).default("text-embedding-004"),
  EXA_RESULT_COUNT: z.coerce.number().int().min(1).max(10).default(5),
  EXA_MAX_CHARACTERS: z.coerce.number().int().min(500).max(20000).default(6000),
  SCRAPLY_OUTPUT_DIR: z.string().min(1).default(".scraply/runs"),
  SCRAPLY_STORE_PATH: z.string().min(1).default(".scraply/store.json"),
  SCRAPLY_REPORT_DIR: z.string().min(1).default("plans/source/generated"),
  SHARE_PUBLISH_COMMAND: z.string().min(1).default("C:\\Business\\planning\\publish-plan.cmd"),
  RESEARCH_PLAN_COST_USD: z.coerce.number().min(0).default(0.02),
  RESEARCH_QUERY_COST_USD: z.coerce.number().min(0).default(0.05),
  RESEARCH_REFLECT_COST_USD: z.coerce.number().min(0).default(0.02),
  RESEARCH_SYNTHESIS_COST_USD: z.coerce.number().min(0).default(0.05),
  SCRAPLY_MAX_DEPTH: z.coerce.number().int().min(0).default(4),
  SCRAPLY_MAX_NODE_BUDGET_USD: z.coerce.number().positive().default(1),
});

export type AppConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    const missing = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n");
    throw new Error(`Invalid environment:\n${missing}\nCopy .env.example to .env and fill the required keys.`);
  }

  return result.data;
}
