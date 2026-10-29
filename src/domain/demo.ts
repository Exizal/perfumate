import { applyChangeset, mergeChangesets, STORE_NAMES, type Changeset, type DataState, type FormulaLine, type StoreName } from './types';
import { createDraft, createProject, forkRevision, freezeRevision, newLine, updateDraft } from './revisions';
import { createMaterial, prepareStock, receiveLot } from './inventory';
import { completeBatch, keepAsWeighed, recordAddition, startBatch } from './batch';
import { addObservation, createApplication, createSample } from './journal';

/**
 * Clearly fictional demonstration records for the "Amber Tea" project. Every record is
 * flagged demo: true and labelled in the UI. Observation texts are placeholders, not
 * sensory results.
 */
export const DEMO_NOTE = 'Demonstration entry. Placeholder text, not a sensory result.';

const MATERIALS = [
  'Bergamot oil FCF', 'Hedione', 'Iso E Super', 'Ambroxan', 'Black tea absolute',
  'Labdanum resinoid', 'Vanillin', 'Ethyl maltol', 'Animalis (base)', 'Benzyl salicylate',
];

export function buildDemo(base: DataState, now = new Date()): Changeset {
  let s = base;
  const sets: Changeset[] = [];
  const apply = (cs: Changeset) => { s = applyChangeset(s, cs); sets.push(cs); };
  const t = (days: number, minutes = 0) => new Date(now.getTime() - days * 86400000 + minutes * 60000).toISOString();

  const mat: Record<string, string> = {};
  for (const name of MATERIALS) {
    const r = createMaterial({ name, grade: '', supplier: 'Demo supplier (fictional)', cas: '', notes: '' }, t(40));
    mat[name] = r.material.id;
    apply(r);
  }
  // Two physical supplied lots and one prepared stock with provenance.
  const amb = receiveLot(s, {
    materialId: mat['Ambroxan'], lotCode: 'DEMO-AMB-2401', supplier: 'Demo supplier (fictional)', strength: '100', carrier: null,
    costPerKg: '450', currency: 'EUR', tracked: true, initialQty: '25', containerCapacity: '30', receivedAt: t(40), notes: '',
  }, t(40));
  apply(amb);
  const hed = receiveLot(s, {
    materialId: mat['Hedione'], lotCode: 'DEMO-HED-2403', supplier: 'Demo supplier (fictional)', strength: '100', carrier: null,
    costPerKg: '60', currency: 'EUR', tracked: true, initialQty: '100', containerCapacity: '120', receivedAt: t(40), notes: '',
  }, t(40));
  apply(hed);
  const stock = prepareStock(s, {
    sourceLotId: amb.lot.id, sourceMass: '1.000', carrier: 'DPG', carrierMass: '9.000', lotCode: 'DEMO-AMB10-01',
    idempotencyKey: 'demo_amb10',
  }, t(35));
  apply(stock);

  const proj = createProject(s, { name: 'Amber Tea', code: 'AT', objective: 'Demonstration project: an amber accord with a tea facet.' }, t(30));
  apply(proj);

  const L = (name: string, amount: string, strength: string | null, carrier: string | null, cost: string | null = null): FormulaLine =>
    newLine({ materialId: mat[name], materialName: name, amount, strength, carrier, costPerKg: cost, currency: cost ? 'EUR' : null });
  const f1Lines = [
    L('Bergamot oil FCF', '120', '100', null, '95'),
    L('Hedione', '200', '100', null, '60'),
    L('Iso E Super', '200', '100', null, '40'),
    L('Ambroxan', '150', '10', 'DPG'),
    L('Labdanum resinoid', '80', '50', 'DPG'),
    L('Vanillin', '50', '10', 'DPG', '2.5'),
    L('Ethyl maltol', '2', '1', 'DPG'),
    L('Benzyl salicylate', '198', '100', null, '12'),
  ];
  const f1 = createDraft(s, { projectId: proj.project.id, lines: f1Lines, amountMode: 'parts', notes: 'Demonstration formula.' }, t(30));
  apply(f1);
  apply(freezeRevision(s, f1.revision.id, t(30)));

  const f2 = forkRevision(s, f1.revision.id, 'Demo: raise Ambroxan stock; add black tea and an animalic trace.', t(10));
  apply(f2);
  const f2Lines = s.revisions[f2.revision.id].lines.map((l) => {
    if (l.materialName === 'Ambroxan') return { ...l, amount: '200' };
    if (l.materialName === 'Benzyl salicylate') return { ...l, amount: '137.8' };
    return l;
  });
  f2Lines.splice(4, 0, L('Black tea absolute', '10', '10', 'EtOH'));
  f2Lines.splice(8, 0, L('Animalis (base)', '0.2', null, null));
  apply(updateDraft(s, f2.revision.id, { lines: f2Lines }, t(10)));
  apply(freezeRevision(s, f2.revision.id, t(10)));

  // Batch numbering continues from earlier (paper) trials: next batches are B017 and B018.
  apply({ projects: [{ ...s.projects[proj.project.id], nextBatchNo: 17 }] });

  const weighAll = (batchId: string, at: string, over: Record<string, string> = {}) => {
    const b = s.batches[batchId];
    b.lines.forEach((l, i) => {
      const mass = over[l.materialName] ?? l.targetGrams;
      apply(recordAddition(s, {
        batchId, lineId: l.lineId, mass, lotId: l.plannedLotId, idempotencyKey: `demo_${b.code}_${i}`, at,
      }));
    });
  };
  const lotsFor = (revId: string) => Object.fromEntries(s.revisions[revId].lines.map((l) => [
    l.id,
    l.materialName === 'Ambroxan' ? stock.lot!.id : l.materialName === 'Hedione' ? hed.lot.id : null,
  ]));

  const b17 = startBatch(s, { revisionId: f1.revision.id, size: '10', lotSelections: lotsFor(f1.revision.id), containerCapacity: '15', at: t(21, -60) });
  apply(b17);
  weighAll(b17.batch.id, t(21, -40));
  apply(completeBatch(s, b17.batch.id, t(21)));

  const b18 = startBatch(s, { revisionId: f2.revision.id, size: '10', lotSelections: lotsFor(f2.revision.id), containerCapacity: '15', at: t(7, -100) });
  apply(b18);
  weighAll(b18.batch.id, t(7, -80), { 'Black tea absolute': '0.120' }); // the demonstrated overpour
  apply(keepAsWeighed(s, b18.batch.id, t(7, -70)));
  apply(completeBatch(s, b18.batch.id, t(7, -60)));

  // Samples at 20 % in ethanol, applied to blotters. Two clocks per observation.
  const s17 = createSample(s, { batchId: b17.batch.id, batchPercent: '20', diluent: 'Ethanol', notes: '', preparedAt: t(7, -60) });
  apply(s17);
  const a17 = createApplication(s, { sampleId: s17.sample.id, medium: 'blotter', appliedAt: t(7, -60), evaluator: 'Demo evaluator', checkpoints: [15, 60], notes: '' }, t(7, -60));
  apply(a17);
  apply(addObservation(s, { applicationId: a17.application.id, at: t(7, -45), text: DEMO_NOTE, intensity: null, descriptors: [], checkpointMin: 15 }, t(7, -45)));

  const s18 = createSample(s, { batchId: b18.batch.id, batchPercent: '20', diluent: 'Ethanol', notes: '', preparedAt: t(0, -50) });
  apply(s18);
  const a18 = createApplication(s, { sampleId: s18.sample.id, medium: 'blotter', appliedAt: t(0, -45), evaluator: 'Demo evaluator', checkpoints: [15, 60, 240], notes: '' }, t(0, -45));
  apply(a18);
  apply(addObservation(s, { applicationId: a18.application.id, at: t(0, -30), text: DEMO_NOTE, intensity: null, descriptors: [], checkpointMin: 15 }, t(0, -30)));

  return markDemo(mergeChangesets(...sets));
}

