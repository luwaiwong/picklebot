<script lang="ts">
  // Integrated date + time picker. Replaces the raw <input type="datetime-local">.
  // Emits the SAME "yyyy-MM-ddThh:mm" local wall-clock string the form already
  // expects, so the submit contract is unchanged — only the UX is upgraded.
  import { untrack } from 'svelte';
  let { value = '', onChange }: { value?: string; onChange: (v: string) => void } = $props();

  const pad = (n: number) => String(n).padStart(2, '0');
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const WD = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // pending time-of-day; seeded ONCE from value (untrack) or a sensible evening default
  let time = $state(untrack(() => (value ? { h: +value.slice(11, 13), m: +value.slice(14, 16) } : { h: 18, m: 0 })));
  // which month the grid shows
  let view = $state(untrack(() => (value ? { y: +value.slice(0, 4), m: +value.slice(5, 7) - 1 } : { y: now.getFullYear(), m: now.getMonth() })));

  // selection lives in `value` ("yyyy-mm-dd" prefix) so external resets clear it for free
  const selKey = $derived(value ? value.slice(0, 10) : '');
  const selected = $derived(value ? new Date(value) : null);

  // calendar cells: leading blanks (null) then day numbers
  const cells = $derived.by(() => {
    const lead = new Date(view.y, view.m, 1).getDay();
    const days = new Date(view.y, view.m + 1, 0).getDate();
    const out: (number | null)[] = Array(lead).fill(null);
    for (let d = 1; d <= days; d++) out.push(d);
    return out;
  });
  const canPrev = $derived(view.y > today.getFullYear() || (view.y === today.getFullYear() && view.m > today.getMonth()));

  function key(d: number) { return `${view.y}-${pad(view.m + 1)}-${pad(d)}`; }
  function isPast(d: number) { return new Date(view.y, view.m, d) < today; }
  function isToday(d: number) { return view.y === today.getFullYear() && view.m === today.getMonth() && d === today.getDate(); }

  function emit(dateKey: string) { onChange(`${dateKey}T${pad(time.h)}:${pad(time.m)}`); }

  function pick(d: number) { if (!isPast(d)) emit(key(d)); }
  function shiftMonth(dir: -1 | 1) {
    if (dir === -1 && !canPrev) return;
    const m = view.m + dir;
    view = { y: view.y + Math.floor(m / 12), m: ((m % 12) + 12) % 12 };
  }

  // time steppers — wrap around; re-emit if a day is already selected
  function setTime(h: number, m: number) {
    time = { h: (h + 24) % 24, m: (m + 60) % 60 };
    if (selKey) emit(selKey);
  }
  const bumpH = (n: number) => setTime(time.h + n, time.m);
  const bumpM = (n: number) => setTime(time.h, time.m + n);
  const toggleAP = () => setTime(time.h + 12, time.m);
  const wheel = (fn: (n: number) => void) => (e: WheelEvent) => { e.preventDefault(); fn(e.deltaY < 0 ? 1 : -1); };

  const hr12 = $derived(time.h % 12 || 12);
  const ap = $derived(time.h < 12 ? 'AM' : 'PM');
</script>

