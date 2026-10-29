import { useEffect, useState } from 'react';
import { useStore } from '../store/store';
import { useI18n } from '../i18n';
import { batchSummaries, conditionMismatches, diffRevisions, observationRows, type ObservationRow } from '../domain/compare';
import { DemoBadge, Empty, go, StateBadge } from './common';
import { AiError, draftComparisonSummary, getAiKey } from '../services/ai';
import { LOCALES } from '../i18n';

function AiSummary({ payload }: { payload: () => unknown }) {
  const { state } = useStore();
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const hasKey = !!getAiKey();
  const run = async () => {
    setBusy(true); setErr(null);
    try {
      const lang = LOCALES.find((l) => l.code === state.settings.locale)?.label ?? 'English';
      setText(await draftComparisonSummary(payload(), lang));
    } catch (e) {
      setErr(e instanceof AiError ? t(`ai.err_${e.message.startsWith('api_') ? 'api' : e.message}` as never) : String(e));
    } finally { setBusy(false); }
  };
  return (
    <section className="panel">
      <h3>{t('ai.title')}</h3>
      {!hasKey ? <p className="muted small">{t('ai.noKey')} <a href="#/data">{t('nav.data')}</a></p> : (
        <>
          <p className="muted small">{t('ai.sendNote')}</p>
          <button onClick={run} disabled={busy}>{busy ? t('ai.working') : t('ai.draft')}</button>
        </>
      )}
      {err && <p className="warn-box">{err}</p>}
      {text && (
        <div className="ai-draft">
          <p className="badge">{t('ai.draftBadge')}</p>
          <div className="ai-text">{text}</div>
          <button className="link" onClick={() => navigator.clipboard?.writeText(text)}>{t('ai.copy')}</button>
        </div>
      )}
    </section>
  );
}

