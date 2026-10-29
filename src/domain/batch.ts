import { D, Dec, canon, sum, type DecStr } from './decimal';
import { planBatch, parentEquivalent } from './formula';
import { batchCode, nowISO, uid } from './ids';
import type {
  AuditEntry, Batch, BatchLine, Changeset, DataState, InventoryTx, Settings, WeighEvent,
} from './types';

export class DomainError extends Error {
  constructor(public code: string, message?: string) {
    super(message ?? code);
  }
}

export function audit(entity: string, entityId: string, action: string, detail: string, at = nowISO()): AuditEntry {
  return { id: uid('audit'), createdAt: at, entity, entityId, action, detail, at };
}

export interface StartBatchInput {
  revisionId: string;
  size: DecStr;
  lotSelections: Record<string, string | null>;
  containerCapacity: DecStr | null;
  /** Named balance profile; omitted = the default balance in settings. */
  balanceId?: string | null;
  at?: string;
}

/** The default balance comes from settings; named profiles are listed in settings.balances. */
export function balanceFor(settings: Settings, balanceId: string | null): { name: string; balanceReadability: string; practicalMin: string; baudRate: number } {
  const p = balanceId ? settings.balances?.find((b) => b.id === balanceId) : undefined;
  if (p) return { name: p.name, balanceReadability: p.readability, practicalMin: p.practicalMin, baudRate: p.baudRate };
  return { name: settings.defaultBalanceName || 'Default balance', balanceReadability: settings.balanceReadability, practicalMin: settings.practicalMin, baudRate: 9600 };
}

/** Start a batch: freezes the source revision's lines, stock strengths and cost snapshot. */
export function startBatch(state: DataState, input: StartBatchInput): Changeset & { batch: Batch } {
  const rev = state.revisions[input.revisionId];
  if (!rev) throw new DomainError('not_found');
  if (rev.status !== 'frozen') throw new DomainError('revision_not_frozen');
  const project = state.projects[rev.projectId];
  if (!project) throw new DomainError('not_found');
  if (!D(input.size).greaterThan(0)) throw new DomainError('invalid_size');
  const s = balanceFor(state.settings, input.balanceId ?? null);
  const plan = planBatch(rev, input.size, s.practicalMin, s.balanceReadability);
  if (plan.error) throw new DomainError(plan.error);
  const at = input.at ?? nowISO();
  const lines: BatchLine[] = plan.lines.map((p) => {
    const fl = rev.lines.find((l) => l.id === p.lineId)!;
    const lotId = input.lotSelections[p.lineId] ?? null;
    const lot = lotId ? state.lots[lotId] : null;
    let costPerKg: string | null = null;
    let currency: string | null = null;
    let costSource: BatchLine['costSource'] = 'unknown';
    if (lot && lot.costPerKg !== null) {
      costPerKg = lot.costPerKg; currency = lot.currency; costSource = 'lot';
    } else if (fl.costPerKg !== null) {
      costPerKg = fl.costPerKg; currency = fl.currency; costSource = 'formula';
    }
    return {
      lineId: fl.id,
      materialId: fl.materialId,
      materialName: fl.materialName,
      strength: fl.strength,
      carrier: fl.carrier,
      targetGrams: canon(p.targetGrams),
      plannedLotId: lotId,
      costPerKg, currency, costSource,
    };
  });
  const batch: Batch = {
    id: uid('batch'),
    createdAt: at,
    code: batchCode(project.code, project.nextBatchNo),
    projectId: project.id,
    revisionId: rev.id,
    revisionCode: rev.code,
    amountMode: rev.amountMode,
    lines,
    targetSize: canon(D(input.size)),
    planFactor: '1',
    planHistory: [{ factor: '1', at, reason: 'initial' }],
    deviationDecision: null,
    state: 'in_progress',
    startedAt: at,
    pausedAt: null,
    completedAt: null,
    cancelledAt: null,
    disposition: '',
    containerCapacity: input.containerCapacity,
    balanceReadability: s.balanceReadability,
    practicalMin: s.practicalMin,
    balanceName: s.name,
    currentLineIndex: 0,
    asWeighed: null,
    notes: '',
  };
  return {
    batch,
    batches: [batch],
    projects: [{ ...project, nextBatchNo: project.nextBatchNo + 1 }],
    audit: [audit('batch', batch.id, 'start', `${batch.code} from ${rev.code}, ${batch.targetSize} g`, at)],
  };
}

