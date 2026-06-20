# Scraply

Scraply is a private, local research-to-idea engine. It runs bounded six-stream research, persists a context-inheriting tree, embeds and deduplicates director ideas across that tree, keeps four scoring axes separate, and exposes the workflow through a stdio MCP server and a SvelteKit UI.

The UI reads and writes the same Zod-validated JSON store as the CLI and MCP server. It has no auth, cloud database, telemetry, or deployment target. Ratings are not passive metadata: every `get_node` response includes an explicit preference context with high- and low-rated few-shot examples and director instructions.

## Setup

```powershell
Copy-Item .env.example .env
bun install
bun run check
bun run build
```

Live use requires `EXA_API_KEY`, `OPENCODE_API_KEY`, and `GOOGLE_API_KEY`. OpenCode defaults to MiMo for grounded extraction and configurable `SMART_MODEL`/GLM for planning, reflection, and synthesis. The worker is never asked to invent final ideas.

## Private local UI

Start the SvelteKit development server:

```powershell
bun run dev
```

Open `http://127.0.0.1:5173`. The interface provides persistent parent/child navigation, active-branch context, node budget/spend/stream status, synthesis and report links, three idea buckets, separate relevance/novelty/demand/supply axes, supporting claims, persisted five-point ratings, and duplicate-safe deeper dives.

Creating a deeper branch is local and works without credentials. The UI then attempts its research run; when provider credentials are absent, it keeps the pending child and reports the exact configuration error instead of pretending research started. A production-local build is available with:

```powershell
bun run build
bun run preview
```

Useful scripts:

- `bun run dev` — local SvelteKit development server
- `bun run build` — adapter-node production build
- `bun run preview` — preview the production build locally
- `bun run check` — Svelte/TypeScript diagnostics plus the full Bun test suite
- `bun run mcp` — stdio MCP server

## Codex MCP and deep-research skill

The repo-local skill lives at `.agents/skills/deep-research`. Start the official TypeScript MCP SDK server over stdio with:

```powershell
bun run mcp
```

Register it in your own `~/.codex/config.toml` (this repository never edits that global file):

```toml
[mcp_servers.scraply]
command = "bun"
args = ["run", "C:/Business/scraply/src/mcp/server.ts"]
```

The server exposes exactly `get_tree`, `get_node`, `create_child`, `research_node`, `add_ideas`, `get_ideas`, and `rate_idea`. It can start and serve read-only tree operations without credentials. `get_node` includes the learned preference context consumed by the repo-local director skill. `add_ideas` requires `GOOGLE_API_KEY`; `research_node` requires all live provider keys. Research reports are local-only through MCP—there is no external publish side effect.

Tree guards default to `SCRAPLY_MAX_DEPTH=4` and `SCRAPLY_MAX_NODE_BUDGET_USD=1`. A child budget is the lower of its parent's budget and the configured per-node cap. `create_child` rejects deeper nodes before writing anything, and `research_node` rechecks both caps.

## Run complete six-stream research

Create `brief.json`:

```json
{
  "brief": {
    "topic": "Student business tools",
    "objective": "Find a small software product students would pay for",
    "audience": "student founders",
    "constraints": ["one-person build", "four weeks"],
    "successCriteria": ["repeated pain", "clear buyer"],
    "budgetUsd": 1
  },
  "maxHops": 3,
  "coverageThreshold": 0.8,
  "maxQueriesPerHop": 3
}
```

```powershell
bun start -- research-all --input brief.json
```

The engine always runs exactly six focused streams—Landscape, Exemplars, Pain & Gaps, Resources, Analogies, and Evaluation—concurrently. It reserves the configured synthesis cost, splits the remaining node budget deterministically in micro-dollar units, and never redistributes quotas based on completion order. Every provider step is charged before dispatch, so failures cannot hide possible spend.

One stream failure produces an explicit `research-partial` result while preserving that stream's earlier claims and all other useful work. The configurable smart worker synthesizes available evidence; the deterministic fallback exists only as an explicitly injected mocked-test utility and is never enabled by the CLI. The completed report contains status and evidence for all six streams plus synthesis, and its local path/optional URL is attached to the node.

## Research one Phase 1 stream

Create `brief.json`:

```json
{
  "brief": {
    "topic": "Student business tools",
    "objective": "Find a small software product students would pay for",
    "audience": "student founders",
    "constraints": ["one-person build", "four weeks"],
    "successCriteria": ["repeated pain", "clear buyer"],
    "budgetUsd": 1
  },
  "stream": {
    "id": "pain",
    "name": "Pain and gaps",
    "lens": "pain-gaps",
    "focus": "Repeated expensive student problems",
    "maxHops": 3,
    "coverageThreshold": 0.8,
    "maxQueriesPerHop": 3
  }
}
```

Run the bounded Plan → Search → Extract → Reflect loop:

```powershell
bun start -- research --input brief.json
```

The command atomically updates `.scraply/store.json` and writes a Markdown report under `plans/source/generated`. It stops with an explicit `coverage`, `budget`, `max-hops`, or `no-follow-ups` reason. The configurable cost values are accounting estimates and guard every model/search step before it starts.

## Import director ideas

Codex (the director) produces `ideas.json`; Scraply only imports, embeds, deduplicates, scores, buckets, and persists it:

```json
[
  {
    "title": "Campus workflow concierge",
    "description": "A focused product based on the researched pain.",
    "supportingClaimIds": ["c_..."]
  }
]
```

```powershell
bun start -- add-ideas --node n_... --input ideas.json
```

Deduplication compares every stored idea, including other nodes, plus earlier accepted ideas in the same batch. The result returns added ideas and dropped duplicates. Relevance, novelty, demand, and supply remain separate axes; they are never averaged into a single rank. Ideas receive `sweet-spot`, `creative-outlier`, or `safe-bet` buckets.

## Publishing boundary

Local Markdown output is the default and is fully tested. Add `--publish` to a research command to pass that Markdown file to `SHARE_PUBLISH_COMMAND`, which defaults to the existing external publisher:

```powershell
bun start -- research --input brief.json --publish
bun start -- research-all --input brief.json --publish
```

The repos remain uncoupled: Scraply exposes a small `Publisher` interface and only invokes the configured command. The exact external live gate is a working `C:\Business\planning\publish-plan.cmd`, its deployment/network access, and a successful `https://<token>.llm-plans.com` response. This gate is not exercised by offline tests.

## Phase 0 compatibility

The original one-shot flow remains available:

```powershell
bun start -- "your research question" --output result.json
```

No live-quality claim is made without real provider credentials. Offline tests do not invoke external publishing. The suite uses deterministic mocks for request shapes, grounding, six-stream concurrency, shared budget safety, partial failures, synthesis, context inheritance, persistence/reload, cross-tree deduplication, ratings, MCP validation, scoring/bucketing, and Markdown rendering.
