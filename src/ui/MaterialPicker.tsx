import { useEffect, useMemo, useRef, useState, type InputHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { useI18n, type TKey } from '../i18n';
import { FAMILIES, KINDS, loadCatalog, scoreName, searchCatalog, type CatalogEntry, type Family, type Kind } from '../catalog/catalog';
import { Field, Modal } from './common';

export function useCatalog(): CatalogEntry[] | null {
  const [c, setC] = useState<CatalogEntry[] | null>(null);
  useEffect(() => { let live = true; loadCatalog().then((x) => { if (live) setC(x); }); return () => { live = false; }; }, []);
  return c;
}

interface Suggestion { name: string; own: boolean; entry?: CatalogEntry; via?: string }

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'>;

/**
 * Material name cell with search-as-you-type. Shows the user's own materials first, then
 * catalog names. Free text is always allowed: suggestions never replace what was typed
 * unless one is chosen.
 */
export function MaterialInput({ value, onText, onPick, ownNames, catalog, onKeyDown, onBlur, readOnly, ...rest }: InputProps & {
  value: string;
  onText: (text: string) => void;
  onPick: (name: string) => void;
  ownNames: string[];
  catalog: CatalogEntry[] | null;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);
  const [rect, setRect] = useState<DOMRect | null>(null);

  const items = useMemo<Suggestion[]>(() => {
    if (!open || !value.trim()) return [];
    const own = ownNames
      .map((name) => ({ name, ...scoreName(value, name) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, 6)
      .map((x) => ({ name: x.name, own: true }));
    const ownSet = new Set(own.map((x) => x.name.toLowerCase()));
    const cat = catalog
      ? searchCatalog(catalog, value, 10).filter((h) => !ownSet.has(h.item.n.toLowerCase()))
        .map((h) => ({ name: h.item.n, own: false, entry: h.item, via: h.via }))
      : [];
    return [...own, ...cat];
  }, [open, value, ownNames, catalog]);

  useEffect(() => {
    if (!open) return;
    const place = () => setRect(ref.current?.getBoundingClientRect() ?? null);
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => { window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); };
  }, [open]);

  const pick = (s: Suggestion) => { setOpen(false); setHi(-1); onPick(s.name); };
  const listId = `${rest.id ?? 'mat'}-list`;
  const showList = open && items.length > 0 && rect;
  const below = rect ? window.innerHeight - rect.bottom > 260 || rect.top < 260 : true;

  return (
    <>
      <input
        {...rest}
        ref={ref}
        value={value}
        readOnly={readOnly}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={!!showList}
        aria-controls={showList ? listId : undefined}
        aria-activedescendant={showList && hi >= 0 ? `${listId}-${hi}` : undefined}
        autoComplete="off"
        onChange={(e) => { onText(e.target.value); setOpen(true); setHi(-1); }}
        onBlur={(e) => { setOpen(false); onBlur?.(e); }}
        onKeyDown={(e) => {
          if (showList) {
            if (e.key === 'ArrowDown' && !e.altKey) { e.preventDefault(); setHi((h) => Math.min(h + 1, items.length - 1)); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); if (hi <= 0) { setHi(-1); } else setHi(hi - 1); return; }
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); return; }
            if ((e.key === 'Enter' || e.key === 'Tab') && hi >= 0 && !e.ctrlKey && !e.metaKey) {
              if (e.key === 'Enter') e.preventDefault();
              pick(items[hi]); return;
            }
          }
          onKeyDown?.(e);
        }}
      />
      {showList && createPortal(
        <ul id={listId} role="listbox" className="suggest"
          style={{ left: rect.left, width: Math.max(rect.width, 360), ...(below ? { top: rect.bottom + 2 } : { bottom: window.innerHeight - rect.top + 2 }) }}
          onMouseDown={(e) => e.preventDefault()}>
          {items.map((s, i) => (
            <li key={`${s.own ? 'o' : 'c'}:${s.name}`} id={`${listId}-${i}`} role="option" aria-selected={i === hi}
              className={i === hi ? 'hi' : undefined} onMouseEnter={() => setHi(i)} onClick={() => pick(s)}>
              <span className="sg-name">{s.name}</span>
              {s.via && <span className="sg-via">{s.via}</span>}
              <span className="sg-meta">
                {s.own ? <span className="tag tag-linked">{t('catalog.yours')}</span>
                  : <>{t(`catalog.family_${s.entry!.f}` as TKey)} · {t(`catalog.kind_${s.entry!.k}` as TKey)}{s.entry!.s ? ` · ${s.entry!.s}` : ''}</>}
              </span>
            </li>
          ))}
          <li className="sg-foot" aria-hidden="true">{t('catalog.typeOwn')}</li>
        </ul>,
        document.body,
      )}
    </>
  );
}

