import { DomainError, audit } from './batch';
import { nowISO, uid } from './ids';
import type { BlindRating, BlindSession, Changeset, DataState } from './types';

// Codes avoid look-alike characters (0/O, 1/I/L) and carry no order.
const LETTERS = 'BCDFGHJKMNPQRSTVWXZ';
const DIGITS = '23456789';

function randomInt(n: number): number {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.getRandomValues) return c.getRandomValues(new Uint32Array(1))[0] % n;
  return Math.floor(Math.random() * n);
}

export function blindCodes(count: number): string[] {
  const out = new Set<string>();
  while (out.size < count) {
    out.add(LETTERS[randomInt(LETTERS.length)] + DIGITS[randomInt(DIGITS.length)] + LETTERS[randomInt(LETTERS.length)]);
  }
  return [...out];
}

export function shuffle<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function createBlindSession(state: DataState, input: { name: string; medium: string; sampleIds: string[] }, at = nowISO()): Changeset & { session: BlindSession } {
  if (!input.name.trim()) throw new DomainError('name_required');
  const ids = [...new Set(input.sampleIds)].filter((id) => state.samples[id]);
  if (ids.length < 2) throw new DomainError('blind_needs_two');
  const codes = blindCodes(ids.length);
  const session: BlindSession = {
    id: uid('blind'), createdAt: at, updatedAt: at, name: input.name.trim(), medium: input.medium,
    items: shuffle(ids).map((sampleId, i) => ({ code: codes[i], sampleId })),
    ratings: [], revealedAt: null, notes: '',
  };
  return { session, blindSessions: [session], audit: [audit('blind', session.id, 'create', session.name, at)] };
}

export function addBlindRating(state: DataState, sessionId: string, r: Omit<BlindRating, 'id' | 'at'>, at = nowISO()): Changeset {
  const s = state.blindSessions[sessionId];
  if (!s) throw new DomainError('not_found');
  if (s.revealedAt) throw new DomainError('blind_revealed');
  if (!s.items.some((i) => i.code === r.code)) throw new DomainError('not_found');
  if (!r.evaluator.trim()) throw new DomainError('evaluator_required');
  const rating: BlindRating = { ...r, evaluator: r.evaluator.trim(), id: uid('rating'), at };
  return { blindSessions: [{ ...s, ratings: [...s.ratings, rating], updatedAt: at }] };
}

/** Revealing is one-way: ratings are locked so they cannot be revised after identities are known. */
export function revealBlindSession(state: DataState, sessionId: string, at = nowISO()): Changeset {
  const s = state.blindSessions[sessionId];
  if (!s) throw new DomainError('not_found');
  if (s.revealedAt) return {};
  return { blindSessions: [{ ...s, revealedAt: at, updatedAt: at }], audit: [audit('blind', s.id, 'reveal', s.name, at)] };
}

export interface BlindResult {
  code: string;
  sampleId: string;
  n: number;
  meanIntensity: number | null;
  meanLiking: number | null;
}

export function blindResults(s: BlindSession): BlindResult[] {
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return s.items.map((it) => {
    const rs = s.ratings.filter((r) => r.code === it.code);
    return {
      code: it.code, sampleId: it.sampleId, n: rs.length,
      meanIntensity: mean(rs.flatMap((r) => (r.intensity === null ? [] : [r.intensity]))),
      meanLiking: mean(rs.flatMap((r) => (r.liking === null ? [] : [r.liking]))),
    };
  });
}
