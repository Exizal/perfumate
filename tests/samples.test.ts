import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDelimited, type Sheet } from '../src/import/grid';
import { readXlsx } from '../src/import/xlsx';
import { buildPreview, blockingRows, conventionNeeded, guessHeaderRow, guessMapping, previewToLines } from '../src/import/mapping';

const dir = join(__dirname, '../samples');

function importSheet(sheet: Sheet) {
  const h = guessHeaderRow(sheet);
  const mapping = guessMapping(sheet, h);
  const need = conventionNeeded(sheet, h, mapping);
  const convention = need.suggestion === 'point' || need.suggestion === 'comma' ? need.suggestion : null;
  const rows = buildPreview(sheet, { headerRow: h, mapping, convention, blankStrength: 'unknown', materials: [] });
  return { rows, lines: previewToLines(rows, 'EUR', new Set()).map((l) => [l.materialName, l.amount, l.strength, l.costPerKg, l.extra?.Notes ?? '']) };
}

describe('sample spreadsheets', () => {
  it('decimal-comma CSV, decimal-point CSV and XLSX import to identical lines', () => {
    const comma = importSheet(parseDelimited(readFileSync(join(dir, 'amber-tea-F003-decimal-comma.csv'), 'utf8')).sheet);
    const point = importSheet(parseDelimited(readFileSync(join(dir, 'amber-tea-F003-decimal-point.csv'), 'utf8')).sheet);
    const xlsx = importSheet(readXlsx(new Uint8Array(readFileSync(join(dir, 'amber-tea-F003.xlsx'))))[0]);
    expect(comma.lines).toHaveLength(10);
    expect(point.lines).toEqual(comma.lines);
    expect(xlsx.lines).toEqual(comma.lines);
    expect(comma.lines.find((l) => l[0] === 'Animalis (base)')).toEqual(['Animalis (base)', '0.2', null, null, '']);
    expect(blockingRows(comma.rows)).toHaveLength(0);
  });
  it('ambiguous file is blocked until a convention is chosen', () => {
    const sheet = parseDelimited(readFileSync(join(dir, 'ambiguous-numbers.csv'), 'utf8')).sheet;
    const need = conventionNeeded(sheet, 0, ['material', 'amount']);
    expect(need.ambiguousCount).toBe(2); // "1,250" and "2.000"
    expect(need.suggestion).toBe('comma'); // "0,500" reveals a decimal comma, but the user still confirms
  });
});
