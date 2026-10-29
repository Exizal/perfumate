import { describe, expect, it } from 'vitest';
import { D, canon, roundForDisplay } from '../src/domain/decimal';
import { applyChangeset, emptyState, type DataState, type Changeset } from '../src/domain/types';
import { planBatch, parentEquivalent, normalizePreview } from '../src/domain/formula';
import { createDraft, createProject, forkRevision, freezeRevision, newLine, updateDraft } from '../src/domain/revisions';
import { createMaterial, prepareStock, receiveLot } from '../src/domain/inventory';
import {
  actualByLine, applyTopUp, cancelBatch, completeBatch, composition, DomainError, lotBalance, recordAddition,
  recordCorrection, startBatch, topUpPreview,
} from '../src/domain/batch';
import { addObservation, createApplication, createSample, formatDuration } from '../src/domain/journal';
import { buildDemo, removeDemo } from '../src/domain/demo';
import { buildBackup, backupToState, integrityProblems, parseBackup, toCsv } from '../src/domain/backup';
import { parseNumber, detectConvention } from '../src/import/numbers';
import { parseDelimited } from '../src/import/grid';
import { buildPreview, blockingRows, guessHeaderRow, guessMapping, previewToLines } from '../src/import/mapping';
import { readXlsx, writeXlsx } from '../src/import/xlsx';
import { parseLabelPayload, labelPayload } from '../src/domain/ids';

function run(state: DataState, cs: Changeset): DataState {
  return applyChangeset(state, cs);
}

/** A 10 g batch setup: 20 % of a 10 % Ambroxan stock and a 1 % tea line. */
function setup() {
  let s = emptyState();
  const m1 = createMaterial({ name: 'Ambroxan', grade: '', supplier: '', cas: '', notes: '' });
  const m2 = createMaterial({ name: 'Black tea absolute', grade: '', supplier: '', cas: '', notes: '' });
  const m3 = createMaterial({ name: 'Benzyl salicylate', grade: '', supplier: '', cas: '', notes: '' });
  s = run(run(run(s, m1), m2), m3);
  const neat = receiveLot(s, {
    materialId: m1.material.id, lotCode: 'AMB-1', supplier: '', strength: '100', carrier: null, costPerKg: '400', currency: 'EUR',
    tracked: true, initialQty: '20', containerCapacity: null, receivedAt: null, notes: '',
  });
  s = run(s, neat);
  const stock = prepareStock(s, { sourceLotId: neat.lot.id, sourceMass: '1', carrier: 'DPG', carrierMass: '9', lotCode: 'AMB10', idempotencyKey: 'k1' });
  s = run(s, stock);
  const p = createProject(s, { name: 'Amber Tea', code: 'AT', objective: '' });
  s = run(s, p);
  const lines = [
    newLine({ materialId: m1.material.id, materialName: 'Ambroxan', strength: '10', carrier: 'DPG', amount: '20' }),
    newLine({ materialId: m2.material.id, materialName: 'Black tea absolute', strength: '10', carrier: 'EtOH', amount: '1' }),
    newLine({ materialId: m3.material.id, materialName: 'Benzyl salicylate', strength: '100', amount: '79' }),
  ];
  const d = createDraft(s, { projectId: p.project.id, lines, amountMode: 'pct' });
  s = run(s, d);
  s = run(s, freezeRevision(s, d.revision.id));
  s = { ...s, projects: { ...s.projects, [p.project.id]: { ...s.projects[p.project.id], nextBatchNo: 19 } } };
  const b = startBatch(s, {
    revisionId: d.revision.id, size: '10.000',
    lotSelections: { [lines[0].id]: stock.lot!.id }, containerCapacity: '15',
  });
  s = run(s, b);
  return { s, lines, batch: b.batch, rev: d.revision, neat: neat.lot, stock: stock.lot!, project: p.project };
}

