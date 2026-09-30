<script lang="ts">
  import { untrack } from "svelte";
  import { ResearchFrameSchema, type ResearchFrame, type ResearchVenue } from "../../shared/research-frame";

  let { frame, sources = [], purpose = "discovery", usage, busy = false, canRegenerate = true,
    onCommit, onRegenerate, onEditBrief, onOpenSource }: {
    frame: ResearchFrame;
    sources?: { id: string; title: string; url: string }[];
    purpose?: "discovery" | "known-problem";
    usage?: { modelCalls: number; searches: number };
    busy?: boolean;
    canRegenerate?: boolean;
    onCommit: (frame: ResearchFrame) => Promise<void>;
    onRegenerate: (frame: ResearchFrame) => Promise<void>;
    onEditBrief: () => Promise<void>;
    onOpenSource?: (url: string) => Promise<void>;
  } = $props();

  // Parse makes an independent draft. A new frame after regeneration replaces it.
  let draft = $state(untrack(() => ResearchFrameSchema.parse(frame)));
  let pending = $state<"commit" | "regenerate" | "brief" | null>(null);
  let error = $state("");
  let languageCode = $state("");
  let newAreaId = $state<string | null>(null);
  let disabled = $derived(busy || pending !== null);
  let includedCount = $derived(draft.areas.filter(area => area.included).length);
  const languageNames = new Intl.DisplayNames(["en"], { type: "language" });
  const goalKinds: { value: ResearchFrame["goalKind"]; label: string }[] = [
    { value: "market-opportunity", label: "Market opportunity" },
    { value: "competition-entry", label: "Competition entry" },
    { value: "research-question", label: "Research question" },
    { value: "community-or-personal", label: "Community or personal" },
    { value: "process-improvement", label: "Process improvement" },
    { value: "other", label: "Other" },
  ];
  const venueKinds: { value: ResearchVenue["kind"]; label: string }[] = [
    { value: "community", label: "Community" }, { value: "issue-tracker", label: "Issue tracker" },
    { value: "social", label: "Social" }, { value: "official", label: "Official" },
    { value: "publication", label: "Publication" },
  ];

  $effect(() => {
    const replacement = frame;
    untrack(() => { draft = ResearchFrameSchema.parse(replacement); newAreaId = null; error = ""; });
  });

  function moveArea(index: number, direction: -1 | 1) {
    const destination = index + direction;
    if (destination < 0 || destination >= draft.areas.length) return;
    const areas = [...draft.areas];
    [areas[index], areas[destination]] = [areas[destination]!, areas[index]!];
    draft.areas = areas.map((area, position) => ({ ...area, priority: position + 1 }));
  }

  function addArea() {
    const id = crypto.randomUUID();
    draft.areas.push({
      id, name: "New area", whyRelevant: "", affectedPeople: "",
      venues: [{ name: "", kind: "community" }], exampleProblems: [],
      included: true, priority: draft.areas.length + 1,
    });
    newAreaId = id;
  }

  function addLanguage() {
    const code = languageCode.trim().toLowerCase();
    // Check languages against the valid original so an unfinished area cannot hide a duplicate-language error.
    const result = ResearchFrameSchema.safeParse({ ...frame, languages: [...draft.languages, code] });
    const issue = result.success ? undefined : result.error.issues.find(item => item.path[0] === "languages");
    if (issue) { error = issue.message; return; }
    draft.languages.push(code);
    languageCode = "";
    error = "";
  }

  async function submit(action: "commit" | "regenerate") {
    if (disabled || (action === "regenerate" && !canRegenerate)) return;
    error = "";
    const result = ResearchFrameSchema.safeParse($state.snapshot(draft));
    if (!result.success) {
      const issue = result.error.issues[0];
      const sections: Record<string, string> = {
        goal: "Goal", goalKind: "Goal kind", contextFacts: "Context facts", successCriteria: "Success criteria",
        constraints: "Constraints", languages: "Search languages", areas: "Research areas",
        exclusions: "Excluded topics", openQuestions: "Open questions",
      };
      const section = sections[String(issue?.path[0])] ?? "Frame";
      error = issue ? `${section}: ${issue.message}` : "Check the frame before continuing.";
      return;
    }
    if (purpose === "discovery" && !result.data.areas.some(area => area.included)) {
      error = "Include at least one area before starting research.";
      return;
    }
    if (purpose === "known-problem" && result.data.areas.length > 0) {
      error = "A known-problem frame cannot include research areas.";
      return;
    }
    pending = action;
    try { await (action === "commit" ? onCommit : onRegenerate)(result.data); }
    catch (cause) { error = cause instanceof Error ? cause.message : "The frame could not be saved. Try again."; }
    finally { pending = null; }
  }

  async function editBrief() {
    if (disabled) return;
    pending = "brief";
    error = "";
    try { await onEditBrief(); }
    catch (cause) { error = cause instanceof Error ? cause.message : "The brief could not be opened. Try again."; }
    finally { pending = null; }
  }
