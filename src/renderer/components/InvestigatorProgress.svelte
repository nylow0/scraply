<script lang="ts">
  import type { InvestigatorLane } from "../lib/investigator-progress";

  let { investigators }: { investigators: InvestigatorLane[] } = $props();
  const stateLabels: Record<InvestigatorLane["state"], string> = {
    planned: "Planned", ready: "Queued", running: "Running", succeeded: "Finished",
    failed: "Failed", cancelled: "Stopped", skipped: "Skipped", unknown: "Completion unknown",
  };
</script>

{#if investigators.length > 0}
  <section class="investigator-progress" aria-label="Area investigators">
    <header><h2>Area investigators</h2><p>Counts reflect saved candidate decisions.</p></header>
    <ol class="investigator-lanes">
      {#each investigators as investigator (investigator.areaId)}
        <li aria-label={`${investigator.areaName} investigator`}>
          <div class="lane-work">
            <div class="lane-heading"><h3>{investigator.areaName}</h3><span class="lane-state" class:running={investigator.state === "running"} class:attention={investigator.state === "failed" || investigator.state === "unknown"}>{stateLabels[investigator.state]}</span></div>
            <p class="current-step"><span>Current step</span> {investigator.currentStep?.trim() || "No step recorded."}</p>
          </div>
          <dl class="lane-counts" aria-label={`${investigator.areaName} candidate counts`}>
            <div><dt>Confirmed</dt><dd>{investigator.confirmedCount ?? "Unknown"}</dd></div>
            <div><dt>Insufficient</dt><dd>{investigator.insufficientCount ?? "Unknown"}</dd></div>
            <div><dt>Dropped</dt><dd>{investigator.droppedCount ?? "Unknown"}</dd></div>
          </dl>
        </li>
      {/each}
    </ol>
  </section>
{/if}

<style>
  .investigator-progress { min-width:0;background:var(--bg);color:var(--text); }
  header { display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:8px 20px; }
  h2 { margin:0;font-size:15px;font-weight:550;letter-spacing:-.2px; }header p { margin:0;color:var(--muted);font-size:12px; }
  .investigator-lanes { padding:0;margin:14px 0 0;list-style:none;border-top:1px solid var(--border); }
  li { display:flex;align-items:center;justify-content:space-between;gap:20px;padding:17px 0;border-bottom:1px solid var(--border); }
  .lane-work { min-width:0;flex:1; }.lane-heading { display:flex;align-items:baseline;gap:8px 14px;flex-wrap:wrap; }h3 { margin:0;font-size:14px;font-weight:550;line-height:1.5;overflow-wrap:anywhere; }
  .lane-state { color:var(--muted);font-size:12px; }.lane-state.running { color:var(--accent-strong); }.lane-state.attention { color:var(--danger); }
  .current-step { max-width:76ch;margin:7px 0 0;font-size:12px;line-height:1.6;overflow-wrap:anywhere; }.current-step > span { color:var(--muted);margin-right:8px; }
  .lane-counts { display:flex;justify-content:flex-end;gap:20px;margin:0; }.lane-counts > div { min-width:62px; }dt { color:var(--muted);font-size:11px; }dd { margin:6px 0 0;font-size:15px;font-variant-numeric:tabular-nums; }
  @media(max-width:760px) { li { align-items:flex-start;flex-direction:column;gap:13px; }.lane-counts { justify-content:flex-start;gap:24px; }.lane-counts > div { min-width:62px; } }
</style>