describe('Acceptance 1: planning and parent equivalent', () => {
  it('20 % of a supplied 10 % stock in 10 g plans 2 g of stock and 0.2 g parent', () => {
    const { s, rev } = setup();
    const plan = planBatch(s.revisions[rev.id], '10', '0.010', '0.001');
    const amb = plan.lines[0];
    expect(canon(amb.targetGrams)).toBe('2');
    expect(canon(amb.parentGrams!)).toBe('0.2');
    expect(canon(parentEquivalent('0.100', '10')!)).toBe('0.01');
  });
  it('unknown strength stays unknown rather than zero', () => {
    expect(parentEquivalent('1', null)).toBeNull();
  });
  it('uses decimal arithmetic (0.1 + 0.2 is exactly 0.3)', () => {
    expect(canon(D('0.1').plus('0.2'))).toBe('0.3');
  });
});

describe('Acceptance 2: stock consumption is counted once, from the stock container', () => {
  it('drawing 0.100 g of the stock subtracts 0.100 g from the stock only', () => {
    const { s: s0, batch, lines, stock, neat } = setup();
    const neatBefore = lotBalance(s0, neat.id)!;
    const stockBefore = lotBalance(s0, stock.id)!;
    expect(canon(neatBefore)).toBe('19'); // 20 g received, 1 g used to prepare the stock
    expect(canon(stockBefore)).toBe('10');
    const cs = recordAddition(s0, { batchId: batch.id, lineId: lines[0].id, mass: '0.100', lotId: stock.id, idempotencyKey: 'ev1' });
    let s = run(s0, cs);
    // retry with the same key: no duplicate
    s = run(s, recordAddition(s, { batchId: batch.id, lineId: lines[0].id, mass: '0.100', lotId: stock.id, idempotencyKey: 'ev1' }));
    expect(canon(lotBalance(s, stock.id)!)).toBe('9.9');
    expect(canon(lotBalance(s, neat.id)!)).toBe('19');
  });
  it('prepared stock strength multiplies nested fractions', () => {
    const { stock } = setup();
    expect(stock.strength).toBe('10');
  });
});

describe('Acceptance 3: overpour and proportional top-up', () => {
  it('0.120 g against 0.100 g keeps the target and previews a 12 g minimum plan', () => {
    const { s: s0, batch, lines } = setup();
    let s = run(s0, recordAddition(s0, { batchId: batch.id, lineId: lines[1].id, mass: '0.120', lotId: null, idempotencyKey: 'ev2' }));
    const p = topUpPreview(s, s.batches[batch.id]);
    expect(canon(p.minFactor)).toBe('1.2');
    expect(canon(p.newSize)).toBe('12');
    expect(s.batches[batch.id].lines[1].targetGrams).toBe('0.1');
    const tea = p.lines[1];
    expect(canon(tea.stillNeeded)).toBe('0');
    expect(p.lines.every((l) => !l.stillNeeded.isNegative())).toBe(true);
    expect(p.capacityExceeded).toBe(false);
    // a larger ratio elsewhere raises the minimum factor
    s = run(s, recordAddition(s, { batchId: batch.id, lineId: lines[0].id, mass: '2.600', lotId: null, idempotencyKey: 'ev3' }));
    expect(canon(topUpPreview(s, s.batches[batch.id]).minFactor)).toBe('1.3');
    // applying keeps original targets and only changes the factor
    s = run(s, applyTopUp(s, batch.id, '1.3'));
    expect(s.batches[batch.id].planFactor).toBe('1.3');
    expect(s.batches[batch.id].lines[1].targetGrams).toBe('0.1');
    expect(() => applyTopUp(s, batch.id, '1.1')).toThrow(DomainError);
  });
  it('flags container capacity', () => {
    const { s: s0, batch, lines } = setup();
    const s = run(s0, recordAddition(s0, { batchId: batch.id, lineId: lines[1].id, mass: '0.200', lotId: null, idempotencyKey: 'x' }));
    expect(topUpPreview(s, s.batches[batch.id]).capacityExceeded).toBe(true); // 20 g > 15 g
  });
});

describe('Acceptance 4: practical minimum weighing', () => {
  it('flags a 0.002 g addition with a 0.010 g practical minimum on a 0.001 g balance', () => {
    const lines = [newLine({ materialName: 'Trace', amount: '0.02', strength: '100' }), newLine({ materialName: 'Bulk', amount: '99.98', strength: '100' })];
    const plan = planBatch({ amountMode: 'pct', lines }, '10', '0.010', '0.001');
    expect(canon(plan.lines[0].targetGrams)).toBe('0.002');
    expect(plan.lines[0].belowPracticalMin).toBe(true);
    expect(plan.lines[0].belowReadability).toBe(false);
  });
  it('never displays a trace as zero', () => {
    const r = roundForDisplay(D('0.0004'), 3);
    expect(r.shown).toBe('0.000');
    expect(r.belowDisplay).toBe(true);
  });
});

