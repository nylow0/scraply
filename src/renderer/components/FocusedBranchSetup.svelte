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
    padding: 16px;
    border: 1px solid color-mix(in srgb, var(--accent-strong) 35%, var(--border));
    border-radius: 10px;
    background: color-mix(in srgb, var(--accent-strong) 7%, var(--surface));
  }
  .eyebrow { margin: 0 0 5px; color: var(--accent-strong); font-family: var(--mono); font-size: 10px; font-weight: 700; letter-spacing: .09em; text-transform: uppercase; }
  h2 { margin: 0 0 8px; font-size: 15px; letter-spacing: -0.02em; }
  .angle { max-width: 72ch; margin: 0; color: var(--muted); font-size: 12px; line-height: 1.5; }
  dl { display: grid; min-width: 150px; margin: 0; }
  dl div { padding: 4px 0; }
  dt { color: var(--muted); font-size: 11px; }
  dd { margin: 2px 0 0; font-size: 12px; font-weight: 700; }
  @media (max-width: 720px) { .focused-setup { flex-direction: column; } }
</style>
