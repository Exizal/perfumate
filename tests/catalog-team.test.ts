import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { applyChangeset, emptyState, type DataState } from '../src/domain/types';
import { buildDemo } from '../src/domain/demo';
import { FAMILIES, KINDS, searchCatalog, scoreName, type CatalogEntry } from '../src/catalog/catalog';
import catalogJson from '../src/catalog/materials.json';
import { writeXlsx } from '../src/import/xlsx';
import { readXlsx } from '../src/import/xlsx';
import { revisionWorkbook } from '../src/services/exporters';
import { eventChanges, nextPosition, normalizeUrl, personSlot, roomLinesToFormula, upsertLine, type RoomEvent, type RoomLine } from '../src/services/team';

const catalog = catalogJson as CatalogEntry[];

function demo(): DataState {
  return applyChangeset(emptyState(), buildDemo(emptyState(), new Date('2026-10-28T12:00:00Z')));
}

describe('material catalog', () => {
  it('is well formed, large and has no duplicate names', () => {
    expect(catalog.length).toBeGreaterThan(2000);
    const names = new Set(catalog.map((e) => e.n.toLowerCase()));
    expect(names.size).toBe(catalog.length);
    for (const e of catalog) {
      expect(FAMILIES).toContain(e.f);
      expect(KINDS).toContain(e.k);
      expect(Array.isArray(e.a)).toBe(true);
    }
  });

  it('ranks a name prefix first and finds materials by alias', () => {
    expect(searchCatalog(catalog, 'hedi')[0].item.n).toBe('Hedione');
    const byAlias = searchCatalog(catalog, 'methyl dihydrojasmonate', 5).map((h) => h.item.n);
    expect(byAlias).toContain('Hedione');
    expect(searchCatalog(catalog, 'iso e')[0].item.n).toBe('Iso E Super');
    expect(searchCatalog(catalog, 'bergamot').every((h) => /bergamot/i.test(h.item.n + h.item.a.join(' ')))).toBe(true);
  });

  it('matches words in any order and ignores accents and case', () => {
    expect(scoreName('absolute rose', 'Rose absolute Turkey').score).toBeGreaterThan(0);
    expect(scoreName('ROSE', 'Rosé').score).toBeGreaterThan(0);
    expect(scoreName('xyzzy', 'Hedione').score).toBe(0);
  });

  it('filters by family and kind', () => {
    const hits = searchCatalog(catalog, '', 50, { family: 'citrus', kind: 'natural' });
    expect(hits.length).toBe(50);
    expect(hits.every((h) => h.item.f === 'citrus' && h.item.k === 'natural')).toBe(true);
  });
});

describe('Excel workbook for a formula', () => {
  it('writes live formulas, totals and a scale sheet that Excel can open', () => {
    const s = demo();
    const rev = Object.values(s.revisions).find((r) => r.code === 'AT-F002')!;
    const sheets = revisionWorkbook(s, rev);
    const bytes = writeXlsx(sheets);
    const files = unzipSync(bytes);
    expect(Object.keys(files)).toContain('xl/styles.xml');
    const sheet1 = strFromU8(files['xl/worksheets/sheet1.xml']);
    const n = rev.lines.filter((l) => l.materialName || l.amount).length;
    const tot = 5 + n;
    expect(sheet1).toContain(`<f>SUM(D5:D${tot - 1})</f>`);
    expect(sheet1).toContain(`<f>IF($D$${tot}=0,&quot;&quot;,D5/$D$${tot}*100)</f>`);
    expect(sheet1).toContain('<pane ySplit="4"');
    expect(strFromU8(files['xl/workbook.xml'])).toContain('fullCalcOnLoad="1"');
    const scale = strFromU8(files['xl/worksheets/sheet2.xml']);
    expect(scale).toContain('<f>IF(B5=&quot;&quot;,&quot;&quot;,B5/100*$B$2)</f>');
    // The cached values read back through our own importer.
    const [read] = readXlsx(bytes);
    expect(read.rows[3][0].text).toBe('Material');
    expect(read.rows[4][0].text).toBe(rev.lines[0].materialName);
  });
});

describe('team session helpers', () => {
  const line = (id: string, position: number, extra: Partial<RoomLine> = {}): RoomLine => ({
    id, room_id: 'r', position, material_name: id, amount: '1', strength: null, note: '', added_by: 'u1', added_by_name: 'Ayla',
    updated_by_name: 'Ayla', created_at: '2026-10-29T10:00:00Z', updated_at: '2026-10-29T10:00:00Z', ...extra,
  });

  it('keeps lines ordered and replaces a line updated elsewhere', () => {
    let ls = [line('a', 1), line('c', 3)];
    ls = upsertLine(ls, line('b', 2));
    expect(ls.map((l) => l.id)).toEqual(['a', 'b', 'c']);
    ls = upsertLine(ls, line('b', 2, { amount: '5' }));
    expect(ls.find((l) => l.id === 'b')!.amount).toBe('5');
    expect(ls.length).toBe(3);
    expect(nextPosition(ls)).toBe(4);
  });

  it('turns shared lines into a local draft, keeping who added them', () => {
    const f = roomLinesToFormula([line('Hedione', 1, { amount: '12.5', note: 'try more' }), line('', 2, { amount: null })]);
    expect(f.length).toBe(1);
    expect(f[0].materialName).toBe('Hedione');
    expect(f[0].amount).toBe('12.5');
    expect(f[0].note).toBe('try more (Ayla)');
  });

  it('lists only the fields that changed', () => {
    const ev: RoomEvent = {
      id: 1, room_id: 'r', at: '', actor: 'u2', actor_name: 'Deniz', kind: 'changed', line_id: 'x', material_name: 'Hedione',
      before: { material_name: 'Hedione', amount: '10', strength: null, note: '' },
      after: { material_name: 'Hedione', amount: '12', strength: null, note: '' },
    };
    expect(eventChanges(ev)).toEqual([{ field: 'amount', before: '10', after: '12' }]);
  });

  it('normalises project URLs and gives people a stable colour', () => {
    expect(normalizeUrl('abcd.supabase.co/')).toBe('https://abcd.supabase.co');
    expect(() => normalizeUrl('not a url')).toThrow();
    expect(personSlot('user-1')).toBe(personSlot('user-1'));
    expect(personSlot('user-1')).toBeGreaterThanOrEqual(0);
    expect(personSlot('user-1')).toBeLessThan(8);
  });
});
