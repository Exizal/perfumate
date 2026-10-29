import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en';
import { es } from '../src/i18n/es';
import { fr } from '../src/i18n/fr';
import { it as itDict } from '../src/i18n/it';
import { ja } from '../src/i18n/ja';
import { tr } from '../src/i18n/tr';
import { zh } from '../src/i18n/zh';

const dicts: Record<string, Record<string, string>> = { es, fr, it: itDict, ja, tr, zh };
const placeholders = (s: string) => (s.match(/\{[a-z]+\}/gi) ?? []).sort().join(',');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
}

describe('localization', () => {
  for (const [code, d] of Object.entries(dicts)) {
    it(`${code} has every key with the same placeholders`, () => {
      expect(Object.keys(d).sort()).toEqual(Object.keys(en).sort());
      for (const k of Object.keys(en) as Array<keyof typeof en>) {
        expect(placeholders(d[k]), `${code} ${k}`).toBe(placeholders(en[k]));
        expect(d[k].trim().length, `${code} ${k}`).toBeGreaterThan(0);
      }
    });
  }
  it('every literal key used in the UI exists', () => {
    const used = new Set<string>();
    for (const f of files(join(__dirname, '../src'))) {
      for (const m of readFileSync(f, 'utf8').matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)) used.add(m[1]);
    }
    const missing = [...used].filter((k) => !(k in en));
    expect(missing).toEqual([]);
  });
  it('trade names in demo data are never in the dictionaries as keys', () => {
    expect(Object.values(fr).join(' ')).not.toContain('Bergamote');
  });
});
