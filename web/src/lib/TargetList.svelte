<script lang="ts">
  import { onMount } from 'svelte';
  import { deleteTarget, runNow } from './api';
  import { ACTIVITY_IDS } from '../../../src/shared/activities';
  import type { TargetRow } from './types';

  let { targets, onChanged }: { targets: TargetRow[]; onChanged: () => void } = $props();

  let now = $state(new Date());
  onMount(() => {
    const id = setInterval(() => (now = new Date()), 1000);
    return () => clearInterval(id);
  });

  // friendly labels for the known activity GUIDs (fall back to a generic tag)
  const ACT_NAMES: Record<string, string> = {
    [ACTIVITY_IDS.ADULTS]: 'Adults',
    [ACTIVITY_IDS.ADULT_AND_CHILD]: 'Adult & Child',
  };
  const acts = (ids: string[]) => ids.map((id) => ACT_NAMES[id] ?? 'Activity').join(' › ');

  const fmtWhen = (iso: string | Date) =>
    new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  function relFire(iso: string) {
    const diff = new Date(iso).getTime() - now.getTime();
    if (diff <= 0) return diff > -120_000 ? 'firing…' : 'overdue';
    const s = Math.floor(diff / 1000);
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    const pad = (n: number) => String(n).padStart(2, '0');
    return d >= 1 ? `${d}d ${h}h` : h >= 1 ? `${h}h ${pad(m)}m` : `${m}m ${pad(ss)}s`;
  }

  async function del(id: string) {
    await deleteTarget(id);
    onChanged();
  }
</script>

<ul class="targets">
  {#each targets as t (t.id)}
    <li>
      <div class="li-top">
        <span class="when">{fmtWhen(t.sessionStart)}</span>
        <span class="tags">
          {#if t.dryRun}<span class="tag dry">dry-run</span>{/if}
          {#if t.joinWaitlistIfFull}<span class="tag wl">waitlist ok</span>{/if}
        </span>
      </div>
      <div class="li-meta">
        {acts(t.activityIds)}
        <span class="dot-sep">·</span>
        {t.locationPrefs?.length ? t.locationPrefs.join(' / ') : 'any venue'}
      </div>
      <div class="li-foot">
        <span class="fires"><span class="ch">⌖</span> fires in {relFire(t.fireAt)} <span class="abs">· {fmtWhen(t.fireAt)}</span></span>
        <span class="li-actions">
          <button class="ghost" onclick={() => runNow(t.id!)}>Run now</button>
          <button class="ghost danger" onclick={() => del(t.id!)}>Delete</button>
        </span>
      </div>
    </li>
  {:else}
    <li class="empty">No targets scheduled yet — create one below.</li>
  {/each}
</ul>

<style>
  .targets { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
  .targets li {
    border: 1px solid var(--line); border-radius: var(--r-sm);
    background: var(--surface-2); padding: 12px 13px;
  }
  .targets li.empty {
    color: var(--faint); font-size: 12.5px; text-align: center; padding: 22px 12px;
    background: transparent; border-style: dashed;
  }
  .li-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .when { font: 600 13.5px/1.2 var(--mono); }
  .tags { display: flex; gap: 5px; flex: none; }
  .tag { font: 500 9.5px/1 var(--mono); letter-spacing: 0.05em; text-transform: uppercase; padding: 4px 6px; border-radius: 5px; }
  .tag.dry { color: var(--warn); background: rgba(235, 203, 139, 0.12); }
  .tag.wl { color: var(--cyan); background: rgba(129, 161, 193, 0.14); }

  .li-meta { font-size: 12px; color: var(--mut); margin-top: 5px; }
  .dot-sep { color: var(--faint); margin: 0 3px; }

  .li-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 10px; }
  .fires { font: 500 11.5px/1 var(--mono); color: var(--acc); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .fires .ch { opacity: 0.85; }
  .fires .abs { color: var(--faint); }
  .li-actions { display: flex; gap: 6px; flex: none; }
  .li-actions button { padding: 6px 11px; font-size: 12px; }
</style>