/** Browse the whole catalog by family and kind, tick materials and add them as formula lines. */
export function LibraryModal({ onClose, onAdd, inFormula }: { onClose: () => void; onAdd: (names: string[]) => void; inFormula: Set<string> }) {
  const { t } = useI18n();
  const catalog = useCatalog();
  const [q, setQ] = useState('');
  const [family, setFamily] = useState<Family | ''>('');
  const [kind, setKind] = useState<Kind | ''>('');
  const [chosen, setChosen] = useState<string[]>([]);
  const hits = useMemo(() => (catalog ? searchCatalog(catalog, q, 300, { family, kind }) : []), [catalog, q, family, kind]);
  const total = catalog?.length ?? 0;
  const toggle = (n: string) => setChosen((c) => (c.includes(n) ? c.filter((x) => x !== n) : [...c, n]));
  return (
    <Modal wide title={t('catalog.title')} onClose={onClose} footer={<>
      <span className="muted small foot-left">{t('catalog.chosen', { n: chosen.length })}</span>
      <button onClick={onClose}>{t('common.cancel')}</button>
      <button className="primary" disabled={!chosen.length} onClick={() => onAdd(chosen)}>{t('catalog.add', { n: chosen.length })}</button>
    </>}>
      <p className="muted small">{t('catalog.explain', { n: total })}</p>
      <div className="form-row">
        <Field label={t('common.search')}><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('catalog.searchPh')} /></Field>
        <Field label={t('catalog.kind')}>
          <select value={kind} onChange={(e) => setKind(e.target.value as Kind | '')}>
            <option value="">{t('catalog.all')}</option>
            {KINDS.map((k) => <option key={k} value={k}>{t(`catalog.kind_${k}` as TKey)}</option>)}
          </select>
        </Field>
      </div>
      <div className="chips" role="group" aria-label={t('catalog.family')}>
        <button className={`chip${family === '' ? ' active' : ''}`} aria-pressed={family === ''} onClick={() => setFamily('')}>{t('catalog.all')}</button>
        {FAMILIES.map((f) => (
          <button key={f} className={`chip${family === f ? ' active' : ''}`} aria-pressed={family === f} onClick={() => setFamily(family === f ? '' : f)}>
            {t(`catalog.family_${f}` as TKey)}
          </button>
        ))}
      </div>
      {!catalog ? <p className="muted">{t('common.loading')}</p> : (
        <div className="library-list">
          {hits.length === 0 && <p className="muted">{t('catalog.noHits')}</p>}
          {hits.map(({ item, via }) => {
            const already = inFormula.has(item.n.toLowerCase());
            const on = chosen.includes(item.n);
            return (
              <label key={item.n} className={`lib-item${on ? ' on' : ''}${already ? ' already' : ''}`}>
                <input type="checkbox" checked={on} disabled={already} onChange={() => toggle(item.n)} />
                <span className="lib-name">{item.n}{via && <span className="sg-via"> {via}</span>}</span>
                <span className="sg-meta">{already ? t('catalog.inFormula') : <>{t(`catalog.family_${item.f}` as TKey)} · {t(`catalog.kind_${item.k}` as TKey)}{item.s ? ` · ${item.s}` : ''}</>}</span>
              </label>
            );
          })}
          {hits.length === 300 && <p className="muted small">{t('catalog.narrow')}</p>}
        </div>
      )}
    </Modal>
  );
}
