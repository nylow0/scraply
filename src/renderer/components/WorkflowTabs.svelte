<script lang="ts">
  import Icon from "./Icon.svelte";
  export type WorkflowStep = "setup" | "research" | "ideas";

  let {
    active,
    setupReady,
    researchReady,
    ideasReady,
    onSelect,
  }: {
    active: WorkflowStep;
    setupReady: boolean;
    researchReady: boolean;
    ideasReady: boolean;
    onSelect: (step: WorkflowStep) => void;
  } = $props();

  const steps: Array<{ id: WorkflowStep; number: string; label: string }> = [
    { id: "setup", number: "01", label: "Setup" },
    { id: "research", number: "02", label: "Research" },
    { id: "ideas", number: "03", label: "Ideas" },
  ];

  function ready(step: WorkflowStep): boolean {
    return step === "setup" ? setupReady : step === "research" ? researchReady : ideasReady;
  }

  function handleKeydown(event: KeyboardEvent, current: WorkflowStep) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;

    const available = steps.filter((step) => ready(step.id));
    const currentIndex = available.findIndex((step) => step.id === current);
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? available.length - 1
        : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + available.length) % available.length;
    const next = available[nextIndex];
    if (!next) return;

    event.preventDefault();
    onSelect(next.id);
    requestAnimationFrame(() => document.getElementById(`workflow-tab-${next.id}`)?.focus());
  }
</script>

<nav class="workflow-tabs" aria-label="Research workflow">
  <div role="tablist" aria-label="Workflow steps">
    {#each steps as step (step.id)}
      <button
        id={`workflow-tab-${step.id}`}
        type="button"
        role="tab"
        aria-selected={active === step.id}
        aria-controls={`workflow-panel-${step.id}`}
        tabindex={active === step.id ? 0 : -1}
        disabled={!ready(step.id)}
        class:active={active === step.id}
        class:complete={ready(step.id) && active !== step.id}
        onclick={() => onSelect(step.id)}
        onkeydown={(event) => handleKeydown(event, step.id)}
      >
        <span class="step-icon"><Icon name={step.id === "setup" ? "brief" : step.id === "research" ? "research" : "ideas"} size={16} /></span>
        <span>{step.label}</span>
        <i aria-hidden="true"></i>
      </button>
    {/each}
  </div>
</nav>

<style>
  .workflow-tabs { position:sticky;top:54px;z-index:2;padding:14px var(--page-inline);background:color-mix(in srgb,var(--bg) 94%,transparent);backdrop-filter:blur(18px);border-bottom:1px solid var(--border); }
  [role="tablist"] { display:flex;align-items:center;gap:22px; }
  button { position:relative;display:flex;align-items:center;gap:9px;height:36px;padding:0 14px 0 6px;border:1px solid transparent;border-radius:9px;background:transparent;color:var(--muted);font-size:13px;font-weight:600; }
  button + button::before { content:"";position:absolute;width:14px;height:1px;background:var(--border-strong);left:-20px; }
  button.active { background:#71cfba0b;color:var(--accent-strong);border-color:#71cfba20; }
  button:hover:not(:disabled) { background:var(--surface-2); }
  button:disabled { opacity:.38; }
  .step-icon { display:grid;place-items:center;width:26px;height:26px;border-radius:7px;color:var(--muted); }
  .active .step-icon { background:#71cfba16;color:var(--accent-strong); }
  button i { position:absolute;bottom:-15px;left:12px;right:12px;height:2px;background:var(--accent);opacity:0;transform:scaleX(.4);transition:transform 250ms var(--ease),opacity 250ms; }
  button.active i { opacity:1;transform:scaleX(1); }
  @media(max-width:650px) { .workflow-tabs { padding-inline:14px; }[role="tablist"] { gap:14px; }button { padding-right:8px;gap:4px; }button + button::before { left:-12px;width:8px; } }
</style>
