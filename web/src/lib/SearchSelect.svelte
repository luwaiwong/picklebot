<script lang="ts">
  import type { FilterOption } from './types';

  // Reusable searchable dropdown (combobox). Used for both Activity (single
  // value) and Location (clears after each pick so it acts as an "add" picker).
  let {
    options,
    value = '',
    placeholder = 'Search…',
    disabled = false,
    clearOnSelect = false,
    onSelect,
  }: {
    options: FilterOption[];
    value?: string;
    placeholder?: string;
    disabled?: boolean;
    clearOnSelect?: boolean;
    onSelect: (opt: FilterOption) => void;
  } = $props();

  let query = $state('');
  let open = $state(false);
  let active = $state(0);

  // label of the currently selected value (activity case)
  let selectedName = $derived(options.find((o) => o.value === value)?.name ?? '');
  // when not actively searching, show the selected label (or nothing if it clears)
  let display = $derived(open ? query : clearOnSelect ? '' : selectedName);

  let filtered = $derived(
    query.trim() ? options.filter((o) => o.name.toLowerCase().includes(query.toLowerCase())) : options,
  );

  function choose(opt: FilterOption) {
    onSelect(opt);
    query = '';
    open = false;
  }

  function onInput(e: Event) {
    query = (e.target as HTMLInputElement).value;
    open = true;
    active = 0;
  }

  function onKeydown(e: KeyboardEvent) {
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) {
      open = true;
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      active = Math.min(active + 1, filtered.length - 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      active = Math.max(active - 1, 0);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const o = filtered[active];
      if (o) choose(o);
    } else if (e.key === 'Escape') {
      open = false;
      query = '';
    }
  }
</script>

<div class="combo">
  <input
    type="text"
    value={display}
    {placeholder}
    {disabled}
    autocomplete="off"
    oninput={onInput}
    onfocus={() => (open = true)}
    onblur={() => setTimeout(() => ((open = false), (query = '')), 120)}
    onkeydown={onKeydown}
  />
  {#if open && filtered.length}
    <ul class="opts">
      {#each filtered as opt, i (opt.value)}
        <li>
          <button
            type="button"
            class:active={i === active}
            class:sel={opt.value === value}
            onmousedown={() => choose(opt)}>{opt.name}</button
          >
        </li>
      {/each}
    </ul>
  {:else if open && query}
    <ul class="opts">
      <li class="none">No matches</li>
    </ul>
  {/if}
</div>

<style>
  .combo { position: relative; }
  .opts {
    list-style: none;
    margin: 5px 0 0;
    padding: 5px;
    position: absolute;
    z-index: 20;
    left: 0;
    right: 0;
    max-height: 240px;
    overflow: auto;
    background: var(--surface);
    border: 1px solid var(--line-2);
    border-radius: var(--r-sm);
    box-shadow: 0 16px 36px -16px rgba(0, 0, 0, 0.8);
  }
  .opts li { border: 0; padding: 0; margin: 0; }
  .opts button {
    width: 100%;
    text-align: left;
    background: transparent;
    color: var(--fg);
    font-weight: 400;
    font-size: 13px;
    padding: 8px 10px;
    border-radius: 6px;
    transition: background 0.1s, color 0.1s;
  }
  .opts button:hover,
  .opts button.active { background: var(--surface-3); filter: none; }
  .opts button.sel { color: var(--acc); }
  .opts .none { padding: 8px 10px; color: var(--mut); font-size: 12px; }
</style>
