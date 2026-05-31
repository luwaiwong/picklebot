<script lang="ts">
  // Turns the abstract timing fields into a tangible, live readout:
  //   release = sessionStart − leadHours   (the instant the bot pounces)
  //   window  = [release − warmup … release + windowMinutes]
  // Nothing here is submitted — it just makes the numbers legible.
  let {
    sessionStart,
    windowLeadHours,
    warmupSeconds,
    windowMinutes,
  }: { sessionStart: string; windowLeadHours: number; warmupSeconds: number; windowMinutes: number } = $props();

  let now = $state(new Date());
  $effect(() => {
    const id = setInterval(() => (now = new Date()), 1000);
    return () => clearInterval(id);
  });

  const session = $derived(sessionStart ? new Date(sessionStart) : null);
  const valid = $derived(!!session && !isNaN(session.getTime()));

  const lead = $derived(Number(windowLeadHours) || 0);
  const warm = $derived(Math.max(0, Number(warmupSeconds) || 0));
  const win = $derived(Math.max(0, Number(windowMinutes) || 0));

  const release = $derived(valid ? new Date(session!.getTime() - lead * 3600_000) : null);
  const warmStart = $derived(release ? new Date(release.getTime() - warm * 1000) : null);
  const giveUp = $derived(release ? new Date(release.getTime() + win * 60_000) : null);

  // RELEASE sits at the warm-up / try-window boundary; size segments by duration
  const leftPct = $derived.by(() => {
    const total = warm + win * 60;
    return total ? (warm / total) * 100 : 0;
  });

  const fmtT = (d: Date | null) => (d ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '—');
  const fmtFull = (d: Date | null) =>
    d ? d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';

  // live relative time to the release instant
  const rel = $derived.by(() => {
    if (!release) return { text: '', state: 'idle' };
    const diff = release.getTime() - now.getTime();
    if (diff > 0) {
      const s = Math.floor(diff / 1000);
      const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
      const text = d >= 1 ? `${d}d ${h}h` : h >= 1 ? `${h}h ${pad(m)}m` : `${m}m ${pad(ss)}s`;
      return { text: `fires in ${text}`, state: 'pending' };
    }
    if (giveUp && now.getTime() <= giveUp.getTime()) return { text: 'window open now', state: 'live' };
    return { text: 'window elapsed', state: 'done' };
  });
  function pad(n: number) { return String(n).padStart(2, '0'); }
</script>

<div class="tl" class:idle={!valid}>
  {#if !valid}
    <div class="placeholder">⌖ Pick a session to preview when the bot fires</div>
  {:else}
    <div class="readout">
      <div class="lead-in">
        <span class="crosshair">⌖</span> bot fires
        <span class="ago" data-state={rel.state}>· {rel.text}</span>
      </div>
      <div class="fire">{fmtFull(release)}</div>
      <div class="ctx">{lead}h before session · {fmtFull(session)}</div>
    </div>

    <div class="schematic">
      <div class="track">
        <div class="seg warm" style="width:{leftPct}%"></div>
        <div class="seg win" style="width:{100 - leftPct}%"></div>
        <div class="pin" style="left:{leftPct}%"><span class="pin-dot"></span></div>
      </div>
      <div class="legend">
        <span class="lg"><b>{fmtT(warmStart)}</b><i>warm-up −{warm}s</i></span>
        <span class="lg mid"><b>{fmtT(release)}</b><i>release</i></span>
        <span class="lg end"><b>{fmtT(giveUp)}</b><i>give up +{win}m</i></span>
      </div>
    </div>
  {/if}
</div>

<style>
  .tl {
    border: 1px solid var(--acc-line);
    border-radius: var(--r-sm);
    background: var(--surface-2);
    padding: 14px;
  }
  .tl.idle { border-color: var(--line); }
  .placeholder { font-size: 12.5px; color: var(--faint); text-align: center; padding: 4px 0; }

  .readout { margin-bottom: 14px; }
  .lead-in {
    font: 500 10.5px/1 var(--mono); letter-spacing: 0.12em; text-transform: uppercase;
    color: var(--mut); display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  }
  .crosshair { color: var(--acc); font-size: 12px; }
  .ago { letter-spacing: 0.04em; }
  .ago[data-state='pending'] { color: var(--acc); }
  .ago[data-state='live'] { color: var(--cyan); animation: pulse 1.4s ease-in-out infinite; }
  .ago[data-state='done'] { color: var(--faint); }
  @keyframes pulse { 50% { opacity: 0.45; } }

  .fire { font: 700 19px/1.2 var(--mono); color: var(--fg); margin: 5px 0 3px; letter-spacing: -0.01em; }
  .ctx { font: 400 11.5px/1.4 var(--sans); color: var(--mut); }

  /* window schematic */
  .schematic { padding-top: 12px; border-top: 1px solid var(--line); }
  .track { position: relative; height: 8px; border-radius: 5px; overflow: visible; display: flex; }
  .seg { height: 100%; }
  .seg.warm { background: var(--line-2); border-radius: 5px 0 0 5px; }
  .seg.win { background: var(--acc); border-radius: 0 5px 5px 0; }
  .pin { position: absolute; top: 50%; transform: translate(-50%, -50%); }
  .pin-dot {
    display: block; width: 11px; height: 11px; border-radius: 50%;
    background: var(--acc); border: 2px solid var(--surface);
    box-shadow: 0 0 0 3px var(--acc-soft), 0 0 10px var(--acc);
  }
  .legend { display: flex; justify-content: space-between; margin-top: 9px; }
  .lg { display: flex; flex-direction: column; gap: 2px; }
  .lg.mid { align-items: center; }
  .lg.end { align-items: flex-end; text-align: right; }
  .lg b { font: 600 12px/1 var(--mono); color: var(--fg); }
  .lg.mid b { color: var(--acc); }
  .lg i { font: 400 10px/1 var(--sans); color: var(--faint); font-style: normal; letter-spacing: 0.02em; }
</style>
