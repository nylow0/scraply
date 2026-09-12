<script lang="ts">
  import type { SolutionView } from "../../shared/ipc";
  import { loadIdeaDetail } from "../lib/idea-details";

  let { idea: summary, rank, onOpenSource }: { idea: SolutionView; rank: number; onOpenSource: (url: string) => Promise<void> } = $props();
  let detail = $state<SolutionView | null>(null);
  let open = $state(false);
  let error = $state("");
  let idea = $derived(detail ?? summary);
  $effect(() => {
    if (open && summary.detailsLoaded === false && !detail) {
      void loadIdeaDetail(summary).then((value) => detail = value).catch((cause: unknown) => error = cause instanceof Error ? cause.message : "Could not load saved details");
    }
  });

  let positiveOutcomes = $derived(idea.outcomes.filter((outcome) => outcome.direction === "positive").length);
  let negativeOutcomes = $derived(idea.outcomes.length - positiveOutcomes);
  let projectEndingRisks = $derived(idea.projectEndingRiskCount ?? idea.risks.filter((risk) => risk.impact === "project ends").length);
  let highestRisk = $derived(idea.highestRisk ?? [...idea.risks].sort((left, right) => right.sortKey - left.sortKey)[0]);
  let warning = $derived(["insufficient-evidence", "overstated", "attempted-and-failed"].includes(idea.problemVerdict));
</script>

