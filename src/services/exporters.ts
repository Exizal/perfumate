import { canon, D } from '../domain/decimal';
import { lineShares } from '../domain/formula';
import { batchEvents, composition } from '../domain/batch';
import { toCsv } from '../domain/backup';
import { supersededIds } from '../domain/journal';
import { writeXlsx, type XCell, type XSheet } from '../import/xlsx';
import type { Batch, DataState, FormulaRevision } from '../domain/types';
import { download } from '../ui/common';

// Export headers are stable English column names so files re-import predictably.
// Material names are exported exactly as recorded.

function revisionRows(rev: FormulaRevision): { header: string[]; rows: Array<Array<{ v: string | null; n?: boolean }>> } {
  const shares = new Map(lineShares(rev).map((s) => [s.lineId, s]));
  const unit = rev.amountMode === 'g' ? 'Grams' : rev.amountMode === 'pct' ? 'Percent' : 'Parts';
  const extraKeys = [...new Set(rev.lines.flatMap((l) => Object.keys(l.extra ?? {})))];
  const header = ['Material', 'Stock strength %', 'Carrier', `Amount (${unit}, as supplied)`, '% of formula', 'Parent equivalent %', 'Cost per kg', 'Currency', 'Note', ...extraKeys];
  const rows = rev.lines.filter((l) => l.materialName || l.amount).map((l) => {
    const s = shares.get(l.id);
    return [
      { v: l.materialName }, { v: l.strength, n: true }, { v: l.carrier }, { v: l.amount, n: true },
      { v: s?.pct ? canon(s.pct.toDecimalPlaces(6)) : null, n: true },
      { v: s?.parentPct ? canon(s.parentPct.toDecimalPlaces(6)) : null, n: true },
      { v: l.costPerKg, n: true }, { v: l.currency }, { v: l.note },
      ...extraKeys.map((k) => ({ v: l.extra?.[k] ?? null })),
    ];
  });
  return { header, rows };
}

function batchRows(state: DataState, batch: Batch) {
  const c = composition(state, batch);
  const header = ['Material', 'Stock strength %', 'Carrier', 'Original target g', 'Current target g', 'Actual g', '% of batch (as weighed)', 'Parent equivalent g', 'Cost', 'Currency'];
  const rows = c.lines.map((l) => {
    const bl = batch.lines.find((x) => x.lineId === l.lineId)!;
    return [
      { v: l.materialName }, { v: l.strength, n: true }, { v: bl.carrier }, { v: canon(l.originalTarget), n: true },
      { v: canon(l.currentTarget), n: true }, { v: canon(l.actual), n: true },
      { v: l.actualPct ? canon(l.actualPct.toDecimalPlaces(6)) : null, n: true },
      { v: l.parentGrams ? canon(l.parentGrams) : null, n: true },
      { v: l.cost ? canon(l.cost.toDecimalPlaces(4)) : null, n: true }, { v: l.cost ? l.currency : null },
    ];
  });
  return { header, rows };
}

function eventRows(state: DataState, batch: Batch) {
  const header = ['Time', 'Material', 'Kind', 'Mass g', 'Lot', 'Cost per kg', 'Currency', 'Reason', 'Event id'];
  const rows = batchEvents(state, batch.id).map((e) => [
    { v: e.at }, { v: batch.lines.find((l) => l.lineId === e.lineId)?.materialName ?? '' }, { v: e.kind },
    { v: e.mass, n: true }, { v: e.lotId ? state.lots[e.lotId]?.lotCode ?? e.lotId : null },
    { v: e.costPerKg, n: true }, { v: e.currency }, { v: e.reason }, { v: e.id },
  ]);
  return { header, rows };
}

const toX = (t: { header: string[]; rows: Array<Array<{ v: string | null; n?: boolean }>> }): XCell[][] => [
  t.header.map((h) => ({ v: h })),
  ...t.rows.map((r) => r.map((c) => (c.n && c.v !== null ? { v: c.v, t: 'n' as const } : { v: c.v }))),
];

export function exportRevisionCsv(rev: FormulaRevision): void {
  const r = revisionRows(rev);
  download(`${rev.code}.csv`, '﻿' + toCsv(r.header, r.rows), 'text/csv;charset=utf-8');
}

const num = (v: string | null | undefined): number | null => (v === null || v === undefined || v === '' ? null : Number(v));

/**
 * Builds a working Excel workbook for one revision: the lines with live formulas for
 * % of formula, parent equivalent and cost, a totals row, and a Scale sheet where the
 * batch size can be typed in and every weight recalculates.
 */
