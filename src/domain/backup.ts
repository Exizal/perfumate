import { emptyState, STORE_NAMES, defaultSettings, type DataState, type StoreName } from './types';

export const BACKUP_FORMAT = 'micro-batch-lab-journal-backup';
export const SCHEMA_VERSION = 3;

export interface Backup {
  format: typeof BACKUP_FORMAT;
  schemaVersion: number;
  exportedAt: string;
  appVersion: string;
  counts: Record<string, number>;
  stores: Partial<Record<StoreName, unknown[]>>;
  settings: DataState['settings'];
}

/** A complete backup: every store including audit history, stock movements and attachments. */
export function buildBackup(state: DataState, at: string): Backup {
  const stores: Partial<Record<StoreName, unknown[]>> = {};
  const counts: Record<string, number> = {};
  for (const name of STORE_NAMES) {
    const recs = Object.values(state[name]);
    stores[name] = recs;
    counts[name] = recs.length;
  }
  return {
    format: BACKUP_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: at,
    appVersion: '1.0.0',
    counts,
    stores,
    settings: { ...state.settings, lastBackupAt: at },
  };
}

export class BackupError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

/** Schema migrations, applied in order to older backups and older local databases. */
const MIGRATIONS: Record<number, (b: Backup) => Backup> = {
  // v1 -> v2: batches gained asWeighed; settings gained checkpointPresets.
  1: (b) => ({
    ...b,
    schemaVersion: 2,
    stores: {
      ...b.stores,
      batches: (b.stores.batches ?? []).map((x) => ({ asWeighed: null, ...(x as object) })),
    },
    settings: { ...defaultSettings(), ...b.settings },
  }),
  // v2 -> v3: blind sessions store; materials gained density, accord link and user limits (all optional).
  2: (b) => ({ ...b, schemaVersion: 3, stores: { ...b.stores, blindSessions: b.stores.blindSessions ?? [] }, settings: { ...defaultSettings(), ...b.settings } }),
};

export function migrate(b: Backup): Backup {
  let cur = b;
  while (cur.schemaVersion < SCHEMA_VERSION) {
    const step = MIGRATIONS[cur.schemaVersion];
    if (!step) throw new BackupError('no_migration');
    cur = step(cur);
  }
  return cur;
}

export function parseBackup(text: string): Backup {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BackupError('not_json');
  }
  const b = raw as Backup;
  if (!b || b.format !== BACKUP_FORMAT) throw new BackupError('wrong_format');
  if (typeof b.schemaVersion !== 'number') throw new BackupError('wrong_format');
  if (b.schemaVersion > SCHEMA_VERSION) throw new BackupError('newer_version');
  const m = migrate(b);
  for (const name of STORE_NAMES) {
    const recs = m.stores[name];
    if (recs !== undefined && !Array.isArray(recs)) throw new BackupError('corrupt');
    for (const r of recs ?? []) if (!r || typeof (r as { id?: unknown }).id !== 'string') throw new BackupError('corrupt');
  }
  return m;
}

export function backupToState(b: Backup): DataState {
  const s = emptyState();
  for (const name of STORE_NAMES) {
    const table: Record<string, unknown> = {};
    for (const r of b.stores[name] ?? []) table[(r as { id: string }).id] = r;
    (s as unknown as Record<string, unknown>)[name] = table;
  }
  s.settings = { ...defaultSettings(), ...b.settings };
  return s;
}

/** Referential checks run after restore; any dangling link is reported, not silently dropped. */
export function integrityProblems(state: DataState): string[] {
  const p: string[] = [];
  for (const r of Object.values(state.revisions)) {
    if (!state.projects[r.projectId]) p.push(`revision ${r.code}: missing project`);
    if (r.parentRevisionId && !state.revisions[r.parentRevisionId]) p.push(`revision ${r.code}: missing parent`);
  }
  for (const b of Object.values(state.batches)) {
    if (!state.revisions[b.revisionId]) p.push(`batch ${b.code}: missing revision`);
  }
  for (const e of Object.values(state.weighEvents)) if (!state.batches[e.batchId]) p.push(`weigh event ${e.id}: missing batch`);
  for (const s of Object.values(state.samples)) if (!state.batches[s.batchId]) p.push(`sample ${s.code}: missing batch`);
  for (const a of Object.values(state.applications)) if (!state.samples[a.sampleId]) p.push(`application ${a.id}: missing sample`);
  for (const o of Object.values(state.observations)) if (!state.applications[o.applicationId]) p.push(`observation ${o.id}: missing application`);
  for (const t of Object.values(state.inventoryTx)) if (!state.lots[t.lotId]) p.push(`stock movement ${t.id}: missing lot`);
  return p;
}

// ---------- CSV ----------

export function csvCell(v: string | null | undefined, numeric = false): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (!numeric && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r;]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** CSV rows. Numeric columns are written with a decimal point and no grouping. */
export function toCsv(header: string[], rows: Array<Array<{ v: string | null; n?: boolean }>>): string {
  return [header.map((h) => csvCell(h)).join(','), ...rows.map((r) => r.map((c) => csvCell(c.v, c.n)).join(','))].join('\r\n') + '\r\n';
}
