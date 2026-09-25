<script lang="ts">
  import type { OpportunityFamiliesView, OpportunityMembershipCommand } from "../../shared/opportunity-review";
  import {
    DEFAULT_RUN_CONFIG,
    modelRefKey,
    type ModelOption,
    type ModelRef,
    type RunConfig,
  } from "../../shared/schemas";
  import { modelDisplayName } from "../lib/research-defaults";
  import { untrack } from "svelte";

  let {
    opportunities,
    modelOptions,
    initialConfig,
    busy,
    onReview,
    onEdit,
  }: {
    opportunities: OpportunityFamiliesView;
    modelOptions: ModelOption[];
    initialConfig?: RunConfig | null;
    busy: boolean;
    onReview: (model: ModelRef, reasoningEffort: string, allowAmbiguousRetry: boolean) => Promise<void>;
    onEdit: (command: OpportunityMembershipCommand) => Promise<void>;
  } = $props();

  const savedConfig = untrack(() => initialConfig);
  let availableModels = $derived(modelOptions.filter((item) => item.providerId === "openai-subscription"));
  let modelKey = $state(savedConfig?.model ? modelRefKey(savedConfig.model) : "");
  let selectedModel = $derived(availableModels.find((item) => modelRefKey(item) === modelKey));
  let reasoningEffort = $state(savedConfig?.reasoningEffort ?? DEFAULT_RUN_CONFIG.reasoningEffort);
  let reasoningAvailable = $derived(selectedModel?.reasoningEfforts.some((item) => item.id === reasoningEffort) ?? false);
  let reviewModel = $derived<ModelRef>({
    providerId: selectedModel?.providerId ?? "",
    modelId: selectedModel?.modelId ?? "",
  });
  let editReason = $state("");
  let targetByOption = $state<Record<string, string>>({});
  let relationByOption = $state<Record<string, "duplicate" | "variant">>({});
  let mergeTargetByFamily = $state<Record<string, string>>({});
  let opportunityIdentity = $state("");

  $effect(() => {
    const nextIdentity = [
      ...opportunities.families.flatMap((family) => family.members.map((member) => member.optionId)),
      ...opportunities.unresolved.map((item) => item.membership.optionId),
      ...opportunities.unreviewedOptionIds,
    ].sort().join("\u0000");
    if (nextIdentity === opportunityIdentity) return;
    opportunityIdentity = nextIdentity;
    editReason = "";
    targetByOption = {};
    relationByOption = {};
    mergeTargetByFamily = {};
  });

  $effect(() => {
    if (modelKey || !availableModels[0]) return;
    modelKey = modelRefKey(availableModels[0]);
    reasoningEffort = availableModels[0].defaultReasoningEffort;
  });

  function selectModel(): void {
    reasoningEffort = selectedModel?.defaultReasoningEffort ?? DEFAULT_RUN_CONFIG.reasoningEffort;
  }

  function reason(): string {
    return editReason.trim();
  }

  function targetFor(optionId: string, excludedFamilyId?: string | null): string {
    const selected = targetByOption[optionId];
    if (selected && selected !== excludedFamilyId) return selected;
    return opportunities.families.find((family) => family.active && family.id !== excludedFamilyId)?.id ?? "";
  }

  function relationFor(optionId: string): "duplicate" | "variant" {
    return relationByOption[optionId] ?? "variant";
  }

  function mergeTarget(familyId: string): string {
    return mergeTargetByFamily[familyId]
      ?? opportunities.families.find((family) => family.active && family.id !== familyId)?.id
      ?? "";
  }

  function updateTarget(optionId: string, event: Event): void {
    targetByOption[optionId] = (event.currentTarget as HTMLSelectElement).value;
  }

  function updateRelation(optionId: string, event: Event): void {
    relationByOption[optionId] = (event.currentTarget as HTMLSelectElement).value as "duplicate" | "variant";
  }

  function updateMergeTarget(familyId: string, event: Event): void {
    mergeTargetByFamily[familyId] = (event.currentTarget as HTMLSelectElement).value;
  }

  async function move(optionId: string, excludedFamilyId?: string | null): Promise<void> {
    await onEdit({
      operation: "move",
      optionId,
      targetFamilyId: targetFor(optionId, excludedFamilyId),
      relationship: relationFor(optionId),
      reason: reason(),
    });
  }

  async function split(optionId: string, title: string, summary: string): Promise<void> {
    await onEdit({ operation: "split", optionId, title, summary, reason: reason() });
  }