export function revisionWorkbook(state: DataState, rev: FormulaRevision): XSheet[] {
  const project = state.projects[rev.projectId];
  const unit = rev.amountMode === 'g' ? 'g' : rev.amountMode === 'pct' ? '%' : 'parts';
  const shares = new Map(lineShares(rev).map((x) => [x.lineId, x]));
  const lines = rev.lines.filter((l) => l.materialName || l.amount);
  const first = 5; // first line row (1-based)
  const last = first + Math.max(lines.length, 1) - 1;
  const totRow = last + 1;
  const total = lines.reduce((a, l) => a + (num(l.amount) ?? 0), 0);
  const head = (v: string): XCell => ({ v, s: 'head' });
  const rows: XCell[][] = [
    [{ v: `${rev.code}${project ? ` ${project.name}` : ''}`, s: 'title' }],
    [{ v: `Status: ${rev.status}` }, { v: `Amounts in ${unit}` }, { v: rev.changeReason ? `Change: ${rev.changeReason}` : '' }],
    [{ v: 'Edit the Amount, Strength and Cost columns; the other columns recalculate.' }],
    [head('Material'), head('Stock strength %'), head('Carrier'), head(`Amount (${unit})`), head('% of formula'),
      head('Parent equivalent %'), head('Cost per kg'), head('Currency'), head('Cost share per kg of formula'), head('Note')],
  ];
  lines.forEach((l, i) => {
    const r = first + i;
    const sh = shares.get(l.id);
    const pctV = sh?.pct ? Number(canon(sh.pct.toDecimalPlaces(6))) : null;
    const parentV = sh?.parentPct ? Number(canon(sh.parentPct.toDecimalPlaces(6))) : null;
    const costV = pctV !== null && l.costPerKg ? Number(((num(l.costPerKg)! * pctV) / 100).toFixed(4)) : null;
    rows.push([
      { v: l.materialName }, { v: num(l.strength), t: 'n', s: 'dec' }, { v: l.carrier }, { v: num(l.amount), t: 'n', s: 'dec' },
      { v: pctV, t: 'n', s: 'dec', f: `IF($D$${totRow}=0,"",D${r}/$D$${totRow}*100)` },
      { v: parentV, t: 'n', s: 'dec', f: `IF(OR(B${r}="",E${r}=""),"",E${r}*B${r}/100)` },
      { v: num(l.costPerKg), t: 'n', s: 'dec' }, { v: l.currency },
      { v: costV, t: 'n', s: 'dec', f: `IF(OR(G${r}="",E${r}=""),"",G${r}*E${r}/100)` },
      { v: l.note },
    ]);
  });
  if (!lines.length) rows.push([]);
  const costTotal = lines.every((l) => l.costPerKg) && lines.length
    ? Number(lines.reduce((a, l) => a + (num(l.costPerKg)! * (Number(canon(shares.get(l.id)?.pct?.toDecimalPlaces(6) ?? D(0))))) / 100, 0).toFixed(4)) : null;
  rows.push([
    { v: 'Total', s: 'bold' }, { v: null }, { v: null },
    { v: total, t: 'n', s: 'dec_bold', f: `SUM(D${first}:D${last})` },
    { v: lines.length ? 100 : 0, t: 'n', s: 'dec_bold', f: `SUM(E${first}:E${last})` },
    { v: null }, { v: null }, { v: null },
    { v: costTotal, t: 'n', s: 'dec_bold', f: `SUM(I${first}:I${last})` },
  ]);

  // Scale sheet: type a batch size, get grams per material.
  const fname = `'${rev.code.replace(/'/g, "''").slice(0, 31)}'`;
  const scale: XCell[][] = [
    [{ v: 'Scale to a batch size', s: 'title' }],
    [{ v: 'Batch size (g)', s: 'bold' }, { v: 10, t: 'n', s: 'input' }, { v: 'Type a new size; the grams below recalculate.' }],
    [],
    [head('Material'), head('% of formula'), head('Grams to weigh'), head('Stock strength %')],
  ];
  lines.forEach((l, i) => {
    const src = first + i;
    const r = 5 + i;
    const pctV = shares.get(l.id)?.pct ? Number(canon(shares.get(l.id)!.pct!.toDecimalPlaces(6))) : null;
    scale.push([
      { v: l.materialName, f: `${fname}!A${src}&""` },
      { v: pctV, t: 'n', s: 'dec', f: `${fname}!E${src}` },
      { v: pctV === null ? null : Number((pctV / 10).toFixed(4)), t: 'n', s: 'dec', f: `IF(B${r}="","",B${r}/100*$B$2)` },
      { v: num(l.strength), t: 'n', s: 'dec', f: `IF(${fname}!B${src}="","",${fname}!B${src})` },
    ]);
  });
  const sLast = 5 + Math.max(lines.length, 1) - 1;
  scale.push([{ v: 'Total', s: 'bold' }, { v: lines.length ? 100 : 0, t: 'n', s: 'dec_bold', f: `SUM(B5:B${sLast})` },
    { v: lines.length ? 10 : 0, t: 'n', s: 'dec_bold', f: `SUM(C5:C${sLast})` }]);

  return [
    { name: rev.code, rows, cols: [34, 16, 14, 16, 14, 18, 12, 10, 22, 30], freezeBelow: 5 },
    { name: 'Scale', rows: scale, cols: [34, 14, 16, 16], freezeBelow: 5 },
  ];
}

