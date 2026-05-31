import { appendFile } from 'node:fs/promises';
import type { LogEvent } from './shared/types.js';

// In-process pub/sub + SSE fan-out. Keeps a ring buffer so a late-connecting UI replays
// recent history, and appends every terminal booking result to a jsonl audit log.
const HISTORY = process.env.PBALL_HISTORY ?? 'bookings.log';
const RING_MAX = 500;

type Sink = (e: LogEvent) => void;

class Bus {
  private ring: LogEvent[] = [];
  private sinks = new Set<Sink>();

  emit(e: LogEvent): void {
    this.ring.push(e);
    if (this.ring.length > RING_MAX) this.ring.shift();
    for (const s of this.sinks) {
      try {
        s(e);
      } catch {
        /* a dead SSE sink must not break the bus */
      }
    }
    if (e.type === 'result') {
      appendFile(HISTORY, JSON.stringify(e) + '\n').catch(() => {});
    }
  }

  log(level: 'info' | 'warn' | 'error', msg: string, targetId?: string): void {
    this.emit({ type: 'log', level, msg, targetId, at: new Date().toISOString() });
    console.log(`[${level}] ${msg}`);
  }

  /** Replays the ring buffer to the new sink, then streams live. Returns an unsubscribe fn. */
  subscribe(sink: Sink): () => void {
    for (const e of this.ring) {
      try {
        sink(e);
      } catch {
        /* ignore */
      }
    }
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }
}

export const events = new Bus();
