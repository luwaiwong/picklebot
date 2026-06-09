<script lang="ts">
    import type { Update, UpdatesFile } from "./types";
    // Changelog is bundled at build time — fully frontend, no server fetch.
    import updatesData from "./updates.json";

    // Shows only the latest entry as a bottom-right panel. No persistence — it surfaces
    // on each load; closing dismisses it for the session.
    const latest: Update | null =
        (updatesData as UpdatesFile).updates[0] ?? null;
    let open = $state(latest !== null);

    const TAG_LABEL: Record<string, string> = {
        feature: "new",
        fix: "fix",
        speed: "speed",
        note: "note",
    };

    function close() {
        open = false;
    }
</script>

{#if latest}
    {#if open}
        <aside class="upd" aria-label="What's new">
            <button class="x" onclick={close} aria-label="Dismiss update"
                >✕</button
            >
            <div class="head">
                <span class="kicker">Updates</span>
                <!-- {#if latest.tag}<span class="tag {latest.tag}"
                        >{TAG_LABEL[latest.tag] ?? latest.tag}</span
                    >{/if} -->
            </div>
            <h3 class="title">{latest.title}</h3>
            <time class="date">{latest.date}</time>
            <ul class="changes">
                {#each latest.changes as change}
                    <li>{change}</li>
                {/each}
            </ul>
        </aside>
    {/if}
{/if}

<style>
    .upd {
        position: fixed;
        bottom: 18px;
        right: 18px;
        z-index: 40;
        width: 320px;
        max-width: calc(100vw - 36px);
        padding: 16px 16px 18px;
        background: var(--surface);
        border: 1px solid var(--line);
        border-radius: var(--r);
        box-shadow: var(--shadow);
        animation: upd-in 0.26s cubic-bezier(0.22, 1, 0.36, 1);
    }
    @keyframes upd-in {
        from {
            opacity: 0;
            transform: translateX(14px);
        }
        to {
            opacity: 1;
            transform: translateX(0);
        }
    }

    .x {
        position: absolute;
        top: 9px;
        right: 9px;
        width: 24px;
        height: 24px;
        padding: 0;
        display: grid;
        place-items: center;
        background: transparent;
        border: 1px solid transparent;
        border-radius: var(--r-sm);
        color: var(--faint);
        font-size: 12px;
        transition:
            color 0.14s,
            border-color 0.14s,
            background 0.14s;
    }
    .x:hover {
        color: var(--fg);
        border-color: var(--line-2);
        background: var(--surface-2);
        filter: none;
    }

    .head {
        display: flex;
        align-items: center;
        gap: 9px;
        margin-bottom: 10px;
    }
    .kicker {
        font: 600 11px/1 var(--sans);
        text-transform: uppercase;
        letter-spacing: 0.13em;
        color: var(--mut);
    }
    .tag {
        font: 600 10px/1 var(--mono);
        text-transform: uppercase;
        letter-spacing: 0.06em;
        padding: 4px 7px;
        border-radius: 999px;
        border: 1px solid var(--acc-line);
        background: var(--acc-soft);
        color: var(--acc);
    }
    .tag.fix {
        border-color: rgba(235, 203, 139, 0.4);
        background: rgba(235, 203, 139, 0.12);
        color: var(--warn);
    }
    .tag.note {
        border-color: var(--line-2);
        background: var(--surface-2);
        color: var(--mut);
    }

    .title {
        margin: 0;
        font: 600 15px/1.3 var(--sans);
        color: var(--fg);
    }
    .date {
        display: block;
        margin-top: 3px;
        font: 500 11px/1 var(--mono);
        color: var(--faint);
    }

    .changes {
        margin: 12px 0 0;
        padding: 0;
        list-style: none;
        display: flex;
        flex-direction: column;
        gap: 9px;
    }
    .changes li {
        position: relative;
        padding-left: 16px;
        font-size: 12.5px;
        line-height: 1.5;
        color: var(--mut);
    }
    .changes li::before {
        content: "";
        position: absolute;
        left: 2px;
        top: 8px;
        width: 5px;
        height: 5px;
        border-radius: 50%;
        background: var(--acc);
    }

    @media (max-width: 600px) {
        .upd {
            top: auto;
            bottom: 14px;
            right: 14px;
            left: 14px;
            width: auto;
            max-width: none;
        }
    }
</style>
