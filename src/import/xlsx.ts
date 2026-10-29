import { strToU8, unzipSync, zipSync, strFromU8 } from 'fflate';
import { ImportError, LIMITS, type Cell, type Sheet } from './grid';

/**
 * Minimal, read-only .xlsx reader. Reads cached cell values only: no macros, no external
 * links, no formula evaluation. Formula cells without a cached value are flagged.
 */
export function readXlsx(bytes: Uint8Array): Sheet[] {
  if (bytes.byteLength > LIMITS.maxFileBytes) throw new ImportError('file_too_large');
  let total = 0;
  const wanted = /^(xl\/workbook\.xml|xl\/_rels\/workbook\.xml\.rels|xl\/sharedStrings\.xml|xl\/styles\.xml|xl\/worksheets\/[^/]+\.xml)$/;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (f) => {
        if (!wanted.test(f.name)) return false;
        total += f.originalSize;
        if (f.originalSize > LIMITS.maxDecompressedBytes || total > LIMITS.maxDecompressedBytes) throw new ImportError('archive_too_large');
        return true;
      },
    });
  } catch (e) {
    if (e instanceof ImportError) throw e;
    throw new ImportError('not_xlsx');
  }
  const wb = files['xl/workbook.xml'];
  if (!wb) throw new ImportError('not_xlsx');
  const shared = files['xl/sharedStrings.xml'] ? parseShared(strFromU8(files['xl/sharedStrings.xml'])) : [];
  const percentStyles = files['xl/styles.xml'] ? parsePercentStyles(strFromU8(files['xl/styles.xml'])) : new Set<number>();
  const rels = files['xl/_rels/workbook.xml.rels'] ? parseRels(strFromU8(files['xl/_rels/workbook.xml.rels'])) : {};
  const sheets: Sheet[] = [];
  const sheetRe = /<sheet\b([^>]*)\/?>/g;
  let m: RegExpExecArray | null;
  const wbXml = strFromU8(wb);
  while ((m = sheetRe.exec(wbXml))) {
    const name = decode(attr(m[1], 'name') ?? 'Sheet');
    const rid = attr(m[1], 'r:id');
    let target = rid ? rels[rid] : undefined;
    if (!target) continue;
    target = target.replace(/^\/?xl\//, '').replace(/^\//, '');
    const xml = files[`xl/${target}`];
    if (!xml) continue;
    sheets.push({ name, rows: parseSheet(strFromU8(xml), shared, percentStyles) });
  }
  if (!sheets.length) throw new ImportError('no_sheets');
  return sheets;
}

function attr(s: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name.replace(':', '\\:')}="([^"]*)"`).exec(s);
  return m ? m[1] : undefined;
}

export function decode(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

function parseShared(xml: string): string[] {
  const out: string[] = [];
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = siRe.exec(xml))) {
    const parts: string[] = [];
    const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
    let t: RegExpExecArray | null;
    // Skip phonetic runs (<rPh>) used in Japanese workbooks.
    const body = m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
    while ((t = tRe.exec(body))) parts.push(decode(t[1]));
    out.push(parts.join(''));
  }
  return out;
}

function parsePercentStyles(xml: string): Set<number> {
  const custom = new Map<number, string>();
  const nfRe = /<numFmt\b([^>]*)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = nfRe.exec(xml))) custom.set(Number(attr(m[1], 'numFmtId')), decode(attr(m[1], 'formatCode') ?? ''));
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml);
  const out = new Set<number>();
  if (!xfs) return out;
  const xfRe = /<xf\b([^>]*)\/?>/g;
  let i = 0;
  while ((m = xfRe.exec(xfs[1]))) {
    const id = Number(attr(m[1], 'numFmtId') ?? 0);
    const code = custom.get(id) ?? '';
    if (id === 9 || id === 10 || /%/.test(code.replace(/"[^"]*"/g, ''))) out.add(i);
    i++;
  }
  return out;
}

function parseRels(xml: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /<Relationship\b([^>]*)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const id = attr(m[1], 'Id');
    const target = attr(m[1], 'Target');
    if (id && target) out[id] = target;
  }
  return out;
}

