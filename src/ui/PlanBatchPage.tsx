import { useMemo, useState } from 'react';
import { useStore } from '../store/store';
import { useI18n } from '../i18n';
import { D, placesOf, roundForDisplay, sum } from '../domain/decimal';
import { planBatch } from '../domain/formula';
import { balanceFor, lotAvailable, startBatch } from '../domain/batch';
import { DecimalInput, Empty, Field, go, StateBadge } from './common';

export function PlanBatchPage({ revisionId }: { revisionId: string }) {
  const { state, run } = useStore();
  const { t, num, grams, pct } = useI18n();
  const rev = state.revisions[revisionId];
  const [balanceId, setBalanceId] = useState<string>('');
  const s = balanceFor(state.settings, balanceId || null);
  const [size, setSize] = useState<string | null>('10');
  const [capacity, setCapacity] = useState<string | null>(null);
  const [lots, setLots] = useState<Record<string, string | null>>({});
  const places = placesOf(s.balanceReadability);

  const plan = useMemo(() => (rev && size && D(size).greaterThan(0) ? planBatch(rev, size, s.practicalMin, s.balanceReadability) : null), [rev, size, s.practicalMin, s.balanceReadability]);
  if (!rev) return <div className="page"><Empty>{t('common.notFound')}</Empty></div>;
  const project = state.projects[rev.projectId];
  const nextCode = `${project.code}-B${String(project.nextBatchNo).padStart(3, '0')}`;

  const lotsFor = (materialId: string | null) => Object.values(state.lots).filter((l) => l.materialId === materialId && !l.deletedAt);
  const displayedSum = plan ? sum(plan.lines.map((p) => p.targetGrams.toDecimalPlaces(places))) : D(0);
  const roundingDiff = plan ? displayedSum.minus(plan.total) : D(0);
  const capacityExceeded = !!(capacity && size && D(size).greaterThan(D(capacity)));

  const start = async () => {
    if (!size) return;
    let id = '';
    const cs = await run((st) => {
      const r = startBatch(st, { revisionId: rev.id, size, lotSelections: lots, containerCapacity: capacity, balanceId: balanceId || null });
      id = r.batch.id;
      return r;
    });
    if (cs) go(`bench/${id}`);
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="crumbs"><a href={`#/formula/${rev.id}`} className="mono">{rev.code}</a> / {t('plan.title')}</div>
          <h1>{t('plan.title')} <span className="mono muted">{nextCode}</span></h1>
          <div className="muted small">{t('plan.explain', { code: rev.code })} <StateBadge state={rev.status} /></div>
        </div>
        <div className="actions">
          <button onClick={() => go(`formula/${rev.id}`)}>{t('common.back')}</button>
          <button className="primary" onClick={start} disabled={!plan || !!plan.error || rev.status !== 'frozen' || capacityExceeded}>
            {t('plan.start', { code: nextCode })}
          </button>
        </div>
      </div>
      {rev.status !== 'frozen' && <p className="warn-box">{t('plan.mustFreeze')}</p>}
      <div className="toolbar">
        <Field label={t('plan.size')}><DecimalInput value={size} onValue={setSize} unit="g" autoFocus /></Field>
        {(state.settings.balances?.length ?? 0) > 0 && (
          <Field label={t('balance.use')}>
            <select value={balanceId} onChange={(e) => setBalanceId(e.target.value)}>
              <option value="">{state.settings.defaultBalanceName || t('balance.default')}</option>
              {state.settings.balances!.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Field>
        )}
        <Field label={t('plan.capacity')} hint={t('common.optional')}><DecimalInput value={capacity} onValue={setCapacity} unit="g" /></Field>
        <div className="muted small">
          {t('plan.balance', { read: grams(s.balanceReadability, places), min: grams(s.practicalMin, places) })} <a href="#/data">{t('common.change')}</a>
        </div>
      </div>
      {capacityExceeded && <p className="warn-box">{t('plan.capacityExceeded')}</p>}
      {plan?.error && <p className="warn-box">{t(`plan.err.${plan.error}` as never)}</p>}
      {plan && !plan.error && (
        <>
          <div className="grid-wrap">
            <table className="tbl">
              <thead><tr>
                <th>{t('col.material')}</th><th className="num">{t('col.strength')}</th>
                <th className="num">{t('plan.target')}</th><th className="num">{t('col.parentG')}</th>
                <th>{t('plan.lot')}</th><th className="num">{t('plan.available')}</th><th>{t('plan.warnings')}</th>
              </tr></thead>
              <tbody>
                {plan.lines.map((p) => {
                  const fl = rev.lines.find((l) => l.id === p.lineId)!;
                  const r = roundForDisplay(p.targetGrams, places);
                  const lotId = lots[p.lineId] ?? null;
                  const lot = lotId ? state.lots[lotId] : null;
                  const bal = lotId ? lotAvailable(state, lotId) : null;
                  const warns: string[] = [];
                  if (p.belowReadability) warns.push(t('plan.wBelowReadability'));
                  else if (p.belowPracticalMin) warns.push(t('plan.wBelowMin', { min: grams(s.practicalMin, places) }));
                  if (p.strength === null) warns.push(t('plan.wUnknownStrength'));
                  if (lot && lot.strength !== p.strength) warns.push(t('plan.wLotStrength', { lot: lot.strength === null ? t('common.unknown') : pct(lot.strength, 3) }));
                  if (bal && bal.lessThan(p.targetGrams)) warns.push(t('plan.wStockShort'));
                  return (
                    <tr key={p.lineId}>
                      <td>{p.materialName}</td>
                      <td className="num">{p.strength === null ? <span className="warn-text">{t('common.unknown')}</span> : pct(p.strength, 3)}{fl.carrier ? ` ${fl.carrier}` : ''}</td>
                      <td className="num strong" title={r.rounded ? t('plan.exact', { v: r.exact }) : undefined}>
                        {r.belowDisplay ? `< ${grams(s.balanceReadability, places)}` : grams(r.shown, places)}
                        {r.rounded && <span className="muted small"> ({num(p.targetGrams)})</span>}
                      </td>
                      <td className="num">{p.parentGrams ? grams(p.parentGrams, 4) : <span className="muted">{t('common.unknown')}</span>}</td>
                      <td>
                        <select value={lotId ?? ''} onChange={(e) => setLots((x) => ({ ...x, [p.lineId]: e.target.value || null }))}>
                          <option value="">{t('plan.noLot')}</option>
                          {lotsFor(fl.materialId).map((l) => (
                            <option key={l.id} value={l.id}>{l.lotCode} · {l.strength === null ? '?' : `${num(l.strength, 3)} %`}{l.kind === 'prepared_stock' ? ` · ${t('materials.prepared')}` : ''}</option>
                          ))}
                        </select>
                      </td>
                      <td className="num">{lotId ? grams(bal, places) : ''}</td>
                      <td className="warn-text small">{warns.join(' · ')}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot><tr>
                <td>{t('grid.total')}</td><td />
                <td className="num strong">{grams(plan.total, places)}</td>
                <td colSpan={4} className="small muted">
                  {!roundingDiff.isZero() && t('plan.roundingNote', { shown: grams(displayedSum, places), exact: num(plan.total) })}
                </td>
              </tr></tfoot>
            </table>
          </div>
          <p className="muted small">{t('plan.footnote')}</p>
        </>
      )}
    </div>
  );
}
