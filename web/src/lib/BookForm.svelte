<script lang="ts">
  import { book, stop } from './api';
  import type { JobPhase } from './types';

  let { phase }: { phase: JobPhase } = $props();

  // creds are transient — held in component state for the request, never persisted.
  let username = $state('');
  let password = $state('');
  let code = $state('');
  let err = $state('');

  const running = $derived(phase === 'running');

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault();
    err = '';
    const u = username.trim();
    const p = password;
    const c = code.trim();
    if (!u || !p || !c) {
      err = 'Enter your email, password, and an activity code.';
      return;
    }
    if (!/^\d+$/.test(c)) {
      err = 'Code must be numeric.';
      return;
    }
    const res = await book(c, u, p);
    if (res.status === 409) {
      err = 'A booking is already running — Stop it first.';
      return;
    }
    if (res.status === 400) {
      const d = res.data?.error;
      err = d ? (typeof d === 'string' ? d : JSON.stringify(d)) : 'Invalid request — check your details.';
      return;
    }
    if (!res.ok) {
      err = res.data?.error ? String(res.data.error) : 'Could not start booking.';
      return;
    }
    code = ''; // keep username/password in the fields for convenience; never persisted
  }

  async function handleStop() {
    err = '';
    await stop();
  }
</script>

<div class="card-head">
  <h2>Book by code</h2>
  <span class="count">logs in &amp; books immediately</span>
</div>

<form onsubmit={handleSubmit}>
  <div class="creds-row">
    <input
      type="text"
      autocomplete="username"
      placeholder="Email"
      bind:value={username}
      aria-label="Email"
    />
    <input
      type="password"
      autocomplete="current-password"
      placeholder="Password"
      bind:value={password}
      aria-label="Password"
    />
  </div>
  <div class="book-row">
    <input
      inputmode="numeric"
      pattern="\d*"
      placeholder="Activity code · e.g. 310024"
      bind:value={code}
      aria-label="Activity code"
    />
    <button type="submit" disabled={running}>Book</button>
    <button type="button" class="ghost danger" onclick={handleStop} disabled={!running}>Stop</button>
  </div>
  {#if err}<div class="hint err">{err}</div>{/if}
</form>

<style>
  .creds-row { display: flex; gap: 10px; align-items: stretch; margin-bottom: 10px; }
  .creds-row input { flex: 1; min-width: 0; }
  .book-row { display: flex; gap: 10px; align-items: stretch; }
  .book-row input {
    flex: 1; min-width: 0;
    font: 500 15px/1.4 var(--mono); letter-spacing: 0.04em;
  }
  .book-row button { flex: none; white-space: nowrap; }
  @media (max-width: 560px) {
    .creds-row { flex-direction: column; }
  }
</style>
