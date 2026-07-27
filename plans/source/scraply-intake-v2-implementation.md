# Scraply Intake V2 — Exact Implementation Roadmap

## The decision

Build Scraply into a **brief interpreter with a reviewable run plan**.

The target flow is:

> One prompt or pasted brief → structured draft → full edit/review → honest run summary → research

Do not start by building three entry modes, mathematical information-gain scoring, dynamic stream generation, criterion weights, uploads, or learned preferences. Those are hypotheses, not requirements.

The implementation order matters:

1. Make the existing brief affect research and ranking.
2. Introduce a backward-compatible brief contract.
3. Replace the questionnaire with one smart input.
4. Make the inferred brief fully editable.
5. Add an honest pre-run review.
6. Pilot it on real work.
7. Add clarification and stream selection only when the pilot justifies them.

---

## What is broken today

- `src/shared/intake.ts` defines 10 required and 5 optional questions.
- `src/renderer/components/ResearchSetupForm.svelte` renders all of them as textareas.
- `src/renderer/components/BriefPanel.svelte` exposes only 6 of the 13 current brief fields.
- `src/core/research-engine.ts` mainly uses `theme`, `description`, and `researchNeeds` when planning searches.
- `src/core/orchestrator.ts` ignores most brief fields during coverage review and synthesis.
- `src/core/ideas.ts` uses only a subset of the brief during generation.
- `src/research/streams.ts` requires exactly six streams, and every run executes all six.
- Stored briefs, research-run snapshots, and branch inheritance are parsed through the current strict schema. Replacing that schema directly can make old projects unreadable.

The first rule for the redesign is therefore:

> No intake field survives unless it has a defined downstream consumer or is explicitly display-only.

---

## Phase 0 — Capture a baseline before changing behavior

### Step 0.1: Record 8–12 real Scraply tasks

For every task, record:

- time from creating the task to being ready to run;
- characters typed during intake;
- fields changed on the brief-review screen;
- whether a critical constraint was missed;
- output usefulness from 1–5;
- post-run regret from 1–5;
- total runtime and estimated research cost.

Use actual projects, not artificial demo prompts.

### Step 0.2: Create a fixed parser fixture set

Add fixtures covering:

1. a one-sentence vague prompt;
2. a detailed pasted brief;
3. a brief with no deadline;
4. a brief with contradictory constraints;
5. a brief containing examples and anti-examples;
6. a request for broad exploration without ranking;
7. a decision request with explicit criteria;
8. a brief with a strict evidence requirement;
9. a prompt containing irrelevant background;
10. an incomplete prompt where important values are unknown.

Store these under `test/fixtures/intake/`.

### Gate 0

Do not judge V2 only by whether it looks cleaner. The baseline must exist so the redesign can be evaluated on effort and output quality.

---

## Phase 1 — Make the current brief operational

This phase comes before the new UI. A better intake is pointless if the pipeline still ignores the result.

### Step 1.1: Add a centralized context builder

Create:

`src/core/brief-context.ts`

Expose typed functions such as:

```ts
buildQueryContext(brief)
buildResearcherContext(brief)
buildCoverageContext(brief)
buildSynthesisContext(brief)
buildIdeaContext(brief)
```

Do not dump every field into every prompt. Route each field deliberately.

### Step 1.2: Use the following field-to-consumer map

| Current concept | Query planning | Research prompt | Coverage | Synthesis | Idea generation/ranking |
|---|---:|---:|---:|---:|---:|
| Objective/theme/description | Yes | Yes | Yes | Yes | Yes |
| Final decision | Yes | Yes | Yes | Yes | Yes |
| Desired output | No | Sometimes | No | Yes | Yes |
| Success definition/criteria | Sometimes | Yes | Yes | Yes | Yes |
| Hard constraints | Yes | Yes | Yes | Yes | Veto/penalty |
| Avoid list | Yes | Yes | Yes | Yes | Veto/penalty |
| Research/evidence needs | Yes | Yes | Yes | Yes | Sometimes |
| Resources | Feasibility queries | Yes | Yes | Yes | Feasibility scoring |
| Deadline/time horizon | Recency/feasibility | Yes | Sometimes | Yes | Feasibility scoring |
| Available effort | No | Feasibility | Sometimes | Yes | Feasibility scoring |
| Idea style | Query diversification | Sometimes | No | Yes | Diversity guidance |

### Step 1.3: Replace scattered prompt assembly

Update:

- `src/core/research-engine.ts`
- `src/core/orchestrator.ts`
- `src/core/ideas.ts`

These files should consume the shared context builders instead of manually selecting unrelated subsets of fields.

### Step 1.4: Add consumer tests

Update or add:

