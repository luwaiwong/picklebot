<script lang="ts">
  import { book, stop } from './api';
  import type { JobPhase } from './types';

  let { phase, loginActive = false }: { phase: JobPhase; loginActive?: boolean } = $props();

  let code = $state('');
  let err = $state('');

  const running = $derived(phase === 'running');

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault();
    err = '';
    const c = code.trim();
    if (!c) {
      err = 'Enter an activity code.';
      return;
    }
    if (!/^\d+$/.test(c)) {
      err = 'Code must be numeric.';
      return;
    }
    const res = await book(c);
    if (res.status === 409) {
      err = 'A booking is already running — Stop it first.';
      return;
    }
    if (!res.ok) {
      err = res.data?.error ? String(res.data.error) : 'Could not start booking.';
      return;
    }
    code = '';
  }

  async function handleStop() {
    err = '';
    await stop();
  }
</script>

<div class="card-head">
  <h2>Book by code</h2>
  <span class="count">on-demand · books immediately</span>
</div>

<form onsubmit={handleSubmit}>
  <div class="book-row">
    <input
      inputmode="numeric"
      pattern="\d*"
      placeholder="Activity code · e.g. 310024"
      bind:value={code}
      aria-label="Activity code"
    />
    <button type="submit" disabled={running || loginActive}>Book</button>
    <button type="button" class="ghost danger" onclick={handleStop} disabled={!running}>Stop</button>
  </div>
  {#if err}<div class="hint err">{err}</div>{/if}
</form>

<style>
  .book-row { display: flex; gap: 10px; align-items: stretch; }
  .book-row input {
    flex: 1; min-width: 0;
    font: 500 15px/1.4 var(--mono); letter-spacing: 0.04em;
  }
  .book-row button { flex: none; white-space: nowrap; }
</style>
