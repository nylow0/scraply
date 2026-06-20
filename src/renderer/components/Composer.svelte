<script lang="ts">
  let {
    value,
    placeholder,
    disabled = false,
    onChange,
    onSubmit,
  }: {
    value: string;
    placeholder: string;
    disabled?: boolean;
    onChange: (value: string) => void;
    onSubmit: () => void;
  } = $props();

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSubmit();
    }
  }
</script>

<div class="composer-wrap">
  <form
    class="composer"
    onsubmit={(event) => {
      event.preventDefault();
      onSubmit();
    }}
  >
    <textarea
      rows="3"
      {placeholder}
      {disabled}
      aria-label="Message composer"
      value={value}
      oninput={(event) => onChange((event.currentTarget as HTMLTextAreaElement).value)}
      onkeydown={handleKeydown}
    ></textarea>
    <button type="submit" class="primary" aria-label="Send message" disabled={disabled || !value.trim()}>Send</button>
  </form>
</div>

<style>
  .composer-wrap {
    padding: 12px 20px 20px;
    background: linear-gradient(to top, var(--bg), transparent);
  }

  .composer {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 10px;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: 14px;
    background: rgba(18, 18, 18, 0.92);
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
  }

  textarea {
    resize: vertical;
    min-height: 72px;
    background: transparent;
    border: none;
    color: var(--text);
    outline: none;
  }

  button.primary {
    align-self: end;
    border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--border));
    background: color-mix(in srgb, var(--accent) 24%, var(--surface));
    color: var(--text);
    border-radius: 8px;
    padding: 8px 14px;
  }

  button.primary:focus-visible,
  textarea:focus-visible {
    outline: 2px solid var(--accent-strong);
    outline-offset: 2px;
  }

  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