- `test/unit/prompts.test.ts`
- `test/unit/intake.test.ts`
- a focused `test/unit/brief-context.test.ts`

Tests must prove that:

- constraints appear in researcher and coverage context;
- final decision appears in coverage, synthesis, and idea context;
- resources and effort affect feasibility context;
- desired output affects synthesis and idea packaging;
- avoid items become explicit exclusions;
- empty optional values do not generate meaningless prompt noise.

### Gate 1

Do not ship the new intake until every retained consequential field has at least one tested consumer.

---

## Phase 2 — Introduce a safe, minimal V2 brief contract

Do not implement the reports’ giant nested schema. Use a smaller schema that fixes the semantic problems without creating another bloated form.

### Step 2.1: Define two explicit schemas

In `src/shared/schemas.ts`, retain the current shape as:

```ts
LegacyProjectBriefSchema
```

Add a minimal:

```ts
ProjectBriefV2Schema
```

Recommended V2 concepts:

```ts
{
  schemaVersion: 2,
  title: string,
  objective: string,
  context: string,
  decisionToSupport: string,
  audience: string[],
  desiredOutput: {
    type: "options" | "ranked-shortlist" | "decision-memo" | "research-brief" | "comparison" | "other",
    notes: string
  },
  successCriteria: string[],
  hardConstraints: string[],
  preferences: string[],
  antiGoals: string[],
  resources: string[],
  deadline: string | null,
  availableEffort: string | null,
  evidenceRequirements: string[],
  examplesToInspect: string[],
  ideaStyle: "safe" | "balanced" | "bold",
  assumptions: string[],
  openQuestions: string[]
}
```

Do not add criterion weights, per-field confidence numbers, budget subobjects, geography subobjects, or source ontologies yet.

### Step 2.2: Normalize old data

Create:

`src/shared/brief-normalizer.ts`

Implement:

```ts
parseAndNormalizeBrief(value: unknown): ProjectBriefV2
```

It must:

- accept both legacy and V2 JSON;
- map legacy fields into the closest V2 concepts;
- preserve unknown values as assumptions/open questions when appropriate;
- never invent deadlines, resources, constraints, or anti-goals;
- always return V2 to the rest of the application.

Important: `briefs.version` is the revision number, not the schema version. Keep `schemaVersion` inside the JSON.

### Step 2.3: Update every parsing boundary

Audit and update:

- `src/db/repositories/threads.ts`
- `src/db/repositories/research-runs.ts`
- `src/shared/ipc.ts`
- `src/renderer/lib/ipc-payloads.ts`
- branch inheritance and `inheritedBriefSnapshot`;
- workspace state loading;
- research recovery.

Write only V2 going forward. Read and normalize both V1 and V2.

### Step 2.4: Protect old workspaces

Add tests for:

- legacy brief → V2 normalization;
- V2 round trip through IPC;
- old research-run snapshot loading;
- old branch inherited-brief loading;
- reopening an existing database;
- no silent field stripping at Zod boundaries.

### Gate 2

Every existing saved brief, branch, and research run must still open. Do not continue if the schema change breaks old data or recovery.

---

## Phase 3 — Replace the questionnaire with one smart entry

### Step 3.1: Add the new entry component

Create:

`src/renderer/components/SmartBriefEntry.svelte`

Primary copy:

> **What are you trying to decide, create, or improve?**
>
> Write a sentence or paste your full brief. Include the decision, desired output, constraints, or deadline if you already know them.

UI:

- one large textarea;
- primary action: `Build research brief`;
- secondary action: `Use guided setup`;
- no separate “quick prompt” and “paste brief” tabs;
- keep `ResearchSetupForm.svelte` temporarily as the guided fallback.

### Step 3.2: Add a single backend operation

Add a request schema in `src/shared/ipc.ts`, for example:

```ts
StartBriefIntakeSchema
```

Add the matching route in `src/backend/server.ts`, for example:

```text
POST /intake/brief
```

Update:

- `src/preload/index.ts`
- renderer IPC types;
- `src/renderer/App.svelte`.

The renderer should send the entire starter text once. Do not simulate the old workflow by posting 15 fake answers.

### Step 3.3: Add brief-first extraction

In `src/core/intake.ts`, add:

```ts
generateBriefFromText(...)
```

Return an envelope:

```ts
{
  brief: ProjectBriefV2,
  missingFields: string[],
  assumptions: string[],
  contradictions: string[]
}
```

Extraction rules:

- never invent a hard constraint;
- never invent a deadline;
- never invent available resources;
- never invent anti-goals or evidence rules;
- use `null`, empty arrays, assumptions, or open questions for missing information;
- distinguish a user statement from a model inference;
- flag contradictions instead of silently choosing one side;
- derive the thread title from the inferred title/objective.

