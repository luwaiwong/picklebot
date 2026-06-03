<script lang="ts">
  import { book, stop } from './api';
  import type { JobPhase } from './types';

  let { phase }: { phase: JobPhase } = $props();

  // login and activity code are persisted client-side so the next open prefills them.
  // (single-user localhost tool — password is stored in plaintext on this machine.)
  const STORAGE_KEY = 'pball.login';

  function loadSavedForm(): { username: string; password: string; code: string } {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { username: '', password: '', code: '' };
      const v = JSON.parse(raw);
      return {
        username: typeof v?.username === 'string' ? v.username : '',
        password: typeof v?.password === 'string' ? v.password : '',
        code: typeof v?.code === 'string' ? v.code : '',
      };
    } catch {
      return { username: '', password: '', code: '' }; // storage unavailable/corrupt - start blank
    }
  }

  function saveForm(username: string, password: string, code: string) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ username, password, code }));
    } catch {
      /* storage unavailable — skip persisting */
    }
  }

  const saved = loadSavedForm();
  // form values are held in component state for the request; persisted on Book via saveForm().
  let username = $state(saved.username);
  let password = $state(saved.password);
  let code = $state(saved.code);
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
    saveForm(u, p, c); // prefilled on next open
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
      type="text"
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
