import type { DecStr } from './decimal';

export type ISODate = string;

/** Records created by the demonstration seed carry demo: true and are labelled in the UI. */
interface Base {
  id: string;
  createdAt: ISODate;
  demo?: boolean;
  deletedAt?: ISODate | null;
}

export interface Project extends Base {
  code: string; // e.g. "AT", used in revision and batch codes
  name: string;
  objective: string;
  nextRevisionNo: number;
  nextBatchNo: number;
  /** An accord project: its frozen revisions can be used as a single material in other formulas. */
  isAccord?: boolean;
}

export type AmountMode = 'g' | 'pct' | 'parts';

export interface FormulaLine {
  id: string;
  materialId: string | null;
  /** Name exactly as entered or imported. Never translated. */
  materialName: string;
  /** Stock strength as % parent material by mass. null = unknown. "100" = neat. */
  strength: DecStr | null;
  carrier: string | null;
  /** Amount in the revision's amount mode. null = blank (omitted), distinct from "0". */
  amount: DecStr | null;
  costPerKg: DecStr | null;
  currency: string | null;
  note: string;
  /** Unmapped spreadsheet fields preserved from import. */
  extra?: Record<string, string>;
}

export type RevisionStatus = 'draft' | 'frozen';

export interface FormulaRevision extends Base {
  projectId: string;
  code: string; // AT-F003
  number: number;
  parentRevisionId: string | null;
  changeReason: string;
  status: RevisionStatus;
  /** Always as-supplied materials by mass in this MVP. */
  basis: 'as_supplied_mass';
  amountMode: AmountMode;
  lines: FormulaLine[];
  notes: string;
  frozenAt: ISODate | null;
  importId: string | null;
  updatedAt: ISODate;
}

export interface Material extends Base {
  name: string; // trade name, never translated
  grade: string;
  supplier: string;
  cas: string;
  notes: string;
  /** g/mL at room temperature, used only to convert volumes the user enters. null = unknown. */
  density?: DecStr | null;
  /** Set when this material is a frozen accord revision used as an ingredient. */
  accordRevisionId?: string | null;
  /** The user's own maximum, % parent material in the finished product. Not a certified limit. */
  maxPct?: DecStr | null;
  limitSource?: string;
}

export type LotKind = 'supplied' | 'prepared_stock';

export interface Lot extends Base {
  materialId: string;
  kind: LotKind;
  lotCode: string;
  supplier: string;
  /** % parent material by mass. null = unknown. */
  strength: DecStr | null;
  carrier: string | null;
  /** Prepared stock provenance. */
  sourceLotId: string | null;
  sourceMass: DecStr | null;
  carrierMass: DecStr | null;
  costPerKg: DecStr | null;
  currency: string | null;
  /** Whether quantity is tracked. Untracked quantity is "unknown", not zero. */
  tracked: boolean;
  containerCapacity: DecStr | null;
  receivedAt: ISODate | null;
  notes: string;
}

export type TxKind = 'receive' | 'weigh' | 'weigh_correction' | 'prepare_out' | 'prepare_in' | 'adjust';

export interface InventoryTx extends Base {
  lotId: string;
  /** Signed grams of the physical stock as drawn or received. */
  delta: DecStr;
  kind: TxKind;
  /** Deterministic key so retries and resaves never double-decrement. Also used as id. */
  idempotencyKey: string;
  refId: string | null;
  reason: string;
  at: ISODate;
}

export type BatchState = 'in_progress' | 'paused' | 'completed' | 'cancelled';

export interface BatchLine {
  lineId: string;
  materialId: string | null;
  materialName: string;
  strength: DecStr | null;
  carrier: string | null;
  /** Target grams at plan factor 1. Never edited after the batch starts. */
  targetGrams: DecStr;
  plannedLotId: string | null;
  costPerKg: DecStr | null;
  currency: string | null;
  costSource: 'lot' | 'formula' | 'unknown';
}

export interface PlanChange {
  factor: DecStr;
  at: ISODate;
  reason: string;
}