<div class="dtp">
  <div class="summary">
    {#if selected}
      <span class="d">{selected.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</span>
      <span class="sep">·</span>
      <span class="t">{selected.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
    {:else}
      <span class="ph">Select a session date below</span>
    {/if}
  </div>

  <div class="body">
    <!-- calendar -->
    <div class="cal">
      <div class="cal-head">
        <button type="button" class="nav" onclick={() => shiftMonth(-1)} disabled={!canPrev} aria-label="Previous month">‹</button>
        <span class="mlabel">{MONTHS[view.m]} {view.y}</span>
        <button type="button" class="nav" onclick={() => shiftMonth(1)} aria-label="Next month">›</button>
      </div>
      <div class="wd">{#each WD as d}<span aria-hidden="true">{d}</span>{/each}</div>
      <div class="grid">
        {#each cells as c, i (i)}
          {#if c === null}
            <span class="blank"></span>
          {:else}
            <button
              type="button"
              class="day"
              class:sel={key(c) === selKey}
              class:today={isToday(c)}
              disabled={isPast(c)}
              onclick={() => pick(c)}
            >{c}</button>
          {/if}
        {/each}
      </div>
    </div>

    <!-- time -->
    <div class="timebar" role="group" aria-label="Session time">
      <span class="time-lbl">Time</span>
      <div class="clock">
        <div class="step" onwheel={wheel(bumpH)}>
          <button type="button" onclick={() => bumpH(1)} aria-label="Hour up">▲</button>
          <span class="val">{pad(hr12)}</span>
          <button type="button" onclick={() => bumpH(-1)} aria-label="Hour down">▼</button>
        </div>
        <span class="colon">:</span>
        <div class="step" onwheel={wheel(bumpM)}>
          <button type="button" onclick={() => bumpM(5)} aria-label="Minute up">▲</button>
          <span class="val">{pad(time.m)}</span>
          <button type="button" onclick={() => bumpM(-5)} aria-label="Minute down">▼</button>
        </div>
        <div class="step ap" onwheel={wheel(() => toggleAP())}>
          <button type="button" onclick={toggleAP} aria-label="AM/PM up">▲</button>
          <span class="val">{ap}</span>
          <button type="button" onclick={toggleAP} aria-label="AM/PM down">▼</button>
        </div>
      </div>
    </div>
  </div>
</div>

<style>
  .dtp { border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--surface-2); overflow: hidden; }

  .summary {
    display: flex; align-items: baseline; gap: 8px;
    padding: 11px 13px;
    border-bottom: 1px solid var(--line);
    background: var(--surface-3);
    font-family: var(--mono);
  }
  .summary .d { font-weight: 600; font-size: 13px; }
  .summary .t { font-weight: 600; font-size: 13px; color: var(--acc); }
  .summary .sep { color: var(--faint); }
  .summary .ph { color: var(--faint); font-family: var(--sans); font-size: 12.5px; }

  .body { display: block; }

  /* calendar */
  .cal { padding: 14px 14px 12px; }
  .cal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
  .mlabel { font: 600 12.5px/1 var(--mono); letter-spacing: 0.02em; }
  .nav {
    width: 26px; height: 26px; padding: 0; line-height: 1;
    background: transparent; border: 1px solid var(--line); color: var(--mut);
    border-radius: 7px; font-size: 15px;
  }
  .nav:hover:not(:disabled) { color: var(--acc); border-color: var(--acc-line); background: var(--acc-soft); filter: none; }
  .nav:disabled { opacity: 0.3; }

  .wd, .grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }
  .wd { margin-bottom: 6px; }
  .wd span { text-align: center; font: 500 10.5px/1 var(--mono); color: var(--faint); }
  .grid { grid-auto-rows: 40px; }

  .day {
    width: 100%; height: 100%; padding: 0;
    display: flex; align-items: center; justify-content: center;
    background: transparent; border: 1px solid transparent; color: var(--fg);
    border-radius: 7px; font: 500 13px/1 var(--mono);
    transition: background 0.12s, color 0.12s, border-color 0.12s;
  }
  .day:hover:not(:disabled) { background: var(--surface-3); filter: none; }
  .day:disabled { color: var(--faint); opacity: 0.4; cursor: default; }
  .day.today:not(.sel) { border-color: var(--line-2); color: var(--acc); }
  .day.sel {
    background: var(--acc); color: var(--acc-ink); font-weight: 700;
    box-shadow: 0 0 0 3px var(--acc-soft);
  }

  /* time bar (full width, below the calendar) */
  .timebar {
    display: flex; align-items: center; justify-content: space-between;
    padding: 11px 14px; border-top: 1px solid var(--line);
  }
  .time-lbl { font: 500 10.5px/1 var(--mono); letter-spacing: 0.13em; text-transform: uppercase; color: var(--faint); }
  .clock { display: flex; align-items: center; gap: 4px; }
  .step {
    display: flex; flex-direction: column; align-items: center;
    background: var(--bg); border: 1px solid var(--line); border-radius: 8px;
    padding: 3px 2px;
  }
  .step.ap { min-width: 40px; }
  .step button {
    background: transparent; border: 0; padding: 2px 6px; color: var(--faint);
    font-size: 8px; line-height: 1; cursor: pointer;
  }
  .step button:hover { color: var(--acc); filter: none; }
  .step .val { font: 600 16px/1.2 var(--mono); padding: 1px 0; min-width: 22px; text-align: center; }
  .step.ap .val { font-size: 12px; color: var(--acc); }
  .colon { font: 600 16px/1 var(--mono); color: var(--faint); padding-bottom: 2px; }
</style>
