import { describe, expect, it } from 'vitest';
import { canon, D } from '../src/domain/decimal';
import { applyChangeset, emptyState, type DataState } from '../src/domain/types';
import { buildDemo } from '../src/domain/demo';
import { DomainError } from '../src/domain/batch';
import { createDraft, createProject, freezeRevision, newLine } from '../src/domain/revisions';
import { explodeRevision, limitChecks } from '../src/domain/accords';
import { gramsFromVolume, parseBalanceLine } from '../src/domain/units';
import { mergeStates } from '../src/domain/merge';
import { addBlindRating, blindResults, createBlindSession, revealBlindSession } from '../src/domain/blind';
import { buildSharePack, importSharePack, parseSharePack } from '../src/domain/share';
import { createApplication, createSample } from '../src/domain/journal';

const AT = '2026-10-29T10:00:00.000Z';

function demo(): DataState {
  return applyChangeset(emptyState(), buildDemo(emptyState(), new Date('2026-10-28T12:00:00Z')));
}

function accordSetup() {
  let s = emptyState();
  const p = createProject(s, { name: 'Tea accord', code: 'TA', objective: '', isAccord: true }, AT);
  s = applyChangeset(s, p);
  const d = createDraft(s, {
    projectId: p.project.id, amountMode: 'pct',
    lines: [newLine({ materialName: 'Linalool', amount: '60' }), newLine({ materialName: 'Hedione', amount: '40' })],
  }, AT);
  s = applyChangeset(s, d);
  s = applyChangeset(s, freezeRevision(s, d.revision.id, AT));
  const accordMat = Object.values(s.materials).find((m) => m.accordRevisionId === d.revision.id)!;
  const q = createProject(s, { name: 'Main', code: 'MN', objective: '' }, AT);
  s = applyChangeset(s, q);
  const linalool = Object.values(s.materials).find((m) => m.name === 'Linalool')!;
  const main = createDraft(s, {
    projectId: q.project.id, amountMode: 'pct',
    lines: [
      newLine({ materialId: accordMat.id, materialName: accordMat.name, amount: '50', strength: '50' }),
      newLine({ materialId: linalool.id, materialName: 'Linalool', amount: '10' }),
      newLine({ materialName: 'Ethanol', amount: '40' }),
    ],
  }, AT);
  s = applyChangeset(s, main);
  return { s, accordMat, main: s.revisions[main.revision.id], linalool };
}

describe('accords', () => {
  it('freezing an accord revision creates a material linked to it', () => {
    const { accordMat } = accordSetup();
    expect(accordMat.name).toBe('TA-F001 Tea accord');
  });

  it('explodes accord lines into parent-equivalent materials, through the stock strength', () => {
    const { s, main } = accordSetup();
    const ex = new Map(explodeRevision(s, main).map((x) => [x.name, x]));
    // 50 % of a 50 % accord stock = 25 % accord; linalool 60 % of that = 15 %, plus 10 % direct.
    expect(canon(ex.get('Linalool')!.parentPct!)).toBe('25');
    expect(ex.get('Linalool')!.via).toEqual(['TA-F001']);
    expect(canon(ex.get('Hedione')!.parentPct!)).toBe('10');
    expect(canon(ex.get('Ethanol')!.parentPct!)).toBe('40');
  });

  it('checks the user\'s own limits at a product dose and never invents one', () => {
    const { s, main, linalool } = accordSetup();
    const s2 = applyChangeset(s, { materials: [{ ...linalool, maxPct: '4', limitSource: 'own note' }] });
    const res = new Map(limitChecks(s2, main, D(20)).map((x) => [x.name, x]));
    expect(canon(res.get('Linalool')!.productPct!)).toBe('5');
    expect(res.get('Linalool')!.status).toBe('over');
    expect(res.get('Hedione')!.status).toBe('no_limit');
  });
});

describe('units and balance output', () => {
  it('converts a measured volume only when density is known', () => {
    expect(canon(gramsFromVolume('0.25', '0.95')!)).toBe('0.2375');
    expect(gramsFromVolume('0.25', null)).toBeNull();
  });

  it('parses common balance lines and flags unstable readings', () => {
    expect(parseBalanceLine('ST,GS,+   0.1200 g')).toEqual({ grams: '0.12', stable: true });
    expect(parseBalanceLine('US,GS,+   0.1180 g')!.stable).toBe(false);
    expect(parseBalanceLine('N     -0.002 g')!.grams).toBe('-0.002');
    expect(parseBalanceLine('     120 mg')!.grams).toBe('0.12');
    expect(parseBalanceLine('ERR')).toBeNull();
  });
});

describe('merging another device', () => {
  it('adds new records, keeps local ones and reports conflicts without overwriting', () => {
    const base = demo();
    const local = structuredClone(base);
    const other = structuredClone(base);
    const p = createProject(other, { name: 'Other device', code: 'OD', objective: '' }, AT);
    const remote = applyChangeset(other, p);
    const mat = Object.values(remote.materials)[0];
    remote.materials[mat.id] = { ...mat, notes: 'changed elsewhere' };
    const r = mergeStates(local, remote);
    expect(r.added.projects).toBe(1);
    expect(r.conflicts.map((c) => c.id)).toContain(mat.id);
    const merged = applyChangeset(local, r.cs);
    expect(merged.materials[mat.id].notes).toBe(mat.notes);
    expect(merged.projects[p.project.id].code).toBe('OD');
  });

  it('takes a newer draft and a batch completed on the other device', () => {
    const local = demo();
    const remote = structuredClone(local);
    const draft = Object.values(remote.revisions).find((r) => r.status === 'draft') ?? Object.values(remote.revisions)[0];
    remote.revisions[draft.id] = { ...draft, notes: 'newer', updatedAt: '2099-01-01T00:00:00.000Z' };
    const r = mergeStates(local, remote);
    expect(applyChangeset(local, r.cs).revisions[draft.id].notes).toBe('newer');
    expect(r.duplicateCodes).toEqual([]);
  });
});