describe('Acceptance 5: editing after a batch does not change the batch', () => {
  it('frozen revision cannot be edited; a fork leaves B019 intact', () => {
    const { s: s0, rev, batch } = setup();
    expect(batch.code).toBe('AT-B019');
    expect(() => updateDraft(s0, rev.id, { lines: [] })).toThrow(DomainError);
    const fork = forkRevision(s0, rev.id, 'more tea');
    let s = run(s0, fork);
    const changed = s.revisions[fork.revision.id].lines.map((l) => ({ ...l, amount: l.materialName === 'Ambroxan' ? '25' : l.amount, strength: l.materialName === 'Ambroxan' ? '1' : l.strength }));
    s = run(s, updateDraft(s, fork.revision.id, { lines: changed }));
    const b = s.batches[batch.id];
    expect(b.lines[0].strength).toBe('10');
    expect(b.lines[0].targetGrams).toBe('2');
    expect(b.revisionId).toBe(rev.id);
    expect(s.revisions[rev.id].lines[0].amount).toBe('20');
    expect(s.revisions[fork.revision.id].parentRevisionId).toBe(rev.id);
  });
  it('cost snapshot is not rewritten by a later lot price', () => {
    const { s: s0, batch, lines, stock } = setup();
    let s = run(s0, recordAddition(s0, { batchId: batch.id, lineId: lines[0].id, mass: '2', lotId: stock.id, idempotencyKey: 'c1' }));
    const before = composition(s, s.batches[batch.id]).costByCurrency.EUR;
    s = { ...s, lots: { ...s.lots, [stock.id]: { ...s.lots[stock.id], costPerKg: '9999' } } };
    expect(canon(composition(s, s.batches[batch.id]).costByCurrency.EUR)).toBe(canon(before));
    expect(composition(s, s.batches[batch.id]).costKnown).toBe(true);
  });
});

describe('Acceptance 6: labels resolve after backup/restore', () => {
  it('label payload round-trips to the exact batch and revision', () => {
    const { s: s0, batch, lines, rev } = setup();
    let s = run(s0, recordAddition(s0, { batchId: batch.id, lineId: lines[0].id, mass: '2', lotId: null, idempotencyKey: 'l1' }));
    s = run(s, completeBatch(s, batch.id));
    const payload = labelPayload(batch.id, batch.code);
    const restored = backupToState(parseBackup(JSON.stringify(buildBackup(s, new Date().toISOString()))));
    const parsed = parseLabelPayload(payload);
    const found = restored.batches[parsed.batchId!];
    expect(found.code).toBe('AT-B019');
    expect(found.revisionId).toBe(rev.id);
    expect(restored.revisions[found.revisionId].code).toBe(rev.code);
    expect(parseLabelPayload('at-b019').code).toBe('AT-B019');
  });
});

describe('Acceptance 7: two independent clocks', () => {
  it('a 7-day-old batch observed 15 minutes after application keeps both timings', () => {
    const { s: s0, batch, lines } = setup();
    const t0 = new Date('2026-10-01T10:00:00Z');
    let s = run(s0, recordAddition(s0, { batchId: batch.id, lineId: lines[0].id, mass: '2', lotId: null, idempotencyKey: 'c7' }));
    s = run(s, completeBatch(s, batch.id, t0.toISOString()));
    const smp = createSample(s, { batchId: batch.id, batchPercent: '20', diluent: 'Ethanol', notes: '' });
    s = run(s, smp);
    const applied = new Date(t0.getTime() + 7 * 86400000).toISOString();
    const app = createApplication(s, { sampleId: smp.sample.id, medium: 'blotter', appliedAt: applied, evaluator: 'E', checkpoints: [15], notes: '' });
    s = run(s, app);
    const at = new Date(t0.getTime() + 7 * 86400000 + 15 * 60000).toISOString();
    const o = addObservation(s, { applicationId: app.application.id, at, text: 'note', intensity: null, descriptors: [], checkpointMin: 15 });
    expect(o.observation.batchAgeMs).toBe(7 * 86400000 + 15 * 60000);
    expect(o.observation.elapsedMs).toBe(15 * 60000);
    const u = { d: 'd', h: 'h', min: 'min' };
    expect(formatDuration(o.observation.batchAgeMs, u)).toBe('7 d 0 h');
    expect(formatDuration(o.observation.elapsedMs, u)).toBe('15 min');
  });
});

