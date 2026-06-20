<script lang="ts">
  import type { Message } from "../../shared/schemas";

  let { messages }: { messages: Message[] } = $props();
</script>

<section class="conversation" aria-live="polite" aria-label="Thread conversation">
  {#each messages as message (message.id)}
    <article class={message.role}>
      <div class="label">{message.role}</div>
      <div class="bubble">
        {message.content}
        {#if message.role === "report" && message.metadata?.reportId}
          <p class="report-note">Open the report viewer below for full HTML.</p>
        {/if}
      </div>
    </article>
  {:else}
    <div class="empty">
      <h2>Start a research thread</h2>
      <p>Click <strong>New research</strong> in the sidebar to begin the one-question intake.</p>
    </div>
  {/each}
</section>

<style>
  .conversation {
    overflow: auto;
    padding: 20px;
    display: grid;
    gap: 14px;
    align-content: start;
  }

  article {
    display: grid;
    gap: 6px;
    max-width: 760px;
  }

  .label {
    color: var(--muted);
    font-family: var(--mono);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .bubble {
    white-space: pre-wrap;
    padding: 12px 14px;
    border-radius: 10px;
    border: 1px solid var(--border);
    background: var(--surface);
  }

  .user .bubble {
    background: color-mix(in srgb, var(--accent) 12%, var(--surface));
  }

  .assistant .bubble {
    background: var(--surface-2);
  }

  .report .bubble {
    border-color: color-mix(in srgb, var(--accent) 35%, var(--border));
  }

  .report-note {
    margin: 8px 0 0;
    color: var(--muted);
    font-size: 12px;
  }

  .system,
  .event {
    opacity: 0.85;
  }

  .empty {
    color: var(--muted);
    padding-top: 12vh;
  }

  .empty h2 {
    color: var(--text);
    margin: 0 0 8px;
    font-weight: 500;
  }
</style>
