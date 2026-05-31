<script lang="ts">
  import { onMount } from 'svelte';
  import { ACTIVITY_IDS } from '../../../src/shared/activities';
  import { getFilters, saveTarget } from './api';
  import type { FilterOption } from './types';
  import SearchSelect from './SearchSelect.svelte';
  import DateTimePicker from './DateTimePicker.svelte';
  import BookingTimeline from './BookingTimeline.svelte';

  let { onSaved }: { onSaved: () => void } = $props();

  // defaults shared by initial state + reset(). Targets are create-only (no edit) and a saved
  // target is always scheduled (no enabled flag).
  const DEFAULTS = {
    activityIds: [ACTIVITY_IDS.ADULTS] as string[], // one or more activity GUIDs
    locationPrefs: [] as string[], // ordered venue names; [] = any
    sessionStart: '', // datetime-local string "yyyy-MM-ddThh:mm" (Toronto wall-clock)
    windowLeadHours: 21,
    warmupSeconds: 60,
    windowMinutes: 10,
    joinWaitlistIfFull: true,
    dryRun: false,
  };

  // picker options pulled live from the Markham widget (GET /api/filters), not hardcoded
  let activityOptions = $state<FilterOption[]>([]);
  let locationOptions = $state<FilterOption[]>([]);
  let filtersError = $state('');

  let activityIds = $state<string[]>([...DEFAULTS.activityIds]);
  let locationPrefs = $state<string[]>([...DEFAULTS.locationPrefs]);
  let sessionStart = $state(DEFAULTS.sessionStart);
  let windowLeadHours = $state(DEFAULTS.windowLeadHours);
  let warmupSeconds = $state(DEFAULTS.warmupSeconds);
  let windowMinutes = $state(DEFAULTS.windowMinutes);
  let joinWaitlistIfFull = $state(DEFAULTS.joinWaitlistIfFull);
  let dryRun = $state(DEFAULTS.dryRun);

  // options not yet chosen — each "add" dropdown only offers what's left
  let availableActivities = $derived(activityOptions.filter((o) => !activityIds.includes(o.value)));
  let availableLocations = $derived(locationOptions.filter((o) => !locationPrefs.includes(o.name)));
  const activityName = (v: string) => activityOptions.find((o) => o.value === v)?.name ?? v;

  onMount(async () => {
    try {
      const f = await getFilters();
      activityOptions = f.activities;
      locationOptions = f.locations;
    } catch {
      filtersError = 'Could not load options from Markham — try reloading.';
    }
  });

  function addActivity(value: string) {
    if (value && !activityIds.includes(value)) activityIds = [...activityIds, value];
  }
  function removeActivity(value: string) {
    activityIds = activityIds.filter((v) => v !== value);
  }
  // order = priority: highest-priority activity is tried first
  function moveActivity(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= activityIds.length) return;
    const next = [...activityIds];
    const [moved] = next.splice(i, 1);
    if (moved !== undefined) next.splice(j, 0, moved);
    activityIds = next;
  }
  function addLocation(name: string) {
    if (name && !locationPrefs.includes(name)) locationPrefs = [...locationPrefs, name];
  }
  function removeLocation(name: string) {
    locationPrefs = locationPrefs.filter((n) => n !== name);
  }
  // order = priority, so let the user reshuffle
  function moveLocation(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= locationPrefs.length) return;
    const next = [...locationPrefs];
    const [moved] = next.splice(i, 1);
    if (moved !== undefined) next.splice(j, 0, moved);
    locationPrefs = next;
  }

  function reset() {
    activityIds = [...DEFAULTS.activityIds];
    locationPrefs = [...DEFAULTS.locationPrefs];
    sessionStart = DEFAULTS.sessionStart;
    windowLeadHours = DEFAULTS.windowLeadHours;
    warmupSeconds = DEFAULTS.warmupSeconds;
    windowMinutes = DEFAULTS.windowMinutes;
    joinWaitlistIfFull = DEFAULTS.joinWaitlistIfFull;
    dryRun = DEFAULTS.dryRun;
  }

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault();
    if (!sessionStart) {
      filtersError = 'Pick a session date & time first.';
      return;
    }
    // bind:value on type=number yields undefined when emptied; coerce so no NaN/null
    // reaches the body (old form sent the defaults / 0).
    const body: Record<string, unknown> = {
      activityIds, // one or more activity GUIDs
      locationPrefs, // already an ordered string[] of venue names
      // datetime-local has no tz; interpret as the browser's local wall-clock -> ISO instant.
      sessionStart: new Date(sessionStart).toISOString(),
      windowLeadHours: Number(windowLeadHours) || DEFAULTS.windowLeadHours,
      warmupSeconds: Number(warmupSeconds) || 0,
      windowMinutes: Number(windowMinutes) || DEFAULTS.windowMinutes,
      joinWaitlistIfFull,
      dryRun,
    };
    const res = await saveTarget(body);
    if (!res.ok) {
      alert('Invalid: ' + JSON.stringify(res.data));
      return;
    }
    reset();
    onSaved();
  }
</script>