</script>

<section class="frame-review" aria-label="Research frame review">
  <header>
    <h1>Review research frame</h1>
    <p>Check the goal and where to look before research starts.</p>
    {#if usage}<p class="usage">Spent so far: {usage.modelCalls} model {usage.modelCalls === 1 ? "call" : "calls"}, {usage.searches} {usage.searches === 1 ? "search" : "searches"}</p>{/if}
  </header>

  <fieldset disabled={disabled}>
    <section class="review-section">
      <h2>Goal</h2>
      <label><span>What should this research achieve?</span><textarea aria-label="Goal" rows="3" bind:value={draft.goal}></textarea></label>
      <label class="goal-kind"><span>Goal kind</span><select bind:value={draft.goalKind}>{#each goalKinds as kind (kind.value)}<option value={kind.value}>{kind.label}</option>{/each}</select></label>
    </section>

    <section class="review-section">
      <h2>Context facts</h2>
      <p class="hint">Sourced background for the brief. Remove anything that does not belong.</p>
      {#each draft.contextFacts as fact, index (fact)}
        <div class="fact-row">
          <div><p>{fact.fact}</p><div class="citations">
            {#each fact.sourceIds as id (id)}
              {@const source = sources.find(item => item.id === id)}
              {#if source && onOpenSource}<button type="button" class="text-button" onclick={() => onOpenSource?.(source.url)}>{source.title}</button>
              {:else}<span>{source?.title ?? `Saved source ${id}`}</span>{/if}
            {/each}
          </div></div>
          <button type="button" class="quiet" aria-label={`Remove context fact ${index + 1}`} onclick={() => draft.contextFacts.splice(index, 1)}>Remove</button>
        </div>
      {:else}<p class="hint">No context facts.</p>{/each}
    </section>

    <section class="review-section">
      <h2>Success criteria</h2>
      <p class="hint">Ideas will be checked against each criterion.</p>
      <div class="criteria">
        {#each draft.successCriteria as criterion, index (criterion.id)}
          <div class="criterion">
            <div class="criterion-heading">
              <label class="grow"><span>Criterion</span><input aria-label={`Criterion name ${index + 1}`} bind:value={criterion.name} /></label>
              <label><span>Weight</span><select aria-label={`Criterion weight ${index + 1}`} bind:value={criterion.weight}><option value="must">Must</option><option value="high">High</option><option value="normal">Normal</option></select></label>
              <button type="button" class="quiet remove-criterion" disabled={draft.successCriteria.length === 1} aria-label={`Remove criterion ${index + 1}`} onclick={() => draft.successCriteria.splice(index, 1)}>Remove</button>
            </div>
            <label><span>How to judge it</span><textarea aria-label={`How to judge criterion ${index + 1}`} rows="2" bind:value={criterion.howJudged}></textarea></label>
            <p class="hint">{criterion.basis === "brief" ? "From your brief" : `Based on ${criterion.basis.length} saved ${criterion.basis.length === 1 ? "source" : "sources"}`}</p>
          </div>
        {/each}
      </div>
      <button type="button" class="quiet" disabled={draft.successCriteria.length >= 12} onclick={() => draft.successCriteria.push({ id: crypto.randomUUID(), name: "", weight: "normal", howJudged: "", basis: "brief" })}>Add criterion</button>
    </section>

    {#if draft.openQuestions.length > 0}
      <section class="review-section questions">
        <h2>Open questions</h2>
        {#each draft.openQuestions as question (question.id)}
          <div>
            <label><span>{question.question}</span><textarea rows="2" value={question.answer ?? ""} oninput={event => { const answer = event.currentTarget.value; question.answer = answer.trim() ? answer : undefined; }}></textarea></label>
            <p class="hint">{question.whyItMatters}</p>
            {#if question.options.length > 0}<div class="answer-options">{#each question.options as option, index (index)}<button type="button" class="quiet" onclick={() => question.answer = option}>{option}</button>{/each}</div>{/if}
          </div>
        {/each}
        <p class="hint">You can leave a question unanswered and continue.</p>
      </section>
    {/if}

    <section class="review-section">
      <h2>Search languages</h2>
      <p class="hint">English is always included. Add up to two other languages using their two-letter codes.</p>
      <div class="languages">
        {#each draft.languages as code (code)}
          <span class="language-chip">{languageNames.of(code) ?? code} <span class="code">{code}</span>{#if code !== "en"}<button type="button" aria-label={`Remove ${languageNames.of(code) ?? code}`} onclick={() => draft.languages = draft.languages.filter(language => language !== code)}>×</button>{/if}</span>
        {/each}
        <label class="language-input"><span class="sr-only">Language code</span><input aria-label="Language code" placeholder="uk" maxlength="2" bind:value={languageCode} disabled={draft.languages.length >= 3} onkeydown={event => { if (event.key === "Enter") { event.preventDefault(); addLanguage(); } }} /></label>
        <button type="button" class="quiet" disabled={draft.languages.length >= 3 || !languageCode.trim()} onclick={addLanguage}>Add language</button>
      </div>
    </section>

    {#if purpose === "discovery"}
      <section class="review-section">
        <div class="section-heading"><h2>Areas and where people talk</h2><span class="hint">{includedCount} of {draft.areas.length} included</span></div>
        <p class="hint">Include the areas to explore. Move the most relevant ones higher.</p>
        <div class="areas">
          {#each draft.areas as area, index (area.id)}
            <article class="area" class:excluded={!area.included}>
              <div class="area-heading">
                <label class="include"><input type="checkbox" aria-label={`Include ${area.name}`} bind:checked={area.included} /><span>{area.name}</span></label>
                <div class="area-order"><button type="button" class="quiet" disabled={index === 0} aria-label={`Move ${area.name} up`} onclick={() => moveArea(index, -1)}>↑</button><button type="button" class="quiet" disabled={index === draft.areas.length - 1} aria-label={`Move ${area.name} down`} onclick={() => moveArea(index, 1)}>↓</button></div>
              </div>
              <p class="area-summary">{area.affectedPeople || "Describe the affected people"}</p>
              <p class="hint">{area.venues.map(venue => venue.name).filter(Boolean).join(", ") || "Add where these people talk"}</p>
              <details open={area.id === newAreaId}>
                <summary>Edit area</summary>
                <div class="area-fields">
                  <label><span>Area name</span><input aria-label={`Area name ${index + 1}`} bind:value={area.name} /></label>
                  <label><span>Why it matters to the goal</span><textarea aria-label={`Area relevance ${index + 1}`} rows="2" bind:value={area.whyRelevant}></textarea></label>
                  <label><span>Affected people</span><textarea aria-label={`Affected people ${index + 1}`} rows="2" bind:value={area.affectedPeople}></textarea></label>
                  <div class="venues">
                    <h3>Where people talk</h3>
                    {#each area.venues as venue, venueIndex (venue)}
                      <div class="venue">
                        <label><span>Venue</span><input aria-label={`Venue name ${index + 1}.${venueIndex + 1}`} bind:value={venue.name} /></label>
                        <label><span>Kind</span><select aria-label={`Venue kind ${index + 1}.${venueIndex + 1}`} bind:value={venue.kind}>{#each venueKinds as kind (kind.value)}<option value={kind.value}>{kind.label}</option>{/each}</select></label>
                        <label><span>Domain, optional</span><input aria-label={`Venue domain ${index + 1}.${venueIndex + 1}`} placeholder="example.org" value={venue.domain ?? ""} oninput={event => { const domain = event.currentTarget.value.trim(); venue.domain = domain || undefined; }} /></label>
                        <button type="button" class="quiet" disabled={area.venues.length === 1} aria-label={`Remove venue ${index + 1}.${venueIndex + 1}`} onclick={() => area.venues.splice(venueIndex, 1)}>Remove</button>
                      </div>
                    {/each}
                    <button type="button" class="quiet" disabled={area.venues.length >= 8} onclick={() => area.venues.push({ name: "", kind: "community" })}>Add venue</button>
                  </div>
                  {#if area.exampleProblems.length > 0}<div class="hypotheses"><h3>Example problems to investigate</h3><p class="hint">These are hypotheses to check.</p><ul>{#each area.exampleProblems as problem, index (index)}<li>{problem}</li>{/each}</ul></div>{/if}
                </div>
              </details>
            </article>
          {/each}
        </div>
        <button type="button" class="quiet" disabled={draft.areas.length >= 12} onclick={addArea}>Add your own area</button>
      </section>
    {/if}

    {#if draft.constraints.length > 0 || draft.exclusions.length > 0}
      <section class="review-section boundaries">
        {#if draft.constraints.length > 0}<div><h2>Constraints</h2><ul>{#each draft.constraints as constraint, index (index)}<li>{constraint.text}</li>{/each}</ul></div>{/if}
        {#if draft.exclusions.length > 0}<div><h2>Excluded</h2><ul>{#each draft.exclusions as exclusion, index (index)}<li>{exclusion}</li>{/each}</ul></div>{/if}
      </section>
    {/if}
  </fieldset>

  <footer>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <div class="footer-actions">
      <button type="button" class="primary" disabled={disabled} onclick={() => submit("commit")}>{pending === "commit" ? "Starting…" : purpose === "known-problem" ? "Continue with this frame" : "Start research with this frame"}</button>
      <button type="button" class="quiet" disabled={disabled || !canRegenerate} onclick={() => submit("regenerate")}>{pending === "regenerate" ? "Regenerating…" : "Regenerate frame (1 call)"}</button>
      <button type="button" class="text-button" disabled={disabled} onclick={editBrief}>Edit brief</button>
    </div>
    {#if !canRegenerate}<p class="hint">No model-call allowance remains for regeneration.</p>{/if}
  </footer>
</section>

<style>
  .frame-review { display:flex;flex-direction:column;max-width:var(--page-max);margin:auto;padding:var(--page-top) var(--page-inline) 0;background:var(--bg); }
  header { padding-bottom:24px; }h1 { margin:0;font-size:27px;font-weight:550;letter-spacing:-.8px; }header p { margin:9px 0 0;color:var(--muted);max-width:72ch; }.usage { font-size:12px; }
  fieldset { border:0;padding:0;margin:0;min-width:0; }h2 { margin:0 0 14px;font-size:17px;font-weight:550;letter-spacing:-.3px; }h3 { margin:0;font-size:13px;font-weight:600; }
  .review-section { padding:24px 0;border-top:1px solid var(--border); }.review-section > .hint { margin:-5px 0 16px; }.review-section > .quiet { margin-top:14px; }
  label { display:flex;flex-direction:column;gap:7px; }label > span { font-size:12px;color:var(--muted); }input:not([type="checkbox"]),textarea,select { width:100%;padding:10px 12px;border:1px solid var(--border-strong);border-radius:8px;background:var(--bg);color:var(--text); }
  .goal-kind { margin-top:14px;max-width:300px; }.hint { color:var(--muted);font-size:12px;line-height:1.6; }.fact-row { display:flex;gap:20px;align-items:flex-start;padding:14px 0;border-bottom:1px solid var(--border); }.fact-row:last-child { border-bottom:0; }.fact-row > div { flex:1;min-width:0; }.fact-row p { margin:0;max-width:76ch; }.citations { display:flex;gap:10px;flex-wrap:wrap;margin-top:7px;font-size:12px;color:var(--muted); }
  button.quiet { padding:8px 11px;border:1px solid var(--border-strong);border-radius:8px;background:var(--surface);color:var(--text);font-size:12px;white-space:nowrap; }.text-button { padding:0;border:0;background:transparent;color:var(--accent-strong);font-size:12px;text-align:left; }.quiet:hover:not(:disabled) { background:var(--surface-2); }button:disabled { opacity:.45;cursor:not-allowed; }
  .criteria { display:flex;flex-direction:column;gap:22px; }.criterion-heading { display:flex;gap:12px;align-items:flex-end;margin-bottom:12px; }.grow { flex:1; }.criterion-heading select { min-width:110px; }.remove-criterion { margin-bottom:2px; }.criterion > .hint { margin:8px 0 0; }
  .questions > div + div { margin-top:22px; }.questions .hint { margin:8px 0; }.answer-options { display:flex;flex-wrap:wrap;gap:8px; }.questions > .hint:last-child { margin:16px 0 0; }
  .languages { display:flex;flex-wrap:wrap;align-items:center;gap:9px; }.language-chip { display:inline-flex;gap:8px;align-items:center;padding:7px 11px;border:1px solid var(--border-strong);border-radius:999px;font-size:12px; }.code { color:var(--subtle); }.language-chip button { border:0;background:none;color:var(--muted);font-size:17px;line-height:1;padding:0 2px; }.language-input { width:60px; }.language-input input { padding:7px 10px; }
  .section-heading { display:flex;justify-content:space-between;align-items:baseline;gap:12px; }.section-heading h2 { margin-bottom:14px; }.areas { display:flex;flex-direction:column;gap:12px; }.area { padding:16px 18px;border:1px solid var(--border);border-radius:12px;background:var(--surface); }.area.excluded { border-style:dashed; }.area.excluded .include > span { color:var(--subtle); }.area-heading { display:flex;justify-content:space-between;align-items:center;gap:10px; }.include { flex-direction:row;align-items:center;gap:10px; }.include input { width:15px;height:15px;accent-color:var(--accent); }.include > span { color:var(--text);font-size:14px;font-weight:550; }.area-order { display:flex;gap:6px; }.area-order button { padding:4px 9px;font-size:16px; }.area-summary { margin:10px 0 5px;font-size:13px; }.area > .hint { margin:0; }.area details { margin-top:14px; }.area summary { width:fit-content;color:var(--accent-strong);font-size:12px;cursor:pointer; }.area-fields { display:flex;flex-direction:column;gap:14px;margin-top:16px; }.venue { display:grid;grid-template-columns:1.1fr 1fr 1.2fr auto;gap:10px;align-items:end;margin:12px 0; }.venue .quiet { margin-bottom:2px; }.hypotheses .hint { margin:5px 0; }
  ul { padding-left:20px;margin:10px 0 0;list-style:disc;color:var(--muted);font-size:13px; }li + li { margin-top:6px; }.boundaries { display:flex;gap:32px; }.boundaries > div { flex:1; }
  footer { position:sticky;bottom:0;margin-top:10px;padding:18px 0;background:var(--bg);border-top:1px solid var(--border);z-index:1; }.footer-actions { display:flex;align-items:center;gap:12px;flex-wrap:wrap; }.primary { padding:11px 16px;border:1px solid transparent;border-radius:9px;background:var(--accent);color:var(--accent-ink);font-size:13px;font-weight:600; }.primary:hover:not(:disabled) { background:var(--accent-strong); }.error { color:var(--danger);margin:0 0 12px;font-size:13px; }footer > .hint { margin:9px 0 0; }.sr-only { position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap; }
  @media(max-width:760px) { .criterion-heading { flex-wrap:wrap; }.criterion-heading .grow { flex-basis:100%; }.venue { grid-template-columns:1fr 1fr; }.venue label:first-child { grid-column:1 / -1; }.venue .quiet { justify-self:start; }.boundaries { flex-direction:column;gap:24px; }.footer-actions { align-items:stretch; }.footer-actions .primary { width:100%; }.section-heading { align-items:flex-start; }.section-heading .hint { white-space:nowrap; } }
</style>