function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseSheet(xml: string, shared: string[], percentStyles: Set<number>): Cell[][] {
  const rows: Cell[][] = [];
  const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>/g;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(xml))) {
    const rIdx = Number(attr(rm[1], 'r') ?? rows.length + 1) - 1;
    if (rIdx >= LIMITS.maxRows) throw new ImportError('too_many_rows');
    const row: Cell[] = [];
    const cRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm: RegExpExecArray | null;
    while ((cm = cRe.exec(rm[2]))) {
      const a = cm[1];
      const body = cm[2] ?? '';
      const ref = attr(a, 'r');
      const ci = ref ? colIndex(ref) : row.length;
      if (ci >= LIMITS.maxCols) continue;
      const t = attr(a, 't') ?? 'n';
      const s = Number(attr(a, 's') ?? 0);
      const hasF = /<f\b/.test(body);
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let cell: Cell;
      if (t === 'inlineStr') {
        const txt = [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((x) => decode(x[1])).join('');
        cell = { text: txt, kind: txt.trim() ? 'text' : 'empty' };
      } else if (v === undefined) {
        cell = hasF ? { text: '', kind: 'formula_no_value', hadFormula: true } : { text: '', kind: 'empty' };
      } else if (t === 's') {
        const txt = shared[Number(v)] ?? '';
        cell = { text: txt, kind: txt.trim() ? 'text' : 'empty' };
      } else if (t === 'str') {
        cell = { text: decode(v), kind: 'text', hadFormula: hasF };
      } else if (t === 'b') {
        cell = { text: v === '1' ? 'TRUE' : 'FALSE', kind: 'bool' };
      } else if (t === 'e') {
        cell = { text: decode(v), kind: 'error', hadFormula: hasF };
      } else {
        cell = { text: v, kind: 'number', percentFormat: percentStyles.has(s), hadFormula: hasF };
      }
      while (row.length < ci) row.push({ text: '', kind: 'empty' });
      row[ci] = cell;
    }
    while (rows.length < rIdx) rows.push([]);
    rows[rIdx] = row;
  }
  return rows;
}

// ---------- writer ----------

export interface XCell {
  v: string | number | null;
  /** Numeric cells are written as numbers; text is always written as an inline string. */
  t?: 'n' | 's';
  /** Optional live formula (without the leading "="); v is its cached value. */
  f?: string;
  /** Optional style: header, bold text, number with decimals, percent-like number, bold number, title. */
  s?: XStyle;
}

export type XStyle = 'head' | 'bold' | 'dec' | 'dec_bold' | 'title' | 'input';

export interface XSheet {
  name: string;
  rows: XCell[][];
  /** Column widths in characters. */
  cols?: number[];
  /** Freeze rows above this 1-based row (e.g. 2 keeps row 1 visible). */
  freezeBelow?: number;
}

const STYLE_IDS: Record<XStyle, number> = { head: 1, bold: 2, dec: 3, dec_bold: 4, title: 5, input: 6 };

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
  + `<numFmts count="1"><numFmt numFmtId="164" formatCode="0.0000"/></numFmts>`
  + `<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font></fonts>`
  + `<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>`
  + `<fill><patternFill patternType="solid"><fgColor rgb="FFE4ECEC"/><bgColor indexed="64"/></patternFill></fill>`
  + `<fill><patternFill patternType="solid"><fgColor rgb="FFFBF2DF"/><bgColor indexed="64"/></patternFill></fill></fills>`
  + `<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FF999999"/></bottom><diagonal/></border></borders>`
  + `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>`
  + `<cellXfs count="7">`
  + `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>`
  + `<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>`
  + `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>`
  + `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`
  + `<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>`
  + `<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>`
  + `<xf numFmtId="164" fontId="1" fillId="3" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/>`
  + `</cellXfs></styleSheet>`;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

export function colName(i: number): string {
  let s = '';
  i++;
  while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

export function sheetName(n: string): string {
  return n.slice(0, 31).replace(/[\\/?*[\]:]/g, ' ');
}

/** Text that a spreadsheet could interpret as a formula is prefixed with an apostrophe. */
export function escapeFormulaText(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

export function writeXlsx(sheets: XSheet[]): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  files['[Content_Types].xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`);
  files['_rels/.rels'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  // fullCalcOnLoad makes Excel and LibreOffice recompute formulas when the file opens.
  files['xl/workbook.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(sheetName(s.name))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`);
  files['xl/_rels/workbook.xml.rels'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  files['xl/styles.xml'] = strToU8(STYLES_XML);
  sheets.forEach((s, i) => {
    const rowsXml = s.rows.map((r, ri) => `<row r="${ri + 1}">${r.map((c, ci) => {
      const ref = `${colName(ci)}${ri + 1}`;
      const st = c.s ? ` s="${STYLE_IDS[c.s]}"` : '';
      if (c.f) {
        const cached = c.v === null || c.v === '' ? '' : `<v>${esc(String(c.v))}</v>`;
        const isText = c.v !== null && c.t !== 'n' && typeof c.v !== 'number';
        return `<c r="${ref}"${st}${isText ? ' t="str"' : ''}><f>${esc(c.f)}</f>${cached}</c>`;
      }
      if (c.v === null || c.v === '') return st ? `<c r="${ref}"${st}/>` : '';
      if (c.t === 'n' || typeof c.v === 'number') return `<c r="${ref}"${st}><v>${esc(String(c.v))}</v></c>`;
      return `<c r="${ref}"${st} t="inlineStr"><is><t xml:space="preserve">${esc(escapeFormulaText(String(c.v)))}</t></is></c>`;
    }).join('')}</row>`).join('');
    const pane = s.freezeBelow && s.freezeBelow > 1
      ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${s.freezeBelow - 1}" topLeftCell="A${s.freezeBelow}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` : '';
    const cols = s.cols?.length ? `<cols>${s.cols.map((w, ci) => `<col min="${ci + 1}" max="${ci + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${pane}${cols}<sheetData>${rowsXml}</sheetData></worksheet>`);
  });
  return zipSync(files);
}
