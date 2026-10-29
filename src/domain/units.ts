import { D, Dec, type DecStr } from './decimal';

/** Grams from a volume the user measured, using the material's recorded density (g/mL). */
export function gramsFromVolume(ml: DecStr, densityGPerMl: DecStr | null | undefined): Dec | null {
  if (!densityGPerMl) return null;
  const d = D(densityGPerMl);
  if (d.lessThanOrEqualTo(0)) return null;
  return D(ml).times(d);
}

/**
 * Parse one line of balance output. Most laboratory balances send lines such as
 * "ST,GS,+   0.1200 g", "     12.345 g" or "N     +0.120 g"; "US" or "?" marks an unstable reading.
 */
export function parseBalanceLine(line: string): { grams: string; stable: boolean } | null {
  const text = line.trim();
  if (!text) return null;
  const m = /([+-]?)\s*(\d+(?:\.\d+)?)\s*(g|mg|kg)\b/i.exec(text);
  if (!m) return null;
  let v = D(m[2]);
  const unit = m[3].toLowerCase();
  if (unit === 'mg') v = v.dividedBy(1000);
  if (unit === 'kg') v = v.times(1000);
  if (m[1] === '-') v = v.negated();
  const unstable = /\bUS\b|\?|\bD\b/.test(text.toUpperCase());
  return { grams: v.toFixed(), stable: !unstable };
}
