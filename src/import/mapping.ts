import { strengthHintFromName } from '../domain/formula';
import { newLine } from '../domain/revisions';
import type { AmountMode, FormulaLine, Material } from '../domain/types';
import type { Cell, Sheet } from './grid';
import { detectConvention, parseCellNumber, parseNumber, type Convention, type ParsedNumber } from './numbers';

export type Field = 'material' | 'amount' | 'strength' | 'carrier' | 'cost' | 'currency' | 'note' | 'keep' | 'ignore';
export const FIELDS: Field[] = ['material', 'amount', 'strength', 'carrier', 'cost', 'currency', 'note', 'keep', 'ignore'];

const HEADER_HINTS: Array<[Field, RegExp]> = [
  ['material', /^(material|materials|ingredient|ingredients|name|raw material|materia( prima)?|mati[eè]re|ingrediente|原料|材料|素材|hammadde|malzeme|bile[sş]en)/i],
  ['strength', /(dilution|dil\.?|strength|conc|stock|diluci[oó]n|concentraci[oó]n|diluizione|concentrazione|稀释|濃度|希釈|seyreltme|konsantrasyon)/i],
  ['carrier', /(solvent|carrier|diluent|alcohol\/dpg|disolvente|solvant|solvente|溶剂|溶剤|[cç][oö]z[uü]c[uü]|ta[sş][iı]y[iı]c[iı])/i],
  ['cost', /(cost|price|coste|costo|prix|co[uû]t|precio|prezzo|价格|成本|価格|fiyat|maliyet)/i],
  ['currency', /^(currency|moneda|devise|valuta|货币|通貨|para birimi)$/i],
  ['note', /^(note|notes|comment|comments|nota|notas|remarque|备注|メモ|not|notlar|a[cç][iı]klama)/i],
  ['amount', /(amount|grams|gram|weight|parts|quantity|qty|^g$|^%$|percent|cantidad|gramos|peso|partes|poids|quantit[eé]|grammi|parti|用量|重量|份|分量|重さ|miktar|gram|a[gğ][iı]rl[iı]k|formula)/i],
];

export function guessField(header: string): Field {
  const h = header.trim();
  if (!h) return 'ignore';
  for (const [f, re] of HEADER_HINTS) if (re.test(h)) return f;
  return 'keep';
}

/** Header row = first row (within the first 25) containing a recognisable material column. */
export function guessHeaderRow(sheet: Sheet): number {
  for (let i = 0; i < Math.min(25, sheet.rows.length); i++) {
    const row = sheet.rows[i] ?? [];
    const texts = row.map((c) => c.text);
    if (texts.some((t) => guessField(t) === 'material') && texts.filter((t) => t.trim()).length >= 2) return i;
  }
  return 0;
}

export function guessMapping(sheet: Sheet, headerRow: number): string[] {
  const headers = (sheet.rows[headerRow] ?? []).map((c) => c.text);
  const used = new Set<Field>();
  return headers.map((h) => {
    const f = guessField(h);
    if (f !== 'keep' && f !== 'ignore' && used.has(f)) return 'keep';
    used.add(f);
    return f;
  });
}

export function guessAmountMode(header: string): AmountMode {
  if (/%|percent|porcentaje|pourcentage|percentuale|百分|パーセント|y[uü]zde/i.test(header)) return 'pct';
  if (/part|parti|partes|份|部/i.test(header)) return 'parts';
  return 'g';
}

export type RowFlag =
  | 'total_row' | 'formula_no_value' | 'blank_amount' | 'ambiguous' | 'invalid_number' | 'zero_amount'
  | 'strength_in_name' | 'unknown_strength' | 'error_cell' | 'no_name';

export interface PreviewRow {
  rowIndex: number;
  include: boolean;
  name: string;
  amount: ParsedNumber;
  strength: ParsedNumber;
  strengthHint: { strength: string; carrier: string | null } | null;
  carrier: string;
  cost: ParsedNumber;
  currency: string;
  note: string;
  extra: Record<string, string>;
  flags: RowFlag[];
  /** Suggested existing material (exact name match only), or null for a new material. */
  materialMatch: string | null;
}

export interface PreviewOptions {
  headerRow: number;
  mapping: string[];
  convention: Convention | null;
  blankStrength: 'unknown' | 'neat';
  materials: Material[];
}

const TOTAL_RE = /^(total|totals|sum|subtotal|toplam|totale|somme|suma|合计|合計|总计|小計)\b/i;

function readNum(cell: Cell | undefined, convention: Convention | null): ParsedNumber {
  if (!cell || cell.kind === 'empty') return { status: 'blank', value: null, percent: false, reveals: null, raw: '' };
  if (cell.kind === 'formula_no_value' || cell.kind === 'error') return { status: 'invalid', value: null, percent: false, reveals: null, raw: cell.text };
  if (cell.kind === 'number') return parseCellNumber(cell.text, !!cell.percentFormat);
  return parseNumber(cell.text, convention);
}

