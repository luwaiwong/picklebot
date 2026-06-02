<script lang="ts">
  import { onMount } from 'svelte';
  import { subscribeEvents, getHealth } from './lib/api';
  import type { JobState } from './lib/types';
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
  // transient hint surfaced from the `login` SSE events during a booking's login step
  let loginHint = $state('');

  onMount(() => {
    // seed from health, then live-hydrate from SSE (server pushes a job snapshot on connect)
    getHealth()
      .then((h) => { if (h?.job) job = h.job; })
      .catch(() => { /* banner stays idle */ });
    const es = subscribeEvents((e) => {
      if (e.type === 'job') {
        job = e.state;
        if (e.state.phase !== 'running') loginHint = ''; // clear once the job settles
      } else if (e.type === 'login') {
        // login happens during a booking; logged-in continues to booking, failures land on the banner
        loginHint = e.state === 'logging-in' ? '● logging in…' : '';
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

{#if loginHint}
  <div class="login-strip active">{loginHint}</div>
{/if}

<main>
  <section class="card">
    <BookForm phase={job.phase} />
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
  .login-strip.active { color: var(--acc); background: var(--acc-soft); border-color: var(--acc-line); animation: blink 1.4s ease-in-out infinite; }

  @media (max-width: 600px) {
    .banner { max-width: 100%; }
  }
</style>
