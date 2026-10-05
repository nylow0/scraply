<script lang="ts">
  import { onMount } from "svelte";

  let reasoningSummaries = $state(true);
  let maxConcurrentModelCalls = $state(8);
  let loading = $state(true);
  let loaded = $state(false);
  let saving = $state(false);
  let saved = $state(false);
  let error = $state("");
  onMount(() => {
    void window.scraply.getAdvancedSettings().then((settings) => {
      reasoningSummaries = settings.reasoningSummaries;
      maxConcurrentModelCalls = settings.maxConcurrentModelCalls;
      loaded = true;
    }).catch(() => { error = "Could not load advanced settings. Reopen Settings to try again."; })
      .finally(() => { loading = false; });
  });
  async function save() {
    saving = true;
    saved = false;
    error = "";
    try {
      await window.scraply.saveAdvancedSettings({ reasoningSummaries, maxConcurrentModelCalls });
      saved = true;
    } catch {
      error = "Could not save advanced settings. Try again.";
    } finally {
      saving = false;
    }
  }
</script>

<form class="settings-cards" onsubmit={(event) => { event.preventDefault(); void save(); }}>
  <label class="summary-toggle settings-card"><input type="checkbox" bind:checked={reasoningSummaries} disabled={!loaded || loading || saving}
    onchange={() => saved = false} />Show reasoning summaries in the trace</label>
  <label class="concurrency settings-card"><span>Concurrent model calls</span><select bind:value={maxConcurrentModelCalls} disabled={!loaded || loading || saving} onchange={() => saved = false}>
    {#each [1, 2, 3, 4, 5, 6, 7, 8] as count (count)}<option value={count}>{count}</option>{/each}
  </select></label>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <footer><button type="submit" disabled={!loaded || loading || saving}>{saving ? "Saving…" : "Save advanced settings"}</button>
    {#if saved}<span role="status">Advanced settings saved</span>{/if}</footer>
</form>

<style>
  label { color:var(--text);font-size:14px; }
  .summary-toggle { flex-direction:row;align-items:center;gap:10px; }
  .concurrency { flex-direction:row;align-items:center;justify-content:space-between;gap:16px; }
  input { accent-color:var(--text); }
  select { padding:8px 12px;border:1px solid var(--glass-edge);border-radius:8px;background:var(--bg);color:var(--text); }
  p { color:var(--muted);font-size:13px;line-height:1.6;margin:0; }
  .error { grid-column:1/-1;color:var(--danger); }
  footer { grid-column:1/-1;display:flex;align-items:center;gap:14px; }
  button { padding:10px 14px;border:1px solid var(--glass-edge);border-radius:8px;background:var(--bg);color:var(--text); }
  button:disabled { opacity:.5; }
  footer span { color:var(--muted);font-size:13px; }
</style>
