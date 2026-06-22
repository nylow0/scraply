<script lang="ts">
  import { untrack } from "svelte";
  import type { ProjectBrief, RunConfig, Researcher } from "../../shared/schemas";
  import type { ModelTestResult } from "../../shared/ipc";
  import { DEFAULT_RUN_CONFIG } from "../../shared/intake";

  let {
    threadId,
    brief,
    config,
    models,
    presets,
    testResults = null,
    testBusy = false,
    launching = false,
    onTest,
    onLaunch,
    onSavePreset,
    onSaveDraft,
  }: {
    threadId: string;
    brief: ProjectBrief | null;
    config: RunConfig | null;
    models: string[];
    presets: Array<{ name: string; config: RunConfig }>;
    testResults?: ModelTestResult[] | null;
    testBusy?: boolean;
    launching?: boolean;
    onTest: (models: string[]) => void;
    onLaunch: (brief: ProjectBrief, config: RunConfig) => void;
    onSavePreset: (config: RunConfig, name: string) => void;
    onSaveDraft?: (brief: ProjectBrief, config: RunConfig) => void;
  } = $props();

  function blankBrief(): ProjectBrief {
    return {
      projectName: "",
      goal: "",
      theme: "",
      description: "",
      successDefinition: "",
      desiredOutput: "A shortlist of strong ideas with evidence",
      successDecider: "",
      motivation: "",
      constraints: [],
      resources: [],
      avoidList: [],
      researchNeeds: "",
      finalDecision: "Choose the best next idea to pursue",
      deadline: "Flexible",
      availableEffort: "Not specified",
      ideaStylePreference: "Balanced",
      examples: "",
      scoringCriteria: "",
      anythingElse: "",
    };
  }

  // Seed once from props (the component is keyed per thread, so it remounts on switch);
  // the form owns its draft after that.
  let b = $state<ProjectBrief>(untrack(() => (brief ? { ...brief } : blankBrief())));
  let c = $state<RunConfig>(
    untrack(() =>
      config
        ? { ...config, researchers: config.researchers.map((r) => ({ ...r })) }
        : { ...DEFAULT_RUN_CONFIG, researchers: DEFAULT_RUN_CONFIG.researchers.map((r) => ({ ...r })) },
    ),
  );

  // List fields edit as text, persist as string[].
  let resourcesText = $state(untrack(() => (brief?.resources ?? []).join("\n")));
  let constraintsText = $state(untrack(() => (brief?.constraints ?? []).join("\n")));
  let avoidText = $state(untrack(() => (brief?.avoidList ?? []).join("\n")));

  let presetName = $state("");
  let showAdvanced = $state(false);
  let draftStatus = $state<"idle" | "saving" | "saved">("idle");
  let draftTimer: ReturnType<typeof setTimeout> | null = null;

  const REQUIRED_FIELD_COUNT = 10;

  function splitLines(value: string): string[] {
    return value.split(/\n|;/).map((part) => part.trim()).filter(Boolean);
  }

  // The required intake questions from IDEAS.md that must be answered to launch.
  const required = $derived(
    [
      !b.projectName.trim() && "a name for this run",
      !b.goal.trim() && "what we're generating ideas for",
      !b.theme.trim() && "theme / area",
      !b.description.trim() && "description",
      !b.successDefinition.trim() && "what makes an idea good",
      !b.desiredOutput.trim() && "desired output",
      !b.successDecider.trim() && "who decides success",
      !b.motivation.trim() && "your motivation",
      !b.deadline.trim() && "deadline or completion window",
      !b.finalDecision.trim() && "the final decision",
    ].filter(Boolean) as string[],
  );

  const requiredComplete = $derived(REQUIRED_FIELD_COUNT - required.length);
  const progressPct = $derived(Math.round((requiredComplete / REQUIRED_FIELD_COUNT) * 100));

  const enabledCount = $derived(c.researchers.filter((r) => r.enabled && r.focus.trim()).length);
  const missing = $derived(
    enabledCount === 0 ? [...required, "at least one researcher"] : required,
  );
  const canLaunch = $derived(missing.length === 0 && !launching);

  function buildFinalBrief(): ProjectBrief {
    return {
      ...b,
      projectName: b.projectName.trim(),
      goal: b.goal.trim(),
      theme: b.theme.trim(),
      description: b.description.trim(),
      successDefinition: b.successDefinition.trim(),
      successDecider: b.successDecider.trim(),
      motivation: b.motivation.trim(),
      deadline: b.deadline.trim(),
      availableEffort: b.availableEffort.trim(),
      constraints: splitLines(constraintsText),
      resources: splitLines(resourcesText),
      avoidList: splitLines(avoidText),
    };
  }

  function scheduleDraftSave() {
    if (!onSaveDraft) return;
    draftStatus = "saving";
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      onSaveDraft(buildFinalBrief(), c);
      draftStatus = "saved";
      setTimeout(() => {
        if (draftStatus === "saved") draftStatus = "idle";
      }, 2000);
    }, 1200);
  }

  $effect(() => {
    void b.projectName;
    void b.goal;
    void b.theme;
    void b.description;
    void b.successDefinition;
    void b.desiredOutput;
    void b.successDecider;
    void b.motivation;
    void b.deadline;
    void b.availableEffort;
    void b.finalDecision;
    void b.ideaStylePreference;
    void b.examples;
    void b.researchNeeds;
    void b.scoringCriteria;
    void b.anythingElse;
    void resourcesText;
    void constraintsText;
    void avoidText;
    void c.orchestratorModel;
    void c.workerModel;
    void c.ideaModel;
    void c.ideasRequested;
    void c.researchers;
    scheduleDraftSave();
  });

  function setResearchersEnabled(enabled: boolean) {
    c.researchers = c.researchers.map((r) => ({ ...r, enabled }));
  }

  function scrollToSection(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function addResearcher() {
    c.researchers = [
      ...c.researchers,
      {
        id: crypto.randomUUID(),
        name: "Custom researcher",
        lens: "landscape",
        focus: "",
        instructions: "",
        enabled: true,
        custom: true,
      } satisfies Researcher,
    ];
  }

  function removeResearcher(id: string) {
    c.researchers = c.researchers.filter((r) => r.id !== id);
  }

  function applyPreset(name: string) {
    const preset = presets.find((p) => p.name === name);
    if (preset) c = { ...preset.config, researchers: preset.config.researchers.map((r) => ({ ...r })) };
  }

  function runModelTests() {
    onTest([c.orchestratorModel, c.workerModel, c.ideaModel]);
  }

  function launch() {
    if (!canLaunch) return;
    onLaunch(buildFinalBrief(), c);
  }

  function modelOptions(selected: string): string[] {
    return models.includes(selected) || !selected ? models : [...models, selected];
  }
</script>

<div class="configurator">
  <div class="intro">
    <div class="intro-head">
      <div>
        <h2>Set up your research run</h2>
        <p>Describe the project, choose who researches it and with which models, then launch. The agents work it out behind the scenes and hand back an idea shortlist.</p>
      </div>
      <div class="progress-wrap" aria-label="Required fields progress">
        <span class="progress-label">{requiredComplete}/{REQUIRED_FIELD_COUNT} essentials</span>
        <div class="progress-track"><span class="progress-fill" style={`width:${progressPct}%`}></span></div>
      </div>
    </div>
    <nav class="section-nav" aria-label="Configurator sections">
      <button type="button" onclick={() => scrollToSection("cfg-essentials")}>Essentials</button>
      <button type="button" onclick={() => scrollToSection("cfg-optional")}>Optional</button>
      <button type="button" onclick={() => scrollToSection("cfg-researchers")}>Researchers</button>
      <button type="button" onclick={() => scrollToSection("cfg-models")}>Models</button>
    </nav>
  </div>

  <!-- BRIEF: REQUIRED QUESTIONS -->
  <section class="card" id="cfg-essentials">
    <header class="card-head">
      <span class="step">01</span>
      <div>
        <h3>Intake — the essentials</h3>
        <p>Answer these so the researchers and idea writer know what you're after. All required.</p>
      </div>
    </header>

    <div class="fields">
      <label class="field">
        <span class="lbl">Name this run <em>required</em></span>
        <input type="text" placeholder="e.g. Weekend AI side-project" bind:value={b.projectName} />
      </label>

      <label class="field">
        <span class="lbl">What are we trying to generate ideas for? <em>required</em></span>
        <textarea rows="2" placeholder="The thing you want ideas for — a project, a business, a paper, a competition entry…" bind:value={b.goal}></textarea>
      </label>

      <label class="field">
        <span class="lbl">What is the broad theme or area? <em>required</em></span>
        <input type="text" placeholder="e.g. Developer tools for solo founders" bind:value={b.theme} />
      </label>

      <label class="field">
        <span class="lbl">Your rough description <em>required</em></span>
        <textarea rows="3" placeholder="A few sentences of context on what you're after." bind:value={b.description}></textarea>
      </label>

      <label class="field">
        <span class="lbl">What would make an idea good in this context? <em>required</em></span>
        <textarea rows="2" placeholder="What separates a great idea from a mediocre one here." bind:value={b.successDefinition}></textarea>
      </label>

      <label class="field">
        <span class="lbl">What final output do you want? <em>required</em></span>
        <input type="text" bind:value={b.desiredOutput} />
      </label>

      <label class="field">
        <span class="lbl">Who or what decides whether this succeeds? <em>required</em></span>
        <input type="text" placeholder="You, a market, judges, a metric…" bind:value={b.successDecider} />
      </label>

      <label class="field">
        <span class="lbl">Why do you want to do this, and what main reward matters? <em>required</em></span>
        <textarea rows="2" placeholder="Learning, money, impact, fun, a grade, a portfolio piece…" bind:value={b.motivation}></textarea>
      </label>

      <label class="field">
        <span class="lbl">Deadline or ideal completion window <em>required</em></span>
        <input type="text" placeholder="e.g. 6 weeks, end of semester, flexible" bind:value={b.deadline} />
      </label>

      <label class="field">
        <span class="lbl">How much time can you spend per week?</span>
        <input type="text" placeholder="e.g. ~5 hours, weekends only" bind:value={b.availableEffort} />
      </label>

      <label class="field">
        <span class="lbl">Hard constraints <em>one per line</em></span>
        <textarea rows="2" placeholder="Budget caps, team size, tech stack, geography, legal limits…" bind:value={constraintsText}></textarea>
      </label>

      <label class="field">
        <span class="lbl">What skills, tools, resources, people, or data do you have? <em>one per line</em></span>
        <textarea rows="2" placeholder="Skills, tools, data, people, budget…" bind:value={resourcesText}></textarea>
      </label>

      <label class="field">
        <span class="lbl">What do you absolutely not want to do? <em>one per line</em></span>
        <textarea rows="2" placeholder="Approaches, topics, or commitments to rule out." bind:value={avoidText}></textarea>
      </label>

      <label class="field">
        <span class="lbl">What decision do we need at the end? <em>required</em></span>
        <input type="text" bind:value={b.finalDecision} />
      </label>
    </div>
  </section>

  <!-- BRIEF: OPTIONAL QUESTIONS -->
  <section class="card" id="cfg-optional">
    <header class="card-head">
      <span class="step">02</span>
      <div>
        <h3>Optional — sharpens the results</h3>
        <p>Skip any of these. They give the agents more to work with.</p>
      </div>
    </header>

    <div class="fields">
      <label class="field">
        <span class="lbl">Safe, weird, or a mix?</span>
        <select bind:value={b.ideaStylePreference}>
          <option value="Safe">Mostly safe / practical</option>
          <option value="Balanced">A balanced mix</option>
          <option value="Weird">Weird / high-upside</option>
        </select>
      </label>
      <label class="field span2">
        <span class="lbl">Existing things, problems, or examples to pay attention to?</span>
        <textarea rows="2" placeholder="Projects, products, papers, competitors, known issues…" bind:value={b.examples}></textarea>
      </label>
      <label class="field span2">
        <span class="lbl">What should we research before generating ideas?</span>
        <textarea rows="2" placeholder="Anything the researchers must dig into." bind:value={b.researchNeeds}></textarea>
      </label>
      <label class="field span2">
        <span class="lbl">What scoring criteria should matter most?</span>
        <textarea rows="2" placeholder="e.g. feasibility over novelty, low cost, fast to ship…" bind:value={b.scoringCriteria}></textarea>
      </label>
      <label class="field span2">
        <span class="lbl">Anything else important the questions didn't cover?</span>
        <textarea rows="2" bind:value={b.anythingElse}></textarea>
      </label>
    </div>
  </section>

  <!-- RESEARCHERS -->
  <section class="card" id="cfg-researchers">
    <header class="card-head">
      <span class="step">03</span>
      <div>
        <h3>Your researchers</h3>
        <p>Each one investigates the topic from a different angle. Toggle them, rewrite their focus, or add your own.</p>
      </div>
      <div class="researcher-actions">
        <button type="button" class="ghost mini" onclick={() => setResearchersEnabled(true)}>All on</button>
        <button type="button" class="ghost mini" onclick={() => setResearchersEnabled(false)}>All off</button>
        <span class="count">{enabledCount} active</span>
      </div>
    </header>

    <div class="researchers">
      {#each c.researchers as researcher (researcher.id)}
        <article class="researcher" class:off={!researcher.enabled}>
          <div class="researcher-top">
            <label class="toggle">
              <input type="checkbox" bind:checked={researcher.enabled} />
              <span class="track"><span class="knob"></span></span>
            </label>
            {#if researcher.custom}
              <input class="researcher-name" bind:value={researcher.name} aria-label="Researcher name" />
              <button class="icon-btn" title="Remove researcher" onclick={() => removeResearcher(researcher.id)}>×</button>
            {:else}
              <span class="researcher-name fixed">{researcher.name}</span>
              <span class="lens">{researcher.lens}</span>
            {/if}
          </div>
          <textarea
            class="researcher-focus"
            rows="2"
            placeholder="What should this researcher look for?"
            bind:value={researcher.focus}
            disabled={!researcher.enabled}
          ></textarea>
        </article>
      {/each}

      <button class="add-researcher" onclick={addResearcher}>
        <span>＋</span> Add your own researcher
      </button>
    </div>
  </section>

  <!-- MODELS -->
  <section class="card" id="cfg-models">
    <header class="card-head">
      <span class="step">04</span>
      <div>
        <h3>Models</h3>
        <p>Pick the model that orchestrates, the one each researcher uses, and the one that writes ideas.</p>
      </div>
      <button class="ghost test-btn" disabled={testBusy} onclick={runModelTests}>
        {testBusy ? "Testing…" : "Test models"}
      </button>
    </header>

    <div class="fields models">
      <label class="field">
        <span class="lbl">Orchestrator</span>
        <select bind:value={c.orchestratorModel}>
          {#each modelOptions(c.orchestratorModel) as model}<option value={model}>{model}</option>{/each}
        </select>
      </label>
      <label class="field">
        <span class="lbl">Researchers (worker)</span>
        <select bind:value={c.workerModel}>
          {#each modelOptions(c.workerModel) as model}<option value={model}>{model}</option>{/each}
        </select>
      </label>
      <label class="field">
        <span class="lbl">Idea writer</span>
        <select bind:value={c.ideaModel}>
          {#each modelOptions(c.ideaModel) as model}<option value={model}>{model}</option>{/each}
        </select>
      </label>
    </div>

    {#if testResults?.length}
      <div class="test-results">
        {#each testResults as result (result.model)}
          <div class="test-row">
            <strong>{result.model}</strong>
            <span class="test-stat" data-ok={result.chatOk}>chat {result.chatOk ? "ok" : "fail"}</span>
            <span class="test-stat" data-ok={result.structuredOk}>json {result.structuredOk ? "ok" : "fail"}</span>
            <span class="latency">{Math.round(result.latencyMs / 1000)}s</span>
            {#if !result.chatOk && result.chatError}<p class="test-err">{result.chatError}</p>{/if}
            {#if !result.structuredOk && result.structuredError}<p class="test-err">{result.structuredError}</p>{/if}
          </div>
        {/each}
      </div>
    {/if}
  </section>

  <!-- ADVANCED -->
  <section class="card">
    <button class="disclosure head-disclosure" onclick={() => (showAdvanced = !showAdvanced)} aria-expanded={showAdvanced}>
      <span class="chev" class:open={showAdvanced}>›</span>
      Advanced run settings
    </button>
    {#if showAdvanced}
      <div class="fields advanced">
        <label class="field">
          <span class="lbl">Ideas requested</span>
          <input type="number" min="1" max="200" bind:value={c.ideasRequested} />
        </label>
        <label class="field">
          <span class="lbl">Batch size</span>
          <input type="number" min="1" max="20" bind:value={c.batchSize} />
        </label>
        <label class="field">
          <span class="lbl">Follow-up rounds</span>
          <input type="number" min="0" max="5" bind:value={c.maxFollowUpRounds} />
        </label>
        <label class="field">
          <span class="lbl">Results / researcher</span>
          <input type="number" min="1" max="20" bind:value={c.searchResultsPerStream} />
        </label>
        <label class="field">
          <span class="lbl">Parallelism</span>
          <input type="number" min="1" max="6" bind:value={c.parallelism} />
        </label>
        <label class="field">
          <span class="lbl">Max spend (USD)</span>
          <input type="number" min="0" step="0.5" bind:value={c.maxSpendUsd} />
        </label>
      </div>
      <div class="preset-row">
        <input class="preset-input" placeholder="Preset name" bind:value={presetName} />
        <button class="ghost" disabled={!presetName.trim()} onclick={() => { onSavePreset(c, presetName.trim()); presetName = ""; }}>Save preset</button>
        {#if presets.length}
          <select class="preset-select" onchange={(e) => applyPreset((e.currentTarget as HTMLSelectElement).value)}>
            <option value="">Load preset…</option>
            {#each presets as preset}<option value={preset.name}>{preset.name}</option>{/each}
          </select>
        {/if}
      </div>
    {/if}
  </section>
</div>

<div class="launch-bar">
  <div class="launch-info">
    {#if missing.length}
      <span class="needs">Still needed: {missing.join(", ")}</span>
    {:else}
      <span class="ready">Ready · {enabledCount} researchers · {c.ideasRequested} ideas</span>
    {/if}
    {#if onSaveDraft && draftStatus !== "idle"}
      <span class="draft-status" data-state={draftStatus}>
        {draftStatus === "saving" ? "Saving draft…" : "Draft saved"}
      </span>
    {/if}
  </div>
  <button class="launch" disabled={!canLaunch} onclick={launch}>
    {launching ? "Launching…" : "Launch research →"}
  </button>
</div>

<style>
  .configurator {
    max-width: 860px;
    margin: 0 auto;
    padding: var(--space-6) var(--space-5) 120px;
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .intro h2 {
    margin: 0 0 var(--space-2);
    font-size: 22px;
    font-weight: 600;
    letter-spacing: -0.02em;
  }
  .intro-head {
    display: flex;
    gap: var(--space-4);
    align-items: flex-start;
    justify-content: space-between;
  }
  .progress-wrap {
    flex-shrink: 0;
    width: 140px;
    display: grid;
    gap: 6px;
  }
  .progress-label {
    font-family: var(--mono);
    font-size: 10px;
    color: var(--muted);
    text-align: right;
  }
  .progress-track {
    height: 4px;
    border-radius: 999px;
    background: var(--surface-3);
    overflow: hidden;
  }
  .progress-fill {
    display: block;
    height: 100%;
    border-radius: 999px;
    background: var(--accent);
    transition: width var(--dur) var(--ease);
  }
  .section-nav {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
    margin-top: var(--space-3);
  }
  .section-nav button {
    border: 1px solid var(--border);
    background: transparent;
    color: var(--muted);
    border-radius: 999px;
    padding: 4px 10px;
    font-size: 11.5px;
    font-weight: 500;
    width: auto;
  }
  .section-nav button:hover {
    border-color: var(--accent-border);
    color: var(--accent-strong);
    background: var(--accent-faint);
  }
  .intro p {
    margin: 0;
    color: var(--muted);
    font-size: 13.5px;
    max-width: 64ch;
    line-height: 1.55;
  }

  .card {
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    background: var(--surface);
    padding: var(--space-5);
    box-shadow: var(--shadow-inset);
  }

  .card-head {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    margin-bottom: var(--space-4);
  }
  .step {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--accent-strong);
    background: var(--accent-bg);
    border: 1px solid var(--accent-border);
    border-radius: var(--r-sm);
    padding: 3px 7px;
    flex-shrink: 0;
    margin-top: 2px;
  }
  .card-head h3 {
    margin: 0 0 2px;
    font-size: 15px;
    font-weight: 600;
  }
  .card-head p {
    margin: 0;
    color: var(--muted);
    font-size: 12.5px;
    line-height: 1.5;
  }
  .card-head .count {
    margin-left: auto;
    align-self: center;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-2);
    white-space: nowrap;
  }
  .researcher-actions {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .ghost.mini {
    padding: 4px 8px;
    font-size: 11px;
  }

  .fields {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-3);
  }
  .fields.extra,
  .fields.advanced {
    margin-top: var(--space-3);
  }
  .field {
    display: grid;
    gap: 6px;
    min-width: 0;
  }
  .field.span2 {
    grid-column: 1 / -1;
  }
  /* The three required fields stack full width for breathing room. */
  .card:first-of-type .fields:first-of-type .field {
    grid-column: 1 / -1;
  }

  .lbl {
    font-size: 12px;
    color: var(--text-2);
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .lbl em {
    font-style: normal;
    font-size: 10px;
    color: var(--faint);
    font-family: var(--mono);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  input,
  textarea,
  select {
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-md);
    color: var(--text);
    padding: 9px 11px;
    width: 100%;
    transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
  }
  textarea {
    resize: vertical;
    line-height: 1.5;
    font-family: var(--sans);
  }
  input:focus,
  textarea:focus,
  select:focus {
    outline: none;
    border-color: var(--accent-border);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 14%, transparent);
  }

  .disclosure {
    margin-top: var(--space-4);
    background: transparent;
    border: none;
    color: var(--muted);
    font-size: 12.5px;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 0;
  }
  .disclosure:hover {
    color: var(--text);
  }
  .head-disclosure {
    margin-top: 0;
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
  }
  .chev {
    display: inline-block;
    transition: transform var(--dur) var(--ease);
    font-size: 16px;
    line-height: 1;
  }
  .chev.open {
    transform: rotate(90deg);
  }

  /* Researchers */
  .researchers {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-3);
  }
  .researcher {
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    background: var(--bg);
    padding: var(--space-3);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    transition: border-color var(--dur) var(--ease), opacity var(--dur) var(--ease);
  }
  .researcher.off {
    opacity: 0.5;
  }
  .researcher:not(.off) {
    border-color: var(--accent-border);
  }
  .researcher-top {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .researcher-name {
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
    width: auto;
    flex: 1;
    background: transparent;
    border: 1px solid transparent;
    padding: 4px 6px;
  }
  .researcher-name.fixed {
    border: none;
    padding: 4px 0;
  }
  .researcher-name:focus {
    background: var(--surface-2);
    border-color: var(--border-strong);
  }
  .lens {
    font-family: var(--mono);
    font-size: 10px;
    color: var(--muted);
    text-transform: lowercase;
  }
  .researcher-focus {
    font-size: 12px;
    color: var(--text-2);
  }
  .researcher-focus:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .toggle {
    position: relative;
    display: inline-flex;
    flex-shrink: 0;
  }
  .toggle input {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
  }
  .track {
    width: 30px;
    height: 17px;
    border-radius: 999px;
    background: var(--surface-3);
    border: 1px solid var(--border-strong);
    display: inline-flex;
    align-items: center;
    padding: 1px;
    transition: background var(--dur) var(--ease);
  }
  .knob {
    width: 13px;
    height: 13px;
    border-radius: 50%;
    background: var(--muted);
    transition: transform var(--dur) var(--ease), background var(--dur) var(--ease);
  }
  .toggle input:checked + .track {
    background: var(--accent-bg-hover);
    border-color: var(--accent-border);
  }
  .toggle input:checked + .track .knob {
    transform: translateX(13px);
    background: var(--accent-strong);
  }

  .icon-btn {
    background: transparent;
    border: none;
    color: var(--muted);
    font-size: 18px;
    line-height: 1;
    padding: 2px 6px;
    border-radius: var(--r-sm);
  }
  .icon-btn:hover {
    color: var(--danger);
    background: var(--danger-bg);
  }

  .add-researcher {
    grid-column: 1 / -1;
    border: 1px dashed var(--border-strong);
    background: transparent;
    border-radius: var(--r-md);
    color: var(--muted);
    padding: var(--space-3);
    font-size: 12.5px;
    transition: border-color var(--dur) var(--ease), color var(--dur) var(--ease);
  }
  .add-researcher:hover {
    border-color: var(--accent-border);
    color: var(--accent-strong);
  }
  .add-researcher span {
    color: var(--accent-strong);
  }

  .models {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .test-btn {
    margin-left: auto;
    align-self: center;
  }

  .test-results {
    display: grid;
    gap: var(--space-2);
    margin-top: var(--space-3);
    padding-top: var(--space-3);
    border-top: 1px solid var(--hairline);
  }
  .test-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    font-size: 12px;
  }
  .test-row strong {
    font-family: var(--mono);
    color: var(--accent-strong);
  }
  .test-stat {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--danger);
  }
  .test-stat[data-ok="true"] {
    color: var(--accent-strong);
  }
  .latency {
    color: var(--muted);
    font-family: var(--mono);
    font-size: 11px;
  }
  .test-err {
    flex-basis: 100%;
    margin: 0;
    color: var(--danger);
    font-size: 11px;
    font-family: var(--mono);
    word-break: break-word;
  }

  .advanced {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .preset-row {
    display: flex;
    gap: var(--space-2);
    margin-top: var(--space-3);
    align-items: center;
  }
  .preset-input {
    width: 160px;
  }
  .preset-select {
    width: auto;
    margin-left: auto;
  }

  .ghost {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-2);
    border-radius: var(--r-md);
    padding: 7px 12px;
    font-size: 12.5px;
    font-weight: 500;
    width: auto;
  }
  .ghost:hover:not(:disabled) {
    border-color: var(--border-strong);
    color: var(--text);
    background: var(--surface-2);
  }
  .ghost:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Launch bar */
  .launch-bar {
    position: sticky;
    bottom: 0;
    display: flex;
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-3) var(--space-5);
    background: color-mix(in srgb, var(--bg) 82%, transparent);
    backdrop-filter: blur(14px) saturate(1.2);
    border-top: 1px solid var(--border);
    z-index: 5;
  }
  .launch-info {
    flex: 1;
    min-width: 0;
    font-size: 12.5px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3);
  }
  .draft-status {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
  }
  .draft-status[data-state="saved"] {
    color: var(--accent-strong);
  }
  .needs {
    color: var(--warn);
  }
  .ready {
    color: var(--muted);
    font-family: var(--mono);
    font-size: 12px;
  }
  .launch {
    background: var(--accent);
    border: 1px solid var(--accent-strong);
    color: #1a1500;
    font-weight: 600;
    border-radius: var(--r-md);
    padding: 10px 20px;
    font-size: 13.5px;
    transition: transform var(--dur-fast) var(--ease), filter var(--dur) var(--ease);
  }
  .launch:hover:not(:disabled) {
    filter: brightness(1.08);
  }
  .launch:active:not(:disabled) {
    transform: translateY(1px);
  }
  .launch:disabled {
    background: var(--surface-3);
    border-color: var(--border-strong);
    color: var(--faint);
    cursor: not-allowed;
  }

  @media (max-width: 720px) {
    .fields,
    .researchers,
    .models,
    .advanced {
      grid-template-columns: 1fr;
    }

    .launch-bar {
      flex-direction: column;
      align-items: stretch;
      gap: var(--space-3);
    }

    .launch {
      width: 100%;
      text-align: center;
    }
  }
</style>