/** Every raw text cell in numeric columns, for detecting the file's number convention. */
export function numericRawTexts(sheet: Sheet, headerRow: number, mapping: string[]): string[] {
  const cols = mapping.map((f, i) => (f === 'amount' || f === 'strength' || f === 'cost' ? i : -1)).filter((i) => i >= 0);
  const out: string[] = [];
  for (let r = headerRow + 1; r < sheet.rows.length; r++) {
    for (const c of cols) {
      const cell = sheet.rows[r]?.[c];
      if (cell && cell.kind === 'text') out.push(cell.text);
    }
  }
  return out;
}

export function conventionNeeded(sheet: Sheet, headerRow: number, mapping: string[]): { suggestion: ReturnType<typeof detectConvention>; ambiguousCount: number } {
  const raws = numericRawTexts(sheet, headerRow, mapping);
  return {
    suggestion: detectConvention(raws),
    ambiguousCount: raws.filter((r) => parseNumber(r, null).status === 'ambiguous').length,
  };
}

export function buildPreview(sheet: Sheet, opt: PreviewOptions): PreviewRow[] {
  const headers = (sheet.rows[opt.headerRow] ?? []).map((c, i) => c.text.trim() || `Column ${i + 1}`);
  const col = (f: Field) => opt.mapping.indexOf(f);
  const byName = new Map(opt.materials.filter((m) => !m.deletedAt).map((m) => [m.name, m.id]));
  const out: PreviewRow[] = [];
  for (let r = opt.headerRow + 1; r < sheet.rows.length; r++) {
    const row = sheet.rows[r] ?? [];
    if (row.every((c) => !c || c.kind === 'empty')) continue;
    const get = (f: Field) => (col(f) >= 0 ? row[col(f)] : undefined);
    const name = (get('material')?.text ?? '').trim();
    const amount = readNum(get('amount'), opt.convention);
    let strength = readNum(get('strength'), opt.convention);
    const flags: RowFlag[] = [];
    const cells = row.filter(Boolean);
    if (cells.some((c) => c.kind === 'formula_no_value')) flags.push('formula_no_value');
    if (cells.some((c) => c.kind === 'error')) flags.push('error_cell');
    if (TOTAL_RE.test(name)) flags.push('total_row');
    if (!name) flags.push('no_name');
    if (amount.status === 'blank') flags.push('blank_amount');
    if (amount.status === 'ambiguous' || strength.status === 'ambiguous') flags.push('ambiguous');
    if (amount.status === 'invalid' && get('amount')?.kind !== 'formula_no_value') flags.push('invalid_number');
    if (amount.status === 'ok' && amount.value === '0') flags.push('zero_amount');
    const hint = name ? strengthHintFromName(name) : null;
    if (hint && strength.status === 'blank') flags.push('strength_in_name');
    if (strength.status === 'blank') {
      if (opt.blankStrength === 'neat') strength = { ...strength, status: 'ok', value: '100' };
      else flags.push('unknown_strength');
    }
    // A strength column written as a fraction (0.1) in a percent-formatted cell has already been scaled.
    const extra: Record<string, string> = {};
    opt.mapping.forEach((f, i) => { if (f === 'keep' && row[i] && row[i].kind !== 'empty') extra[headers[i]] = row[i].text; });
    out.push({
      rowIndex: r,
      include: !flags.includes('total_row') && !!name,
      name,
      amount,
      strength,
      strengthHint: hint,
      carrier: (get('carrier')?.text ?? '').trim(),
      cost: readNum(get('cost'), opt.convention),
      currency: (get('currency')?.text ?? '').trim(),
      note: (get('note')?.text ?? '').trim(),
      extra,
      flags,
      materialMatch: byName.get(name) ?? null,
    });
  }
  return out;
}

/** Rows that block committing: unresolved ambiguity, invalid numbers or missing cached values. */
export function blockingRows(rows: PreviewRow[]): PreviewRow[] {
  return rows.filter((r) => r.include && (
    r.flags.includes('ambiguous') || r.flags.includes('invalid_number') || r.flags.includes('formula_no_value')
    || r.flags.includes('error_cell') || r.flags.includes('no_name') || r.strength.status === 'invalid'
    || r.cost.status === 'invalid' || r.cost.status === 'ambiguous'
  ));
}

export function previewToLines(rows: PreviewRow[], defaultCurrency: string, acceptHints: Set<number>): FormulaLine[] {
  return rows.filter((r) => r.include).map((r) => {
    const useHint = acceptHints.has(r.rowIndex) && r.strengthHint;
    return newLine({
      materialId: r.materialMatch,
      materialName: r.name,
      amount: r.amount.status === 'ok' ? r.amount.value : null,
      strength: useHint ? r.strengthHint!.strength : r.strength.status === 'ok' ? r.strength.value : null,
      carrier: useHint && r.strengthHint!.carrier ? r.strengthHint!.carrier : r.carrier || null,
      costPerKg: r.cost.status === 'ok' ? r.cost.value : null,
      currency: r.cost.status === 'ok' ? (r.currency || defaultCurrency) : null,
      note: r.note,
      extra: Object.keys(r.extra).length ? r.extra : undefined,
    });
  });
}
