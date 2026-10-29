import { D, canon } from '../domain/decimal';

export type Convention = 'point' | 'comma';

export interface ParsedNumber {
  status: 'ok' | 'blank' | 'ambiguous' | 'invalid';
  /** Canonical decimal string when status is ok. */
  value: string | null;
  /** Whether the source carried a % sign or a percent cell format. */
  percent: boolean;
  /** Decimal convention this value reveals unambiguously, if any. */
  reveals: Convention | null;
  raw: string;
}

const SPACES = /[\s   ']/g;

/**
 * Parse a number written with either decimal convention. Without an explicit convention,
 * "1,250" and "1.250" are ambiguous and are flagged rather than guessed.
 */
export function parseNumber(raw: string, convention: Convention | null): ParsedNumber {
  const res = (status: ParsedNumber['status'], value: string | null, percent = false, reveals: Convention | null = null): ParsedNumber =>
    ({ status, value, percent, reveals, raw });
  let s = (raw ?? '').trim();
  if (s === '') return res('blank', null);
  let percent = false;
  if (s.endsWith('%')) { percent = true; s = s.slice(0, -1).trim(); }
  s = s.replace(SPACES, '');
  if (s === '') return res('invalid', null, percent);
  let sign = '';
  if (s[0] === '-' || s[0] === '+') { sign = s[0] === '-' ? '-' : ''; s = s.slice(1); }
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return res('invalid', null, percent);

  const commas = (s.match(/,/g) ?? []).length;
  const dots = (s.match(/\./g) ?? []).length;
  const finish = (intPart: string, frac: string, reveals: Convention | null) => {
    const v = `${sign}${intPart || '0'}${frac ? '.' + frac : ''}`;
    try {
      return res('ok', canon(D(v)), percent, reveals);
    } catch {
      return res('invalid', null, percent);
    }
  };
  const grouped = (intPart: string, sep: string) => {
    const g = intPart.split(sep);
    return g[0].length >= 1 && g[0].length <= 3 && g.slice(1).every((x) => x.length === 3);
  };

  if (commas === 0 && dots === 0) return finish(s, '', null);

  if (commas > 0 && dots > 0) {
    const lastComma = s.lastIndexOf(',');
    const lastDot = s.lastIndexOf('.');
    const decSep = lastComma > lastDot ? ',' : '.';
    const thouSep = decSep === ',' ? '.' : ',';
    const [intPart, frac] = [s.slice(0, s.lastIndexOf(decSep)), s.slice(s.lastIndexOf(decSep) + 1)];
    if (intPart.includes(decSep) || !grouped(intPart, thouSep)) return res('invalid', null, percent);
    const reveals: Convention = decSep === ',' ? 'comma' : 'point';
    if (convention && convention !== reveals) return res('invalid', null, percent, reveals);
    return finish(intPart.split(thouSep).join(''), frac, reveals);
  }

  const sep = commas > 0 ? ',' : '.';
  const count = commas + dots;
  const sepConv: Convention = sep === ',' ? 'comma' : 'point';
  const otherConv: Convention = sep === ',' ? 'point' : 'comma';
  if (count > 1) {
    // Several identical separators can only be thousands grouping.
    if (!grouped(s, sep)) return res('invalid', null, percent);
    if (convention === sepConv) return res('invalid', null, percent);
    return finish(s.split(sep).join(''), '', otherConv);
  }
  const [intPart, frac] = s.split(sep);
  const couldBeThousands = frac.length === 3 && intPart.length >= 1 && intPart.length <= 3 && !/^0*$/.test(intPart);
  if (couldBeThousands) {
    if (convention === null) return res('ambiguous', null, percent);
    if (convention === sepConv) return finish(intPart, frac, null);
    return finish(intPart + frac, '', null);
  }
  // Unambiguously a decimal separator ("0,12", "1,25", ",5", "12,3456").
  if (frac === '') return res('invalid', null, percent);
  if (convention && convention !== sepConv) return res('invalid', null, percent, sepConv);
  return finish(intPart, frac, sepConv);
}

/** Suggest a file convention from unambiguous evidence; "mixed" or "unknown" must be resolved by the user. */
export function detectConvention(raws: string[]): 'point' | 'comma' | 'mixed' | 'unknown' {
  let point = 0;
  let comma = 0;
  for (const r of raws) {
    const p = parseNumber(r, null);
    if (p.reveals === 'point') point++;
    if (p.reveals === 'comma') comma++;
  }
  if (point && comma) return 'mixed';
  if (point) return 'point';
  if (comma) return 'comma';
  return 'unknown';
}

/** Numeric cell from a workbook: always canonical with a point, never ambiguous. */
export function parseCellNumber(v: string, percentFormat: boolean): ParsedNumber {
  try {
    let d = D(v);
    if (percentFormat) d = d.times(100);
    return { status: 'ok', value: canon(d), percent: percentFormat, reveals: null, raw: v };
  } catch {
    return { status: 'invalid', value: null, percent: false, reveals: null, raw: v };
  }
}
