<script lang="ts">
  import { onMount } from 'svelte';
  import { subscribeEvents, getHealth } from './lib/api';
  import type { JobState } from './lib/types';
  import AccountForm from './lib/AccountForm.svelte';
  import BookForm from './lib/BookForm.svelte';
  import LiveLog from './lib/LiveLog.svelte';

  let job = $state<JobState>({
    phase: 'idle',
    code: null,
    startedAt: null,
    finishedAt: null,
    lastStatus: null,
    lastDetail: null,
  });
  let loginActive = $state(false);
  let loginHint = $state('');

  // Book + Save&Log in are unavailable while a login is in flight or a booking is running.
  const loginBusy = $derived(loginActive || job.phase === 'running');

  onMount(() => {
    // seed from health, then live-hydrate from SSE (server pushes a job snapshot on connect)
    getHealth()
      .then((h) => {
        if (h?.job) job = h.job;
        loginActive = !!h?.loginActive;
      })
      .catch(() => { /* banner stays idle */ });
    const es = subscribeEvents((e) => {
      if (e.type === 'job') {
        job = e.state;
      } else if (e.type === 'login') {
        loginActive = e.state === 'logging-in';
        if (e.state === 'logging-in') loginHint = '';
        else if (e.state === 'logged-in') loginHint = '✓ signed in';
        else loginHint = '✗ login failed' + (e.detail ? ' — ' + e.detail : ''); // login-failed | error
      }
    });
    return () => es.close();
  });
</script>

<header>
  <div class="brand">
    <span class="dot" class:run={job.phase === 'running'}></span>
    <h1>Event Booker</h1>
  </div>
  <div class="banner" class:run={job.phase === 'running'} class:ok={job.phase === 'success'} class:bad={job.phase === 'failed'}>
    {#if job.phase === 'running'}
      <span class="pulse">●</span> currently booking <span class="code">#{job.code}</span> …
    {:else if job.phase === 'success'}
      <span class="ic">✓</span> booked <span class="code">#{job.code}</span>
    {:else if job.phase === 'failed'}
      <span class="ic">✗</span> <span class="code">#{job.code}</span> — {job.lastStatus}{job.lastDetail ? `: ${job.lastDetail}` : ''}
    {:else}
      <span class="dim">idle</span>
    {/if}
  </div>
</header>

{#if loginActive || loginHint}
  <div class="login-strip" class:active={loginActive} class:bad={!loginActive && loginHint.startsWith('✗')}>
    {#if loginActive}
      <span class="pulse">●</span> logging in…
    {:else}
      {loginHint}
    {/if}
  </div>
{/if}

<main>
  <section class="card">
    <AccountForm disabled={loginBusy} />
  </section>

  <section class="card">
    <BookForm phase={job.phase} {loginActive} />
  </section>

  <section class="card">
    <div class="card-head">
      <h2>Live status</h2>
      <span class="count">⦿ streaming</span>
    </div>
    <LiveLog />
  </section>
</main>

<style>
  .brand .dot.run { animation: blink 1.1s ease-in-out infinite; }
  @keyframes blink { 50% { opacity: 0.3; } }

  .banner {
    margin-left: auto;
    display: flex; align-items: center; gap: 7px;
    font: 600 13px/1 var(--mono); letter-spacing: 0.02em;
    color: var(--mut);
    padding: 8px 14px;
    border: 1px solid var(--line);
    border-radius: var(--r-sm);
    background: var(--surface-2);
    max-width: 48ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .banner .code { color: var(--fg); }
  .banner .dim { color: var(--faint); font-weight: 500; }
  .banner.run { color: var(--acc); border-color: var(--acc-line); background: var(--acc-soft); }
  .banner.run .code { color: var(--acc); }
  .banner.run .pulse { animation: blink 1.1s ease-in-out infinite; }
  .banner.ok { color: var(--acc); border-color: var(--acc-line); background: var(--acc-soft); }
  .banner.ok .ic { color: var(--acc); }
  .banner.bad { color: var(--err); border-color: var(--err); background: rgba(191, 97, 106, 0.12); }
  .banner.bad .code { color: var(--err); }

  .login-strip {
    display: flex; align-items: center; gap: 7px;
    padding: 9px 24px;
    font: 500 12px/1.3 var(--mono);
    color: var(--mut);
    background: var(--surface-2);
    border-bottom: 1px solid var(--line);
  }
  .login-strip.active { color: var(--acc); background: var(--acc-soft); border-color: var(--acc-line); }
  .login-strip.active .pulse { animation: blink 1.1s ease-in-out infinite; }
  .login-strip.bad { color: var(--err); background: rgba(191, 97, 106, 0.12); border-color: var(--err); }

  @media (max-width: 600px) {
    .banner { max-width: 100%; }
  }
</style>