<div class="card-head">
  <h2>New booking target</h2>
  <span class="count">one-shot · auto-deletes after run</span>
</div>

<form onsubmit={handleSubmit}>
  <div class="form-grid">
    <div class="fg-col">
      <div class="field">
        <span class="cap">Activities <span class="lbl-note">priority order — books the first found</span></span>
        <SearchSelect
          options={availableActivities}
          placeholder={activityOptions.length ? 'Search activities…' : 'Loading…'}
          disabled={!activityOptions.length}
          clearOnSelect={true}
          onSelect={(o) => addActivity(o.value)}
        />
        {#if activityIds.length}
          <ol class="chips">
            {#each activityIds as aid, i (aid)}
              <li>
                <span class="rank">{i + 1}</span>
                <span class="nm">{activityName(aid)}</span>
                <span class="ctl">
                  <button type="button" onclick={() => moveActivity(i, -1)} disabled={i === 0} aria-label="Move up">↑</button>
                  <button type="button" onclick={() => moveActivity(i, 1)} disabled={i === activityIds.length - 1} aria-label="Move down">↓</button>
                  <button type="button" onclick={() => removeActivity(aid)} aria-label="Remove">×</button>
                </span>
              </li>
            {/each}
          </ol>
        {/if}
      </div>

      <div class="field">
        <span class="cap">Locations <span class="lbl-note">priority order — none = any venue</span></span>
        <SearchSelect
          options={availableLocations}
          placeholder={locationOptions.length ? 'Search locations…' : 'Loading…'}
          disabled={!locationOptions.length}
          clearOnSelect={true}
          onSelect={(o) => addLocation(o.name)}
        />
        {#if locationPrefs.length}
          <ol class="chips">
            {#each locationPrefs as name, i (name)}
              <li>
                <span class="rank">{i + 1}</span>
                <span class="nm">{name}</span>
                <span class="ctl">
                  <button type="button" onclick={() => moveLocation(i, -1)} disabled={i === 0} aria-label="Move up">↑</button>
                  <button type="button" onclick={() => moveLocation(i, 1)} disabled={i === locationPrefs.length - 1} aria-label="Move down">↓</button>
                  <button type="button" onclick={() => removeLocation(name)} aria-label="Remove">×</button>
                </span>
              </li>
            {/each}
          </ol>
        {/if}
      </div>

      <div class="field">
        <div class="subhead">Attempt window</div>
        <div class="row3">
          <div class="num">
            <label for="lead">Release lead</label>
            <div class="num-in"><input id="lead" type="number" bind:value={windowLeadHours} step="0.5" min="0" /><span class="unit">h</span></div>
          </div>
          <div class="num">
            <label for="warm">Warm-up</label>
            <div class="num-in"><input id="warm" type="number" bind:value={warmupSeconds} min="0" /><span class="unit">s</span></div>
          </div>
          <div class="num">
            <label for="win">Try window</label>
            <div class="num-in"><input id="win" type="number" bind:value={windowMinutes} step="0.5" min="0.1" /><span class="unit">m</span></div>
          </div>
        </div>
        <p class="hint">Release auto-refines from the live registration-open time. The bot only acts inside this window.</p>
      </div>

      <div class="checks">
        <label class="chk">
          <input type="checkbox" bind:checked={joinWaitlistIfFull} />
          <span class="lbl">Join waitlist if full</span>
          <span class="desc">else report &amp; stop</span>
        </label>
        <label class="chk">
          <input type="checkbox" bind:checked={dryRun} />
          <span class="lbl">Dry run</span>
          <span class="desc">stop before final confirm</span>
        </label>
      </div>
    </div>

    <div class="fg-col">
      <div class="field">
        <span class="cap">Session start <span class="lbl-note">local wall-clock</span></span>
        <DateTimePicker value={sessionStart} onChange={(v) => (sessionStart = v)} />
      </div>
    </div>
  </div>

  {#if filtersError}<div class="hint err">{filtersError}</div>{/if}

  <div class="timeline-wrap">
    <BookingTimeline {sessionStart} {windowLeadHours} {warmupSeconds} {windowMinutes} />
  </div>

  <div class="actions-row">
    <button type="submit">Schedule target</button>
    <button type="button" class="ghost" onclick={reset}>Clear</button>
  </div>
</form>

<style>
  .fg-col { min-width: 0; }
  .checks { display: flex; flex-direction: column; gap: 8px; }
  .timeline-wrap { margin-top: 14px; }
  .lbl-note { color: var(--faint); font-weight: 400; text-transform: none; letter-spacing: 0; }
  .subhead {
    font: 600 10px/1 var(--mono); letter-spacing: 0.14em; text-transform: uppercase;
    color: var(--faint); margin-bottom: 10px;
    display: flex; align-items: center; gap: 10px;
  }
  .subhead::after { content: ''; flex: 1; height: 1px; background: var(--line); }
  .num-in { position: relative; }
  .num-in .unit {
    position: absolute; right: 11px; top: 50%; transform: translateY(-50%);
    font: 500 10.5px/1 var(--mono); color: var(--faint); pointer-events: none;
  }
  .num-in input { padding-right: 30px; }
</style>
