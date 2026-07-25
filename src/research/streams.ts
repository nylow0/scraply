import { ResearchStreamSchema, type ResearchStream } from "../shared/schemas";

const settings = { maxHops: 3, coverageThreshold: 0.8, maxQueriesPerHop: 3 } as const;

export const RESEARCH_STREAMS = [
  {
    id: "landscape",
    name: "Landscape",
    lens: "landscape",
    focus: "Map topic state, key concepts, constraints, and current approaches.",
    instructions: "Map the current landscape and its boundaries. Prefer primary data and clearly distinguish established facts from forecasts.",
    ...settings,
  },
  {
    id: "exemplars",
    name: "Exemplars",
    lens: "exemplars",
    focus: "Find related people, projects, products, papers, demos, and entries.",
    instructions: "Find concrete exemplars and explain what measurably works, for whom, and under which conditions.",
    ...settings,
  },
  {
    id: "pain-gaps",
    name: "Pain & Gaps",
    lens: "pain-gaps",
    focus: "Find complaints, missing pieces, weak points, and unsolved problems.",
    instructions: "Prioritize evidenced pain, failed workarounds, switching friction, and unmet demand.",
    ...settings,
  },
  {
    id: "resources",
    name: "Resources",
    lens: "resources",
    focus: "Find usable datasets, APIs, libraries, tools, communities, and methods.",
    instructions: "Inventory resources that materially change feasibility, including access requirements and limitations.",
    ...settings,
  },
  {
    id: "analogies",
    name: "Analogies",
    lens: "analogies",
    focus: "Find adjacent fields solving similarly shaped problems.",
    instructions: "Seek structural analogies, not surface similarity. State where the analogy is likely to break.",
    ...settings,
  },
  {
    id: "evaluation",
    name: "Evaluation",
    lens: "evaluation",
    focus: "Find rubrics, benchmarks, judging criteria, and quality signals.",
    instructions: "Define how options should be judged. Surface disconfirming evidence and cheap validation tests.",
    ...settings,
  },
] as const satisfies readonly ResearchStream[];

if (RESEARCH_STREAMS.length !== 6) throw new Error("Scraply requires exactly six research streams");
for (const stream of RESEARCH_STREAMS) ResearchStreamSchema.parse(stream);

export type CanonicalStream = (typeof RESEARCH_STREAMS)[number];
