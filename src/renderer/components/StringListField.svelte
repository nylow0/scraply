<script lang="ts">
  let {
    id,
    label,
    values,
    placeholder,
    help,
    disabled = false,
    onChange,
  }: {
    id: string;
    label: string;
    values: string[];
    placeholder: string;
    help?: string;
    disabled?: boolean;
    onChange: (values: string[]) => void;
  } = $props();

  let pendingValue = $state("");

  function updateItem(index: number, value: string) {
    onChange(values.map((item, itemIndex) => itemIndex === index ? value : item));
  }

  function removeItem(index: number) {
    onChange(values.filter((_, itemIndex) => itemIndex !== index));
  }

  function addItem() {
    const value = pendingValue.trim();
    if (!value || disabled) return;
    onChange([...values, value]);
    pendingValue = "";
  }
</script>

<div class="list-field">
  <div class="field-head">
    <label for={`${id}-new`}>{label}</label>
    {#if help}<small>{help}</small>{/if}
  </div>

  {#if values.length}
    <div class="items">
      {#each values as value, index (`${id}-${index}`)}
        <div class="item">
          <input
            aria-label={`${label} ${index + 1}`}
            value={value}
            disabled={disabled}
            oninput={(event) => updateItem(index, event.currentTarget.value)}
          />
          <button
            type="button"
            aria-label={`Remove ${label.toLowerCase()} ${index + 1}`}
            disabled={disabled}
            onclick={() => removeItem(index)}
          >Remove</button>
        </div>
      {/each}
    </div>
  {:else}
    <p class="empty">Not provided</p>
  {/if}

  <div class="add-row">
    <input
      id={`${id}-new`}
      bind:value={pendingValue}
      disabled={disabled}
      placeholder={placeholder}
      onkeydown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        addItem();
      }}
    />
    <button type="button" disabled={disabled || !pendingValue.trim()} onclick={addItem}>Add</button>
  </div>
</div>

<style>
  .list-field {
    min-width: 0;
    display: grid;
    align-content: start;
    gap: 9px;
  }

  .field-head {
    display: grid;
    gap: 3px;
  }

  label {
    color: var(--text);
    font-size: 12px;
    font-weight: 650;
  }

  small,
  .empty {
    color: var(--subtle);
    font-size: 11px;
  }

  .empty {
    min-height: 34px;
    margin: 0;
    display: flex;
    align-items: center;
    border-bottom: 1px dashed var(--border);
    font-style: italic;
  }

  .items {
    display: grid;
    gap: 6px;
  }

  .item,
  .add-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 7px;
  }

  input {
    width: 100%;
    min-width: 0;
    min-height: 38px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    color: var(--text);
    transition:
      border-color 180ms var(--ease),
      background 180ms var(--ease),
      box-shadow 180ms var(--ease);
  }

  input::placeholder {
    color: var(--subtle);
  }

  input:hover:not(:disabled) {
    border-color: var(--border-strong);
  }

  input:focus {
    outline: none;
    border-color: color-mix(in srgb, var(--accent) 68%, var(--border));
    background: var(--surface-2);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 12%, transparent);
  }

  button {
    min-width: 62px;
    padding: 7px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: transparent;
    color: var(--muted);
    font-size: 11px;
    font-weight: 650;
  }

  button:hover:not(:disabled) {
    border-color: var(--border-strong);
    background: var(--surface-2);
    color: var(--text);
  }

  .add-row {
    margin-top: 1px;
  }

  .add-row button {
    color: var(--accent-strong);
  }

  button:disabled,
  input:disabled {
    opacity: 0.52;
  }
</style>
