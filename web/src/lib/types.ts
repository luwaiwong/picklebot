export type { BookStatus, BookResult, JobState, JobPhase, LogEvent } from '../../../src/shared/types';

// Frontend-only changelog shape, served as a static /updates.json asset.
export type UpdateTag = 'feature' | 'fix' | 'speed' | 'note';
export interface Update {
  id: string;
  date: string;
  title: string;
  tag?: UpdateTag;
  changes: string[];
}
export interface UpdatesFile {
  updates: Update[];
}
