import { D, Dec } from './decimal';
import { lineShares } from './formula';
import type { DataState, FormulaRevision } from './types';

export interface ExplodedLine {
  /** Material id, or the recorded name when the line is not linked to a material. */
  key: string;
  name: string;
  /** % of the formula as parent material, after expanding accords. null = unknown strength somewhere on the path. */
  parentPct: Dec | null;
  /** Accord codes the material reached this formula through, outermost first. */
  via: string[];
}

const MAX_DEPTH = 6;

/**
 * Expand accord ingredients into their own materials. An accord line at 10 % of a 50 % stock
 * contributes 5 % accord, and each accord material contributes its share of that 5 %.
 */
export function explodeRevision(state: DataState, rev: Pick<FormulaRevision, 'amountMode' | 'lines' | 'id'>): ExplodedLine[] {
  const out = new Map<string, ExplodedLine>();
  const walk = (r: Pick<FormulaRevision, 'amountMode' | 'lines' | 'id'>, factor: Dec | null, via: string[], seen: Set<string>) => {
    const shares = new Map(lineShares(r).map((s) => [s.lineId, s]));
    for (const l of r.lines) {
      if (!l.materialName.trim() && l.amount === null) continue;
      const share = shares.get(l.id);
      const part = share?.parentPct == null || factor === null ? null : share.parentPct.times(factor).dividedBy(100);
      const mat = l.materialId ? state.materials[l.materialId] : undefined;
      const accord = mat?.accordRevisionId ? state.revisions[mat.accordRevisionId] : undefined;
      if (accord && !seen.has(accord.id) && via.length < MAX_DEPTH) {
        walk(accord, part, [...via, accord.code], new Set([...seen, accord.id]));
        continue;
      }
      const key = l.materialId ?? `name:${l.materialName.trim()}`;
      const cur = out.get(key);
      if (cur) {
        cur.parentPct = cur.parentPct === null || part === null ? null : cur.parentPct.plus(part);
        for (const v of via) if (!cur.via.includes(v)) cur.via.push(v);
      } else {
        out.set(key, { key, name: mat?.name ?? l.materialName, parentPct: part, via: [...via] });
      }
    }
  };
  walk(rev, D(100), [], new Set([rev.id]));
  return [...out.values()];
}

export function usesAccords(state: DataState, rev: Pick<FormulaRevision, 'lines'>): boolean {
  return rev.lines.some((l) => l.materialId && state.materials[l.materialId]?.accordRevisionId);
}

export type LimitStatus = 'over' | 'ok' | 'unknown' | 'no_limit';

export interface LimitCheck {
  key: string;
  name: string;
  /** % parent material in the finished product at the given dose. */
  productPct: Dec | null;
  maxPct: Dec | null;
  source: string;
  status: LimitStatus;
}

/**
 * Compare each material against the maximum the user recorded for it. These are the user's own
 * limits with their stated source; the result is a working check, not a compliance statement.
 */
export function limitChecks(state: DataState, rev: Pick<FormulaRevision, 'amountMode' | 'lines' | 'id'>, dosePct: Dec): LimitCheck[] {
  return explodeRevision(state, rev).map((x) => {
    const mat = state.materials[x.key];
    const max = mat?.maxPct ? D(mat.maxPct) : null;
    const productPct = x.parentPct === null ? null : x.parentPct.times(dosePct).dividedBy(100);
    const status: LimitStatus = max === null ? 'no_limit' : productPct === null ? 'unknown' : productPct.greaterThan(max) ? 'over' : 'ok';
    return { key: x.key, name: x.name, productPct, maxPct: max, source: mat?.limitSource ?? '', status };
  });
}
