<script lang="ts">
  import { onMount } from 'svelte';
  import { subscribeEvents } from './api';
  import type { LogEvent } from './types';

  type Line = { cls: string; ts: string; text: string };
  let lines = $state<Line[]>([]);
  let logEl: HTMLDivElement;

  const MAX = 1000;

  function render(e: LogEvent): Line {
    const ts = new Date(e.at).toLocaleTimeString();
    let cls = '';
    let text = '';
    switch (e.type) {
      case 'log':
        cls = 'lvl-' + e.level;
        text = e.msg;
        break;
      case 'queue':
        cls = 'ev';
        text = `🚦 queue ${e.state}`;
        break;
      case 'result':
        cls = e.result.ok ? 'ev' : 'lvl-warn';
        text = `🎯 #${e.code}: ${e.result.status}${e.result.detail ? ' — ' + e.result.detail : ''}`;
        break;
      case 'job':
        cls = 'mut';
        text = `▸ ${e.state.phase}${e.state.code ? ' #' + e.state.code : ''}`;
        break;
      case 'login':
        cls = e.state === 'error' ? 'lvl-error' : 'ev';
        text = `🔐 login ${e.state}${e.detail ? ' — ' + e.detail : ''}`;
        break;
    }
    return { cls, ts, text };
  }

  onMount(() => {
    const es = subscribeEvents((e) => {
      const line = render(e);
      if (!line) return;
      lines.push(line);
      if (lines.length > MAX) lines = lines.slice(-MAX);
      // scroll after DOM updates
      queueMicrotask(() => {
        if (logEl) logEl.scrollTop = logEl.scrollHeight;
      });
    });
    return () => es.close();
  });
</script>

<div id="log" bind:this={logEl}>
  {#each lines as line}
    <div class="line {line.cls}"><span class="ts">{line.ts}</span><span class="msg">{line.text}</span></div>
  {:else}
    <div class="empty">⦿ waiting for activity…</div>
  {/each}
</div>