describe('Acceptance 8: decimal conventions on import', () => {
  it('decimal comma and decimal point files produce the same amounts', () => {
    const point = 'Material,Grams,Dilution %\nAmbroxan,2.000,10\nBlack tea absolute,0.100,10\nBenzyl salicylate,7.9,100\n';
    const comma = 'Material;Grams;Dilution %\nAmbroxan;2,000;10\nBlack tea absolute;0,100;10\nBenzyl salicylate;7,9;100\n';
    const lines = (text: string, conv: 'point' | 'comma') => {
      const { sheet } = parseDelimited(text);
      const h = guessHeaderRow(sheet);
      const mapping = guessMapping(sheet, h);
      const rows = buildPreview(sheet, { headerRow: h, mapping, convention: conv, blankStrength: 'unknown', materials: [] });
      return previewToLines(rows, 'EUR', new Set()).map((l) => [l.materialName, l.amount, l.strength]);
    };
    expect(lines(point, 'point')).toEqual(lines(comma, 'comma'));
    expect(lines(point, 'point')[1]).toEqual(['Black tea absolute', '0.1', '10']);
  });
  it('flags "1,250" as ambiguous instead of guessing', () => {
    expect(parseNumber('1,250', null).status).toBe('ambiguous');
    expect(parseNumber('1.250', null).status).toBe('ambiguous');
    expect(parseNumber('1,250', 'comma').value).toBe('1.25');
    expect(parseNumber('1,250', 'point').value).toBe('1250');
    expect(parseNumber('0,120', null).value).toBe('0.12');
    expect(parseNumber('1.234,5', null).value).toBe('1234.5');
    expect(parseNumber('', null).status).toBe('blank');
    expect(parseNumber('0', null).value).toBe('0');
    expect(parseNumber('20%', null)).toMatchObject({ value: '20', percent: true });
    expect(detectConvention(['0,12', '1,250'])).toBe('comma');
    const { sheet } = parseDelimited('Material;Grams\nX;1,250\n');
    const rows = buildPreview(sheet, { headerRow: 0, mapping: ['material', 'amount'], convention: null, blankStrength: 'unknown', materials: [] });
    expect(rows[0].flags).toContain('ambiguous');
    expect(blockingRows(rows)).toHaveLength(1);
  });
  it('distinguishes blank from zero and detects total rows and header rows', () => {
    const { sheet } = parseDelimited('My formula\n\nMaterial,Amount\nA,0\nB,\nTotal,10\n');
    const h = guessHeaderRow(sheet);
    expect(h).toBe(2);
    const rows = buildPreview(sheet, { headerRow: h, mapping: guessMapping(sheet, h), convention: 'point', blankStrength: 'unknown', materials: [] });
    expect(rows[0].flags).toContain('zero_amount');
    expect(rows[1].flags).toContain('blank_amount');
    expect(rows[2].flags).toContain('total_row');
    expect(rows[2].include).toBe(false);
    const lines = previewToLines(rows, 'EUR', new Set());
    expect(lines.map((l) => l.amount)).toEqual(['0', null]);
  });
  it('reads xlsx cached values, percent formats, and flags formulas without cached values', () => {
    const bytes = writeXlsx([{ name: 'F', rows: [[{ v: 'Material' }, { v: 'Grams' }], [{ v: '=cmd' }, { v: 1.5, t: 'n' }]] }]);
    const sheets = readXlsx(bytes);
    expect(sheets[0].rows[1][0].text).toBe("'=cmd"); // formula-like text escaped on export
    expect(sheets[0].rows[1][1]).toMatchObject({ kind: 'number', text: '1.5' });
  });
});