function eventsFor(state: DataState, batchId: string): WeighEvent[] {
  return Object.values(state.weighEvents)
    .filter((e) => e.batchId === batchId)
    .sort((a, b) => a.at.localeCompare(b.at));
}

export function batchEvents(state: DataState, batchId: string): WeighEvent[] {
  return eventsFor(state, batchId);
}

/** Actual grams of stock added per line, including append-only corrections. */
export function actualByLine(state: DataState, batchId: string): Record<string, Dec> {
  const out: Record<string, Dec> = {};
  for (const e of eventsFor(state, batchId)) {
    out[e.lineId] = (out[e.lineId] ?? D(0)).plus(D(e.mass));
  }
  return out;
}

export function currentTarget(batch: Batch, line: BatchLine): Dec {
  return D(line.targetGrams).times(D(batch.planFactor));
}

export interface RecordInput {
  batchId: string;
  lineId: string;
  mass: DecStr;
  lotId: string | null;
  /** Client-generated once per entry; retries with the same key are no-ops. */
  idempotencyKey: string;
  /** How the mass was obtained when not typed in grams, e.g. a balance reading or a converted volume. */
  note?: string;
  at?: string;
}

/** Record a confirmed physical addition. Appends a weigh event and one inventory draw. */
export function recordAddition(state: DataState, input: RecordInput): Changeset {
  if (state.weighEvents[input.idempotencyKey]) return {}; // already recorded: no duplicate
  const batch = state.batches[input.batchId];
  if (!batch) throw new DomainError('not_found');
  if (batch.state === 'completed' || batch.state === 'cancelled') throw new DomainError('batch_locked');
  if (batch.state === 'paused') throw new DomainError('batch_paused');
  const line = batch.lines.find((l) => l.lineId === input.lineId);
  if (!line) throw new DomainError('line_not_found');
  const m = D(input.mass);
  if (!m.greaterThan(0)) throw new DomainError('invalid_mass');
  const at = input.at ?? nowISO();
  const lot = input.lotId ? state.lots[input.lotId] : null;
  const costPerKg = lot && lot.costPerKg !== null ? lot.costPerKg : line.costPerKg;
  const currency = lot && lot.costPerKg !== null ? lot.currency : line.currency;
  const ev: WeighEvent = {
    id: input.idempotencyKey,
    createdAt: at,
    batchId: batch.id,
    lineId: line.lineId,
    mass: canon(m),
    lotId: input.lotId,
    costPerKg, currency,
    kind: 'addition',
    correctsEventId: null,
    reason: input.note ?? '',
    at,
    demo: batch.demo,
  };
  const cs: Changeset = { weighEvents: [ev] };
  if (input.lotId) {
    const tx: InventoryTx = {
      id: `tx_${ev.id}`,
      createdAt: at,
      lotId: input.lotId,
      delta: canon(m.negated()),
      kind: 'weigh',
      idempotencyKey: `tx_${ev.id}`,
      refId: ev.id,
      reason: `${batch.code} ${line.materialName}`,
      at,
      demo: batch.demo,
    };
    cs.inventoryTx = [tx];
  }
  return cs;
}

/**
 * Correct a recording error (e.g. a typo). This is not a physical removal: the original
 * event stays, and an offsetting correction event with a reason is appended.
 */
