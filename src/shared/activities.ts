// Activity GUIDs for the Markham PerfectMind widget. Kept in a zero-dep module so the
// web client can import them without pulling zod (TargetSchema) into the browser bundle.
export const ACTIVITY_IDS = {
  ADULTS: '6326206c-e5ad-44d3-8a68-444c44a3eba3', // "Drop-In Pickleball: Adults"
  ADULT_AND_CHILD: '28c934e6-f278-4a2f-a8eb-24c5ebb1019e', // "Drop-In Pickleball: Adult and Child"
} as const;