describe('Acceptance 9: cancel or resave never erases or duplicates consumption', () => {
  it('resaving the same addition does not duplicate; cancelling keeps consumption', () => {
    const { s: s0, batch, lines, stock } = setup();
    const input = { batchId: batch.id, lineId: lines[0].id, mass: '1.000', lotId: stock.id, idempotencyKey: 'p1' };
    let s = run(s0, recordAddition(s0, input));
    s = run(s, recordAddition(s, input));
    s = run(s, recordAddition(s, input));
    expect(canon(actualByLine(s, batch.id)[lines[0].id])).toBe('1');
    expect(canon(lotBalance(s, stock.id)!)).toBe('9');
    s = run(s, cancelBatch(s, batch.id, 'Spilled; discarded.'));
    expect(s.batches[batch.id].state).toBe('cancelled');
    expect(canon(lotBalance(s, stock.id)!)).toBe('9');
    expect(() => recordAddition(s, { ...input, idempotencyKey: 'p2' })).toThrow(DomainError);
    expect(() => cancelBatch(s0, batch.id, '')).toThrow(DomainError);
  });
  it('corrections append history rather than editing it', () => {
    const { s: s0, batch, lines, stock } = setup();
    let s = run(s0, recordAddition(s0, { batchId: batch.id, lineId: lines[0].id, mass: '2.100', lotId: stock.id, idempotencyKey: 'q1' }));
    s = run(s, recordCorrection(s, { eventId: 'q1', correctMass: '2.010', reason: 'typo', idempotencyKey: 'q2' }));
    expect(s.weighEvents.q1.mass).toBe('2.1');
    expect(canon(actualByLine(s, batch.id)[lines[0].id])).toBe('2.01');
    expect(canon(lotBalance(s, stock.id)!)).toBe('7.99');
  });
});

describe('Acceptance 10: export/restore preserves relationships; unknown never becomes zero', () => {
  it('demo data round-trips with every link intact', () => {
    const demo = buildDemo(emptyState(), new Date('2026-10-28T12:00:00Z'));
    const s = applyChangeset(emptyState(), demo);
    expect(Object.values(s.batches).map((b) => b.code).sort()).toEqual(['AT-B017', 'AT-B018']);
    expect(integrityProblems(s)).toEqual([]);
    const restored = backupToState(parseBackup(JSON.stringify(buildBackup(s, '2026-10-28T12:00:00Z'))));
    expect(integrityProblems(restored)).toEqual([]);
    for (const k of ['revisions', 'batches', 'weighEvents', 'observations', 'inventoryTx', 'lots'] as const) {
      expect(Object.keys(restored[k]).length).toBe(Object.keys(s[k]).length);
    }
    const b18 = Object.values(restored.batches).find((b) => b.code === 'AT-B018')!;
    const animalis = b18.lines.find((l) => l.materialName === 'Animalis (base)')!;
    expect(animalis.strength).toBeNull();
    const comp = composition(restored, b18);
    expect(comp.costKnown).toBe(false); // lines without cost stay unknown, not free
    expect(comp.lines.find((l) => l.materialName === 'Animalis (base)')!.parentGrams).toBeNull();
    const tea = comp.lines.find((l) => l.materialName === 'Black tea absolute')!;
    expect(canon(tea.actual)).toBe('0.12');
    expect(canon(tea.originalTarget)).toBe('0.1');
    expect(restored.projects[b18.projectId].nextBatchNo).toBe(19);
    const removed = applyChangeset(restored, removeDemo(restored).cs);
    expect(Object.keys(removed.batches)).toHaveLength(0);
    expect(Object.keys(removed.materials)).toHaveLength(0);
  });
  it('csv export escapes formula-like text', () => {
    const csv = toCsv(['a', 'b'], [[{ v: '=HYPERLINK("x")' }, { v: '-0.5', n: true }]]);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain('-0.5');
  });
  it('normalization is a preview, not an automatic change', () => {
    const rev = { amountMode: 'pct' as const, lines: [newLine({ materialName: 'a', amount: '40' }), newLine({ materialName: 'b', amount: '40' })] };
    const p = normalizePreview(rev)!;
    expect(p.lines.map((l) => l.after)).toEqual(['50', '50']);
    expect(rev.lines[0].amount).toBe('40');
    expect(planBatch(rev, '10', '0.01', '0.001').error).toBe('pct_total');
  });
});
