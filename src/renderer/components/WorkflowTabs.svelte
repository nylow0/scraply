<script lang="ts">
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
        <span class="number">{step.number}</span>
        <span>{step.label}</span>
        <i aria-hidden="true"></i>
      </button>
    {/each}
  </div>
</nav>

<style>
  .workflow-tabs {
    position: sticky;
    top: 48px;
    z-index: 2;
    overflow-x: auto;
    border-bottom: 1px solid var(--border);
    background: color-mix(in srgb, var(--bg) 94%, transparent);
    backdrop-filter: blur(12px);
    scrollbar-width: none;
  }

  .workflow-tabs::-webkit-scrollbar {
    display: none;
  }

  [role="tablist"] {
    display: flex;
    min-width: max-content;
    padding: 0 var(--page-inline);
  }

  button {
    position: relative;
    display: grid;
    grid-template-columns: auto auto;
    align-items: center;
    gap: 8px;
    min-width: 112px;
    height: 48px;
    padding: 0 18px;
    border: 0;
    border-radius: 6px 6px 0 0;
    background: transparent;
    color: var(--subtle);
    font-weight: 550;
    text-align: left;
    transition: color .25s var(--ease), background .25s var(--ease), transform .2s var(--ease);
  }

  button:last-child {
    border-right: 0;
  }

  button:not(:disabled):hover {
    color: var(--text);
    background: var(--surface);
  }

  button:not(:disabled):active {
    transform: translateY(1px);
  }

  button:disabled {
    cursor: not-allowed;
    opacity: .38;
  }

  button.active {
    color: var(--text);
    background: var(--surface);
  }

  button i {
    position: absolute;
    right: 18px;
    bottom: -1px;
    left: 18px;
    height: 2px;
    background: transparent;
    transform: scaleX(.35);
    transition: transform .3s var(--ease), background .3s var(--ease);
  }

  button.active i {
    background: var(--accent-strong);
    transform: scaleX(1);
  }

  .number {
    font: 600 10px var(--mono);
    color: var(--subtle);
  }

  button.complete .number {
    color: var(--accent-strong);
  }

  @media (max-width: 720px) {
    [role="tablist"] {
      padding: 0 14px;
    }

    button {
      min-width: 112px;
      padding-inline: 14px;
    }
  }
</style>
