import { events } from "./events.js";
import * as booker from "./booker.js";
import { profileLock } from "./profile.js";
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
    // single-profile mutex: rejects if a job is already running OR a login window is open.
    if (!profileLock.acquire("booking")) {
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
    // fire-and-forget: the route returns immediately; settle updates JobState.
    running = booker
      .run(code, (e) => events.emit(e), ac.signal, creds)
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
        profileLock.release("booking");
        emitJob();
      });

    return { ok: true, state: snapshot() };
  },

  stop(): { stopped: boolean; state: JobState } {
    if (running && abort) {
      abort.abort();
      return { stopped: true, state: snapshot() };
    }
    return { stopped: false, state: snapshot() };
  },
};