<details bind:open class:warning class="solution" style={`--rank:${rank}`}>
  <summary class="solution-summary disclosure-title" title={idea.mechanism}>
    <span class="disclosure-label">{idea.mechanism}</span>
  </summary>

  <div class="solution-body">
    {#if idea.detailsLoaded === false}<p role="status">{error || "Loading saved analysis…"}</p>{:else}
    <section class="overview">
        <div>
          <span class="label">How it works</span>
          <p>{idea.description}</p>
        </div>
        <div>
          <span class="label">Problem addressed</span>
          <p>{idea.problemStatement}</p>
          <small class:estimated={idea.problemVerdict !== "confirmed"}>Evidence verdict: {idea.problemVerdict}</small>
        </div>
        <div class:conflict={!idea.respectsOffLimits}>
          <span class="label">Scope constraints</span>
          <p>{idea.respectsOffLimitsWhy}</p>
          <small>{idea.respectsOffLimits ? "Within the stated off-limits rules" : "Possible off-limits conflict"}</small>
        </div>
    </section>

    <details class="category">
      <summary>
        <span><strong>Evidence behind this problem</strong><small>{idea.factors.length} source-backed {idea.factors.length === 1 ? "factor" : "factors"}</small></span>
        <span class="chevron" aria-hidden="true"></span>
      </summary>
      <div class="category-body evidence-list">
        {#each idea.factors as factor (factor.id)}
          <article class="evidence-item">
            <p><strong>{factor.subject}</strong> {factor.behavior}</p>
            <blockquote>{factor.quote}</blockquote>
            <a href={factor.sourceUrl} onclick={(event) => { event.preventDefault(); void onOpenSource(factor.sourceUrl); }}>{factor.sourceTitle}</a>
          </article>
        {:else}
          <div class="no-evidence">
            <strong>{idea.problemVerdict === "user-asserted" ? "User-asserted problem" : "No source-backed evidence"}</strong>
            <p>{idea.problemVerdict === "user-asserted"
              ? "This problem was stated directly. Discovery did not gather source-backed factors for it."
              : "No source-backed factors are attached to this idea."}</p>
          </div>
        {/each}
      </div>
    </details>

    <details class="category">
      <summary>
        <span><strong>Outcomes</strong><small>{positiveOutcomes} positive · {negativeOutcomes} negative · {idea.confirmedCoreOutcomes} model-judged core</small></span>
        <span class="chevron" aria-hidden="true"></span>
      </summary>
      <div class="category-body nested-list">
        {#each idea.outcomes as outcome, index (outcome.id)}
          <details class:negative={outcome.direction === "negative"} class="nested-item">
            <summary>
              <span class="item-number">{String(index + 1).padStart(2, "0")}</span>
              <span class="item-title">{outcome.description}</span>
              <span class="direction">{outcome.direction}</span>
              <span class="chevron" aria-hidden="true"></span>
            </summary>
            <div class="item-detail">
              <dl>
                <div><dt>Affects</dt><dd>{outcome.affects}</dd></div>
                <div><dt>Relation</dt><dd>{outcome.addressesCore ? "Addresses the core problem" : "Indirect consequence"}</dd></div>
              </dl>
            </div>
          </details>
        {/each}
      </div>
    </details>

    <details class="category">
      <summary>
        <span><strong>Review all risks and responses</strong><small>{idea.risks.length} risks · {projectEndingRisks} project-ending · {idea.unaddressedCatastrophicRisks} unaddressed</small></span>
        <span class="chevron" aria-hidden="true"></span>
      </summary>
    <div class="expanded-snapshot">
    <span class="risk-preview">
      {#if highestRisk}
        <span class="top-risk-label estimated">Highest risk: {highestRisk.likelihood} · {highestRisk.impact}</span>
        <span class="top-risk-statement">{highestRisk.description}</span>
      {:else}
        <span class="top-risk-label">No risks identified</span>
      {/if}
    </span>
    <span class="metrics" aria-label="Solution evaluation snapshot">
      <span><strong>{idea.confirmedCoreOutcomes}</strong> model-judged core</span>
      <span><strong>{projectEndingRisks}</strong> project-ending</span>
      <span class:danger={idea.unaddressedCatastrophicRisks > 0}><strong>{idea.unaddressedCatastrophicRisks}</strong> unaddressed</span>
    </span>
    </div>
      <div class="category-body risk-list">
        {#each idea.risks as risk, index (risk.id)}
          <article class:project-ending={risk.impact === "project ends" && risk.mitigations.length === 0} class="risk-item" aria-labelledby={`risk-${risk.id}`}>
            <header>
              <span class="item-number">{String(index + 1).padStart(2, "0")}</span>
              <span class="item-title" id={`risk-${risk.id}`}>{risk.description}</span>
              <span class="risk-count">{risk.mitigations.length} proposed {risk.mitigations.length === 1 ? "response" : "responses"}</span>
            </header>
            <div class="risk-detail">
              <div class="risk-meta">
                <span class="estimated">Likelihood: {risk.likelihood}</span>
                <span class="estimated">Impact: {risk.impact}</span>
              </div>
              {#if risk.mitigations.length > 0}
                <div class="responses">
                  {#each risk.mitigations as mitigation, mitigationIndex (mitigationIndex)}
                    <div class="response">
                      <span class="response-number">Proposed response {mitigationIndex + 1}</span>
                      <p>{mitigation.approach}</p>
                      <dl>
                        <div><dt>Cost</dt><dd>{mitigation.cost}</dd></div>
                        <div><dt>Fails if</dt><dd>{mitigation.failsIf}</dd></div>
                      </dl>
                    </div>
                  {/each}
                </div>
              {:else if risk.impact === "project ends"}
                <p class="flag">No proposed response for this project-ending risk.</p>
              {:else}
                <p class="no-response">No proposed response was generated for this risk.</p>
              {/if}
            </div>
          </article>
        {/each}
      </div>
    </details>
    {/if}
  </div>
</details>

<style>
  details,
  summary {
    min-width: 0;
  }

  summary {
    list-style: none;
    cursor: pointer;
  }

  summary::-webkit-details-marker {
    display: none;
  }

  .solution {
    border: 1px solid var(--border);
    border-radius: 13px;
    overflow: hidden;
    background: linear-gradient(120deg,#1b202377,var(--surface));
  }

  .solution.warning {
    box-shadow: inset 3px 0 #b98645;
  }

  .solution-summary {
    display: flex;
    gap: 16px;
    align-items: center;
    min-height: 56px;
    padding: 18px 22px;
    transition: background-color 180ms var(--ease);
  }

  .solution-summary:hover {
    background: var(--surface);
  }

  .solution[open] > .solution-summary {
    background: var(--surface-2);
    box-shadow: inset 0 -1px var(--border-strong);
  }

  .item-number,
  .response-number {
    font:600 13px var(--mono);
    color: var(--subtle);
  }

  .risk-preview {
    display: grid;
    gap: 4px;
    min-width: 0;
  }

  .top-risk-label {
    color: var(--danger);
    font:500 13px var(--sans);
    letter-spacing: .04em;
    text-transform: none;
  }

  .top-risk-statement {
    overflow: hidden;
    color: var(--muted);
    font-size:13px;
    line-height: 1.35;
    text-overflow: ellipsis;
    overflow-wrap: anywhere;
  }

  .metrics {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 16px;
    flex-wrap:wrap;
    color: var(--subtle);
    font:500 13px var(--sans);
    text-transform: none;
  }

  .metrics > span {
    white-space: nowrap;
  }

  .metrics strong {
    margin-right: 3px;
    color: var(--text);
    font-size: 13px;
  }

  .metrics .danger,
  .metrics .danger strong {
    color: var(--danger);
  }

  .chevron {
    width: 8px;
    height: 8px;
    border-right: 1.5px solid var(--muted);
    border-bottom: 1.5px solid var(--muted);
    transform: rotate(45deg) translate(-2px, -2px);
    transition: transform 220ms var(--ease);
  }

  details[open] > summary > .chevron,
  details[open] > summary .chevron:last-child {
    transform: rotate(225deg) translate(-1px, -1px);
  }

  .solution-body {
    padding: 12px 26px 26px;
    background: color-mix(in srgb, var(--surface) 38%, transparent);
  }

  .category {
    border-bottom: 1px solid var(--border);
  }

  .category > summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 18px;
    min-height: 62px;
    padding: 12px 4px;
  }

  .category > summary > span:first-child {
    display: grid;
    gap: 3px;
  }

  .category > summary strong {
    font-size: 14px;
  }

  .category > summary small {
    color: var(--subtle);
  }

  .category-body {
    padding: 0 0 18px;
  }

  .overview {
    display: grid;
    grid-template-columns: repeat(2,minmax(0,1fr));
    gap: 20px;
    padding:20px 0;
    border:0;
    border-radius:12px;
    background:var(--surface);
  }

  .overview > div {
    padding: 0;
    min-width:0;
    overflow-wrap:anywhere;
  }

  .overview > div:first-child { grid-column:1/-1; }
  .overview > div:first-child p { font-size:16px;line-height:1.8;color:var(--text);max-width:85ch; }
  .overview p {
    margin: 7px 0;
    color: var(--muted);
  }

  .overview small {
    color: var(--success);
  }

  .overview .conflict small {
    color: var(--danger);
  }

  .label,
  dt,
  .direction,
  .risk-count,
  .response-number {
    font:500 13px var(--sans);
    letter-spacing: .04em;
    text-transform: none;
    color: var(--subtle);
  }

  .estimated {
    text-decoration: underline dotted;
    text-underline-offset: 3px;
  }

  .nested-list {
    border-top: 1px solid var(--border);
  }

  .nested-item {
    border-bottom: 1px solid var(--border);
    box-shadow: inset 2px 0 var(--success);
  }

  .nested-item.negative,
  .risk-item.project-ending {
    box-shadow: inset 2px 0 var(--danger);
  }

  .evidence-list {
    display: grid;
    gap: 1px;
    padding-bottom: 18px;
    border-top: 1px solid var(--border);
    background: var(--border);
  }

  .evidence-item,
  .no-evidence {
    padding: 16px;
    background: var(--bg);
  }

  .evidence-item p,
  .evidence-item blockquote,
  .no-evidence p {
    margin: 0;
  }

  .evidence-item p {
    color: var(--muted);
  }

  .evidence-item p strong {
    color: var(--text);
  }

  .evidence-item blockquote {
    margin-top: 12px;
    padding-left: 14px;
    border-left: 1px solid var(--border-strong);
    color: var(--text);
  }

  .evidence-item a {
    display: inline-block;
    margin-top: 10px;
    color: var(--accent-strong);
  }

  .no-evidence p {
    margin-top: 6px;
    color: var(--muted);
  }

  .nested-item > summary {
    display: grid;
    grid-template-columns: 30px minmax(180px, 1fr) auto 18px;
    gap: 12px;
    align-items: center;
    min-height: 58px;
    padding: 10px 14px;
    background: var(--bg);
    transition: background-color 180ms var(--ease);
  }

  .nested-item > summary:hover,
  .nested-item[open] > summary {
    background: var(--surface-2);
  }

  .item-title {
    color: var(--muted);
  }

  .direction {
    color: var(--success);
  }

  .negative .direction {
    color: var(--danger);
  }

  .risk-count {
    white-space: nowrap;
  }

  .item-detail {
    padding: 14px 18px 18px 56px;
    background: var(--surface);
  }

  .risk-list {
    display: grid;
    gap: 1px;
    padding-bottom: 18px;
    border-top: 1px solid var(--border);
    background: var(--border);
  }

  .risk-item {
    min-width: 0;
    background: var(--surface);
    box-shadow: inset 2px 0 var(--border-strong);
  }

  .risk-item > header {
    display: grid;
    grid-template-columns: 30px minmax(180px, 1fr) auto;
    gap: 12px;
    align-items: center;
    min-height: 58px;
    padding: 12px 14px 8px;
  }

  .risk-detail {
    padding: 6px 18px 18px 56px;
  }

  dl {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 18px;
    margin: 0;
  }

  dt {
    margin-bottom: 4px;
  }

  dd {
    margin: 0;
    color: var(--muted);
  }

  .risk-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 7px;
    margin-bottom: 14px;
  }

  .risk-meta span {
    padding: 4px 8px;
    border: 1px solid var(--border-strong);
    border-radius: 99px;
    color: var(--muted);
    font:500 13px var(--sans);
    text-transform: none;
  }

  .responses {
    display: grid;
    gap: 10px;
  }

  .response {
    padding: 18px;
    border: 1px solid var(--border);
    border-radius:10px;
    background: var(--surface);
  }

  .response p {
    margin: 7px 0 13px;
  }

  .flag,
  .no-response {
    margin: 0;
    color: var(--danger);
  }

  .no-response {
    color: var(--subtle);
  }


  @media (max-width: 850px) {
    .solution-summary {
      min-height: 56px;
      padding-inline: 12px;
    }

    .metrics {
      grid-column: 2;
      justify-content: flex-start;
      gap: 12px;
    }

    .risk-preview {
      grid-column: 2;
    }


    .solution-body {
      padding: 6px 16px 18px;
    }

    .overview {
      grid-template-columns: 1fr;
    }

    .nested-item > summary {
      grid-template-columns: 24px minmax(0, 1fr) 18px;
    }

    .direction,
    .risk-count {
      grid-column: 2;
    }

    .nested-item > summary > .chevron {
      grid-column: 3;
      grid-row: 1 / span 2;
    }

    .item-detail {
      padding-left: 46px;
    }

    .risk-item > header {
      grid-template-columns: 24px minmax(0, 1fr);
    }

    .risk-item .risk-count {
      grid-column: 2;
    }

    .risk-detail {
      padding-left: 50px;
    }
  }

  .expanded-snapshot { display:flex;flex-wrap:wrap;gap:24px;padding:18px 0; }
</style>