</script>

<section class="opportunity-review" aria-labelledby="opportunity-review-title">
  <header>
    <div>
      <p class="eyebrow">Business grouping</p>
      <h2 id="opportunity-review-title">{opportunities.acceptedFamilyCount} accepted {opportunities.acceptedFamilyCount === 1 ? "family" : "families"}</h2>
      <p>{opportunities.reviewedOptionCount}/{opportunities.rawOptionCount} saved ideas reviewed. Variants and duplicates stay visible without increasing the family count.</p>
    </div>
    <span class:warning={opportunities.reviewStatus === "failed" || opportunities.reviewStatus === "blocked" || opportunities.unresolved.length > 0} class="status">{opportunities.reviewStatus === "completed" && opportunities.unresolved.length > 0 ? `${opportunities.unresolved.length} need a decision` : opportunities.reviewStatus === "not-reviewed" ? "Not reviewed" : opportunities.reviewStatus.charAt(0).toUpperCase() + opportunities.reviewStatus.slice(1)}</span>
  </header>

  {#if opportunities.reviewError}<p class="review-error" role="alert">{opportunities.reviewError}</p>{/if}
  {#if opportunities.reviewStatus === "blocked"}<p class="retry-warning">The previous request may have completed before Scraply saved its result. Starting a new review can make another paid model call.</p>{/if}

  <div class="review-controls">
    <label>
      <span>Review model</span>
      <select aria-label="Opportunity review model" bind:value={modelKey} onchange={selectModel} disabled={busy || availableModels.length === 0}>
        {#if modelKey && !selectedModel}<option value={modelKey}>{modelDisplayName(savedConfig?.model ?? DEFAULT_RUN_CONFIG.model)} (unavailable)</option>{/if}
        {#each availableModels as item (modelRefKey(item))}<option value={modelRefKey(item)}>{modelDisplayName(item)}</option>{/each}
      </select>
    </label>
    <label>
      <span>Review reasoning</span>
      <select aria-label="Opportunity review reasoning" bind:value={reasoningEffort} disabled={busy || !selectedModel}>
        {#if !reasoningAvailable}<option value={reasoningEffort}>{reasoningEffort} (unavailable)</option>{/if}
        {#each (selectedModel?.reasoningEfforts ?? []) as effort (effort.id)}<option value={effort.id}>{effort.id.charAt(0).toUpperCase() + effort.id.slice(1)}</option>{/each}
      </select>
    </label>
    <button class="review-button" disabled={busy || !selectedModel || !reasoningAvailable || opportunities.unreviewedOptionIds.length === 0} onclick={() => onReview(reviewModel, reasoningEffort, opportunities.reviewStatus === "blocked")}>
      {busy && opportunities.reviewStatus === "running" ? "Reviewing…" : opportunities.reviewStatus === "blocked" ? "Start a new review" : opportunities.unreviewedOptionIds.length > 0 ? `Review ${opportunities.unreviewedOptionIds.length} saved ${opportunities.unreviewedOptionIds.length === 1 ? "idea" : "ideas"}` : "Saved ideas reviewed"}
    </button>
    {#if modelKey && !selectedModel}<p role="status">The saved review model is unavailable. Choose an available model to review ideas.</p>{:else if selectedModel && !reasoningAvailable}<p role="status">The saved reasoning effort is unavailable for this model. Choose an available effort to review ideas.</p>{/if}
  </div>

  {#if opportunities.reviewedOptionCount > 0}
    <label class="decision-note">
      <span>Reason for a grouping change</span>
      <input bind:value={editReason} maxlength="2000" placeholder="Describe the overlap, distinction, or uncertainty" aria-describedby="grouping-reason-help" disabled={busy} />
    </label>
    <small id="grouping-reason-help" class="decision-help">Add a reason to enable manual decisions. Scraply saves it with each change.</small>
  {/if}

  <div class="families">
    {#each opportunities.families.filter((family) => family.active) as family (family.id)}
      <article class:uncounted={!family.counted}>
        <div class="family-heading">
          <div><h3>{family.title}</h3><p>{family.summary}</p></div>
          <span>{family.counted ? "Counted startup family" : "Not counted"}</span>
        </div>
        <div class="members">
          {#each family.members as member (member.optionId)}
            <details>
              <summary><span>{member.mechanism}</span><small>{member.relationship.replace("-", " ")}{member.discarded ? " · discarded" : ""}</small></summary>
              <p>{member.description}</p>
              <p class="decision-reason">{member.reason}</p>
              <div class="member-actions">
                <select aria-label={`Relationship for ${member.mechanism}`} value={relationFor(member.optionId)} onchange={(event) => updateRelation(member.optionId, event)} disabled={busy}>
                  <option value="variant">Variant</option><option value="duplicate">Duplicate</option>
                </select>
                <select aria-label={`Move ${member.mechanism} to family`} value={targetFor(member.optionId, member.familyId)} onchange={(event) => updateTarget(member.optionId, event)} disabled={busy}>
                  {#each opportunities.families.filter((target) => target.active && target.id !== member.familyId) as target (target.id)}<option value={target.id}>{target.title}</option>{/each}
                </select>
                <button disabled={busy || !reason() || !targetFor(member.optionId, member.familyId)} onclick={() => move(member.optionId, member.familyId)}>Move</button>
                <button disabled={busy || !reason()} onclick={() => split(member.optionId, member.mechanism, member.description)}>Split</button>
                <button disabled={busy || !reason()} onclick={() => onEdit({ operation: "mark-uncertain", optionId: member.optionId, reason: reason() })}>Mark uncertain</button>
              </div>
            </details>
          {/each}
        </div>
        {#if opportunities.families.filter((target) => target.active && target.id !== family.id).length > 0}
          <div class="merge">
            <select aria-label={`Merge ${family.title} into family`} value={mergeTarget(family.id)} onchange={(event) => updateMergeTarget(family.id, event)} disabled={busy}>
              {#each opportunities.families.filter((target) => target.active && target.id !== family.id) as target (target.id)}<option value={target.id}>{target.title}</option>{/each}
            </select>
            <button disabled={busy || !reason() || !mergeTarget(family.id)} onclick={() => onEdit({ operation: "merge-family", sourceFamilyId: family.id, targetFamilyId: mergeTarget(family.id), reason: reason() })}>Merge family</button>
          </div>
        {/if}
      </article>
    {/each}
  </div>

  {#if opportunities.unresolved.length > 0}
    <section class="unresolved" aria-labelledby="unresolved-title">
      <h3 id="unresolved-title">Needs a human decision <span>{opportunities.unresolved.length}</span></h3>
      {#if !reason()}<p class="decision-hint">Enter a reason above to enable these decisions.</p>{/if}
      {#each opportunities.unresolved as item (item.membership.optionId)}
        <article>
          <details class="candidate-detail"><summary>{item.membership.mechanism}</summary><div><p>{item.membership.description}</p><p>{item.membership.reason}</p></div></details>
          <div class="member-actions">
            {#if opportunities.families.some((family) => family.active)}
              <select aria-label={`Relationship for ${item.membership.mechanism}`} value={relationFor(item.membership.optionId)} onchange={(event) => updateRelation(item.membership.optionId, event)} disabled={busy}>
                <option value="variant">Variant</option><option value="duplicate">Duplicate</option>
              </select>
              <select aria-label={`Move ${item.membership.mechanism} to family`} value={targetFor(item.membership.optionId)} onchange={(event) => updateTarget(item.membership.optionId, event)} disabled={busy}>
                {#each opportunities.families.filter((family) => family.active) as family (family.id)}<option value={family.id}>{family.title}</option>{/each}
              </select>
              <button disabled={busy || !reason() || !targetFor(item.membership.optionId)} onclick={() => move(item.membership.optionId)}>Assign</button>
            {/if}
            <button disabled={busy || !reason()} onclick={() => split(item.membership.optionId, item.membership.mechanism, item.membership.description)}>Keep separate</button>
          </div>
        </article>
      {/each}
    </section>
  {/if}
</section>

<style>
  .opportunity-review { margin:26px 0;padding:22px;border:1px solid var(--border);border-radius:14px;background:#000; }
  header { display:flex;align-items:flex-start;justify-content:space-between;gap:20px; }
  h2,h3,p { margin:0; }
  h2 { margin-top:5px;font-size:22px;letter-spacing:-.025em; }
  header p:last-child { margin-top:8px;max-width:72ch;color:var(--muted);font-size:13px;line-height:1.6; }
  .eyebrow { color:var(--accent-strong);font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase; }
  .status { flex:none;padding:5px 8px;border:1px solid #bdbdbd45;border-radius:999px;color:var(--muted);font-size:11px; }
  .status.warning { border-color:#d69b5c66;color:#e4b46f; }
  .review-error,.retry-warning { margin-top:14px;padding:10px 12px;border:1px solid #d69b5c55;border-radius:8px;background:#d69b5c0c;color:#e4b46f;font-size:13px; }
  .retry-warning { margin-top:8px;line-height:1.55; }
  .review-controls { display:grid;grid-template-columns:minmax(170px,1fr) minmax(150px,.7fr) auto;gap:10px;align-items:end;margin-top:18px;padding:14px;border:1px solid var(--border);border-radius:10px;background:var(--surface); }
  label { display:grid;gap:7px;color:var(--muted);font-size:12px; }
  select,input { min-width:0;padding:9px 10px;border:1px solid var(--border-strong);border-radius:8px;background:#000;color:var(--text);font:inherit; }
  button { padding:9px 11px;border:1px solid var(--border-strong);border-radius:8px;background:var(--surface-2);color:var(--text);font:inherit;font-size:12px; }
  button:disabled { opacity:.45; }
  .review-button { min-height:36px;border-color:#bdbdbd55;background:#bdbdbd18;color:var(--accent-strong);font-weight:650; }
  .decision-note { margin-top:12px; }
  .decision-help { display:block;margin-top:6px;color:var(--subtle);font-size:12px;line-height:1.5; }
  .families { display:grid;gap:10px;margin-top:16px; }
  .families > article,.unresolved > article { border:1px solid var(--border);border-radius:11px;background:var(--surface); }
  .families > article.uncounted { border-color:#d69b5c4f; }
  .family-heading { display:flex;justify-content:space-between;gap:16px;padding:16px; }
  .family-heading h3 { font-size:15px; }
  .family-heading p { margin-top:5px;color:var(--muted);font-size:12px;line-height:1.5; }
  .family-heading > span { flex:none;color:var(--subtle);font-size:11px; }
  .members { border-top:1px solid var(--border); }
  details { border-bottom:1px solid var(--border); }
  details:last-child { border-bottom:0; }
  summary { display:flex;justify-content:space-between;gap:12px;padding:12px 16px;cursor:pointer;font-size:13px; }
  summary small { color:var(--subtle);text-transform:capitalize; }
  details > p { padding:0 16px 10px;color:var(--muted);font-size:12px;line-height:1.55; }
  details > .decision-reason { color:var(--subtle); }
  .member-actions,.merge { display:flex;flex-wrap:wrap;gap:7px;padding:0 16px 14px; }
  .member-actions select { flex:1;min-width:130px; }
  .merge { justify-content:flex-end;padding-top:12px;border-top:1px solid var(--border); }
  .unresolved { display:grid;gap:9px;margin-top:18px;padding-top:18px;border-top:1px solid var(--border); }
  .unresolved > h3 { font-size:14px; }.unresolved > h3 span { color:#e4b46f; }
  .unresolved > article { display:grid;gap:12px;padding:14px; }
  .decision-hint { margin:0;color:var(--subtle);font-size:12px; }
  .candidate-detail { border:0; }
  .candidate-detail summary { display:list-item;padding:0 0 0 17px;color:var(--text);font-size:13px;font-weight:600;line-height:1.5; }
  .candidate-detail > div { display:grid;gap:8px;margin:10px 0 0 17px; }
  .candidate-detail p { margin:0;color:var(--muted);font-size:12px;line-height:1.55; }
  .candidate-detail p:last-child { color:var(--subtle); }
  .unresolved .member-actions { padding:0; }
  @container page (max-width:600px) { .review-controls { grid-template-columns:1fr; }.family-heading { flex-direction:column; }.family-heading > span { align-self:flex-start; } }
</style>