export function recordCorrection(
  state: DataState,
  input: { eventId: string; correctMass: DecStr; reason: string; idempotencyKey: string; at?: string },
): Changeset {
  if (state.weighEvents[input.idempotencyKey]) return {};
  const orig = state.weighEvents[input.eventId];
  if (!orig) throw new DomainError('not_found');
  if (!input.reason.trim()) throw new DomainError('reason_required');
  const batch = state.batches[orig.batchId];
  if (batch.state === 'completed' || batch.state === 'cancelled') throw new DomainError('batch_locked');
  const delta = D(input.correctMass).minus(D(orig.mass));
  if (delta.isZero()) return {};
  if (D(input.correctMass).isNegative()) throw new DomainError('invalid_mass');
  const at = input.at ?? nowISO();
  const ev: WeighEvent = {
    ...orig,
    id: input.idempotencyKey,
    createdAt: at,
    mass: canon(delta),
    kind: 'correction',
    correctsEventId: orig.id,
    reason: input.reason,
    at,
  };
  const cs: Changeset = {
    weighEvents: [ev],
    audit: [audit('batch', batch.id, 'correction', `${orig.mass} g -> ${input.correctMass} g: ${input.reason}`, at)],
  };
  if (orig.lotId) {
    cs.inventoryTx = [{
      id: `tx_${ev.id}`, createdAt: at, lotId: orig.lotId, delta: canon(delta.negated()),
      kind: 'weigh_correction', idempotencyKey: `tx_${ev.id}`, refId: ev.id, reason: input.reason, at,
    }];
  }
  return cs;
}

export interface Deviation {
  lineId: string;
  materialName: string;
  target: Dec;
  actual: Dec;
  kind: 'over' | 'under' | 'unplanned';
}

/**
 * A difference smaller than half the balance readability cannot be resolved by the balance
 * (e.g. 1.414 g weighed against an exact 1.4136 g target on a 0.001 g balance).
 * The exact difference is still kept in the record.
 */
export function weighTolerance(batch: Batch): Dec {
  return D(batch.balanceReadability).dividedBy(2);
}

export type LineStatus = 'pending' | 'partial' | 'done' | 'over';

export function lineStatus(batch: Batch, target: Dec, actual: Dec): LineStatus {
  const tol = weighTolerance(batch);
  if (actual.isZero()) return target.isZero() ? 'done' : 'pending';
  if (actual.greaterThan(target.plus(tol))) return 'over';
  if (actual.lessThan(target.minus(tol))) return 'partial';
  return 'done';
}

export function deviations(state: DataState, batch: Batch, includeUnder: boolean): Deviation[] {
  const act = actualByLine(state, batch.id);
  const out: Deviation[] = [];
  for (const l of batch.lines) {
    const t = currentTarget(batch, l);
    const a = act[l.lineId] ?? D(0);
    const st = lineStatus(batch, t, a);
    if (t.isZero() && a.greaterThan(0)) out.push({ lineId: l.lineId, materialName: l.materialName, target: t, actual: a, kind: 'unplanned' });
    else if (st === 'over') out.push({ lineId: l.lineId, materialName: l.materialName, target: t, actual: a, kind: 'over' });
    else if (includeUnder && (st === 'partial' || st === 'pending')) out.push({ lineId: l.lineId, materialName: l.materialName, target: t, actual: a, kind: 'under' });
  }
  return out;
}

export interface TopUpLine {
  lineId: string;
  materialName: string;
  originalTarget: Dec;
  newTarget: Dec;
  alreadyAdded: Dec;
  stillNeeded: Dec;
  lotId: string | null;
  available: Dec | null;
  stockShort: boolean;
}

export interface TopUpPreview {
  minFactor: Dec;
  factor: Dec;
  newSize: Dec;
  lines: TopUpLine[];
  unrepairable: string[];
  capacityExceeded: boolean;
}

/**
 * Proportional top-up plan. The factor must be at least the largest actual/target ratio of
 * any line already added. Only non-negative additional quantities are presented.
 */
export function topUpPreview(state: DataState, batch: Batch, requestedFactor?: DecStr): TopUpPreview {
  const act = actualByLine(state, batch.id);
  let minFactor = D(batch.planFactor);
  const unrepairable: string[] = [];
  for (const l of batch.lines) {
    const a = act[l.lineId] ?? D(0);
    const t0 = D(l.targetGrams);
    if (a.isZero()) continue;
    if (t0.isZero()) { unrepairable.push(l.materialName); continue; }
    const r = a.dividedBy(t0);
    if (r.greaterThan(minFactor)) minFactor = r;
  }
  let factor = minFactor;
  if (requestedFactor && D(requestedFactor).greaterThan(minFactor)) factor = D(requestedFactor);
  const lines = batch.lines.map<TopUpLine>((l) => {
    const a = act[l.lineId] ?? D(0);
    const newTarget = D(l.targetGrams).times(factor);
    const need = Dec.max(newTarget.minus(a), 0);
    const available = l.plannedLotId ? lotAvailable(state, l.plannedLotId, batch.id) : null;
    return {
      lineId: l.lineId, materialName: l.materialName, originalTarget: D(l.targetGrams), newTarget,
      alreadyAdded: a, stillNeeded: need, lotId: l.plannedLotId, available,
      stockShort: available !== null && available.lessThan(need),
    };
  });
  const newSize = D(batch.targetSize).times(factor);
  return {
    minFactor, factor, newSize, lines, unrepairable,
    capacityExceeded: batch.containerCapacity !== null && newSize.greaterThan(D(batch.containerCapacity)),
  };
}

