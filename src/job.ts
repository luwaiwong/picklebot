import { events } from "./events.js";
import * as booker from "./booker.js";
import type { Creds } from "./auth.js";
import type { JobState } from "./shared/types.js";

// Single active job manager. The bot runs ONE book-by-code job at a time; a second start()
// while running is rejected (busy). The booker emits its own log/queue/result events; this
// manager owns only the high-level JobState (phase + last outcome) and broadcasts it.
const iso = () => new Date().toISOString();

const state: JobState = {
  phase: "idle",
  code: null,
  startedAt: null,
  finishedAt: null,
  lastStatus: null,
  lastDetail: null,
};

let running: Promise<void> | null = null;
let abort: AbortController | null = null;

function snapshot(): JobState {
  return { ...state };
}

function emitJob(): void {
  events.emit({ type: "job", state: snapshot(), at: iso() });
}

export const jobManager = {
  snapshot,

  start(
    code: string,
    creds: Creds,
  ): { ok: boolean; busy?: boolean; state: JobState } {
    if (running) {
      return { ok: false, busy: true, state: snapshot() };
    }
    state.phase = "running";
    state.code = code;
    state.startedAt = iso();
    state.finishedAt = null;
    state.lastStatus = null;
    state.lastDetail = null;
    abort = new AbortController();
    emitJob();

    const ac = abort;
    // Spin up PBALL_WINDOWS independent windows (each its own profile/session → its own Queue-it
    // position) racing for the same code; the first to book wins. Defaults to 4; set 1 for the
    // classic single-window run. runRace short-circuits to a plain run() when windows === 1.
    const windows = Number(process.env.PBALL_WINDOWS ?? "4");
    // fire-and-forget: the route returns immediately; settle updates JobState.
    running = booker
      .runRace(code, (e) => events.emit(e), ac.signal, creds, windows)
      .then(
        (result) => {
          state.phase = result.ok ? "success" : "failed";
          state.lastStatus = result.status;
          state.lastDetail = result.detail ?? null;
        },
        (err) => {
          state.phase = "failed";
          state.lastStatus = "error";
          state.lastDetail = err instanceof Error ? err.message : String(err);
        },
      )
      .finally(() => {
        state.finishedAt = iso();
        running = null;
        abort = null;
        emitJob();
      });

    return { ok: true, state: snapshot() };
  },

  stop(): { stopped: boolean; state: JobState } {
    if (running && abort) {
      abort.abort();
      // force the browser closed too: cooperative abort only fires at our own checkpoints, so a
      // long in-flight Playwright op (e.g. a 20s waitFor) would otherwise freeze until it times
      // out. Closing the context makes that op reject immediately → instant cancel.
      void booker.closeActive();
      return { stopped: true, state: snapshot() };
    }
    return { stopped: false, state: snapshot() };
  },
};