export function ComparePage({ a, b }: { a: string | null; b: string | null }) {
  const { state } = useStore();
  const { t, pct, num, grams, duration } = useI18n();
  const revs = Object.values(state.revisions).filter((r) => !r.deletedAt).sort((x, y) => x.code.localeCompare(y.code));
  const ra = a ? state.revisions[a] : undefined;
  const rb = b ? state.revisions[b] : undefined;
  const previous = rb && Object.values(state.revisions)
    .filter((r) => r.projectId === rb.projectId && r.number < rb.number && !r.deletedAt)
    .sort((x, y) => y.number - x.number)[0];
  const fallbackA = !ra && rb ? (rb.parentRevisionId ?? previous?.id ?? null) : null;
  useEffect(() => { if (fallbackA && rb) go(`compare?a=${fallbackA}&b=${rb.id}`); }, [fallbackA, rb]);

  const set = (side: 'a' | 'b', id: string) => {
    const q = new URLSearchParams({ a: side === 'a' ? id : a ?? '', b: side === 'b' ? id : b ?? '' });
    go(`compare?${q.toString()}`);
  };

  const picker = (side: 'a' | 'b', value: string | null) => (
    <select value={value ?? ''} onChange={(e) => set(side, e.target.value)} aria-label={side.toUpperCase()}>
      <option value="">{t('compare.pick')}</option>
      {revs.map((r) => <option key={r.id} value={r.id}>{r.code} · {state.projects[r.projectId]?.name} · {t(`state.${r.status}` as never)}</option>)}
    </select>
  );

  const diff = ra && rb ? diffRevisions(ra, rb) : [];
  const obsA = ra ? observationRows(state, ra.id, 'A') : [];
  const obsB = rb ? observationRows(state, rb.id, 'B') : [];
  const pairs: Array<{ a?: ObservationRow; b?: ObservationRow; mismatch: string[] }> = [];
  const n = Math.max(obsA.length, obsB.length);
  for (let i = 0; i < n; i++) pairs.push({ a: obsA[i], b: obsB[i], mismatch: obsA[i] && obsB[i] ? conditionMismatches(obsA[i], obsB[i]) : [] });

  const obsCell = (o?: ObservationRow) => o ? (
    <div>
      <div className="small muted">
        <span className="mono">{o.sampleCode}</span> · {t('compare.ageShort')} {duration(o.batchAgeMs)} · {t('compare.elapsedShort')} {duration(o.elapsedMs)} · {t(`medium.${o.medium}` as never)} · {o.sampleStrength === null ? t('common.unknown') : pct(o.sampleStrength, 1)} {o.diluent}
      </div>
      <div>{o.text} {o.intensity !== null && <span className="muted">({t('journal.intensity')} {o.intensity})</span>} <DemoBadge show={o.demo} /></div>
    </div>
  ) : <span className="muted">—</span>;

  return (
    <div className="page">
      <div className="page-head"><h1>{t('compare.title')}</h1></div>
      <div className="toolbar">
        <label className="field"><span className="field-label">A</span>{picker('a', a)}</label>
        <label className="field"><span className="field-label">B</span>{picker('b', b)}</label>
        {ra && rb && <button onClick={() => go(`compare?a=${rb.id}&b=${ra.id}`)}>{t('compare.swap')}</button>}
      </div>
      {!(ra && rb) ? <Empty>{t('compare.pickBoth')}</Empty> : (
        <>
          <p className="muted small">{t('compare.basisNote')}</p>
          <AiSummary payload={() => ({
            a: { code: ra.code, amountMode: ra.amountMode, lines: ra.lines.map((l) => ({ name: l.materialName, strength: l.strength, amount: l.amount })) },
            b: { code: rb.code, changeReason: rb.changeReason, amountMode: rb.amountMode, lines: rb.lines.map((l) => ({ name: l.materialName, strength: l.strength, amount: l.amount })) },
            batchesA: batchSummaries(state, ra.id), batchesB: batchSummaries(state, rb.id),
            observationsA: obsA, observationsB: obsB,
          })} />
          <section className="panel">
            <h3>{t('compare.formulaChanges')} <span className="mono">{ra.code} → {rb.code}</span></h3>
            {rb.changeReason && <p className="reason"><strong>{t('formulas.changeReason')}:</strong> {rb.changeReason}</p>}
            <div className="grid-wrap">
              <table className="tbl">
                <thead><tr>
                  <th>{t('col.material')}</th><th>{t('compare.change')}</th>
                  <th className="num">A %</th><th className="num">B %</th><th className="num">{t('compare.deltaPp')}</th>
                  <th className="num">{t('compare.strengthA')}</th><th className="num">{t('compare.strengthB')}</th>
                  <th className="num">{t('compare.parentA')}</th><th className="num">{t('compare.parentB')}</th>
                </tr></thead>
                <tbody>{diff.map((d) => (
                  <tr key={d.key} className={`diff-${d.status}`}>
                    <td>{d.materialName}</td>
                    <td>{t(`compare.st.${d.status}` as never)}</td>
                    <td className="num">{d.pctA ? num(d.pctA, 3) : '—'}</td>
                    <td className="num">{d.pctB ? num(d.pctB, 3) : '—'}</td>
                    <td className="num strong">{d.deltaPp && !d.deltaPp.isZero() ? `${d.deltaPp.greaterThan(0) ? '+' : ''}${num(d.deltaPp, 3)}` : ''}</td>
                    <td className={`num${d.strengthChanged ? ' warn-text' : ''}`}>{d.strengthA === undefined ? '—' : d.strengthA === null ? t('common.unknown') : pct(d.strengthA, 3)}</td>
                    <td className={`num${d.strengthChanged ? ' warn-text' : ''}`}>{d.strengthB === undefined ? '—' : d.strengthB === null ? t('common.unknown') : pct(d.strengthB, 3)}</td>
                    <td className="num">{d.parentPctA ? num(d.parentPctA, 4) : d.pctA ? t('common.unknown') : '—'}</td>
                    <td className="num">{d.parentPctB ? num(d.parentPctB, 4) : d.pctB ? t('common.unknown') : '—'}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </section>

          <section className="panel">
            <h3>{t('compare.batches')}</h3>
            <div className="two-col">
              {[ra, rb].map((r, i) => (
                <div key={r.id}>
                  <h4>{i === 0 ? 'A' : 'B'} · <span className="mono">{r.code}</span></h4>
                  {batchSummaries(state, r.id).length === 0 ? <p className="muted">{t('formula.noBatches')}</p> : (
                    <table className="tbl small"><tbody>{batchSummaries(state, r.id).map((s) => (
                      <tr key={s.batch.id}>
                        <td className="mono"><a href={`#/batch/${s.batch.id}`}>{s.batch.code}</a> <DemoBadge show={s.batch.demo} /></td>
                        <td><StateBadge state={s.batch.state} /></td>
                        <td className="num">{grams(s.actualTotal)}</td>
                        <td>{s.deviationCount ? <span className="warn-text">{t('compare.deviations', { n: s.deviationCount })}</span> : t('compare.noDeviations')}</td>
                        <td>{Object.entries(s.costByCurrency).map(([c, v]) => `${num(v, 2)} ${c}`).join(' + ') || '—'}{!s.costKnown && <span className="muted"> ({t('record.costPartial')})</span>}</td>
                      </tr>
                    ))}</tbody></table>
                  )}
                </div>
              ))}
            </div>
          </section>

          <section className="panel">
            <h3>{t('compare.observations')}</h3>
            <p className="warn-box small">{t('compare.causationNote')}</p>
            {pairs.length === 0 ? <p className="muted">{t('compare.noObservations')}</p> : (
              <table className="tbl">
                <thead><tr><th>A · {ra.code}</th><th>B · {rb.code}</th><th>{t('compare.conditions')}</th></tr></thead>
                <tbody>{pairs.map((p, i) => (
                  <tr key={i}>
                    <td>{obsCell(p.a)}</td><td>{obsCell(p.b)}</td>
                    <td className="small">{p.a && p.b ? (p.mismatch.length ? <span className="warn-text">{p.mismatch.map((m) => t(`compare.mm.${m}` as never)).join(', ')}</span> : t('compare.matched')) : t('compare.unpaired')}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </section>
        </>
      )}
    </div>
  );
}
