import { STORE_NAMES, type Batch, type Changeset, type DataState, type Project, type StoreName } from './types';

export interface MergeResult {
  cs: Changeset;
  added: Partial<Record<StoreName, number>>;
  updated: number;
  /** Records that differ on both sides and were left as they are on this device. */
  conflicts: Array<{ store: StoreName; id: string; label: string }>;
  /** Human codes that now exist twice (e.g. two devices both created AT-F004). */
  duplicateCodes: string[];
}

const TERMINAL = new Set(['completed', 'cancelled']);

function label(rec: Record<string, unknown>): string {
  return String(rec.code ?? rec.name ?? rec.lotCode ?? rec.id);
}

/**
 * Merge records from another device or backup into this one. Nothing local is deleted.
 * New records are added. A record that exists on both sides is replaced only when the
 * incoming copy is unambiguously newer (later updatedAt, or a batch that has since been
 * completed or cancelled); otherwise the local copy is kept and the record is reported.
 */
export function mergeStates(local: DataState, incoming: DataState): MergeResult {
  const cs: Changeset = {};
  const added: MergeResult['added'] = {};
  const conflicts: MergeResult['conflicts'] = [];
  let updated = 0;
  const put = (name: StoreName, rec: unknown) => {
    const bag = cs as Record<string, unknown[]>;
    (bag[name] ??= []).push(rec);
  };

  for (const name of STORE_NAMES) {
    const mine = local[name] as unknown as Record<string, Record<string, unknown>>;
    for (const rec of Object.values(incoming[name] as unknown as Record<string, Record<string, unknown>>)) {
      const cur = mine[rec.id as string];
      if (!cur) { put(name, rec); added[name] = (added[name] ?? 0) + 1; continue; }
      if (JSON.stringify(cur) === JSON.stringify(rec)) continue;
      if (name === 'projects') {
        // Counters only move forward so codes are never reissued on either device.
        const a = cur as unknown as Project, b = rec as unknown as Project;
        const next = { ...a, nextRevisionNo: Math.max(a.nextRevisionNo, b.nextRevisionNo), nextBatchNo: Math.max(a.nextBatchNo, b.nextBatchNo) };
        if (next.nextRevisionNo !== a.nextRevisionNo || next.nextBatchNo !== a.nextBatchNo) { put(name, next); updated++; }
        if (a.name !== b.name || a.objective !== b.objective || !!a.deletedAt !== !!b.deletedAt) conflicts.push({ store: name, id: a.id, label: label(cur) });
        continue;
      }
      if (name === 'batches') {
        const a = cur as unknown as Batch, b = rec as unknown as Batch;
        if (!TERMINAL.has(a.state) && TERMINAL.has(b.state)) { put(name, rec); updated++; }
        else if (!(TERMINAL.has(a.state) && !TERMINAL.has(b.state))) conflicts.push({ store: name, id: a.id, label: label(cur) });
        continue;
      }
      const ua = cur.updatedAt as string | undefined, ub = rec.updatedAt as string | undefined;
      if (ua && ub) {
        if (ub > ua) { put(name, rec); updated++; }
        continue;
      }
      conflicts.push({ store: name, id: rec.id as string, label: label(cur) });
    }
  }

  const codes = new Map<string, number>();
  const count = (c: string) => codes.set(c, (codes.get(c) ?? 0) + 1);
  for (const p of Object.values({ ...local.projects, ...incoming.projects })) if (!p.deletedAt) count(`project ${p.code}`);
  for (const r of Object.values({ ...local.revisions, ...incoming.revisions })) count(r.code);
  for (const b of Object.values({ ...local.batches, ...incoming.batches })) count(b.code);
  const duplicateCodes = [...codes].filter(([, n]) => n > 1).map(([c]) => c);

  return { cs, added, updated, conflicts, duplicateCodes };
}
