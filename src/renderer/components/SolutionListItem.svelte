<script lang="ts">
  import type { SolutionView } from "../../shared/ipc";

  let { idea, rank }: { idea: SolutionView; rank: number } = $props();

  let positiveOutcomes = $derived(idea.outcomes.filter((outcome) => outcome.direction === "positive").length);
  let negativeOutcomes = $derived(idea.outcomes.length - positiveOutcomes);
  let projectEndingRisks = $derived(idea.risks.filter((risk) => risk.impact === "project ends").length);
  let warning = $derived(["insufficient-evidence", "overstated", "attempted-and-failed"].includes(idea.problemVerdict));
</script>

<details class:warning class="solution" style={`--rank:${rank}`}>
  <summary class="solution-summary">
    <span class="rank">{String(rank).padStart(2, "0")}</span>
    <span class="identity">
      <strong>{idea.mechanism}</strong>
      <small>{idea.problemStatement}</small>
    </span>
    <span class="metrics" aria-label="Solution evaluation snapshot">
      <span><strong>{idea.confirmedCoreOutcomes}</strong> core</span>
      <span><strong>{idea.risks.length}</strong> risks</span>
      {#if projectEndingRisks > 0}
        <span class:danger={idea.unaddressedCatastrophicRisks > 0}><strong>{projectEndingRisks}</strong> fatal</span>
      {/if}
    </span>
    <span class="chevron" aria-hidden="true"></span>
  </summary>

  <div class="solution-body">
    <details class="category">
      <summary>
        <span><strong>Overview</strong><small>Mechanism, constraints, and source problem</small></span>
        <span class="chevron" aria-hidden="true"></span>
      </summary>
      <div class="category-body overview">
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
      </div>
    </details>

    <details class="category">
      <summary>
        <span><strong>Outcomes</strong><small>{positiveOutcomes} positive · {negativeOutcomes} negative · {idea.confirmedCoreOutcomes} confirmed core</small></span>
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
        <span><strong>Risks and responses</strong><small>{idea.risks.length} risks · {projectEndingRisks} project-ending · {idea.unaddressedCatastrophicRisks} unaddressed</small></span>
        <span class="chevron" aria-hidden="true"></span>
      </summary>
      <div class="category-body nested-list">
        {#each idea.risks as risk, index (risk.id)}
          <details class:catastrophic={risk.impact === "project ends" && risk.mitigations.length === 0} class="nested-item risk-item">
            <summary>
              <span class="item-number">{String(index + 1).padStart(2, "0")}</span>
              <span class="item-title">{risk.description}</span>
              <span class="risk-count">{risk.mitigations.length} {risk.mitigations.length === 1 ? "response" : "responses"}</span>
              <span class="chevron" aria-hidden="true"></span>
            </summary>
            <div class="item-detail">
              <div class="risk-meta">
                <span class="estimated">Likelihood: {risk.likelihood}</span>
                <span class="estimated">Impact: {risk.impact}</span>
              </div>
              {#if risk.mitigations.length > 0}
                <div class="responses">
                  {#each risk.mitigations as mitigation, mitigationIndex (mitigationIndex)}
                    <div class="response">
                      <span class="response-number">Response {mitigationIndex + 1}</span>
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
                <p class="no-response">No response was generated for this risk.</p>
              {/if}
            </div>
          </details>
        {/each}
      </div>
    </details>
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
    border-top: 1px solid var(--border);
    animation: enter .38s var(--ease) both;
    animation-delay: calc(var(--rank) * 55ms);
  }

  .solution.warning {
    box-shadow: inset 3px 0 #b98645;
  }

  .solution-summary {
    display: grid;
    grid-template-columns: 30px minmax(240px, 1fr) auto 20px;
    gap: 16px;
    align-items: center;
    min-height: 82px;
    padding: 14px 18px;
    transition: background-color 180ms var(--ease);
  }

  .solution-summary:hover {
    background: var(--surface);
  }

  .solution[open] > .solution-summary {
    background: var(--surface-2);
    box-shadow: inset 0 -1px var(--border-strong);
  }

  .rank,
  .item-number,
  .response-number {
    font: 600 11px var(--mono);
    color: var(--subtle);
  }

  .identity {
    display: grid;
    gap: 4px;
    min-width: 0;
  }

  .identity strong {
    overflow: hidden;
    font-size: 16px;
    line-height: 1.3;
    letter-spacing: -.015em;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .identity small {
    overflow: hidden;
    color: var(--muted);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .metrics {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 16px;
    color: var(--subtle);
    font: 500 10px var(--mono);
    text-transform: uppercase;
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
    padding: 8px 18px 22px 64px;
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
    grid-template-columns: 1.4fr 1fr 1fr;
    gap: 1px;
    background: var(--border);
  }

  .overview > div {
    padding: 16px;
    background: var(--bg);
  }

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
    font: 600 10px var(--mono);
    letter-spacing: .04em;
    text-transform: uppercase;
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
  .nested-item.catastrophic {
    box-shadow: inset 2px 0 var(--danger);
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
    font: 600 10px var(--mono);
    text-transform: uppercase;
  }

  .responses {
    display: grid;
    gap: 10px;
  }

  .response {
    padding: 14px;
    border: 1px solid var(--border);
    background: var(--bg);
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

  @keyframes enter {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
  }

  @media (max-width: 850px) {
    .solution-summary {
      grid-template-columns: 26px minmax(0, 1fr) 18px;
      min-height: 72px;
      padding-inline: 12px;
    }

    .metrics {
      grid-column: 2;
      justify-content: flex-start;
      gap: 12px;
    }

    .solution-summary > .chevron {
      grid-column: 3;
      grid-row: 1 / span 2;
    }

    .solution-body {
      padding: 6px 12px 18px 38px;
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
  }

  @media (max-width: 560px) {
    .identity strong,
    .identity small {
      white-space: normal;
    }

    .metrics {
      flex-wrap: wrap;
    }

    dl {
      grid-template-columns: 1fr;
    }
  }
</style>