export function exportRevisionXlsx(state: DataState, rev: FormulaRevision): void {
  download(`${rev.code}.xlsx`, writeXlsx(revisionWorkbook(state, rev)), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}

export function exportBatchCsv(state: DataState, batch: Batch): void {
  const r = batchRows(state, batch);
  download(`${batch.code}.csv`, '﻿' + toCsv(r.header, r.rows), 'text/csv;charset=utf-8');
}

export function exportBatchXlsx(state: DataState, batch: Batch): void {
  download(`${batch.code}.xlsx`, writeXlsx([
    { name: batch.code, rows: toX(batchRows(state, batch)) },
    { name: 'Weigh events', rows: toX(eventRows(state, batch)) },
  ]), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}

/** One workbook with every revision, batch and observation, for use in Excel. */
export function exportWorkbook(state: DataState): void {
  const sheets: Array<{ name: string; rows: XCell[][] }> = [];
  const revs = Object.values(state.revisions).filter((r) => !r.deletedAt).sort((a, b) => a.code.localeCompare(b.code));
  sheets.push({
    name: 'Revisions',
    rows: toX({
      header: ['Code', 'Project', 'Status', 'Parent', 'Change reason', 'Amount mode', 'Frozen at', 'Demo'],
      rows: revs.map((r) => [
        { v: r.code }, { v: state.projects[r.projectId]?.name ?? '' }, { v: r.status },
        { v: r.parentRevisionId ? state.revisions[r.parentRevisionId]?.code ?? '' : '' }, { v: r.changeReason },
        { v: r.amountMode }, { v: r.frozenAt }, { v: r.demo ? 'yes' : '' },
      ]),
    }),
  });
  for (const r of revs) sheets.push({ name: r.code, rows: toX(revisionRows(r)) });
  const batches = Object.values(state.batches).sort((a, b) => a.code.localeCompare(b.code));
  for (const b of batches) sheets.push({ name: b.code, rows: toX(batchRows(state, b)) });
  const replaced = supersededIds(state);
  sheets.push({
    name: 'Observations',
    rows: toX({
      header: ['Batch', 'Sample', 'Sample % of batch', 'Diluent', 'Medium', 'Evaluator', 'Applied at', 'Observed at', 'Batch age (h)', 'Since application (min)', 'Intensity 0-5', 'Descriptors', 'Text', 'Demo', 'Replaced by correction', 'Correction reason'],
      rows: Object.values(state.observations).sort((x, y) => x.at.localeCompare(y.at)).map((o) => {
        const app = state.applications[o.applicationId];
        const smp = app ? state.samples[app.sampleId] : undefined;
        const b = smp ? state.batches[smp.batchId] : undefined;
        return [
          { v: b?.code ?? '' }, { v: smp?.code ?? '' }, { v: smp?.batchPercent ?? null, n: true }, { v: smp?.diluent ?? '' },
          { v: app?.medium ?? '' }, { v: app?.evaluator ?? '' }, { v: app?.appliedAt ?? '' }, { v: o.at },
          { v: o.batchAgeMs === null ? null : (o.batchAgeMs / 3600000).toFixed(2), n: true },
          { v: (o.elapsedMs / 60000).toFixed(1), n: true },
          { v: o.intensity === null ? null : String(o.intensity), n: true }, { v: o.descriptors.join('; ') }, { v: o.text },
          { v: o.demo ? 'yes' : '' },
          { v: replaced.has(o.id) ? 'yes' : '' }, { v: o.amendReason ?? '' },
        ];
      }),
    }),
  });
  const seen = new Set<string>();
  for (const s of sheets) {
    let n = s.name.slice(0, 31);
    let i = 2;
    while (seen.has(n)) n = `${s.name.slice(0, 28)}-${i++}`;
    seen.add(n);
    s.name = n;
  }
  download(`perfumate-${new Date().toISOString().slice(0, 10)}.xlsx`, writeXlsx(sheets), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}
