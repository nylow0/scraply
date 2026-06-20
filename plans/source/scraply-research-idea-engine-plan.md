# Scraply — Deep Research & Idea Generation Engine: Build Plan

This is an implementation handoff document. It describes a system to be built in the `C:\Business\scraply` workspace by an autonomous coding agent (Codex or Claude Code). It assumes familiarity with TypeScript, agent SDKs, and LLM tool use. Read it top to bottom before writing code.

## 1. What we are building

A **deep-research-to-idea-generation engine**. The user gives a topic; the system runs structured, multi-hop research using cheap models, hands the synthesized findings to a strong "director" model (Codex), and the director generates and ranks ideas. The user can then **dive deeper** into any idea, spawning a persistent **tree** of research-and-ideas that survives across sessions.

The research is **fuel**, not a standalone product. We optimize for idea quality, creative coverage, and low factual error — not bulletproof academic citations.

Scope is domain-agnostic (software projects, business, marketing, Instagram posts, research papers, competitions). Generality is preserved through an intake brief, not hardcoded assumptions.

## 2. Core philosophy (read this before designing anything)

- **Strong model where it matters, cheap models where it does not.** Research is mostly fetch-and-summarize (cheap). Planning research directions, generating ideas, and navigating the tree require judgment (strong). Route by task difficulty.
- **The model has no memory; the store does.** Codex is stateless across sessions. The research tree, knowledge, and ideas live in a local JSON store. "Remembering the branch" means Codex re-reads the store each session through tools.
- **Do not average scores into one rank.** Creative outliers score low on feasibility and get buried by a weighted sum. Keep a Pareto frontier and present buckets.
- **Prove the atom before multiplying.** A single research-to-ideas node must produce ideas worth acting on before the tree, parallelism, or UI are built. The tree only multiplies whatever quality the single node has.

## 3. Division of labor

