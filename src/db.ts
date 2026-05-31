import { readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { TargetSchema, type Target } from './shared/types.js';

// JSON-file persistence behind a narrow interface. This is the seam where SQLite could
// drop in later with no caller changes — but for a single-user one-shot bot a file is plenty.
const FILE = process.env.PBALL_TARGETS ?? 'targets.json';

let cache: Target[] | null = null;

async function load(): Promise<Target[]> {
  if (cache) return cache;
  try {
    const raw = await readFile(FILE, 'utf8');
    const arr: unknown = JSON.parse(raw);
    cache = Array.isArray(arr) ? arr.map((t) => TargetSchema.parse(t)) : [];
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') cache = [];
    else throw e;
  }
  return cache;
}

async function persist(ts: Target[]): Promise<void> {
  cache = ts;
  const tmp = `${FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(ts, null, 2)); // atomic: write tmp + rename
  await rename(tmp, FILE);
}

export const db = {
  async init(): Promise<void> {
    await load();
  },
  async list(): Promise<Target[]> {
    return [...(await load())];
  },
  async get(id: string): Promise<Target | undefined> {
    return (await load()).find((t) => t.id === id);
  },
  async create(input: Target): Promise<Target> {
    const ts = await load();
    const t: Target = { ...input, id: input.id ?? randomUUID() };
    await persist([...ts, t]);
    return t;
  },
  async update(id: string, patch: Partial<Target>): Promise<Target> {
    const ts = await load();
    const i = ts.findIndex((t) => t.id === id);
    if (i < 0) throw new Error(`no target ${id}`);
    const next: Target = { ...ts[i]!, ...patch, id };
    const copy = [...ts];
    copy[i] = next;
    await persist(copy);
    return next;
  },
  async remove(id: string): Promise<void> {
    const ts = await load();
    await persist(ts.filter((t) => t.id !== id));
  },
};
