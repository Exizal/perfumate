import { D, canon, type DecStr } from './decimal';
import { preparedStrength } from './formula';
import { audit, DomainError } from './batch';
import { nowISO, uid } from './ids';
import type { Changeset, DataState, InventoryTx, Lot, Material } from './types';

export function createMaterial(input: Pick<Material, 'name' | 'grade' | 'supplier' | 'cas' | 'notes'> & Partial<Pick<Material, 'density' | 'maxPct' | 'limitSource'>>, at = nowISO()): Changeset & { material: Material } {
  if (!input.name.trim()) throw new DomainError('name_required');
  const material: Material = { id: uid('mat'), createdAt: at, ...input, name: input.name.trim() };
  return { material, materials: [material], audit: [audit('material', material.id, 'create', material.name, at)] };
}

export interface NewLotInput {
  materialId: string;
  lotCode: string;
  supplier: string;
  strength: DecStr | null;
  carrier: string | null;
  costPerKg: DecStr | null;
  currency: string | null;
  tracked: boolean;
  initialQty: DecStr | null;
  containerCapacity: DecStr | null;
  receivedAt: string | null;
  notes: string;
}

export function receiveLot(state: DataState, input: NewLotInput, at = nowISO()): Changeset & { lot: Lot } {
  if (!state.materials[input.materialId]) throw new DomainError('not_found');
  const lot: Lot = {
    id: uid('lot'), createdAt: at, materialId: input.materialId, kind: 'supplied', lotCode: input.lotCode.trim(),
    supplier: input.supplier, strength: input.strength, carrier: input.carrier, sourceLotId: null, sourceMass: null,
    carrierMass: null, costPerKg: input.costPerKg, currency: input.currency, tracked: input.tracked,
    containerCapacity: input.containerCapacity, receivedAt: input.receivedAt, notes: input.notes,
  };
  const cs: Changeset & { lot: Lot } = { lot, lots: [lot], audit: [audit('lot', lot.id, 'receive', lot.lotCode, at)] };
  if (input.tracked && input.initialQty !== null) {
    if (D(input.initialQty).isNegative()) throw new DomainError('invalid_mass');
    cs.inventoryTx = [tx(lot.id, input.initialQty, 'receive', `receive_${lot.id}`, null, 'received', at)];
  }
  return cs;
}

function tx(lotId: string, delta: DecStr, kind: InventoryTx['kind'], key: string, refId: string | null, reason: string, at: string): InventoryTx {
  return { id: key, idempotencyKey: key, createdAt: at, lotId, delta, kind, refId, reason, at };
}

/**
 * Prepare a working dilution by mass. The parent is consumed here, once; later use of the
 * prepared stock draws only from the stock's own container.
 */
export function prepareStock(
  state: DataState,
  input: { sourceLotId: string; sourceMass: DecStr; carrier: string; carrierMass: DecStr; lotCode: string; idempotencyKey: string; notes?: string },
  at = nowISO(),
): Changeset & { lot: Lot | null } {
  if (state.lots[`lot_${input.idempotencyKey}`]) return { lot: null };
  const src = state.lots[input.sourceLotId];
  if (!src) throw new DomainError('not_found');
  if (!D(input.sourceMass).greaterThan(0) || D(input.carrierMass).isNegative()) throw new DomainError('invalid_mass');
  const strength = preparedStrength(input.sourceMass, src.strength, input.carrierMass);
  const total = D(input.sourceMass).plus(D(input.carrierMass));
  let costPerKg: string | null = null;
  if (src.costPerKg !== null) {
    // Carrier cost is not known here, so the stock's cost covers only the parent material.
    costPerKg = canon(D(src.costPerKg).times(D(input.sourceMass)).dividedBy(total).toDecimalPlaces(6));
  }
  const lot: Lot = {
    id: `lot_${input.idempotencyKey}`, createdAt: at, materialId: src.materialId, kind: 'prepared_stock',
    lotCode: input.lotCode.trim(), supplier: '', strength: strength ? canon(strength.toDecimalPlaces(10)) : null,
    carrier: input.carrier, sourceLotId: src.id, sourceMass: canon(D(input.sourceMass)),
    carrierMass: canon(D(input.carrierMass)), costPerKg, currency: src.currency, tracked: true,
    containerCapacity: null, receivedAt: at, notes: input.notes ?? (costPerKg ? 'Cost excludes carrier.' : ''),
  };
  return {
    lot,
    lots: [lot],
    inventoryTx: [
      tx(src.id, canon(D(input.sourceMass).negated()), 'prepare_out', `prep_out_${input.idempotencyKey}`, lot.id, `prepared ${lot.lotCode}`, at),
      tx(lot.id, canon(total), 'prepare_in', `prep_in_${input.idempotencyKey}`, src.id, `from ${src.lotCode}`, at),
    ],
    audit: [audit('lot', lot.id, 'prepare', `${input.sourceMass} g ${src.lotCode} + ${input.carrierMass} g ${input.carrier}`, at)],
  };
}

/** Corrections append a reasoned adjustment rather than editing history. */
export function adjustLot(state: DataState, input: { lotId: string; delta: DecStr; reason: string; idempotencyKey: string }, at = nowISO()): Changeset {
  if (state.inventoryTx[input.idempotencyKey]) return {};
  const lot = state.lots[input.lotId];
  if (!lot) throw new DomainError('not_found');
  if (!input.reason.trim()) throw new DomainError('reason_required');
  const changes: Changeset = {
    inventoryTx: [tx(lot.id, canon(D(input.delta)), 'adjust', input.idempotencyKey, null, input.reason, at)],
    audit: [audit('lot', lot.id, 'adjust', `${input.delta} g: ${input.reason}`, at)],
  };
  if (!lot.tracked) changes.lots = [{ ...lot, tracked: true }];
  return changes;
}

/** Edit material identity details. Formula lines keep the name they were written with. */
export function updateMaterial(
  state: DataState,
  id: string,
  patch: Pick<Material, 'name' | 'grade' | 'supplier' | 'cas' | 'notes'> & Partial<Pick<Material, 'density' | 'maxPct' | 'limitSource'>>,
  at = nowISO(),
): Changeset {
  const m = state.materials[id];
  if (!m) throw new DomainError('not_found');
  if (!patch.name.trim()) throw new DomainError('name_required');
  const next: Material = { ...m, ...patch, name: patch.name.trim() };
  const changed = (['name', 'grade', 'supplier', 'cas', 'notes', 'density', 'maxPct', 'limitSource'] as const)
    .filter((k) => (m[k] ?? null) !== (next[k] ?? null))
    .map((k) => `${k}: "${m[k]}" -> "${next[k]}"`);
  if (!changed.length) return {};
  return { materials: [next], audit: [audit('material', m.id, 'edit', changed.join('; '), at)] };
}
