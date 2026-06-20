import { ResearchStreamSchema, type ResearchStream } from "../store/schema";

const settings = { maxHops: 3, coverageThreshold: 0.8, maxQueriesPerHop: 3 } as const;

export const RESEARCH_STREAMS = [
  {
    id: "landscape",
    name: "Landscape",
    lens: "landscape",
    focus: "Market structure, categories, actors, trends, and credible baselines.",
    instructions: "Map the current landscape and its boundaries. Prefer primary data and clearly distinguish established facts from forecasts.",
    ...settings,
  },
  {
    id: "exemplars",
    name: "Exemplars",
    lens: "exemplars",
    focus: "Strong products, projects, workflows, and business models worth learning from.",
    instructions: "Find concrete exemplars and explain what measurably works, for whom, and under which conditions. Avoid generic best-practice lists.",
    ...settings,
  },
  {
    id: "pain-gaps",
    name: "Pain & Gaps",
    lens: "pain-gaps",
    focus: "Repeated, costly, underserved problems and weaknesses in existing options.",
    instructions: "Prioritize evidenced pain, failed workarounds, switching friction, and unmet demand. Separate loud complaints from costly recurring problems.",
    ...settings,
  },
  {
    id: "resources",
    name: "Resources",
    lens: "resources",
    focus: "Available data, tools, channels, communities, capabilities, and constraints.",
    instructions: "Inventory resources that materially change feasibility or distribution, including access requirements, limitations, and likely costs.",
    ...settings,
  },
  {
    id: "analogies",
    name: "Analogies",
    lens: "analogies",
    focus: "Transferable mechanisms and patterns from adjacent or structurally similar domains.",
    instructions: "Seek structural analogies, not surface similarity. State the transferable mechanism and where the analogy is likely to break.",
    ...settings,
  },
  {
    id: "evaluation",
    name: "Evaluation",
    lens: "evaluation",
    focus: "Decision criteria, risks, counter-evidence, validation methods, and kill signals.",
    instructions: "Define how options should be judged. Surface disconfirming evidence, operational risks, cheap tests, and explicit stop conditions.",
    ...settings,
  },
] as const satisfies readonly ResearchStream[];

if (RESEARCH_STREAMS.length !== 6) throw new Error("Scraply requires exactly six research streams");
for (const stream of RESEARCH_STREAMS) ResearchStreamSchema.parse(stream);