export interface Batch extends Base {
  code: string; // AT-B019
  projectId: string;
  revisionId: string;
  revisionCode: string;
  /** Frozen copy of the revision at batch start. */
  amountMode: AmountMode;
  lines: BatchLine[];
  targetSize: DecStr;
  /** Current scale factor of the physical plan; starts at "1". */
  planFactor: DecStr;
  planHistory: PlanChange[];
  deviationDecision: 'kept_as_weighed' | 'topped_up' | null;
  state: BatchState;
  startedAt: ISODate;
  pausedAt: ISODate | null;
  completedAt: ISODate | null;
  cancelledAt: ISODate | null;
  disposition: string;
  containerCapacity: DecStr | null;
  balanceReadability: DecStr;
  practicalMin: DecStr;
  /** Name of the balance profile used, snapshotted at batch start. */
  balanceName?: string;
  currentLineIndex: number;
  /** As-weighed composition saved at completion (grams of stock per line). */
  asWeighed: Array<{ lineId: string; grams: DecStr }> | null;
  notes: string;
}

export interface WeighEvent extends Base {
  batchId: string;
  lineId: string;
  /** Grams of stock drawn. Corrections are separate events. */
  mass: DecStr;
  lotId: string | null;
  costPerKg: DecStr | null;
  currency: string | null;
  kind: 'addition' | 'correction';
  /** For a correction: the event whose recorded mass was wrong. */
  correctsEventId: string | null;
  reason: string;
  at: ISODate;
}

export interface Sample extends Base {
  code: string; // AT-B019-S1
  batchId: string;
  preparedAt: ISODate;
  /** % of the batch in this sample by mass. null = unknown. "100" = undiluted. */
  batchPercent: DecStr | null;
  diluent: string;
  notes: string;
}

export interface Application extends Base {
  sampleId: string;
  medium: string; // blotter, skin, fabric, other
  appliedAt: ISODate;
  evaluator: string;
  /** Planned checkpoints in minutes after application. */
  checkpoints: number[];
  notes: string;
}

export interface Observation extends Base {
  applicationId: string;
  at: ISODate;
  /** Snapshot of both clocks at the time of the observation. */
  batchAgeMs: number | null;
  elapsedMs: number;
  checkpointMin: number | null;
  text: string;
  intensity: number | null; // optional 0-5
  descriptors: string[];
  /** A correction appends a new observation that supersedes an earlier one; nothing is overwritten. */
  supersedesId?: string | null;
  amendReason?: string;
}

export interface Attachment extends Base {
  materialId: string | null;
  lotId: string | null;
  fileName: string;
  mime: string;
  dataBase64: string;
  source: string;
  docDate: string;
  intendedUse: string;
  reviewState: 'not_reviewed' | 'reviewed' | 'superseded';
}

export interface ImportMapping extends Base {
  name: string;
  headerRow: number;
  columns: Record<string, string>; // header -> field
  convention: 'point' | 'comma';
  amountMode: AmountMode;
}

export interface AuditEntry extends Base {
  entity: string;
  entityId: string;
  action: string;
  detail: string;
  at: ISODate;
}

/** A blind smelling session: evaluators see only random codes until the session is revealed. */
export interface BlindItem {
  code: string;
  sampleId: string;
}

export interface BlindRating {
  id: string;
  code: string;
  evaluator: string;
  intensity: number | null;
  /** 1 (dislike) to 9 (like). null = not given. */
  liking: number | null;
  text: string;
  at: ISODate;
}

export interface BlindSession extends Base {
  name: string;
  medium: string;
  items: BlindItem[];
  ratings: BlindRating[];
  revealedAt: ISODate | null;
  notes: string;
  updatedAt: ISODate;
}

export interface BalanceProfile {
  id: string;
  name: string;
  readability: DecStr;
  practicalMin: DecStr;
  /** Serial settings for reading a connected balance. */
  baudRate: number;
}

