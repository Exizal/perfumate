import Decimal from 'decimal.js';

// Decimal is the source of truth for every mass, percentage and cost.
// Values are stored as canonical strings ("0.120") and never as JS numbers.
export const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export type Dec = Decimal;

/** A canonical decimal string, or null meaning "unknown" (never zero). */
export type DecStr = string;

export function D(v: DecStr | number | Decimal): Decimal {
  return new Dec(v as Decimal.Value);
}

export function isDecStr(v: unknown): v is string {
  if (typeof v !== 'string' || v.trim() === '') return false;
  return /^-?\d+(\.\d+)?$/.test(v.trim());
}

/** Canonical string without exponent notation and without trailing zeros. */
export function canon(v: Decimal): DecStr {
  const s = v.toFixed();
  if (!s.includes('.')) return s;
  return s.replace(/0+$/, '').replace(/\.$/, '');
}

export function sum(values: Array<DecStr | Decimal>): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(v instanceof Dec ? v : D(v as DecStr)), D(0));
}

/** Number of decimal places implied by a readability such as "0.001" -> 3. */
export function placesOf(readability: DecStr): number {
  const r = D(readability);
  return Math.max(0, r.decimalPlaces());
}

export interface Rounded {
  exact: string;
  shown: string;
  /** True when the shown value differs from the exact value. */
  rounded: boolean;
  /** True when a non-zero value would display as zero at this precision. */
  belowDisplay: boolean;
}

/** Round for display only. A non-zero trace is never presented as zero. */
export function roundForDisplay(v: Decimal, places: number): Rounded {
  const shownDec = v.toDecimalPlaces(places, Dec.ROUND_HALF_UP);
  const belowDisplay = !v.isZero() && shownDec.isZero();
  return {
    exact: canon(v),
    shown: shownDec.toFixed(places),
    rounded: !shownDec.equals(v),
    belowDisplay,
  };
}