function markDemo(cs: Changeset): Changeset {
  const out: Changeset = { ...cs };
  for (const name of STORE_NAMES) {
    const recs = cs[name] as Array<{ demo?: boolean }> | undefined;
    if (recs) (out as Record<string, unknown>)[name] = recs.map((r) => ({ ...r, demo: true }));
  }
  return out;
}

/** Remove demonstration data and anything recorded inside demonstration projects. */
export function removeDemo(state: DataState): { cs: Changeset; counts: Record<string, number> } {
  const demoProjects = new Set(Object.values(state.projects).filter((p) => p.demo).map((p) => p.id));
  const remove: Partial<Record<StoreName, Set<string>>> = {};
  const add = (n: StoreName, id: string) => { (remove[n] ??= new Set()).add(id); };
  for (const name of STORE_NAMES) {
    for (const r of Object.values(state[name]) as Array<{ id: string; demo?: boolean }>) if (r.demo) add(name, r.id);
  }
  for (const r of Object.values(state.revisions)) if (demoProjects.has(r.projectId)) add('revisions', r.id);
  for (const b of Object.values(state.batches)) if (demoProjects.has(b.projectId)) add('batches', b.id);
  const batches = remove.batches ?? new Set();
  for (const e of Object.values(state.weighEvents)) if (batches.has(e.batchId)) add('weighEvents', e.id);
  for (const x of Object.values(state.samples)) if (batches.has(x.batchId)) add('samples', x.id);
  const samples = remove.samples ?? new Set();
  for (const a of Object.values(state.applications)) if (samples.has(a.sampleId)) add('applications', a.id);
  const apps = remove.applications ?? new Set();
  for (const o of Object.values(state.observations)) if (apps.has(o.applicationId)) add('observations', o.id);
  const events = remove.weighEvents ?? new Set();
  for (const tx of Object.values(state.inventoryTx)) if (tx.refId && events.has(tx.refId)) add('inventoryTx', tx.id);
  // Keep demo materials and lots that the user's own records still reference.
  const keptRevs = Object.values(state.revisions).filter((r) => !remove.revisions?.has(r.id));
  for (const r of keptRevs) for (const l of r.lines) if (l.materialId) remove.materials?.delete(l.materialId);
  const keptBatches = Object.values(state.batches).filter((b) => !batches.has(b.id));
  for (const b of keptBatches) for (const l of b.lines) if (l.plannedLotId) remove.lots?.delete(l.plannedLotId);
  for (const tx of Object.values(state.inventoryTx)) if (!remove.lots?.has(tx.lotId)) remove.inventoryTx?.delete(tx.id);
  for (const lot of Object.values(state.lots)) if (!remove.materials?.has(lot.materialId)) remove.lots?.delete(lot.id);
  const cs: Changeset = { remove: {} };
  const counts: Record<string, number> = {};
  for (const [k, v] of Object.entries(remove)) {
    cs.remove![k as StoreName] = [...(v as Set<string>)];
    counts[k] = (v as Set<string>).size;
  }
  return { cs, counts };
}
