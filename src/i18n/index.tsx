import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { en } from './en';
import { es } from './es';
import { fr } from './fr';
import { it } from './it';
import { ja } from './ja';
import { tr } from './tr';
import { zh } from './zh';
import { useStore } from '../store/store';
import { D, Dec, type DecStr } from '../domain/decimal';
import { formatDuration } from '../domain/journal';

export type Dict = Record<keyof typeof en, string>;

export const LOCALES: Array<{ code: string; label: string; dict: Partial<Dict>; intl: string }> = [
  { code: 'en', label: 'English', dict: en, intl: 'en-GB' },
  { code: 'es', label: 'Español', dict: es, intl: 'es-ES' },
  { code: 'zh', label: '中文', dict: zh, intl: 'zh-CN' },
  { code: 'fr', label: 'Français', dict: fr, intl: 'fr-FR' },
  { code: 'it', label: 'Italiano', dict: it, intl: 'it-IT' },
  { code: 'ja', label: '日本語', dict: ja, intl: 'ja-JP' },
  { code: 'tr', label: 'Türkçe', dict: tr, intl: 'tr-TR' },
];

export type TKey = keyof typeof en;

export interface I18n {
  locale: string;
  intl: string;
  t: (key: TKey, vars?: Record<string, string | number>) => string;
  /** Decimal and grouping symbols for display. Stored values stay canonical. */
  decimalSep: string;
  groupSep: string;
  num: (v: DecStr | Dec | null | undefined, places?: number) => string;
  grams: (v: DecStr | Dec | null | undefined, places?: number) => string;
  pct: (v: DecStr | Dec | null | undefined, places?: number) => string;
  date: (iso: string | null | undefined) => string;
  dateTime: (iso: string | null | undefined) => string;
  duration: (ms: number | null) => string;
  /** Show a canonical value in an input using the locale's decimal separator. */
  toInput: (v: DecStr | null) => string;
}

const Ctx = createContext<I18n | null>(null);

function symbols(intl: string): { dec: string; group: string } {
  const parts = new Intl.NumberFormat(intl).formatToParts(12345.6);
  return {
    dec: parts.find((p) => p.type === 'decimal')?.value ?? '.',
    group: parts.find((p) => p.type === 'group')?.value ?? ',',
  };
}

/** Exact formatting of a decimal string: no binary floating point involved. */
export function formatDecimal(v: Dec, places: number | undefined, dec: string, group: string): string {
  const s = places === undefined ? v.toFixed() : v.toFixed(places);
  const neg = s.startsWith('-');
  const [i, f] = (neg ? s.slice(1) : s).split('.');
  const grouped = i.length > 4 ? i.replace(/\B(?=(\d{3})+(?!\d))/g, group) : i;
  return `${neg ? '-' : ''}${grouped}${f !== undefined ? dec + f : ''}`;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const { state, setErrorTranslator } = useStore();
  const code = state.settings.locale;
  const loc = LOCALES.find((l) => l.code === code) ?? LOCALES[0];
  const value = useMemo<I18n>(() => {
    const { dec, group } = symbols(loc.intl);
    const t = (key: TKey, vars?: Record<string, string | number>) => {
      let s = (loc.dict[key] ?? en[key] ?? key) as string;
      if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
      return s;
    };
    const num = (v: DecStr | Dec | null | undefined, places?: number) => {
      if (v === null || v === undefined) return t('common.unknown');
      return formatDecimal(v instanceof Dec ? v : D(v), places, dec, group);
    };
    const dtf = new Intl.DateTimeFormat(loc.intl, { year: 'numeric', month: 'short', day: 'numeric' });
    const dtt = new Intl.DateTimeFormat(loc.intl, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    return {
      locale: loc.code,
      intl: loc.intl,
      t,
      decimalSep: dec,
      groupSep: group,
      num,
      grams: (v, places = 3) => (v === null || v === undefined ? t('common.unknown') : `${num(v, places)} g`),
      pct: (v, places = 2) => (v === null || v === undefined ? t('common.unknown') : `${num(v, places)} %`),
      date: (iso) => (iso ? dtf.format(new Date(iso)) : '—'),
      dateTime: (iso) => (iso ? dtt.format(new Date(iso)) : '—'),
      duration: (ms) => formatDuration(ms, { d: t('unit.day'), h: t('unit.hour'), min: t('unit.min') }),
      toInput: (v) => (v === null ? '' : v.replace('.', dec)),
    };
  }, [loc]);

  useEffect(() => {
    setErrorTranslator((c) => {
      const key = `err.${c.split(':')[0]}` as TKey;
      const detail = c.includes(':') ? ` (${c.split(':')[1]})` : '';
      return (loc.dict[key] ?? en[key] ?? c) + detail;
    });
    document.documentElement.lang = loc.code;
  }, [loc, setErrorTranslator]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const v = useContext(Ctx);
  if (!v) throw new Error('I18nProvider missing');
  return v;
}

/**
 * Parse a number typed into the app. Either "." or "," is accepted as the decimal separator;
 * grouping separators are rejected so that "1,250" can never mean 1250 here.
 */
export function parseUserNumber(text: string): { ok: true; value: string | null } | { ok: false } {
  const s = text.replace(/[\s  ]/g, '');
  if (s === '') return { ok: true, value: null };
  const norm = s.replace(',', '.');
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(norm)) return { ok: false };
  try {
    return { ok: true, value: D(norm.endsWith('.') ? norm.slice(0, -1) : norm).toFixed().replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') };
  } catch {
    return { ok: false };
  }
}
