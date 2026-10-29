import { audit, DomainError } from './batch';
import { nowISO, uid } from './ids';
import type { Application, Batch, Changeset, DataState, Observation, Sample } from './types';

/** When the blend was compounded. Completed batches use completion time; otherwise start time. */
export function compoundedAt(batch: Batch): string {
  return batch.completedAt ?? batch.startedAt;
}

export function batchAgeMs(batch: Batch, at: string): number {
  return new Date(at).getTime() - new Date(compoundedAt(batch)).getTime();
}

export function elapsedSinceApplication(app: Application, at: string): number {
  return new Date(at).getTime() - new Date(app.appliedAt).getTime();
}

export function createSample(
  state: DataState,
  input: { batchId: string; batchPercent: string | null; diluent: string; notes: string; preparedAt?: string },
  at = nowISO(),
): Changeset & { sample: Sample } {
  const batch = state.batches[input.batchId];
  if (!batch) throw new DomainError('not_found');
  if (batch.state !== 'completed') throw new DomainError('batch_not_completed');
  const n = Object.values(state.samples).filter((s) => s.batchId === batch.id).length + 1;
  const sample: Sample = {
    id: uid('smp'), createdAt: at, code: `${batch.code}-S${n}`, batchId: batch.id,
    preparedAt: input.preparedAt ?? at, batchPercent: input.batchPercent, diluent: input.diluent, notes: input.notes,
    demo: batch.demo,
  };
  return { sample, samples: [sample], audit: [audit('sample', sample.id, 'create', sample.code, at)] };
}

export function createApplication(
  state: DataState,
  input: { sampleId: string; medium: string; appliedAt: string; evaluator: string; checkpoints: number[]; notes: string },
  at = nowISO(),
): Changeset & { application: Application } {
  const sample = state.samples[input.sampleId];
  if (!sample) throw new DomainError('not_found');
  if (!input.medium.trim()) throw new DomainError('medium_required');
  const application: Application = {
    id: uid('app'), createdAt: at, sampleId: sample.id, medium: input.medium.trim(), appliedAt: input.appliedAt,
    evaluator: input.evaluator, checkpoints: [...input.checkpoints].sort((a, b) => a - b), notes: input.notes, demo: sample.demo,
  };
  return { application, applications: [application] };
}

export function addObservation(
  state: DataState,
  input: { applicationId: string; at: string; text: string; intensity: number | null; descriptors: string[]; checkpointMin: number | null },
  now = nowISO(),
): Changeset & { observation: Observation } {
  const app = state.applications[input.applicationId];
  if (!app) throw new DomainError('not_found');
  const sample = state.samples[app.sampleId];
  const batch = state.batches[sample.batchId];
  if (!input.text.trim() && input.intensity === null && input.descriptors.length === 0) throw new DomainError('observation_empty');
  const elapsed = elapsedSinceApplication(app, input.at);
  if (elapsed < 0) throw new DomainError('before_application');
  if (input.intensity !== null && (input.intensity < 0 || input.intensity > 5)) throw new DomainError('invalid_intensity');
  const observation: Observation = {
    id: uid('obs'), createdAt: now, applicationId: app.id, at: input.at,
    batchAgeMs: batchAgeMs(batch, input.at), elapsedMs: elapsed, checkpointMin: input.checkpointMin,
    text: input.text.trim(), intensity: input.intensity, descriptors: input.descriptors, demo: app.demo,
  };
  return { observation, observations: [observation] };
}

export interface DueEvaluation {
  application: Application;
  sample: Sample;
  checkpointMin: number;
  dueAt: Date;
}

/** Planned checkpoints whose time has arrived and that have no observation yet. */
export function dueEvaluations(state: DataState, now = new Date(), horizonMin = 60): DueEvaluation[] {
  const out: DueEvaluation[] = [];
  const obs = Object.values(state.observations);
  for (const app of Object.values(state.applications)) {
    if (app.deletedAt) continue;
    const sample = state.samples[app.sampleId];
    if (!sample) continue;
    for (const cp of app.checkpoints) {
      const dueAt = new Date(new Date(app.appliedAt).getTime() + cp * 60000);
      if (dueAt.getTime() > now.getTime() + horizonMin * 60000) continue;
      if (obs.some((o) => o.applicationId === app.id && o.checkpointMin === cp)) continue;
      if (now.getTime() - dueAt.getTime() > 3 * 86400000) continue; // stale beyond 3 days
      out.push({ application: app, sample, checkpointMin: cp, dueAt });
    }
  }
  return out.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
}

/** Format a duration in an unambiguous way: "7 d 2 h", "15 min", "1 h 05 min". */
export function formatDuration(ms: number | null, units: { d: string; h: string; min: string }): string {
  if (ms === null) return '—';
  const sign = ms < 0 ? '-' : '';
  let m = Math.floor(Math.abs(ms) / 60000);
  const d = Math.floor(m / 1440); m -= d * 1440;
  const h = Math.floor(m / 60); m -= h * 60;
  if (d > 0) return `${sign}${d} ${units.d} ${h} ${units.h}`;
  if (h > 0) return `${sign}${h} ${units.h} ${String(m).padStart(2, '0')} ${units.min}`;
  return `${sign}${m} ${units.min}`;
}

/**
 * Correct an observation by appending a superseding entry with a reason. The original stays in
 * the record with its timings; only the text, intensity and descriptors can change.
 */
export function amendObservation(
  state: DataState,
  input: { observationId: string; text: string; intensity: number | null; descriptors: string[]; reason: string },
  now = nowISO(),
): Changeset & { observation: Observation } {
  const orig = state.observations[input.observationId];
  if (!orig) throw new DomainError('not_found');
  if (supersededIds(state).has(orig.id)) throw new DomainError('already_superseded');
  if (!input.reason.trim()) throw new DomainError('reason_required');
  if (!input.text.trim() && input.intensity === null && input.descriptors.length === 0) throw new DomainError('observation_empty');
  if (input.intensity !== null && (input.intensity < 0 || input.intensity > 5)) throw new DomainError('invalid_intensity');
  const observation: Observation = {
    ...orig,
    id: uid('obs'),
    createdAt: now,
    text: input.text.trim(),
    intensity: input.intensity,
    descriptors: input.descriptors,
    supersedesId: orig.id,
    amendReason: input.reason.trim(),
  };
  return {
    observation,
    observations: [observation],
    audit: [audit('observation', orig.id, 'amend', input.reason.trim(), now)],
  };
}

/** Ids of observations that a later correction has replaced. */
export function supersededIds(state: DataState): Set<string> {
  const out = new Set<string>();
  for (const o of Object.values(state.observations)) if (o.supersedesId) out.add(o.supersedesId);
  return out;
}
