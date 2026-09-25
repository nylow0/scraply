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

  const steps: Array<{ id: WorkflowStep; label: string }> = [
    { id: "setup", label: "Setup" },
    { id: "research", label: "Research" },
    { id: "ideas", label: "Solutions" },
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
      </button>
    {/each}
  </div>
</nav>

<style>
  .workflow-tabs { flex:none;max-width:100%; }
  [role="tablist"] { display:flex;align-items:center;gap:4px; }
  button { display:flex;align-items:center;gap:7px;min-height:40px;padding:8px 10px;border:0;border-radius:7px;background:transparent;color:var(--muted);font-size:14px;font-weight:500; }
  button.active { background:#bdbdbd0b;color:var(--text);border-color:#bdbdbd20; }
  button:hover:not(:disabled) { background:var(--surface-2); }
  button:disabled { opacity:.38; }
  .step-icon { display:grid;place-items:center;color:var(--muted); }
  .active .step-icon { color:var(--accent-strong); }
  @media(max-width:420px) { button { padding-inline:8px;gap:6px; } }
</style>
