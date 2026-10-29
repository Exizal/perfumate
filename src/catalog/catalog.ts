// Reference list of perfumery materials, used to suggest names while typing and to browse.
// It holds names, aliases, a kind and an odour family only: no CAS numbers, safety data or
// limits. Picking a catalog name never creates a material record until a revision is frozen.

export const FAMILIES = [
  'citrus', 'green', 'aromatic', 'floral', 'fruity', 'spicy', 'woody', 'amber', 'musk', 'animalic',
  'balsamic', 'gourmand', 'aldehydic', 'marine', 'earthy', 'leathery', 'powdery', 'solvent',
] as const;
export type Family = (typeof FAMILIES)[number];

export const KINDS = ['natural', 'aroma', 'trade', 'base', 'solvent'] as const;
export type Kind = (typeof KINDS)[number];

export interface CatalogEntry {
  /** Name as perfumers write it. */
  n: string;
  /** Aliases and synonyms. */
  a: string[];
  k: Kind;
  f: Family;
  /** Supplier or owner, for trade names, when known. */
  s?: string;
}

let cache: Promise<CatalogEntry[]> | null = null;

/** Loads the catalog on first use so it does not weigh on start-up. */
export function loadCatalog(): Promise<CatalogEntry[]> {
  cache ??= import('./materials.json').then((m) => (m.default as CatalogEntry[]));
  return cache;
}

export function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export interface Hit<T> { item: T; score: number; via?: string }

/**
 * Ranks names against what has been typed: whole-name prefix first, then a word in the
 * name starting with the query, then aliases, then anywhere in the name or aliases.
 * Every typed word must match somewhere.
 */
export function scoreName(query: string, name: string, aliases: string[] = []): { score: number; via?: string } {
  const q = fold(query);
  if (!q) return { score: 0 };
  const n = fold(name);
  const words = q.split(' ');
  const test = (target: string): number => {
    if (target === q) return 100;
    if (target.startsWith(q)) return 80;
    if ((' ' + target).includes(' ' + q)) return 60;
    if (words.every((w) => (' ' + target).includes(' ' + w))) return 45;
    if (target.includes(q)) return 30;
    if (words.every((w) => target.includes(w))) return 20;
    return 0;
  };
  let best = test(n);
  let via: string | undefined;
  for (const a of aliases) {
    const sc = test(fold(a)) - 5;
    if (sc > best) { best = sc; via = a; }
  }
  return best > 0 ? { score: best, via } : { score: 0 };
}

export function searchCatalog(entries: CatalogEntry[], query: string, limit = 12, filter?: { kind?: Kind | ''; family?: Family | '' }): Array<Hit<CatalogEntry>> {
  const pass = (e: CatalogEntry) => (!filter?.kind || e.k === filter.kind) && (!filter?.family || e.f === filter.family);
  if (!query.trim()) return entries.filter(pass).slice(0, limit).map((item) => ({ item, score: 0 }));
  const hits: Array<Hit<CatalogEntry>> = [];
  for (const e of entries) {
    if (!pass(e)) continue;
    const r = scoreName(query, e.n, e.a);
    if (r.score) hits.push({ item: e, score: r.score - e.n.length / 1000, via: r.via });
  }
  hits.sort((x, y) => y.score - x.score || x.item.n.localeCompare(y.item.n));
  return hits.slice(0, limit);
}
