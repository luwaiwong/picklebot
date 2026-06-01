export type { BookStatus, BookResult, JobState, JobPhase, LogEvent } from '../../../src/shared/types';
import type { JobState } from '../../../src/shared/types';

// GET /api/health response shape.
export type Health = { uptimeSec: number; job: JobState };
