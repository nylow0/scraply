<script lang="ts">
  import type { BranchContext } from "../../shared/schemas";

  let { context }: { context: BranchContext } = $props();
</script>

<section class="focused-setup" aria-labelledby="focused-branch-title">
  <div>
    <p class="eyebrow">Focused branch setup</p>
    <h2 id="focused-branch-title">{context.seedIdeaTitle}</h2>
    <p class="angle">{context.explorationAngle}</p>
  </div>
  <dl>
    <div><dt>Inherited brief</dt><dd>Version {context.inheritedBriefVersion}</dd></div>
    <div><dt>Selected evidence</dt><dd>{context.selectedClaimIds.length} claims</dd></div>
  </dl>
</section>

<style>
  .focused-setup {
    display: flex;
    justify-content: space-between;
    gap: 24px;
    margin-bottom: 18px;
    padding: 20px;
    border: 1px solid color-mix(in srgb, var(--accent-strong) 35%, var(--border));
    border-radius: 14px;
    background: color-mix(in srgb, var(--accent-strong) 7%, var(--surface));
  }
  .eyebrow { margin: 0 0 5px; color: var(--accent-strong); font-size: 11px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
  h2 { margin: 0 0 8px; font-size: 19px; }
  .angle { max-width: 680px; margin: 0; color: var(--muted); line-height: 1.5; }
  dl { display: grid; min-width: 150px; margin: 0; }
  dl div { padding: 4px 0; }
  dt { color: var(--muted); font-size: 11px; }
  dd { margin: 2px 0 0; font-size: 12px; font-weight: 700; }
  @media (max-width: 720px) { .focused-setup { flex-direction: column; } }
</style>
