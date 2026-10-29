import { D, Dec } from './decimal';
import { lineShares } from './formula';
import { composition, deviations } from './batch';
import { supersededIds } from './journal';
import type { Batch, DataState, FormulaLine, FormulaRevision } from './types';

export type DiffStatus = 'added' | 'removed' | 'changed' | 'same';

export interface LineDiff {
  key: string;
  materialName: string;
  status: DiffStatus;
  pctA: Dec | null;
  pctB: Dec | null;
  deltaPp: Dec | null;
  strengthA: string | null | undefined;
  strengthB: string | null | undefined;
  strengthChanged: boolean;
  parentPctA: Dec | null;
  parentPctB: Dec | null;
}

/** Lines match by linked material id (or exact name) plus stock strength is compared separately. */
function keyOf(l: FormulaLine): string {
  return l.materialId ?? `name:${l.materialName.trim()}`;
}

export function diffRevisions(a: FormulaRevision, b: FormulaRevision): LineDiff[] {
  const sa = new Map(lineShares(a).map((s) => [s.lineId, s]));
  const sb = new Map(lineShares(b).map((s) => [s.lineId, s]));
  const mapA = new Map<string, FormulaLine>();
  const mapB = new Map<string, FormulaLine>();
  a.lines.forEach((l) => mapA.set(keyOf(l), l));
  b.lines.forEach((l) => mapB.set(keyOf(l), l));
  const keys = [...new Set([...mapA.keys(), ...mapB.keys()])];
  return keys.map((k) => {
    const la = mapA.get(k);
    const lb = mapB.get(k);
    const pctA = la ? sa.get(la.id)?.pct ?? null : null;
    const pctB = lb ? sb.get(lb.id)?.pct ?? null : null;
    const strengthChanged = !!la && !!lb && la.strength !== lb.strength;
    let status: DiffStatus = 'same';
    if (!la) status = 'added';
    else if (!lb) status = 'removed';
    else if (strengthChanged || !(pctA ?? D(-1)).equals(pctB ?? D(-1))) status = 'changed';
    return {
      key: k,
      materialName: (lb ?? la)!.materialName,
      status,
      pctA, pctB,
      deltaPp: (pctB ?? D(0)).minus(pctA ?? D(0)),
      strengthA: la?.strength, strengthB: lb?.strength, strengthChanged,
      parentPctA: la ? sa.get(la.id)?.parentPct ?? null : null,
      parentPctB: lb ? sb.get(lb.id)?.parentPct ?? null : null,
    };
  });
}

export interface BatchSummary {
  batch: Batch;
  deviationCount: number;
  actualTotal: Dec;
  costByCurrency: Record<string, Dec>;
  costKnown: boolean;
}

export function batchSummaries(state: DataState, revisionId: string): BatchSummary[] {
  return Object.values(state.batches)
    .filter((b) => b.revisionId === revisionId && !b.deletedAt)
    .sort((x, y) => x.startedAt.localeCompare(y.startedAt))
    .map((batch) => {
      const c = composition(state, batch);
      return {
        batch,
        deviationCount: deviations(state, batch, batch.state === 'completed').length,
        actualTotal: c.total,
        costByCurrency: c.costByCurrency,
        costKnown: c.costKnown,
      };
    });
}

export interface ObservationRow {
  side: 'A' | 'B';
  batchCode: string;
  sampleCode: string;
  sampleStrength: string | null;
  diluent: string;
  medium: string;
  evaluator: string;
  batchAgeMs: number | null;
  elapsedMs: number;
  text: string;
  intensity: number | null;
  descriptors: string[];
  demo: boolean;
}

export function observationRows(state: DataState, revisionId: string, side: 'A' | 'B'): ObservationRow[] {
  const batchIds = new Set(Object.values(state.batches).filter((b) => b.revisionId === revisionId).map((b) => b.id));
  const rows: ObservationRow[] = [];
  const replaced = supersededIds(state);
  for (const o of Object.values(state.observations)) {
    if (o.deletedAt || replaced.has(o.id)) continue;
    const app = state.applications[o.applicationId];
    const sample = app && state.samples[app.sampleId];
    if (!sample || !batchIds.has(sample.batchId)) continue;
    const batch = state.batches[sample.batchId];
    rows.push({
      side, batchCode: batch.code, sampleCode: sample.code, sampleStrength: sample.batchPercent, diluent: sample.diluent,
      medium: app.medium, evaluator: app.evaluator, batchAgeMs: o.batchAgeMs, elapsedMs: o.elapsedMs,
      text: o.text, intensity: o.intensity, descriptors: o.descriptors, demo: !!o.demo,
    });
  }
  return rows.sort((x, y) => x.elapsedMs - y.elapsedMs);
}

/** Conditions that differ between two observations, which must stay visible in comparisons. */
export function conditionMismatches(a: ObservationRow, b: ObservationRow): string[] {
  const out: string[] = [];
  const dayA = a.batchAgeMs === null ? null : Math.floor(a.batchAgeMs / 86400000);
  const dayB = b.batchAgeMs === null ? null : Math.floor(b.batchAgeMs / 86400000);
  if (dayA !== dayB) out.push('batch_age');
  if (Math.abs(a.elapsedMs - b.elapsedMs) > 5 * 60000) out.push('elapsed');
  if (a.medium !== b.medium) out.push('medium');
  if (a.sampleStrength !== b.sampleStrength) out.push('sample_strength');
  return out;
}