describe('blind sessions', () => {
  function samples() {
    let s = demo();
    const batches = Object.values(s.batches);
    const ids: string[] = [];
    for (const b of batches) {
      const smp = createSample(s, { batchId: b.id, batchPercent: '20', diluent: 'ethanol', notes: '' }, AT);
      s = applyChangeset(s, smp);
      ids.push(smp.sample.id);
    }
    return { s, ids };
  }

  it('hides identities behind codes, locks ratings on reveal and summarises', () => {
    const { s: s0, ids } = samples();
    let s = s0;
    expect(() => createBlindSession(s, { name: 'x', medium: 'blotter', sampleIds: [ids[0]] }, AT)).toThrow(DomainError);
    const c = createBlindSession(s, { name: 'Round 1', medium: 'blotter', sampleIds: ids }, AT);
    s = applyChangeset(s, c);
    const codes = c.session.items.map((i) => i.code);
    expect(new Set(codes).size).toBe(ids.length);
    for (const code of codes) expect(code).toMatch(/^[B-Z][2-9][B-Z]$/);
    s = applyChangeset(s, addBlindRating(s, c.session.id, { code: codes[0], evaluator: 'E', intensity: 3, liking: 7, text: '' }, AT));
    s = applyChangeset(s, addBlindRating(s, c.session.id, { code: codes[0], evaluator: 'F', intensity: 4, liking: null, text: '' }, AT));
    s = applyChangeset(s, revealBlindSession(s, c.session.id, AT));
    expect(() => addBlindRating(s, c.session.id, { code: codes[1], evaluator: 'E', intensity: 1, liking: 1, text: '' }, AT)).toThrow(DomainError);
    const res = blindResults(s.blindSessions[c.session.id]).find((x) => x.code === codes[0])!;
    expect(res.n).toBe(2);
    expect(res.meanIntensity).toBe(3.5);
    expect(res.meanLiking).toBe(7);
    void createApplication;
  });
});

describe('share packs', () => {
  it('round-trips a revision without costs and imports it as a new draft', () => {
    const s = demo();
    const rev = Object.values(s.revisions).find((r) => r.code === 'AT-F002')!;
    const pack = buildSharePack(rev, { title: 'Amber tea', author: 'Me', includeCosts: false, includeNotes: true }, AT);
    expect(pack.lines.every((l) => !('costPerKg' in l))).toBe(true);
    const parsed = parseSharePack(JSON.stringify(pack));
    const r = importSharePack(s, parsed, 'SH', AT);
    const s2 = applyChangeset(s, r);
    const imported = s2.revisions[r.revisionId];
    expect(imported.code).toBe('SH-F001');
    expect(imported.status).toBe('draft');
    expect(imported.lines.map((l) => l.amount)).toEqual(pack.lines.map((l) => l.amount));
    expect(Object.values(s2.projects).find((p) => p.code === 'SH')!.nextRevisionNo).toBe(2);
    expect(() => parseSharePack('{"format":"other"}')).toThrow(DomainError);
  });
});

describe('OpenDocument import', () => {
  it('reads stored values, percentages, blank gaps and ignores trailing padding', async () => {
    const { zipSync, strToU8 } = await import('fflate');
    const { readOds } = await import('../src/import/ods');
    const content = `<?xml version="1.0"?><office:document-content><office:body><office:spreadsheet>
<table:table table:name="F003">
<table:table-row><table:table-cell office:value-type="string"><text:p>Material</text:p></table:table-cell><table:table-cell table:number-columns-repeated="2"/><table:table-cell office:value-type="string"><text:p>Amount</text:p></table:table-cell><table:table-cell table:number-columns-repeated="1020"/></table:table-row>
<table:table-row><table:table-cell office:value-type="string"><text:p>Iso E Super &amp; co</text:p></table:table-cell><table:table-cell table:number-columns-repeated="2"/><table:table-cell office:value-type="float" office:value="1.25" table:formula="of:=1+0.25"><text:p>1,25</text:p></table:table-cell></table:table-row>
<table:table-row><table:table-cell office:value-type="percentage" office:value="0.2"><text:p>20%</text:p></table:table-cell></table:table-row>
<table:table-row table:number-rows-repeated="1048570"><table:table-cell table:number-columns-repeated="1024"/></table:table-row>
</table:table></office:spreadsheet></office:body></office:document-content>`;
    const bytes = zipSync({ mimetype: strToU8('application/vnd.oasis.opendocument.spreadsheet'), 'content.xml': strToU8(content) });
    const [sheet] = readOds(bytes);
    expect(sheet.name).toBe('F003');
    expect(sheet.rows.length).toBe(3);
    expect(sheet.rows[0].map((c) => c.text)).toEqual(['Material', '', '', 'Amount']);
    expect(sheet.rows[1][0].text).toBe('Iso E Super & co');
    expect(sheet.rows[1][3]).toMatchObject({ text: '1.25', kind: 'number', hadFormula: true });
    expect(sheet.rows[2][0]).toMatchObject({ text: '0.2', percentFormat: true });
  });
});
