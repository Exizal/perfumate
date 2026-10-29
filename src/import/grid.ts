/** A parsed spreadsheet cell. Workbook formulas are never evaluated. */
export interface Cell {
  text: string;
  kind: 'text' | 'number' | 'bool' | 'error' | 'formula_no_value' | 'empty';
  percentFormat?: boolean;
  /** The cell had a formula; only its cached value is used. */
  hadFormula?: boolean;
}

export interface Sheet {
  name: string;
  rows: Cell[][];
}

export const LIMITS = {
  maxFileBytes: 10 * 1024 * 1024,
  maxDecompressedBytes: 60 * 1024 * 1024,
  maxRows: 5000,
  maxCols: 60,
};

export class ImportError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

export function textCell(text: string): Cell {
  return { text, kind: text.trim() === '' ? 'empty' : 'text' };
}

/** Parse CSV/TSV text. Delimiter is detected from the first lines (tab, semicolon, comma). */
export function parseDelimited(input: string, delimiter?: string): { sheet: Sheet; delimiter: string } {
  const text = input.replace(/^﻿/, '');
  const sample = text.split(/\r?\n/).slice(0, 10).join('\n');
  const delim = delimiter ?? (['\t', ';', ','] as const)
    .map((d) => ({ d, n: countOutsideQuotes(sample, d) }))
    .sort((a, b) => b.n - a.n)[0].d;
  const rows: Cell[][] = [];
  let row: string[] = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false;
      else field += c;
      continue;
    }
    if (c === '"' && field === '') inQ = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row.map(textCell)); row = [];
      if (rows.length > LIMITS.maxRows) throw new ImportError('too_many_rows');
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row.map(textCell)); }
  while (rows.length && rows[rows.length - 1].every((c) => c.kind === 'empty')) rows.pop();
  if (rows.some((r) => r.length > LIMITS.maxCols)) throw new ImportError('too_many_columns');
  return { sheet: { name: 'Sheet1', rows }, delimiter: delim };
}

function countOutsideQuotes(s: string, d: string): number {
  let n = 0;
  let q = false;
  for (const c of s) {
    if (c === '"') q = !q;
    else if (!q && c === d) n++;
  }
  return n;
}