### Step 3.4: Test extraction before connecting the UI

Use the Phase 0 fixtures.

Required launch thresholds:

- at least 90% correct extraction of objective, decision, and output across the fixture set;
- zero invented hard constraints;
- zero invented deadlines;
- zero invented anti-goals;
- all important unknowns visible;
- contradictions surfaced.

### Gate 3

Do not pilot the smart entry until critical-field invention is zero in the launch fixture set.

---

## Phase 4 — Build the full brief review

### Step 4.1: Replace the current six-field editor

Rewrite `src/renderer/components/BriefPanel.svelte` or replace it with:

`src/renderer/components/BriefReviewPanel.svelte`

Group fields into:

1. **Goal and decision**
   - title;
   - objective;
   - context;
   - decision to support;
   - audience.

2. **What good looks like**
   - desired output;
   - success criteria;
   - idea style.

3. **Boundaries**
   - hard constraints;
   - preferences;
   - anti-goals;
   - deadline;
   - available effort.

4. **Research context**
   - resources;
   - evidence requirements;
   - examples to inspect.

5. **Uncertainty**
   - assumptions;
   - contradictions;
   - open questions.

### Step 4.2: Use appropriate controls

- short text for title;
- textarea for objective/context/decision;
- select or chips for output type and idea style;
- editable tag/list controls for criteria, constraints, resources, evidence requirements, examples, and anti-goals;
- nullable text/date control for deadline;
- visible “Not provided” state instead of fabricated defaults.

### Step 4.3: Fix draft state handling

The current component shallow-clones the brief. V2 contains nested arrays and objects.

Use a deep clone such as:

```ts
structuredClone(untrack(() => brief))
```

Never allow edits to mutate the persisted brief before explicit confirmation.

### Step 4.4: Validate before confirmation

Only these fields should block confirmation:

- objective;
- decision to support or a clear exploratory intent;
- desired output.

Missing constraints, deadline, resources, or criteria should remain visible but should not universally block a run.

### Gate 4

The user must be able to inspect and edit every field that will influence research or ranking.

---

## Phase 5 — Add an honest “Review and Run” screen

For the first release, do not pretend streams are editable while the backend still forces all six.

### Step 5.1: Combine the useful review information

Create:

`src/renderer/components/RunReviewPanel.svelte`

Show:

- objective and final decision;
- output;
- success criteria;
- constraints and anti-goals;
- evidence requirements;
- assumptions/open questions;
- the six existing streams, clearly marked as fixed for this version;
- models and run limits;
- expected cost/runtime information already available from configuration;
- one explicit `Start research` action.

Reuse `RunConfigPanel.svelte` internally or place advanced model/limit settings in a collapsible section.

### Step 5.2: Keep control honest

In the MVP:

- brief fields are editable;
- model and limits are editable;
- streams are visible but read-only;
- the screen says unresolved unknowns will be treated as assumptions.

Do not show add/remove stream controls until the execution engine respects them.

### Step 5.3: Preserve run immutability

On launch, snapshot:

- normalized V2 brief;
- run config;
- the six selected stream IDs for the legacy-compatible run.

Edits made after launch must not change a running or resumed run.

### Gate 5

The screen must accurately describe what the backend will execute. No false controls.

---

## Phase 6 — Pilot the smallest useful redesign

Run V2 on 10–12 real Scraply tasks.

Alternate between the old and new intake where practical, or replay matched archived briefs.

Track:

- median time to ready-to-run;
- characters typed;
- extraction failures;
- fields edited after inference;
- repeated edits to the same field;
- hidden or missed constraints;
- report usefulness;
- post-run regret;
- runtime and cost by stream.

### Success thresholds

- median intake time decreases by at least 40%;
- characters typed decrease by at least 50%;
- output usefulness is no worse than 0.5 points on a 5-point scale;
- no hidden critical-constraint misses;
- extraction or start failures remain below 5%;
- old projects and branches continue to open;
- all unit, integration, and E2E tests pass.

### Rollback threshold

Stop or revise the redesign if:

- intake time improves by less than 25%;
- usefulness drops by more than 0.5/5;
- any critical constraint is silently lost;
- extraction/start failures exceed 5%;
- users repeatedly accept an incorrect plan because inferred assumptions are not visible.

---

## Phase 7 — Add deterministic clarifications only if justified

Do this only if at least 30% of pilot runs require correction to the same consequential field.

### Step 7.1: Add simple rules

Ask a clarification only when:

1. the decision/output is unclear;
2. hard constraints contradict each other;
3. ranking is required but no success criteria exist;
4. audience materially changes evidence or presentation;
5. a strict evidence boundary is clearly required but unspecified.

