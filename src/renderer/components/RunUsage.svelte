<script lang="ts">
  import type { RunUsage } from "../../shared/ipc";

  let { usage }: { usage: RunUsage | undefined } = $props();

  function dimension(value: { known: number; unknownAttempts: number }, suffix = ""): string {
    const known = `${value.known.toLocaleString()}${suffix}`;
    return value.unknownAttempts > 0 ? `${known} + ${value.unknownAttempts} unknown` : known;
  }

  function modelLabel(providerId: string, modelId: string): string {
    return providerId === "openai-subscription" ? modelId : `${providerId} / ${modelId}`;
  }

  function costLabel(value: RunUsage["costs"]): string {
    if (value.status === "not_reported") return "Not reported";
    if (value.status === "unknown") return "Unknown";
    const unlabelled = value.reportedWithoutCurrencyAmounts.map(formatAmount).map((amount) => `${amount} (currency not reported)`);
    const amounts = [...value.reported.map((item) => `${formatAmount(item.amount)} ${item.currency}`), ...unlabelled];
    if (amounts.length > 0) {
      const qualifiers = [
        ...(value.unknownAttempts > 0 ? ["unknown"] : []),
        ...(value.notReportedAttempts > 0 ? ["unreported"] : []),
      ];
      return qualifiers.length > 0 ? `${amounts.join(", ")} plus ${qualifiers.join(" or ")} amounts` : amounts.join(", ");
    }
    if (value.notReportedAttempts > 0 && value.unknownAttempts > 0) return "Unknown or not reported";
    if (value.notReportedAttempts > 0) return "Not reported";
    return "Unknown";
  }

  function formatAmount(amount: number): string {
    const formatted = amount.toLocaleString(undefined, { maximumSignificantDigits: 12 });
    return amount !== 0 && /^-?0(?:[.,]0+)?$/.test(formatted) ? amount.toExponential(6) : formatted;
  }
</script>

{#if usage}
  <details class="run-usage" aria-label="Run usage details">
    <summary>
      <span><span class="eyebrow">Run usage</span> {usage.availability === "unavailable" ? "Unavailable" : `${usage.attemptCount.toLocaleString()} attempt${usage.attemptCount === 1 ? "" : "s"}`}</span>
      {#if usage.availability === "available"}<span class="summary-detail">{dimension(usage.tokens.total, " tokens")} · {costLabel(usage.costs)}</span>{/if}
      {#if usage.unknownAttemptCount > 0}<span class="unknown">{usage.unknownAttemptCount} unknown</span>{/if}
    </summary>
    {#if usage.availability === "available"}
    <dl class="usage-grid">
      <div><dt>Input tokens</dt><dd>{dimension(usage.tokens.input)}</dd></div>
      <div><dt>Output tokens</dt><dd>{dimension(usage.tokens.output)}</dd></div>
      <div><dt>Total tokens</dt><dd>{dimension(usage.tokens.total)}</dd></div>
      <div><dt>Cached input</dt><dd>{dimension(usage.tokens.cachedInput)}</dd></div>
      <div><dt>Reasoning tokens</dt><dd>{dimension(usage.tokens.reasoning)}</dd></div>
      <div><dt>Latency</dt><dd>{dimension(usage.latencyMs, " ms")}</dd></div>
      <div><dt>Repairs</dt><dd>{dimension(usage.repairCount)}</dd></div>
      <div><dt>Cost</dt><dd>{costLabel(usage.costs)}</dd></div>
    </dl>
    {#if usage.models.length > 0}
      <p class="models"><span>Models</span>{usage.models.map((model) => modelLabel(model.providerId, model.modelId)).join(", ")}</p>
    {/if}
    {:else}<p class="unavailable">No generation record is available for this run.</p>{/if}
  </details>
{/if}

<style>
  .run-usage { margin:0;padding:10px var(--page-inline);border-bottom:1px solid var(--border);background:var(--surface); }
  summary { display:flex;align-items:center;gap:14px;cursor:pointer;list-style:none;font-size:13px;color:var(--subtle); }
  summary::-webkit-details-marker { display:none; }
  summary::after { content:"";width:5px;height:5px;border-bottom:1px solid var(--subtle);border-right:1px solid var(--subtle);transform:rotate(45deg);margin-left:auto; }
  .run-usage[open] summary::after { transform:rotate(225deg); }.run-usage[open] summary { padding-bottom:14px; }
  .eyebrow { color:var(--muted);margin-right:8px; }
  .summary-detail { color:var(--muted); }.unknown { color:#d6ad74; }
  .usage-grid { display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:18px;margin:0;padding:18px 0;border-top:1px solid var(--border); }
  dt,.models span { font-size:13px;color:var(--subtle); }dd { margin:6px 0 0;font-size:13px;color:var(--muted);overflow-wrap:anywhere; }
  .models,.unavailable { color:var(--muted);font-size:13px;line-height:1.7; }.models span { margin-right:12px; }
  @container page (max-width:680px) { .summary-detail { display:none; }.usage-grid { grid-template-columns:1fr 1fr; } }
</style>
