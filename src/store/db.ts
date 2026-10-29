import { openDB, type IDBPDatabase } from 'idb';
import { SCHEMA_VERSION } from '../domain/backup';
import { defaultSettings, emptyState, STORE_NAMES, type Changeset, type DataState, type Settings } from '../domain/types';

export const DB_NAME = 'micro-batch-lab-journal';

export type DB = IDBPDatabase<unknown>;

/**
 * IndexedDB persistence. Every changeset is written in one transaction across all touched
 * stores, so a partial write cannot happen. Schema upgrades run in onupgradeneeded.
 */
export async function openDatabase(name = DB_NAME): Promise<DB> {
  return openDB(name, SCHEMA_VERSION, {
    upgrade(db, oldVersion, _newVersion, tx) {
      for (const s of [...STORE_NAMES, 'meta']) {
        if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
      }
      if (oldVersion > 0 && oldVersion < 2) {
        // v1 -> v2: batches gained asWeighed.
        const store = tx.objectStore('batches');
        void store.openCursor().then(async function walk(cur): Promise<void> {
          if (!cur) return;
          const v = cur.value as Record<string, unknown>;
          if (!('asWeighed' in v)) await cur.update({ ...v, asWeighed: null });
          return walk(await cur.continue());
        });
      }
    },
  });
}

export async function loadAll(db: DB): Promise<DataState> {
  const state = emptyState();
  const tx = db.transaction([...STORE_NAMES, 'meta'], 'readonly');
  for (const name of STORE_NAMES) {
    const recs = (await tx.objectStore(name).getAll()) as Array<{ id: string }>;
    const table: Record<string, unknown> = {};
    for (const r of recs) table[r.id] = r;
    (state as unknown as Record<string, unknown>)[name] = table;
  }
  const settings = (await tx.objectStore('meta').get('settings')) as Settings | undefined;
  state.settings = { ...defaultSettings(), ...(settings ?? {}) };
  await tx.done;
  return state;
}

export async function commit(db: DB, cs: Changeset): Promise<void> {
  const names = STORE_NAMES.filter((n) => (cs[n] as unknown[] | undefined)?.length || cs.remove?.[n]?.length);
  const all = cs.settings ? [...names, 'meta'] : names;
  if (all.length === 0) return;
  const tx = db.transaction(all, 'readwrite');
  const ops: Promise<unknown>[] = [];
  for (const n of names) {
    const store = tx.objectStore(n);
    for (const r of (cs[n] as unknown[] | undefined) ?? []) ops.push(store.put(r));
    for (const id of cs.remove?.[n] ?? []) ops.push(store.delete(id));
  }
  if (cs.settings) ops.push(tx.objectStore('meta').put(cs.settings));
  await Promise.all(ops);
  await tx.done;
}

/** Replace the whole database (used by restore). One transaction: all or nothing. */
export async function replaceAll(db: DB, state: DataState): Promise<void> {
  const tx = db.transaction([...STORE_NAMES, 'meta'], 'readwrite');
  const ops: Promise<unknown>[] = [];
  for (const n of STORE_NAMES) {
    const store = tx.objectStore(n);
    ops.push(store.clear());
    for (const r of Object.values(state[n])) ops.push(store.put(r));
  }
  ops.push(tx.objectStore('meta').put(state.settings));
  await Promise.all(ops);
  await tx.done;
}
