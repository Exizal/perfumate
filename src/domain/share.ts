import { DomainError } from './batch';
import { createDraft, createProject, newLine } from './revisions';
import { mergeChangesets, type AmountMode, type Changeset, type DataState, type FormulaRevision } from './types';

export const SHARE_FORMAT = 'micro-batch-lab-journal-share';

export interface SharePack {
  format: typeof SHARE_FORMAT;
  version: 1;
  sharedAt: string;
  author: string;
  title: string;
  sourceCode: string;
  amountMode: AmountMode;
  notes: string;
  lines: Array<{ name: string; strength: string | null; carrier: string | null; amount: string | null; note: string; costPerKg?: string | null; currency?: string | null }>;
}

/** A single formula revision as a file to send to a colleague. Costs are left out unless asked for. */
export function buildSharePack(rev: FormulaRevision, opts: { title: string; author: string; includeCosts: boolean; includeNotes: boolean }, at: string): SharePack {
  return {
    format: SHARE_FORMAT, version: 1, sharedAt: at, author: opts.author.trim(), title: opts.title.trim() || rev.code,
    sourceCode: rev.code, amountMode: rev.amountMode, notes: opts.includeNotes ? rev.notes : '',
    lines: rev.lines.filter((l) => l.materialName.trim() || l.amount !== null).map((l) => ({
      name: l.materialName, strength: l.strength, carrier: l.carrier, amount: l.amount,
      note: opts.includeNotes ? l.note : '',
      ...(opts.includeCosts ? { costPerKg: l.costPerKg, currency: l.currency } : {}),
    })),
  };
}

export function parseSharePack(text: string): SharePack {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new DomainError('share_invalid'); }
  const p = raw as SharePack;
  if (!p || p.format !== SHARE_FORMAT || p.version !== 1 || !Array.isArray(p.lines)) throw new DomainError('share_invalid');
  if (!['g', 'pct', 'parts'].includes(p.amountMode)) throw new DomainError('share_invalid');
  const okNum = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v));
  for (const l of p.lines) {
    if (typeof l.name !== 'string' || !okNum(l.amount) || !okNum(l.strength) || !okNum(l.costPerKg)) throw new DomainError('share_invalid');
  }
  return p;
}

/** Imports a share pack as a new project with one draft; names are linked to local materials only at freeze. */
export function importSharePack(state: DataState, pack: SharePack, projectCode: string, at: string): Changeset & { revisionId: string } {
  const proj = createProject(state, { name: pack.title, code: projectCode, objective: pack.author ? `Shared by ${pack.author}` : '' }, at);
  const st = { ...state, projects: { ...state.projects, [proj.project.id]: proj.project } };
  const draft = createDraft(st, {
    projectId: proj.project.id, amountMode: pack.amountMode, notes: pack.notes ?? '',
    changeReason: `Share pack ${pack.sourceCode}${pack.author ? ` from ${pack.author}` : ''}, ${String(pack.sharedAt).slice(0, 10)}`,
    lines: pack.lines.map((l) => newLine({
      materialName: l.name, strength: l.strength ?? null, carrier: l.carrier ?? null, amount: l.amount ?? null, note: l.note ?? '',
      costPerKg: l.costPerKg ?? null, currency: l.currency ?? null,
    })),
  }, at);
  // createDraft bumped the counter on its copy of the new project; keep that one.
  const { project: _p, projects: _ps, ...a } = proj;
  const { revision, ...b } = draft;
  return { ...mergeChangesets(a, b), revisionId: revision.id };
}