export interface Settings {
  id: 'settings';
  locale: string;
  balanceReadability: DecStr;
  practicalMin: DecStr;
  currency: string;
  lastBackupAt: ISODate | null;
  checkpointPresets: number[];
  theme?: 'system' | 'light' | 'dark';
  /** Additional named balances; the readability/practicalMin fields above are the default balance. */
  balances?: BalanceProfile[];
  defaultBalanceName?: string;
  syncFolder?: string | null;
  lastSyncAt?: ISODate | null;
}

export interface DataState {
  projects: Record<string, Project>;
  revisions: Record<string, FormulaRevision>;
  materials: Record<string, Material>;
  lots: Record<string, Lot>;
  inventoryTx: Record<string, InventoryTx>;
  batches: Record<string, Batch>;
  weighEvents: Record<string, WeighEvent>;
  samples: Record<string, Sample>;
  applications: Record<string, Application>;
  observations: Record<string, Observation>;
  attachments: Record<string, Attachment>;
  importMappings: Record<string, ImportMapping>;
  audit: Record<string, AuditEntry>;
  blindSessions: Record<string, BlindSession>;
  settings: Settings;
}

export type StoreName = Exclude<keyof DataState, 'settings'>;
export const STORE_NAMES: StoreName[] = [
  'projects', 'revisions', 'materials', 'lots', 'inventoryTx', 'batches', 'weighEvents',
  'samples', 'applications', 'observations', 'attachments', 'importMappings', 'audit', 'blindSessions',
];

/** A set of records to write atomically. Records are only ever put, never hard-deleted. */
export type Changeset = Partial<{ [K in StoreName]: Array<DataState[K][string]> }> & {
  settings?: Settings;
  /** Hard removal is used only for removing demonstration data. User records are soft-deleted. */
  remove?: Partial<Record<StoreName, string[]>>;
};

export function defaultSettings(): Settings {
  return {
    id: 'settings',
    locale: 'en',
    balanceReadability: '0.001',
    practicalMin: '0.010',
    currency: 'EUR',
    lastBackupAt: null,
    checkpointPresets: [0, 15, 60, 240, 1440],
    theme: 'system',
    balances: [],
    defaultBalanceName: 'Default balance',
    syncFolder: null,
    lastSyncAt: null,
  };
}

export function emptyState(): DataState {
  return {
    projects: {}, revisions: {}, materials: {}, lots: {}, inventoryTx: {}, batches: {},
    weighEvents: {}, samples: {}, applications: {}, observations: {}, attachments: {},
    importMappings: {}, audit: {}, blindSessions: {}, settings: defaultSettings(),
  };
}

export function applyChangeset(state: DataState, cs: Changeset): DataState {
  const next: DataState = { ...state };
  for (const name of STORE_NAMES) {
    const recs = cs[name] as Array<{ id: string }> | undefined;
    if (!recs || recs.length === 0) continue;
    const table = { ...(state[name] as Record<string, unknown>) };
    for (const r of recs) table[r.id] = r;
    (next as unknown as Record<string, unknown>)[name] = table;
  }
  for (const name of STORE_NAMES) {
    const ids = cs.remove?.[name];
    if (!ids || ids.length === 0) continue;
    const table = { ...((next as unknown as Record<string, Record<string, unknown>>)[name]) };
    for (const id of ids) delete table[id];
    (next as unknown as Record<string, unknown>)[name] = table;
  }
  if (cs.settings) next.settings = cs.settings;
  return next;
}

export function mergeChangesets(...sets: Changeset[]): Changeset {
  const out: Changeset = {};
  for (const cs of sets) {
    for (const name of STORE_NAMES) {
      const recs = cs[name] as unknown[] | undefined;
      if (!recs) continue;
      const cur = (out[name] as unknown[] | undefined) ?? [];
      (out as Record<string, unknown[]>)[name] = cur.concat(recs);
    }
    if (cs.remove) {
      out.remove = out.remove ?? {};
      for (const [k, ids] of Object.entries(cs.remove)) {
        out.remove[k as StoreName] = (out.remove[k as StoreName] ?? []).concat(ids ?? []);
      }
    }
    if (cs.settings) out.settings = cs.settings;
  }
  return out;
}
