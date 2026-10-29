import { describe, expect, it } from 'vitest';
import { canon } from '../src/domain/decimal';
import { applyChangeset, emptyState, type DataState } from '../src/domain/types';
import { buildDemo } from '../src/domain/demo';
import { cancelBatch, completeBatch, DomainError, lotAvailable, lotReserved, recordAddition, startBatch, topUpPreview } from '../src/domain/batch';
import { amendObservation, supersededIds } from '../src/domain/journal';
import { updateMaterial } from '../src/domain/inventory';
import { deleteProject, updateProject } from '../src/domain/revisions';
import { observationRows } from '../src/domain/compare';

function demo(): DataState {
  return applyChangeset(emptyState(), buildDemo(emptyState(), new Date('2026-10-28T12:00:00Z')));
}

function f2Setup(s: DataState) {
  const stock = Object.values(s.lots).find((l) => l.lotCode === 'DEMO-AMB10-01')!;
  const f2 = Object.values(s.revisions).find((r) => r.code === 'AT-F002')!;
  const amb = f2.lines.find((l) => l.materialName === 'Ambroxan')!;
  return { stock, f2, amb };
}

describe('stock reservations', () => {
  it('an open batch reserves its planned stock; drawing and cancelling release it', () => {
    let s = demo();
    const { stock, f2, amb } = f2Setup(s);
    expect(canon(lotAvailable(s, stock.id)!)).toBe('6.5');
    const b = startBatch(s, { revisionId: f2.id, size: '10', lotSelections: { [amb.id]: stock.id }, containerCapacity: null });
    s = applyChangeset(s, b);
    expect(canon(lotReserved(s, stock.id))).toBe('2');
    expect(canon(lotAvailable(s, stock.id)!)).toBe('4.5');
    expect(canon(lotAvailable(s, stock.id, b.batch.id)!)).toBe('6.5'); // its own reservation does not block itself
    s = applyChangeset(s, recordAddition(s, { batchId: b.batch.id, lineId: amb.id, mass: '0.5', lotId: stock.id, idempotencyKey: 'r1' }));
    expect(canon(lotReserved(s, stock.id))).toBe('1.5');
    expect(canon(lotAvailable(s, stock.id)!)).toBe('4.5'); // 6 g balance minus 1.5 g still reserved
    s = applyChangeset(s, cancelBatch(s, b.batch.id, 'test'));
    expect(canon(lotReserved(s, stock.id))).toBe('0');
    expect(canon(lotAvailable(s, stock.id)!)).toBe('6'); // the poured 0.5 g is not returned
  });

  it('top-up stock check ignores the batch own reservation but counts other batches', () => {
    let s = demo();
    const { stock, f2, amb } = f2Setup(s);
    const sel = { [amb.id]: stock.id };
    const a = startBatch(s, { revisionId: f2.id, size: '10', lotSelections: sel, containerCapacity: null });
    s = applyChangeset(s, a);
    s = applyChangeset(s, startBatch(s, { revisionId: f2.id, size: '20', lotSelections: sel, containerCapacity: null })); // reserves 4 g
    const line = topUpPreview(s, s.batches[a.batch.id]).lines.find((l) => l.lineId === amb.id)!;
    expect(canon(line.available!)).toBe('2.5');
    expect(line.stockShort).toBe(false);
  });

  it('completing releases the reservation', () => {
    let s = demo();
    const { stock, f2, amb } = f2Setup(s);
    const b = startBatch(s, { revisionId: f2.id, size: '10', lotSelections: { [amb.id]: stock.id }, containerCapacity: null });
    s = applyChangeset(s, b);
    s = applyChangeset(s, recordAddition(s, { batchId: b.batch.id, lineId: amb.id, mass: '1', lotId: stock.id, idempotencyKey: 'c1' }));
    s = applyChangeset(s, completeBatch(s, b.batch.id));
    expect(canon(lotReserved(s, stock.id))).toBe('0');
  });
});

describe('observation corrections', () => {
  it('append a superseding entry and keep the original with its clocks', () => {
    let s = demo();
    const f2 = Object.values(s.revisions).find((x) => x.code === 'AT-F002')!;
    const before = observationRows(s, f2.id, 'B');
    expect(before).toHaveLength(1);
    const orig = Object.values(s.observations).find((o) => o.text === before[0].text && o.batchAgeMs === before[0].batchAgeMs)!;
    const r = amendObservation(s, { observationId: orig.id, text: 'corrected text', intensity: 3, descriptors: ['amber'], reason: 'typo' });
    s = applyChangeset(s, r);
    expect(s.observations[orig.id].text).toBe(orig.text);
    expect(r.observation.batchAgeMs).toBe(orig.batchAgeMs);
    expect(r.observation.elapsedMs).toBe(orig.elapsedMs);
    expect(supersededIds(s).has(orig.id)).toBe(true);
    expect(() => amendObservation(s, { observationId: orig.id, text: 'x', intensity: null, descriptors: [], reason: 'again' })).toThrow(DomainError);
    expect(() => amendObservation(s, { observationId: r.observation.id, text: 'x', intensity: null, descriptors: [], reason: '' })).toThrow(DomainError);
    expect(observationRows(s, f2.id, 'B').map((x) => x.text)).toEqual(['corrected text']);
  });
});

describe('material and project edits', () => {
  it('editing a material keeps recorded formula names and writes history', () => {
    let s = demo();
    const hed = Object.values(s.materials).find((m) => m.name === 'Hedione')!;
    s = applyChangeset(s, updateMaterial(s, hed.id, { name: 'Hedione HC', grade: 'HC', supplier: 'X', cas: '24851-98-7', notes: '' }));
    expect(s.materials[hed.id].name).toBe('Hedione HC');
    const f1 = Object.values(s.revisions).find((r) => r.code === 'AT-F001')!;
    expect(f1.lines.find((l) => l.materialId === hed.id)!.materialName).toBe('Hedione');
    expect(Object.values(s.audit).some((a) => a.entityId === hed.id && a.action === 'edit')).toBe(true);
    expect(() => updateMaterial(s, hed.id, { name: ' ', grade: '', supplier: '', cas: '', notes: '' })).toThrow(DomainError);
  });

  it('projects can be renamed and soft-deleted, but not while a batch is open', () => {
    let s = demo();
    const p = Object.values(s.projects)[0];
    s = applyChangeset(s, updateProject(s, p.id, { name: 'Amber Tea II', objective: 'x' }));
    expect(s.projects[p.id].code).toBe('AT');
    const f2 = Object.values(s.revisions).find((r) => r.code === 'AT-F002')!;
    const withOpen = applyChangeset(s, startBatch(s, { revisionId: f2.id, size: '10', lotSelections: {}, containerCapacity: null }));
    expect(() => deleteProject(withOpen, p.id)).toThrow(DomainError);
    s = applyChangeset(s, deleteProject(s, p.id));
    expect(s.projects[p.id].deletedAt).toBeTruthy();
    expect(Object.values(s.batches)).toHaveLength(2); // batches and labels still resolve
  });
});