| Role | Who | Responsibility |
|---|---|---|
| Director | Codex (user's existing subscription) | Intake to brief, plan research directions, generate ideas, navigate/expand the tree, final creative curation |
| Research labor | MiMo v2.5 (non-pro) via OpenCode Go | Fetch + summarize + extract claims, at volume |
| Smart sub-steps | GLM-5.2 via OpenCode Go | Sub-question planning, gap analysis, verification critic, qualitative scoring |
| Embeddings | Google `text-embedding-004` (free tier) | Dedup + novelty distance |
| Web fetch | Exa API | Search + page contents |
| Research context bus | `share` publisher (`llm-plans.com`) | Research reports as links for agent-to-agent handoff |
| Idea store + tree + UI | Scraply local store + Svelte UI | Private. Ideas never published |

> The two repos stay separate. `planning` (the `share` publisher) is only the research context bus. `scraply` is the engine, the tree store, and the private idea UI.

## 4. Technology stack

| Concern | Choice | Why |
|---|---|---|
| Language / runtime | TypeScript + Bun | User preference; integrates with the TS `share` publisher |
| Agent runtime | OpenAI Agents SDK (TS, `@openai/agents`) | Provider-agnostic; points at any OpenAI-compatible endpoint; built-in tools, handoffs, MCP, Zod structured output |
| Worker model backend | OpenCode Go | OpenAI-compatible API, ~$10/month, dollar-capped, bundles MiMo/GLM/DeepSeek/Kimi/Qwen |
| Structured output | Zod via Agents SDK `outputType` | Native to the SDK. (BAML is an acceptable alternative if MiMo's structured output proves unreliable.) |
| Web search/contents | Exa | Semantic, research-grade source discovery; first 10 results' contents free |
| Embeddings | Google `text-embedding-004` | Free tier; OpenCode Go has no embedding endpoint |
| Director integration | Codex Skill + MCP server | Codex's native extension points |
| Research presentation | `share` skill (existing) | Already deployed |
| Idea UI | SvelteKit + Tailwind | User preference; reads local store |

**Conflict resolved (do not blend):** use the **Agents SDK + Zod** as the single structured-output path. Do **not** also wire in BAML unless Phase 0 shows MiMo cannot hold a schema. One framework.

## 5. Project structure (scraply)

```text
scraply/
  package.json
  src/
    models/
      opencode.ts        # OpenAI client pointed at OpenCode Go + Agents SDK wiring
      embeddings.ts      # Google text-embedding-004 client
      routing.ts         # task -> model map
    search/
      exa.ts             # Exa search + contents
    streams/
      run-stream.ts      # one stream's multi-hop loop
      streams.ts         # the 6 stream definitions
    store/
      knowledge.ts       # claims + sources + embeddings
      ideas.ts           # ideas + scores + buckets
      tree.ts            # persistent node tree
      schema.ts          # Zod types for all stored entities
    ideas/
      score.ts           # relevance/novelty/demand/supply -> Pareto buckets
      dedup.ts           # embedding-based dedup across the whole tree
    report/
      render.ts          # node -> Markdown -> publish via share
    mcp/
      server.ts          # MCP server exposing tree + research tools to Codex
    cli/
      research.ts        # CLI entry (Phase 0/1 before MCP)
  data/
    store.json           # the persistent store (gitignored)
  .agents/
    skills/
      deep-research/
        SKILL.md
        agents/openai.yaml
  plans/
    source/              # research reports staged for the share publisher
```

## 6. Data model

All entities are Zod-typed in `store/schema.ts`. The store is a single local JSON file (or a tiny embedded DB later); start with JSON.

**Claim** (knowledge store):

```json
{
  "id": "c_01H...",
  "nodeId": "n_root",
  "stream": "pain-gaps",
  "text": "Indie makers complain that existing X tools lack Y.",
  "sourceUrl": "https://...",
  "embedding": [0.01, -0.02, "..."],
  "confidence": 0.8,
  "verified": true
}
```

**Idea**:

```json
{
  "id": "i_01H...",
  "nodeId": "n_root",
  "title": "...",
  "description": "...",
  "embedding": [0.01, "..."],
  "scores": { "relevance": 0.72, "novelty": 0.81, "demand": 0.6, "supply": 0.2 },
  "bucket": "creative-outlier",
  "supportingClaimIds": ["c_...", "c_..."],
  "rating": null
}
```

**Tree node**:

```json
{
  "id": "n_01H...",
  "parentId": null,
  "depth": 0,
  "brief": "Generate project ideas for ...",
  "status": "ideated",
  "researchReportLink": "https://<token>.llm-plans.com",
  "researchLocalPath": "C:/Business/planning/plans/published/<slug>.json",
  "ideaIds": ["i_...", "i_..."],
  "budgetUsd": 2.0,
  "spentUsd": 0.7
}
```

## 7. The research pipeline (the 6 streams)

The streams are the proven decomposition: **Landscape, Exemplars, Pain & Gaps, Resources, Analogies, Evaluation**. Each stream runs the same loop, and the loop quality is the single biggest lever — not the model.

**The multi-hop loop (per stream):**

1. **Plan** — GLM-5.2 turns the node brief into 3–6 answerable sub-questions for this stream.
2. **Search** — Exa `/search` (with contents) per sub-question.
3. **Extract** — MiMo v2.5 reads each result and emits atomic claims with source URLs (Zod-validated).
4. **Reflect** — GLM-5.2 reviews accumulated claims and asks: what is still missing? Emits follow-up searches.
5. **Loop** steps 2–4 until coverage is sufficient or the node budget is hit.
6. **Verify** — GLM-5.2 critic flags claims unsupported by their source; unverified claims are marked, not silently dropped.
7. **Persist** — claims written to the knowledge store with embeddings.

Streams run in parallel (one Agents-SDK agent each). A final synthesis pass (GLM-5.2 or Codex) merges the six into one research summary.

The summary is rendered to Markdown and **published via `share`**, producing the `llm-plans.com` link stored on the node. Codex reads the summary — on the same machine, directly from `plans/published/<slug>.json` (faster, lossless) rather than re-fetching the URL.

## 8. Idea generation and ranking

**Generation is Codex's job.** Codex reads the research summary and generates ideas, using diverse lenses to maximize creativity:

- analogical transfer (from the Analogies stream),
- constraint relaxation,
- combining distant findings,
- inversion of assumptions.

The user picks the target count per run (e.g. 50 small, 300 deep). Note: a single model producing hundreds of distinct, high-quality ideas in one context degrades; the director should generate in **batches** and rely on the engine to dedup.

**Scoring and bucketing is the engine's job** (`add_ideas` tool). For each idea Codex submits, the engine:

1. embeds the idea;
2. **dedups** against the whole tree (drop near-duplicates above a cosine threshold);
3. scores four axes:
   - **relevance** — semantic fit to the node brief,
   - **novelty** — embedding distance from the Exemplars stream + absence from "already attempted" (Pain & Gaps),
   - **demand** — strength of unmet-need signal from Pain & Gaps,
   - **supply/saturation** — count of existing players from Exemplars;
4. assigns a **Pareto bucket**: `sweet-spot` (high demand, low supply, feasible), `creative-outlier` (high novelty), `safe-bet` (proven demand + available resources);
5. persists and returns the scored, bucketed result plus which were dropped as duplicates.

Do **not** collapse the four axes into one number. The UI shows buckets, not a single ranked list.

## 9. The branching / deeper-dive system

This is the heart of the product. The tree is **persistent JSON**; Codex reads and extends it through tools. Codex's "memory" of the branch is the store.

**Diving deeper into idea X:**

1. Codex calls `create_child(parentId, focusTopic=X)`.
2. The engine builds the child brief, **inheriting the ancestor path's research** (parent summaries + the specific idea) so the dive deepens rather than restarts.
3. `research_node(childId)` runs the 6-stream loop scoped to the narrower topic.
4. Codex reads the new summary, generates sharper ideas, calls `add_ideas`.
5. New ideas are deduped against the **whole tree**, so sibling dives do not regenerate the same idea.

**Guards (not optional):**

- **Context inheritance** — children build on ancestors' claims.
- **Cross-tree dedup** — embedding check against every existing idea.
- **Depth and budget caps** — each node has `budgetUsd`; a dive cannot silently spiral. Stop and report when hit.

## 10. Integration wiring (the part that must be exact)

**Codex Skill** lives at `.agents/skills/deep-research/SKILL.md` (repo-local; Codex scans `.agents/skills`). Required frontmatter:

```yaml
---
name: deep-research
description: Run structured deep research and generate/rank ideas, with a persistent explorable tree. Trigger when the user asks to research a topic and generate or expand project/business/content ideas.
---
```

The skill documents the workflow and tells Codex to use the MCP tools. It declares the MCP dependency in `agents/openai.yaml`:

```yaml
dependencies:
  tools:
    - type: "mcp"
      value: "scraply"
      description: "Deep research + idea tree tools"
      transport: "streamable_http"
      url: "http://localhost:8900/mcp"
```

**MCP server** (`src/mcp/server.ts`) exposes these tools to Codex (register in `~/.codex/config.toml`):

- `get_tree()`, `get_node(id)` — load state (this is the memory)
- `create_child(parentId, focusTopic)` — start a deeper branch
- `research_node(id)` — run the 6-stream pipeline, publish report, attach link, store claims
- `add_ideas(nodeId, ideas[])` — embed, dedup vs tree, score, bucket, persist
- `get_ideas(nodeId, bucket?)`
- `rate_idea(ideaId, rating)` — preference signal for future runs

Codex config (`~/.codex/config.toml`):

```toml
[mcp_servers.scraply]
command = "bun"
args = ["run", "C:/Business/scraply/src/mcp/server.ts"]
```

**Worker swarm on OpenCode Go via the Agents SDK** (`src/models/opencode.ts`):

```ts
import OpenAI from "openai";
import {
  setDefaultOpenAIClient,
  setOpenAIAPI,
  Agent,
} from "@openai/agents";

// OpenCode Go is OpenAI-compatible.
const opencode = new OpenAI({
  baseURL: "https://opencode.ai/zen/go/v1",
  apiKey: process.env.OPENCODE_GO_KEY,
});

setDefaultOpenAIClient(opencode);
setOpenAIAPI("chat_completions"); // use Chat Completions, not Responses

export const extractor = new Agent({
  name: "Extractor",
  model: "mimo-v2.5",          // exact id from GET /zen/go/v1/models
  instructions: "Extract atomic, source-attributed factual claims as JSON ...",
  // outputType: z.array(ClaimSchema)  // Zod structured output
});

export const planner = new Agent({
  name: "Planner",
  model: "glm-5.2",
  instructions: "Plan sub-questions and identify research gaps ...",
});
```

**Exa** (`src/search/exa.ts`): POST `https://api.exa.ai/search` with `{ query, type, contents: { text: true, highlights: true } }`, auth via `x-api-key`. Use `/contents` for follow-up page pulls.

**Embeddings** (`src/models/embeddings.ts`): Google Generative Language API `text-embedding-004`, free tier, batched.

## 11. Model routing

| Task | Model | Backend |
|---|---|---|
| Intake -> brief, research direction, idea generation, tree navigation | Codex | User subscription |
| Fetch + summarize + extract claims | MiMo v2.5 (non-pro) | OpenCode Go |
| Sub-question planning, gap analysis, verification, qualitative scoring | GLM-5.2 | OpenCode Go |
| Embeddings (dedup, novelty) | text-embedding-004 | Google (free) |
| Numeric scoring + bucketing | none (engine math) | local |

MiMo v2.5 quality is **unverified** and must be validated in Phase 0. Swapping the worker model is a one-line `model` change (e.g. to `deepseek-v4-flash` or `glm-5.2`).

## 12. Cost model

- **OpenCode Go**: ~$10/month flat, dollar-capped ($12 / 5h, $30 / week, $60 / month).
- **Exa**: ~$7 per 1k searches; first 10 results' contents free. A deep run (~100 searches) is well under $1.
- **Google embeddings**: free tier.
- **Codex**: existing subscription; the main constraint is its usage limits, which is why the mechanical loop runs on workers, not in Codex.

Per-node `budgetUsd` caps enforce this; a run stops and reports rather than overspending.

## 13. Build phases

**Phase 0 — Plumbing & MiMo validation.** OpenCode Go client + Exa + embeddings. A CLI that takes a query, searches, has MiMo extract claims, embeds them. *Success: grounded, source-attributed claims of acceptable quality. If MiMo is sloppy, switch worker model now.* Also confirm OpenCode Go auth (API key vs OAuth) — blocking unknown.

**Phase 1 — Single-node vertical slice.** One brief -> one stream multi-hop loop -> knowledge store -> Codex generates ideas -> `add_ideas` scores/buckets -> publish report via `share`. *Success: ideas the user would actually act on. This is the make-or-break gate.*

**Phase 2 — Full research.** All 6 streams in parallel + synthesis + report publishing. *Success: a complete research summary link per run.*

**Phase 3 — The tree.** MCP server, persistent nodes, `create_child`, context inheritance, cross-tree dedup, budget/depth caps, Codex skill wired in. *Success: dive into an idea and get a context-inheriting child with non-duplicate deeper ideas.*

**Phase 4 — Polish.** SvelteKit UI reading the store (tree view + bucketed ideas + drill-down); preference learning (ratings become few-shot bias). *Success: the user navigates the tree and rates ideas in a private UI.*

## 14. Open questions and risks (resolve before or during Phase 0)

- **OpenCode Go auth**: does the $10 plan expose a plain API key for the `apiKey` field, or an OAuth/device flow? Blocking for Phase 0.
- **MiMo v2.5 extraction quality**: unverified. Validate early; swap if poor.
- **Codex idea volume**: hundreds of ideas in one context degrade — director must batch and lean on engine dedup.
- **Exa free-tier limits**: confirm the monthly free allowance and whether a card is required.
- **Embeddings provider**: Google free tier vs a local model (bge / MiniLM). Local removes a dependency and rate limits; decide in Phase 0.
- **MCP vs CLI**: Phase 1 can use a CLI; the tree (Phase 3) needs MCP so Codex calls fine-grained tools. Do not over-build MCP before the single node works.

## 15. Reference links

- OpenCode Go API: `https://opencode.ai/docs/go/` — endpoints `https://opencode.ai/zen/go/v1/chat/completions`, `/messages`, `/models`
- Codex Skills: `https://developers.openai.com/codex/skills`
- Codex customization / MCP: `https://developers.openai.com/codex/concepts/customization`
- Codex with Agents SDK: `https://developers.openai.com/codex/guides/agents-sdk`
- OpenAI Agents SDK (TS): `https://openai.github.io/openai-agents-js/`
- Exa docs: `https://exa.ai/docs`
- Google embeddings: `https://ai.google.dev/gemini-api/docs/embeddings`
- The `share` publisher skill: `C:\Business\planning\skills\share\SKILL.md`