/** Apply an approved top-up plan. The original targets stay unchanged; only the factor moves. */
export function applyTopUp(state: DataState, batchId: string, factor: DecStr, at = nowISO()): Changeset {
  const batch = state.batches[batchId];
  if (batch.state === 'completed' || batch.state === 'cancelled') throw new DomainError('batch_locked');
  const p = topUpPreview(state, batch, factor);
  if (p.unrepairable.length) throw new DomainError('unrepairable');
  if (D(factor).lessThan(p.minFactor)) throw new DomainError('factor_too_small');
  const f = canon(p.factor);
  const next: Batch = {
    ...batch,
    planFactor: f,
    planHistory: [...batch.planHistory, { factor: f, at, reason: 'proportional top-up approved' }],
    deviationDecision: 'topped_up',
  };
  return {
    batches: [next],
    audit: [audit('batch', batch.id, 'top_up', `plan x${f}, new size ${canon(p.newSize)} g`, at)],
  };
}

export function keepAsWeighed(state: DataState, batchId: string, at = nowISO()): Changeset {
  const batch = state.batches[batchId];
  if (batch.state === 'completed' || batch.state === 'cancelled') throw new DomainError('batch_locked');
  return {
    batches: [{ ...batch, deviationDecision: 'kept_as_weighed' }],
    audit: [audit('batch', batch.id, 'keep_as_weighed', 'deviation kept as weighed', at)],
  };
}

export function setPaused(state: DataState, batchId: string, paused: boolean, at = nowISO()): Changeset {
  const batch = state.batches[batchId];
  if (batch.state === 'completed' || batch.state === 'cancelled') throw new DomainError('batch_locked');
  return {
    batches: [{ ...batch, state: paused ? 'paused' : 'in_progress', pausedAt: paused ? at : null }],
    audit: [audit('batch', batch.id, paused ? 'pause' : 'resume', '', at)],
  };
}

export function setCurrentLine(state: DataState, batchId: string, index: number): Changeset {
  const batch = state.batches[batchId];
  if (batch.state === 'completed' || batch.state === 'cancelled') return {};
  return { batches: [{ ...batch, currentLineIndex: index }] };
}

/** Complete a batch: saves the as-weighed composition. Consumption was recorded per addition. */
export function completeBatch(state: DataState, batchId: string, at = nowISO()): Changeset {
  const batch = state.batches[batchId];
  if (batch.state === 'completed' || batch.state === 'cancelled') throw new DomainError('batch_locked');
  const act = actualByLine(state, batch.id);
  if (Object.values(act).every((v) => v.isZero())) throw new DomainError('nothing_weighed');
  const devs = deviations(state, batch, false);
  const decision = devs.length && batch.deviationDecision === null ? 'kept_as_weighed' : batch.deviationDecision;
  const next: Batch = {
    ...batch,
    state: 'completed',
    completedAt: at,
    pausedAt: null,
    deviationDecision: decision,
    asWeighed: batch.lines.map((l) => ({ lineId: l.lineId, grams: canon(act[l.lineId] ?? D(0)) })),
  };
  return { batches: [next], audit: [audit('batch', batch.id, 'complete', `as weighed ${canon(batchActualTotal(state, batch))} g`, at)] };
}

/** Cancel: consumption stays recorded; poured material is not returned to its source bottle. */
export function cancelBatch(state: DataState, batchId: string, disposition: string, at = nowISO()): Changeset {
  const batch = state.batches[batchId];
  if (batch.state === 'completed' || batch.state === 'cancelled') throw new DomainError('batch_locked');
  if (!disposition.trim()) throw new DomainError('reason_required');
  return {
    batches: [{ ...batch, state: 'cancelled', cancelledAt: at, disposition }],
    audit: [audit('batch', batch.id, 'cancel', disposition, at)],
  };
}