### Step 7.2: Hard-cap the interaction

- maximum three questions;
- structured controls before free text;
- never ask for information already present;
- never ask “anything else?”;
- do not ask for numerical weights;
- allow `Proceed with assumptions`.

### Step 7.3: Keep metadata separate

Do not expose fake precision such as “confidence: 0.73” in the interface. Use human-readable states:

- provided;
- inferred;
- not provided;
- contradictory.

### Gate 7

Clarifications stay only if they reduce repeated high-impact edits without materially increasing time-to-run.

---

## Phase 8 — Make existing streams conditional

This is a later architectural phase, not part of the first brief-first release.

Do not add new stream types yet. First prove that Scraply can safely select a subset of the existing six.

### Step 8.1: Introduce a persisted research plan

Add:

```ts
ResearchPlanSchema
```

Minimum shape:

```ts
{
  schemaVersion: 1,
  briefVersion: number,
  selectedStreamIds: string[],
  streamQueries: Record<string, string>,
  coverageChecks: string[],
  sourceScope: string[],
  assumptions: string[]
}
```

Persist the confirmed plan and snapshot it into the research run.

Old runs without a plan must normalize to all six current streams.

### Step 8.2: Remove global six-stream assumptions

Update:

- `src/research/streams.ts`;
- `src/core/research-engine.ts`;
- `src/core/orchestrator.ts`;
- research recovery/resume logic;
- progress totals in the renderer;
- stream completion and follow-up calculations;
- unit and integration tests.

Remove the exact-six invariant only after run-level selected stream IDs exist.

Recovery must use the run’s immutable plan snapshot, not the current global stream library.

### Step 8.3: Add selection rules

Keep by default:

- Landscape;
- Evaluation.

Conditionally include:

- Exemplars when examples or solution-space learning matter;
- Pain & Gaps for opportunity discovery;
- Resources when feasibility depends on tools, data, channels, or assets;
- Analogies when novelty is balanced/bold or the direct space is stale.

Strengthen the existing Evaluation stream to cover risks and disconfirming evidence before creating a separate counterevidence stream.

### Gate 8

Add conditional streams only if, across at least 12 runs:

- a stream is judged low-value in at least 50% of runs;
- excluding it saves at least 20% cost or runtime;
- usefulness and missed-constraint rates do not worsen.

---

## Phase 9 — Improve ranking after the brief and plan are stable

Pass:

- hard constraints as veto rules;
- anti-goals as vetoes or penalties;
- success criteria as ranking guidance;
- resources, deadline, and effort as feasibility inputs;
- preferences as tie-breakers;
- idea style as diversity guidance.

Add constraint violations and optional per-criterion explanations to generated ideas before replacing the current stored score fields.

Keep existing scores for backward compatibility until the idea schema and UI are migrated together.

---

## Explicitly defer

Do not implement these during the initial redesign:

- three prominent entry lanes;
- pure conversational intake;
- uploads and document parsing;
- numerical criterion weights;
- pairwise comparison UI;
- sensitivity analysis;
- mathematical information-gain scoring;
- exposed LLM confidence percentages;
- learned preferences or automatic defaults;
- a new counterevidence stream;
- automatic generation of arbitrary new streams;
- large multi-user A/B infrastructure.

Revisit each only when observed Scraply usage demonstrates the problem it would solve.

---

## Recommended commit sequence

Keep the work reviewable with this order:

1. `test: add intake baseline fixtures`
2. `refactor: centralize brief context consumers`
3. `test: cover field-to-consumer routing`
4. `feat: add versioned brief v2 normalization`
5. `test: preserve legacy briefs runs and branches`
6. `feat: add brief-first extraction endpoint`
7. `feat: replace intake questionnaire with smart entry`
8. `feat: make inferred brief fully editable`
9. `feat: add honest review-and-run summary`
10. `test: cover paste brief to run end to end`
11. `chore: record single-user pilot metrics`

Only after the pilot gates pass:

12. `feat: add deterministic intake clarifications`
13. `feat: persist research plans`
14. `feat: execute selected research streams`
15. `feat: make ranking decision-aware`

---

## Definition of done for the first release

The first release is done when:

- a user can paste one sentence or a full brief;
- Scraply extracts a draft without inventing critical constraints;
- every retained field is visible and editable;
- fields demonstrably affect the correct downstream stages;
- assumptions and unknowns are visible;
- the pre-run screen honestly shows the fixed execution plan and limits;
- the run snapshots its brief and configuration;
- legacy briefs, branches, and runs still load;
- the full test suite passes;
- `bun run build:installed` passes;
- the 10–12 task pilot meets the effort and quality gates.

That release captures most of the value from both reports without committing Scraply to speculative complexity.
