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
  .run-usage{max-width:760px;margin:22px var(--page-inline) 0;padding:18px 20px;border:1px solid var(--border);background:var(--surface)}
  summary{display:flex;align-items:center;justify-content:space-between;gap:12px;cursor:pointer;list-style:none}.run-usage[open] summary{border-bottom:1px solid var(--border);padding-bottom:14px}.run-usage summary::-webkit-details-marker{display:none}
  .eyebrow,dt,.models span{font:600 10px var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--subtle)}
  .eyebrow{margin:0;color:var(--accent-strong)}
  .summary-detail{margin-left:auto;color:var(--muted);font:500 11px var(--mono)}.unknown{padding:4px 8px;border:1px solid color-mix(in srgb,#b98645 55%,var(--border));border-radius:999px;color:#b98645;font:600 10px var(--mono)}
  .usage-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px 18px;margin:16px 0 0}
  dt{margin-bottom:5px}dd{margin:0;font:600 13px var(--mono);overflow-wrap:anywhere}.models{margin:16px 0 0;padding-top:14px;border-top:1px solid var(--border);color:var(--muted);font-size:12px}.models span{margin-right:9px}
  .unavailable{margin:16px 0 0;color:var(--muted);font-size:12px}
  @media(max-width:760px){.run-usage{margin-inline:20px}.usage-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style>
