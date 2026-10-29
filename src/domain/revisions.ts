import { blockingIssues, revisionIssues } from './formula';
import { audit, DomainError } from './batch';
import { nowISO, revisionCode, uid } from './ids';
import type { AmountMode, Changeset, DataState, FormulaLine, FormulaRevision, Material, Project } from './types';

export function newLine(partial: Partial<FormulaLine> = {}): FormulaLine {
  return {
    id: uid('line'), materialId: null, materialName: '', strength: '100', carrier: null,
    amount: null, costPerKg: null, currency: null, note: '', ...partial,
  };
}

export function createProject(state: DataState, input: { name: string; code: string; objective: string; isAccord?: boolean }, at = nowISO()): Changeset & { project: Project } {
  const code = input.code.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,6}$/.test(code)) throw new DomainError('invalid_code');
  if (Object.values(state.projects).some((p) => !p.deletedAt && p.code === code)) throw new DomainError('duplicate_code');
  if (!input.name.trim()) throw new DomainError('name_required');
  const project: Project = {
    id: uid('proj'), createdAt: at, code, name: input.name.trim(), objective: input.objective.trim(),
    nextRevisionNo: 1, nextBatchNo: 1, ...(input.isAccord ? { isAccord: true } : {}),
  };
  return { project, projects: [project], audit: [audit('project', project.id, 'create', project.name, at)] };
}

export function createDraft(
  state: DataState,
  input: { projectId: string; lines: FormulaLine[]; amountMode: AmountMode; parentRevisionId?: string | null; changeReason?: string; notes?: string; importId?: string | null },
  at = nowISO(),
): Changeset & { revision: FormulaRevision } {
  const project = state.projects[input.projectId];
  if (!project) throw new DomainError('not_found');
  const n = project.nextRevisionNo;
  const revision: FormulaRevision = {
    id: uid('rev'), createdAt: at, updatedAt: at, projectId: project.id, code: revisionCode(project.code, n), number: n,
    parentRevisionId: input.parentRevisionId ?? null, changeReason: input.changeReason ?? '',
    status: 'draft', basis: 'as_supplied_mass', amountMode: input.amountMode, lines: input.lines,
    notes: input.notes ?? '', frozenAt: null, importId: input.importId ?? null,
  };
  return {
    revision,
    revisions: [revision],
    projects: [{ ...project, nextRevisionNo: n + 1 }],
    audit: [audit('revision', revision.id, 'create', revision.code, at)],
  };
}

/** Drafts are editable. Frozen revisions are immutable: this refuses to touch them. */
export function updateDraft(state: DataState, revisionId: string, patch: Partial<Pick<FormulaRevision, 'lines' | 'amountMode' | 'notes' | 'changeReason'>>, at = nowISO()): Changeset {
  const rev = state.revisions[revisionId];
  if (!rev) throw new DomainError('not_found');
  if (rev.status !== 'draft') throw new DomainError('revision_frozen');
  return { revisions: [{ ...rev, ...patch, updatedAt: at }] };
}

/** Freeze a draft. Unlinked material names become new material records (never merged by similarity). */
export function freezeRevision(state: DataState, revisionId: string, at = nowISO()): Changeset {
  const rev = state.revisions[revisionId];
  if (!rev) throw new DomainError('not_found');
  if (rev.status === 'frozen') return {};
  const lines = rev.lines.filter((l) => l.materialName.trim() !== '' || l.amount !== null);
  const blocking = blockingIssues(revisionIssues({ ...rev, lines }));
  if (blocking.length) throw new DomainError(`cannot_freeze:${blocking[0].kind}`);
  const created: Material[] = [];
  const byExactName = new Map<string, string>();
  for (const m of Object.values(state.materials)) if (!m.deletedAt) byExactName.set(m.name, m.id);
  const linked = lines.map((l) => {
    if (l.materialId && state.materials[l.materialId]) return l;
    const exact = byExactName.get(l.materialName.trim());
    if (exact) return { ...l, materialId: exact };
    const m: Material = {
      id: uid('mat'), createdAt: at, name: l.materialName.trim(), grade: '', supplier: '', cas: '', notes: '', demo: rev.demo,
    };
    created.push(m);
    byExactName.set(m.name, m.id);
    return { ...l, materialId: m.id };
  });
  // A frozen accord revision becomes a material that other formulas can use as one ingredient.
  const project = state.projects[rev.projectId];
  if (project?.isAccord && !Object.values(state.materials).some((m) => m.accordRevisionId === rev.id)) {
    created.push({
      id: uid('mat'), createdAt: at, name: `${rev.code} ${project.name}`, grade: 'accord', supplier: '', cas: '',
      notes: '', accordRevisionId: rev.id, demo: rev.demo,
    });
  }
  return {
    revisions: [{ ...rev, lines: linked, status: 'frozen', frozenAt: at, updatedAt: at }],
    materials: created,
    audit: [audit('revision', rev.id, 'freeze', rev.code, at)],
  };
}

/** Fork a new draft from any revision, recording why. The source is untouched. */
export function forkRevision(state: DataState, revisionId: string, reason: string, at = nowISO()): Changeset & { revision: FormulaRevision } {
  const src = state.revisions[revisionId];
  if (!src) throw new DomainError('not_found');
  if (!reason.trim()) throw new DomainError('reason_required');
  const lines = src.lines.map((l) => ({ ...l, id: uid('line'), extra: l.extra ? { ...l.extra } : undefined }));
  return createDraft(state, {
    projectId: src.projectId, lines, amountMode: src.amountMode, parentRevisionId: src.id, changeReason: reason.trim(),
  }, at);
}

export function revisionsInBatches(state: DataState): Set<string> {
  return new Set(Object.values(state.batches).map((b) => b.revisionId));
}

export function softDelete<T extends { deletedAt?: string | null }>(rec: T, at = nowISO()): T {
  return { ...rec, deletedAt: at };
}

export function restoreDeleted<T extends { deletedAt?: string | null }>(rec: T): T {
  return { ...rec, deletedAt: null };
}

/** Name and objective can change; the code is fixed because it is part of every revision and batch ID. */
export function updateProject(state: DataState, id: string, patch: { name: string; objective: string }, at = nowISO()): Changeset {
  const p = state.projects[id];
  if (!p) throw new DomainError('not_found');
  if (!patch.name.trim()) throw new DomainError('name_required');
  return {
    projects: [{ ...p, name: patch.name.trim(), objective: patch.objective.trim() }],
    audit: [audit('project', p.id, 'edit', `${p.name} -> ${patch.name.trim()}`, at)],
  };
}

/** Recoverable deletion: the project is hidden; its revisions, batches and labels keep resolving. */
export function deleteProject(state: DataState, id: string, at = nowISO()): Changeset {
  const p = state.projects[id];
  if (!p) throw new DomainError('not_found');
  const open = Object.values(state.batches).some((b) => b.projectId === id && (b.state === 'in_progress' || b.state === 'paused'));
  if (open) throw new DomainError('project_has_open_batch');
  return { projects: [softDelete(p, at)], audit: [audit('project', p.id, 'delete', p.name, at)] };
}
