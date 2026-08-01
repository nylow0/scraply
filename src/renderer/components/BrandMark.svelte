<script lang="ts">
  let { size = 20 }: { size?: number } = $props();
</script>

<svg
  class="mark"
  width={size}
  height={size}
  viewBox="0 0 64 64"
  fill="none"
  aria-hidden="true"
>
  <g fill="currentColor">
    <path d="M10 10h18l7 7H20v8L10 35Z" />
    <path d="M54 10v18l-7 7V20h-8L29 10Z" />
    <path d="M54 54H36l-7-7h15v-8l10-10Z" />
    <path d="M10 54V36l7-7v15h8l10 10Z" />
  </g>
  <path
    class="spark"
    d="M32 24c0 5 3 8 8 8-5 0-8 3-8 8 0-5-3-8-8-8 5 0 8-3 8-8Z"
  />
</svg>

<style>
  .mark {
    display: block;
    flex: none;
    color: var(--accent);
  }

  .spark {
    fill: var(--accent-strong);
  }
</style>
