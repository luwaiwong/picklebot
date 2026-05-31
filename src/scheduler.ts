import { Cron } from 'croner';
import { db } from './db.js';
import { events } from './events.js';
import * as booker from './booker.js';
import { releaseInstant, fmt } from './timezone.js';
import type { Target } from './shared/types.js';

// One croner job per saved target, fired ONCE at its warmup instant. After the single run
// the record is deleted (one-shot) — the bot never retries the same slot.
const jobs = new Map<string, Cron>();
const iso = () => new Date().toISOString();

/** When the booker launches: warmupSeconds before the (computed) release instant. */
export function fireAt(t: Target): Date {
  const release = releaseInstant(t.sessionStart, t.windowLeadHours);
  return new Date(release.getTime() - t.warmupSeconds * 1000);
}

async function fire(id: string): Promise<void> {
  jobs.delete(id);
  const t = await db.get(id);
  if (!t) return;
  const label = fmt(t.sessionStart);
  events.log('info', `firing "${label}"`, id);
  try {
    await booker.run(t, (e) => events.emit(e));
  } catch (e) {
    events.log('error', `run failed: ${e instanceof Error ? e.message : String(e)}`, id);
  } finally {
    // one-shot: remove after its single run, whatever the outcome. History stays in bookings.log.
    await db.remove(id).catch(() => {});
    events.emit({ type: 'deleted', targetId: id, label, at: iso() });
    events.log('info', `"${label}" ran once and was removed`, id);
  }
}

export const scheduler = {
  schedule(t: Target): void {
    if (!t.id) return;
    this.unschedule(t.id);
    const label = fmt(t.sessionStart);
    const at = fireAt(t);
    const release = releaseInstant(t.sessionStart, t.windowLeadHours);
    if (at.getTime() <= Date.now()) {
      events.log('warn', `"${label}" fire time ${fmt(at)} already passed — not armed`, t.id);
      return;
    }
    const id = t.id;
    jobs.set(
      id,
      new Cron(at, () => {
        void fire(id);
      }),
    );
    events.emit({ type: 'scheduled', targetId: id, label, fireAt: at.toISOString(), release: release.toISOString(), at: iso() });
    events.log('info', `"${label}" armed for ${fmt(at)} (release ${fmt(release)})`, id);
  },

  unschedule(id: string): void {
    jobs.get(id)?.stop();
    jobs.delete(id);
  },

  async reconcile(): Promise<void> {
    for (const t of await db.list()) this.schedule(t);
  },

  /** Manual test run — runs the booker now but KEEPS the record (unlike a scheduled fire). */
  async runNow(id: string): Promise<void> {
    const t = await db.get(id);
    if (!t) return;
    events.log('info', `manual test run "${fmt(t.sessionStart)}" (record kept)`, id);
    await booker.run(t, (e) => events.emit(e));
  },

  armedCount(): number {
    return jobs.size;
  },

  nextFireAt(): string | null {
    let min: number | null = null;
    for (const c of jobs.values()) {
      const n = c.nextRun();
      if (n && (min === null || n.getTime() < min)) min = n.getTime();
    }
    return min === null ? null : new Date(min).toISOString();
  },
};