export function batchActualTotal(state: DataState, batch: Batch): Dec {
  return sum(Object.values(actualByLine(state, batch.id)));
}

export interface CompositionLine {
  lineId: string;
  materialName: string;
  strength: DecStr | null;
  originalTarget: Dec;
  currentTarget: Dec;
  actual: Dec;
  actualPct: Dec | null;
  parentGrams: Dec | null;
  cost: Dec | null;
  currency: string | null;
}

export interface Composition {
  lines: CompositionLine[];
  total: Dec;
  /** Known cost by currency; costKnown false when any weighed line lacks a cost. */
  costByCurrency: Record<string, Dec>;
  costKnown: boolean;
}

export function composition(state: DataState, batch: Batch): Composition {
  const events = eventsFor(state, batch.id);
  const act = actualByLine(state, batch.id);
  const total = sum(Object.values(act));
  const costByCurrency: Record<string, Dec> = {};
  let costKnown = true;
  const lineCost: Record<string, Dec | null> = {};
  const lineCur: Record<string, string | null> = {};
  for (const e of events) {
    if (e.costPerKg === null || !e.currency) {
      costKnown = false; lineCost[e.lineId] = null; continue;
    }
    const c = D(e.mass).times(D(e.costPerKg)).dividedBy(1000);
    costByCurrency[e.currency] = (costByCurrency[e.currency] ?? D(0)).plus(c);
    if (lineCost[e.lineId] !== null) lineCost[e.lineId] = (lineCost[e.lineId] ?? D(0)).plus(c);
    lineCur[e.lineId] = e.currency;
  }
  return {
    total,
    costByCurrency,
    costKnown,
    lines: batch.lines.map((l) => {
      const a = act[l.lineId] ?? D(0);
      return {
        lineId: l.lineId,
        materialName: l.materialName,
        strength: l.strength,
        originalTarget: D(l.targetGrams),
        currentTarget: currentTarget(batch, l),
        actual: a,
        actualPct: total.isZero() ? null : a.dividedBy(total).times(100),
        parentGrams: parentEquivalent(a, l.strength),
        cost: a.isZero() ? D(0) : (lineCost[l.lineId] ?? null),
        currency: lineCur[l.lineId] ?? l.currency,
      };
    }),
  };
}

/** Lot quantity in grams from its transaction ledger. Untracked lots are unknown (null), never zero. */
export function lotBalance(state: DataState, lotId: string): Dec | null {
  const lot = state.lots[lotId];
  if (!lot || !lot.tracked) return null;
  return sum(Object.values(state.inventoryTx).filter((t) => t.lotId === lotId).map((t) => t.delta));
}

/**
 * Stock reserved by open batches: for every in-progress or paused batch line planned from this
 * lot, the part of its current target not yet drawn from that lot. Reservations are derived, so
 * completing or cancelling a batch releases them; drawn material stays consumed.
 */
export function lotReserved(state: DataState, lotId: string, exceptBatchId?: string): Dec {
  let reserved = D(0);
  for (const b of Object.values(state.batches)) {
    if (b.id === exceptBatchId || b.deletedAt) continue;
    if (b.state !== 'in_progress' && b.state !== 'paused') continue;
    for (const l of b.lines) {
      if (l.plannedLotId !== lotId) continue;
      const drawn = sum(Object.values(state.weighEvents)
        .filter((e) => e.batchId === b.id && e.lineId === l.lineId && e.lotId === lotId)
        .map((e) => e.mass));
      const open = currentTarget(b, l).minus(drawn);
      if (open.greaterThan(0)) reserved = reserved.plus(open);
    }
  }
  return reserved;
}

/** Quantity not yet drawn and not reserved by other open batches. Unknown for untracked lots. */
export function lotAvailable(state: DataState, lotId: string, exceptBatchId?: string): Dec | null {
  const bal = lotBalance(state, lotId);
  if (bal === null) return null;
  return bal.minus(lotReserved(state, lotId, exceptBatchId));
}
