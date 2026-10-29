// Writes fictional demonstration spreadsheets into samples/ for trying the importer.
import { writeFileSync } from 'node:fs';
import { EXAMPLE_SHEET } from '../src/import/example';
import { writeXlsx, type XCell } from '../src/import/xlsx';

writeFileSync('samples/amber-tea-F003-decimal-comma.csv', EXAMPLE_SHEET);
const point = EXAMPLE_SHEET.split('\n').map((l) => l.replace(/(\d),(\d)/g, '$1.$2').split(';').join(',')).join('\n');
writeFileSync('samples/amber-tea-F003-decimal-point.csv', point);
writeFileSync('samples/ambiguous-numbers.csv', 'Material;Grams\nHedione;1,250\nIso E Super;0,500\nAmbroxan;2.000\n');
const rows: XCell[][] = EXAMPLE_SHEET.trim().split('\n').map((l) => l.split(';').map((c) => {
  const n = c.replace(',', '.');
  return c !== '' && /^-?\d+(\.\d+)?$/.test(n) ? { v: n, t: 'n' as const } : { v: c || null };
}));
writeFileSync('samples/amber-tea-F003.xlsx', writeXlsx([{ name: 'Amber Tea F003', rows }]));
console.log('samples written');
