import { useMemo, useState } from 'react';
import { useStore } from '../store/store';
import { useI18n } from '../i18n';
import { D } from '../domain/decimal';
import { explodeRevision, limitChecks, usesAccords } from '../domain/accords';
import { buildSharePack, importSharePack, parseSharePack, type SharePack } from '../domain/share';
import type { FormulaLine, FormulaRevision } from '../domain/types';
import { DecimalInput, download, Field, go, Modal } from './common';

/**
 * Accord breakdown and the user's own limit check. Limits come from the material records;
 * nothing here states compliance.
 */
export function CompositionPanel({ rev, lines }: { rev: FormulaRevision; lines: FormulaLine[] }) {
  const { state } = useStore();
  const { t, pct } = useI18n();
  const [dose, setDose] = useState<string | null>('100');
  const draft = useMemo(() => ({ ...rev, lines }), [rev, lines]);
  const hasAccords = usesAccords(state, draft);
  const doseD = dose && D(dose).greaterThan(0) && D(dose).lessThanOrEqualTo(100) ? D(dose) : null;
  const checks = useMemo(() => (doseD ? limitChecks(state, draft, doseD) : []), [state, draft, doseD]);
  const withLimit = checks.filter((c) => c.status !== 'no_limit');
  const exploded = useMemo(() => (hasAccords ? explodeRevision(state, draft) : []), [state, draft, hasAccords]);
  if (!hasAccords && !Object.values(state.materials).some((m) => m.maxPct)) return null;
  return (
    <section className="panel">
      {hasAccords && (
        <>
          <h3>{t('accord.breakdown')}</h3>
          <p className="muted small">{t('accord.breakdownHint')}</p>
          <table className="tbl small">
            <thead><tr><th>{t('col.material')}</th><th className="num">{t('col.parentPct')}</th><th>{t('accord.via')}</th></tr></thead>
            <tbody>{exploded.map((x) => (
              <tr key={x.key}><td>{x.name}</td><td className="num">{x.parentPct ? pct(x.parentPct, 4) : t('common.unknown')}</td><td className="mono">{x.via.join(' › ') || '—'}</td></tr>
            ))}</tbody>
          </table>
        </>
      )}
      <h3>{t('limits.title')}</h3>
      <p className="muted small">{t('limits.disclaimer')}</p>
      <Field label={t('limits.dose')} hint={t('limits.doseHint')}>
        <DecimalInput value={dose} onValue={setDose} unit="%" />
      </Field>
      {withLimit.length === 0 ? <p className="muted">{t('limits.none')}</p> : (
        <table className="tbl small">
          <thead><tr><th>{t('col.material')}</th><th className="num">{t('limits.inProduct')}</th><th className="num">{t('limits.max')}</th><th>{t('limits.source')}</th><th>{t('limits.status')}</th></tr></thead>
          <tbody>{withLimit.map((c) => (
            <tr key={c.key} className={c.status === 'over' ? 'warn-row' : ''}>
              <td>{c.name}</td>
              <td className="num">{c.productPct ? pct(c.productPct, 4) : t('common.unknown')}</td>
              <td className="num">{c.maxPct ? pct(c.maxPct, 4) : '—'}</td>
              <td>{c.source || '—'}</td>
              <td className={c.status === 'over' ? 'warn-text strong' : c.status === 'unknown' ? 'muted' : ''}>{t(`limits.status_${c.status}` as never)}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </section>
  );
}

export function ShareModal({ rev, onClose }: { rev: FormulaRevision; onClose: () => void }) {
  const { state } = useStore();
  const { t } = useI18n();
  const [title, setTitle] = useState(state.projects[rev.projectId]?.name ?? rev.code);
  const [author, setAuthor] = useState('');
  const [includeCosts, setIncludeCosts] = useState(false);
  const [includeNotes, setIncludeNotes] = useState(true);
  const save = () => {
    const pack = buildSharePack(rev, { title, author, includeCosts, includeNotes }, new Date().toISOString());
    download(`${rev.code}.share.json`, JSON.stringify(pack, null, 1), 'application/json');
    onClose();
  };
  return (
    <Modal title={t('share.title')} onClose={onClose} footer={<>
      <button onClick={onClose}>{t('common.cancel')}</button>
      <button className="primary" onClick={save}>{t('share.download')}</button>
    </>}>
      <p>{t('share.explain', { code: rev.code })}</p>
      <Field label={t('share.packTitle')}><input value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
      <Field label={t('share.author')}><input value={author} onChange={(e) => setAuthor(e.target.value)} /></Field>
      <label className="check"><input type="checkbox" checked={includeNotes} onChange={(e) => setIncludeNotes(e.target.checked)} /> {t('share.includeNotes')}</label>
      <label className="check"><input type="checkbox" checked={includeCosts} onChange={(e) => setIncludeCosts(e.target.checked)} /> {t('share.includeCosts')}</label>
      <p className="muted small">{t('share.privacy')}</p>
    </Modal>
  );
}

export function ImportShareModal({ onClose }: { onClose: () => void }) {
  const { run, toast, errorText } = useStore();
  const { t } = useI18n();
  const [pack, setPack] = useState<SharePack | null>(null);
  const [code, setCode] = useState('');
  const onFile = async (f: File) => {
    try { setPack(parseSharePack(await f.text())); } catch (e) { toast(errorText(e), 'error'); }
  };
  const doImport = async () => {
    if (!pack) return;
    let id = '';
    const cs = await run((s) => { const r = importSharePack(s, pack, code, new Date().toISOString()); id = r.revisionId; return r; });
    if (cs) { onClose(); go(`formula/${id}`); }
  };
  return (
    <Modal title={t('share.importTitle')} onClose={onClose} footer={<>
      <button onClick={onClose}>{t('common.cancel')}</button>
      <button className="primary" disabled={!pack || !code.trim()} onClick={doImport}>{t('share.import')}</button>
    </>}>
      <p>{t('share.importExplain')}</p>
      <label className="button">
        {t('share.chooseFile')}
        <input type="file" accept=".json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
      </label>
      {pack && (
        <>
          <p><strong>{pack.title}</strong> <span className="mono">{pack.sourceCode}</span> · {t('share.lines', { n: pack.lines.length })}{pack.author ? ` · ${pack.author}` : ''}</p>
          <Field label={t('projects.code')} hint={t('projects.codeHint')}>
            <input value={code} maxLength={6} onChange={(e) => setCode(e.target.value.toUpperCase())} />
          </Field>
        </>
      )}
    </Modal>
  );
}
