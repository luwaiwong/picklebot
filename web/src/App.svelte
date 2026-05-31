<script lang="ts">
  import { onMount } from 'svelte';
  import { listTargets, getHealth } from './lib/api';
  import type { TargetRow, Health } from './lib/types';
  import TargetForm from './lib/TargetForm.svelte';
  import TargetList from './lib/TargetList.svelte';
  import LiveLog from './lib/LiveLog.svelte';

  let targets = $state<TargetRow[]>([]);
  let health = $state<Health | null>(null);
  let now = $state(new Date());

  async function refresh() {
    targets = await listTargets();
    try { health = await getHealth(); } catch { /* header status optional */ }
  }

  onMount(() => {
    refresh();
    const tick = setInterval(() => (now = new Date()), 1000);
    const poll = setInterval(refresh, 30_000);
    return () => { clearInterval(tick); clearInterval(poll); };
  });

  // live relative countdown to the next scheduled fire
  const nextFire = $derived.by(() => {
    if (!health?.nextFireAt) return { v: 'idle', dim: true };
    const diff = new Date(health.nextFireAt).getTime() - now.getTime();
    if (diff <= 0) return { v: 'firing…', dim: false };
    const s = Math.floor(diff / 1000);
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    const pad = (n: number) => String(n).padStart(2, '0');
    const v = d >= 1 ? `${d}d ${h}h` : h >= 1 ? `${h}h ${pad(m)}m` : `${m}m ${pad(ss)}s`;
    return { v, dim: false };
  });
</script>

<header>
  <div class="brand">
    <span class="dot"></span>
    <h1>Event Booker</h1>
  </div>
  <div class="status">
    <div class="stat">
      <span class="k">Scheduled</span>
      <span class="v" class:acc={!!health?.armed} class:dim={!health?.armed}>{health?.armed ?? '—'}</span>
    </div>
    <div class="stat">
      <span class="k">Next fire</span>
      <span class="v" class:acc={!nextFire.dim} class:dim={nextFire.dim}>{nextFire.v}</span>
    </div>
  </div>
</header>

<main>
  <div class="top">
    <section class="card">
      <div class="card-head">
        <h2>Scheduled targets</h2>
        <span class="count">{targets.length} scheduled</span>
      </div>
      <div class="scroll">
        <TargetList {targets} onChanged={refresh} />
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <h2>Live status</h2>
        <span class="count">⦿ streaming</span>
      </div>
      <LiveLog onDeleted={refresh} />
    </section>
  </div>

  <section class="card">
    <TargetForm onSaved={refresh} />
  </section>
</main>
