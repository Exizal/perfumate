import { strFromU8, unzipSync } from 'fflate';
import { ImportError, LIMITS, type Cell, type Sheet } from './grid';
import { decode } from './xlsx';

/**
 * Minimal, read-only OpenDocument spreadsheet (.ods) reader. Like the .xlsx reader it uses
 * stored cell values only: formulas, macros and links are never evaluated.
 */
export function readOds(bytes: Uint8Array): Sheet[] {
  if (bytes.byteLength > LIMITS.maxFileBytes) throw new ImportError('file_too_large');
  let content: Uint8Array | undefined;
  try {
    let total = 0;
    const files = unzipSync(bytes, {
      filter: (f) => {
        total += f.originalSize;
        if (f.originalSize > LIMITS.maxDecompressedBytes || total > LIMITS.maxDecompressedBytes) throw new ImportError('archive_too_large');
        return f.name === 'content.xml' || f.name === 'mimetype';
      },
    });
    const mime = files.mimetype ? strFromU8(files.mimetype).trim() : '';
    if (mime && mime !== 'application/vnd.oasis.opendocument.spreadsheet') throw new ImportError('not_ods');
    content = files['content.xml'];
  } catch (e) {
    if (e instanceof ImportError) throw e;
    throw new ImportError('not_ods');
  }
  if (!content) throw new ImportError('not_ods');
  const xml = strFromU8(content);
  const sheets: Sheet[] = [];
  const tableRe = /<table:table\b([^>]*)>([\s\S]*?)<\/table:table>/g;
  let m: RegExpExecArray | null;
  while ((m = tableRe.exec(xml))) {
    sheets.push({ name: decode(attr(m[1], 'table:name') ?? 'Sheet'), rows: parseTable(m[2]) });
  }
  if (!sheets.length) throw new ImportError('no_sheets');
  return sheets;
}

function attr(s: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name.replace(':', '\\:')}="([^"]*)"`).exec(s);
  return m ? m[1] : undefined;
}

function cellText(inner: string): string {
  const paras: string[] = [];
  const pRe = /<text:p\b[^>]*>([\s\S]*?)<\/text:p>/g;
  let m: RegExpExecArray | null;
  while ((m = pRe.exec(inner))) {
    paras.push(decode(m[1]
      .replace(/<text:s\b[^>]*?(?:text:c="(\d+)")?[^>]*\/>/g, (_, n) => ' '.repeat(Number(n ?? 1)))
      .replace(/<text:tab\b[^>]*\/>/g, '\t')
      .replace(/<text:line-break\b[^>]*\/>/g, '\n')
      .replace(/<[^>]+>/g, '')));
  }
  return paras.join('\n');
}

function parseTable(xml: string): Cell[][] {
  const rows: Cell[][] = [];
  const rowRe = /<table:table-row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/table:table-row>)/g;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(xml))) {
    const repeat = Math.min(Number(attr(m[1], 'table:number-rows-repeated') ?? 1), LIMITS.maxRows);
    const cells = parseRow(m[2] ?? '');
    // Trailing repeated empty rows are padding written by the editor; skip them.
    const empty = cells.every((c) => c.kind === 'empty');
    for (let i = 0; i < repeat; i++) {
      if (empty && repeat > 1) break;
      rows.push(i === 0 ? cells : cells.map((c) => ({ ...c })));
      if (rows.length > LIMITS.maxRows) throw new ImportError('too_many_rows');
    }
  }
  while (rows.length && rows[rows.length - 1].every((c) => c.kind === 'empty')) rows.pop();
  return rows;
}

function parseRow(xml: string): Cell[] {
  const row: Cell[] = [];
  // Blank runs are only materialised when a filled cell follows; trailing runs are padding.
  let pendingBlanks = 0;
  const cellRe = /<table:(?:covered-)?table-cell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/table:(?:covered-)?table-cell>)/g;
  let m: RegExpExecArray | null;
  while ((m = cellRe.exec(xml))) {
    const a = m[1];
    const repeat = Number(attr(a, 'table:number-columns-repeated') ?? 1);
    const type = attr(a, 'office:value-type');
    const value = attr(a, 'office:value');
    const hadFormula = !!attr(a, 'table:formula');
    let cell: Cell;
    if ((type === 'float' || type === 'currency') && value !== undefined) cell = { text: value, kind: 'number', hadFormula };
    else if (type === 'percentage' && value !== undefined) cell = { text: value, kind: 'number', percentFormat: true, hadFormula };
    else if (type === 'boolean') cell = { text: attr(a, 'office:boolean-value') ?? '', kind: 'bool', hadFormula };
    else {
      const text = cellText(m[2] ?? '');
      cell = text ? { text, kind: 'text', hadFormula } : hadFormula ? { text: '', kind: 'formula_no_value', hadFormula } : { text: '', kind: 'empty' };
    }
    if (cell.kind === 'empty') { pendingBlanks += repeat; continue; }
    if (row.length + pendingBlanks + repeat > LIMITS.maxCols) throw new ImportError('too_many_columns');
    for (; pendingBlanks > 0; pendingBlanks--) row.push({ text: '', kind: 'empty' });
    for (let i = 0; i < repeat; i++) row.push({ ...cell });
  }
  return row;
}
