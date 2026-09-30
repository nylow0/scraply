<script lang="ts">
  import { onMount } from "svelte";

  let maxConcurrentModelCalls = $state(2);
  let loading = $state(true);
  let loaded = $state(false);
  let saving = $state(false);
  let saved = $state(false);
  let error = $state("");
  onMount(() => {
    void window.scraply.getAdvancedSettings().then((settings) => {
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
      await window.scraply.saveAdvancedSettings({ maxConcurrentModelCalls });
      saved = true;
    } catch {
      error = "Could not save advanced settings. Try again.";
    } finally {
      saving = false;
    }
  }
</script>

<form onsubmit={(event) => { event.preventDefault(); void save(); }}>
  <label class="concurrency"><span>Concurrent model calls</span><select bind:value={maxConcurrentModelCalls} disabled={!loaded || loading || saving} onchange={() => saved = false}>
    <option value={1}>1</option><option value={2}>2</option><option value={3}>3</option>
  </select></label>
  <p>The default is 2 simultaneous calls. Choose 1 to reduce overlap, or 3 for more parallel work. Higher concurrency can reach account limits sooner.</p>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <footer><button type="submit" disabled={!loaded || loading || saving}>{saving ? "Saving…" : "Save advanced settings"}</button>
    {#if saved}<span role="status">Advanced settings saved</span>{/if}</footer>
</form>

<style>
  form { display:flex;flex-direction:column;gap:12px;max-width:560px; }
  label { color:var(--text);font-size:14px; }
  .concurrency { display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:12px; }
  select { padding:8px 12px;border:1px solid var(--glass-edge);border-radius:8px;background:var(--bg);color:var(--text); }
  p { color:var(--muted);font-size:13px;line-height:1.6;margin:0; }
  .error { color:var(--danger); }
  footer { display:flex;align-items:center;gap:14px;margin-top:16px; }
  button { padding:10px 14px;border:1px solid var(--glass-edge);border-radius:8px;background:var(--bg);color:var(--text); }
  button:disabled { opacity:.5; }
  footer span { color:var(--muted);font-size:13px; }
</style>
