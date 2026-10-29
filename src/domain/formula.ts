import { D, Dec, canon, sum, type DecStr } from './decimal';
import type { AmountMode, FormulaLine, FormulaRevision } from './types';

/** Parent-material equivalent of a weighed stock mass. Unknown strength stays unknown. */
export function parentEquivalent(mass: DecStr | Dec, strengthPct: DecStr | null): Dec | null {
  if (strengthPct === null) return null;
  const m = mass instanceof Dec ? mass : D(mass);
  return m.times(D(strengthPct)).dividedBy(100);
}

/** Strength of a stock prepared from a source of known strength: nested fractions multiply. */
export function preparedStrength(sourceMass: DecStr, sourceStrength: DecStr | null, carrierMass: DecStr): Dec | null {
  if (sourceStrength === null) return null;
  const total = D(sourceMass).plus(D(carrierMass));
  if (total.isZero()) return null;
  return D(sourceMass).times(D(sourceStrength)).dividedBy(total);
}

export function amountTotal(lines: FormulaLine[]): Dec {
  return sum(lines.filter((l) => l.amount !== null).map((l) => l.amount as string));
}

export interface LineShare {
  lineId: string;
  /** % of formula by mass of the supplied material (stock as weighed). */
  pct: Dec | null;
  /** % of formula as parent-material equivalent; null when strength is unknown. */
  parentPct: Dec | null;
}

/** Formula percentage by mass = line mass / total formula mass x 100. */
export function lineShares(rev: Pick<FormulaRevision, 'amountMode' | 'lines'>): LineShare[] {
  const total = amountTotal(rev.lines);
  return rev.lines.map((l) => {
    if (l.amount === null || total.isZero()) return { lineId: l.id, pct: null, parentPct: null };
    const pct = rev.amountMode === 'pct' ? D(l.amount) : D(l.amount).dividedBy(total).times(100);
    return { lineId: l.id, pct, parentPct: parentEquivalent(pct, l.strength) };
  });
}

export type RevisionIssue =
  | { kind: 'pct_total'; total: string }
  | { kind: 'blank_amount'; lineId: string }
  | { kind: 'negative_amount'; lineId: string }
  | { kind: 'no_name'; lineId: string }
  | { kind: 'unknown_strength'; lineId: string }
  | { kind: 'empty' };

export function revisionIssues(rev: Pick<FormulaRevision, 'amountMode' | 'lines'>): RevisionIssue[] {
  const issues: RevisionIssue[] = [];
  const used = rev.lines.filter((l) => l.materialName.trim() !== '' || l.amount !== null);
  if (used.length === 0) issues.push({ kind: 'empty' });
  for (const l of used) {
    if (l.materialName.trim() === '') issues.push({ kind: 'no_name', lineId: l.id });
    if (l.amount === null) issues.push({ kind: 'blank_amount', lineId: l.id });
    else if (D(l.amount).isNegative()) issues.push({ kind: 'negative_amount', lineId: l.id });
    if (l.strength === null) issues.push({ kind: 'unknown_strength', lineId: l.id });
  }
  if (rev.amountMode === 'pct') {
    const total = amountTotal(used);
    if (!total.equals(100)) issues.push({ kind: 'pct_total', total: canon(total) });
  }
  return issues;
}

/** Issues that prevent freezing or batching (unknown strength is allowed but flagged). */
export function blockingIssues(issues: RevisionIssue[]): RevisionIssue[] {
  return issues.filter((i) => i.kind !== 'unknown_strength');
}

export interface NormalizePreview {
  factor: Dec;
  lines: Array<{ lineId: string; before: string; after: string }>;
}

/** Explicit, previewable normalization of a % formula to 100. Nothing is applied here. */
export function normalizePreview(rev: Pick<FormulaRevision, 'amountMode' | 'lines'>, places = 6): NormalizePreview | null {
  const total = amountTotal(rev.lines);
  if (total.isZero()) return null;
  const factor = D(100).dividedBy(total);
  return {
    factor,
    lines: rev.lines
      .filter((l) => l.amount !== null)
      .map((l) => ({
        lineId: l.id,
        before: l.amount as string,
        after: canon(D(l.amount as string).times(factor).toDecimalPlaces(places)),
      })),
  };
}

/** Convert amounts between modes for display only. Stored amounts stay in the revision's own mode. */
export function convertAmounts(lines: FormulaLine[], from: AmountMode, to: AmountMode, gramsTotal = '100'): FormulaLine[] {
  if (from === to) return lines;
  const total = amountTotal(lines);
  if (total.isZero()) return lines;
  const target = to === 'pct' ? D(100) : to === 'parts' ? D(1000) : D(gramsTotal);
  return lines.map((l) =>
    l.amount === null ? l : { ...l, amount: canon(D(l.amount).dividedBy(total).times(target)) },
  );
}

export interface PlannedLine {
  lineId: string;
  materialName: string;
  strength: DecStr | null;
  targetGrams: Dec;
  parentGrams: Dec | null;
  belowPracticalMin: boolean;
  belowReadability: boolean;
}

export interface BatchPlan {
  size: Dec;
  lines: PlannedLine[];
  total: Dec;
  error: 'pct_total' | 'empty' | 'blank_amount' | null;
}

/**
 * Plan grams of each supplied material for a batch of `size` grams.
 * Grams and parts modes scale proportionally; % mode requires an exact 100 total.
 */
export function planBatch(
  rev: Pick<FormulaRevision, 'amountMode' | 'lines'>,
  size: DecStr,
  practicalMin: DecStr,
  readability: DecStr,
): BatchPlan {
  const S = D(size);
  const lines = rev.lines.filter((l) => l.materialName.trim() !== '' || l.amount !== null);
  if (lines.length === 0) return { size: S, lines: [], total: D(0), error: 'empty' };
  if (lines.some((l) => l.amount === null)) return { size: S, lines: [], total: D(0), error: 'blank_amount' };
  const total = amountTotal(lines);
  if (rev.amountMode === 'pct' && !total.equals(100)) return { size: S, lines: [], total, error: 'pct_total' };
  if (total.isZero()) return { size: S, lines: [], total, error: 'empty' };
  const min = D(practicalMin);
  const read = D(readability);
  const planned = lines.map<PlannedLine>((l) => {
    const g = rev.amountMode === 'pct'
      ? D(l.amount as string).dividedBy(100).times(S)
      : D(l.amount as string).dividedBy(total).times(S);
    return {
      lineId: l.id,
      materialName: l.materialName,
      strength: l.strength,
      targetGrams: g,
      parentGrams: parentEquivalent(g, l.strength),
      belowPracticalMin: !g.isZero() && g.lessThan(min),
      belowReadability: !g.isZero() && g.lessThan(read),
    };
  });
  return { size: S, lines: planned, total: sum(planned.map((p) => p.targetGrams)), error: null };
}

/** Parse "Iso E Super 10%" or "Ambroxan (10% in DPG)" into a suggestion; never applied silently. */
export function strengthHintFromName(name: string): { strength: string; carrier: string | null } | null {
  const m = /(\d+(?:[.,]\d+)?)\s*%(?:\s*(?:in|en|dans|in|içinde|@)?\s*([A-Za-z]{2,10}))?/i.exec(name);
  if (!m) return null;
  return { strength: m[1].replace(',', '.'), carrier: m[2] ? m[2].toUpperCase() : null };
}
