import type { Target, LogEvent } from '../../../src/shared/types';

export type { Target, LogEvent };

// GET /api/targets augments each Target with fireAt (ISO string).
export type TargetRow = Target & { fireAt: string };

// GET /api/health response shape.
export type Health = { uptimeSec: number; armed: number; nextFireAt: string | null };

// GET /api/filters response — picker options sourced live from the Markham widget.
export type FilterOption = { value: string; name: string };
export type WidgetFilters = { activities: FilterOption[]; locations: FilterOption[] };
