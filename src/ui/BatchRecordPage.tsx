import { useState } from 'react';
import { useStore } from '../store/store';
import { useI18n } from '../i18n';
import { D, placesOf } from '../domain/decimal';
import { batchEvents, composition } from '../domain/batch';
import { batchAgeMs, createSample } from '../domain/journal';
import { DecimalInput, DemoBadge, Empty, Field, go, Modal, StateBadge, useNow } from './common';
import { downloadLabel, labelData, LabelPreview, printLabel } from './Label';
import { exportBatchCsv, exportBatchXlsx } from '../services/exporters';

export function BatchRecordPage({ batchId }: { batchId: string }) {
  const { state, run } = useStore();
  const { t, grams, num, pct, dateTime, duration } = useI18n();
  const now = useNow();
  const batch = state.batches[batchId];
  const [withQr, setWithQr] = useState(true);
  const [sampleModal, setSampleModal] = useState(false);
  const [sp, setSp] = useState<{ pct: string | null; diluent: string; notes: string }>({ pct: '20', diluent: 'Ethanol', notes: '' });
  if (!batch) return <div className="page"><Empty>{t('common.notFound')}</Empty></div>;
  const places = placesOf(batch.balanceReadability);
  const rev = state.revisions[batch.revisionId];
  const project = state.projects[batch.projectId];
  const comp = composition(state, batch);
  const events = batchEvents(state, batch.id);
  const samples = Object.values(state.samples).filter((s) => s.batchId === batch.id);
  const auditRows = Object.values(state.audit).filter((a) => a.entityId === batch.id).sort((a, b) => a.at.localeCompare(b.at));
  const label = labelData(state, batch);
  const lineName = (id: string) => batch.lines.find((l) => l.lineId === id)?.materialName ?? '';

  const makeSample = async () => {
    let id = '';
    const cs = await run((s) => { const r = createSample(s, { batchId: batch.id, batchPercent: sp.pct, diluent: sp.diluent, notes: sp.notes }); id = r.sample.id; return r; });
    if (cs) { setSampleModal(false); go(`journal/${id}`); }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="crumbs"><a href="#/bench">{t('nav.bench')}</a> / {project?.name}</div>
          <h1 className="mono">{batch.code} <StateBadge state={batch.state} /> <DemoBadge show={batch.demo} /></h1>
          <div className="muted small">
            {t('record.from')} <a className="mono" href={`#/formula/${batch.revisionId}`}>{batch.revisionCode}</a>
            {rev && rev.status === 'frozen' ? ` · ${t('record.revisionFrozen')}` : ''}
          </div>
        </div>
        <div className="actions">
          {(batch.state === 'in_progress' || batch.state === 'paused') && <button className="primary" onClick={() => go(`bench/${batch.id}`)}>{t('projects.continueBatch', { code: batch.code })}</button>}
          {batch.state === 'completed' && <button className="primary" onClick={() => setSampleModal(true)}>{t('record.createSample')}</button>}
          <button onClick={() => exportBatchCsv(state, batch)}>{t('common.exportCsv')}</button>
          <button onClick={() => exportBatchXlsx(state, batch)}>{t('common.exportXlsx')}</button>
        </div>
      </div>

      <div className="two-col">
        <section className="panel">
          <dl className="kv">
            <dt>{t('record.started')}</dt><dd>{dateTime(batch.startedAt)}</dd>
            <dt>{t('record.completed')}</dt><dd>{dateTime(batch.completedAt)}</dd>
            {batch.cancelledAt && <><dt>{t('record.cancelled')}</dt><dd>{dateTime(batch.cancelledAt)} · {batch.disposition}</dd></>}
            <dt>{t('record.batchAge')}</dt><dd>{batch.state === 'completed' ? duration(batchAgeMs(batch, now.toISOString())) : '—'}</dd>
            <dt>{t('record.plannedSize')}</dt><dd>{grams(batch.targetSize, places)}{batch.planFactor !== '1' ? ` → ${grams(D(batch.targetSize).times(batch.planFactor), places)} (×${num(batch.planFactor)})` : ''}</dd>
            <dt>{t('record.actualTotal')}</dt><dd className="strong">{grams(comp.total, places)}</dd>
            <dt>{t('record.deviationDecision')}</dt><dd>{batch.deviationDecision ? t(`bench.decision.${batch.deviationDecision}` as never) : '—'}</dd>
            <dt>{t('record.cost')}</dt>
            <dd>{Object.entries(comp.costByCurrency).map(([c, v]) => `${num(v, 2)} ${c}`).join(' + ') || '—'}{!comp.costKnown && <span className="warn-text"> · {t('record.costPartial')}</span>}</dd>
            <dt>{t('record.balance')}</dt><dd>{t('plan.balance', { read: grams(batch.balanceReadability, places), min: grams(batch.practicalMin, places) })}</dd>
          </dl>
        </section>
        <section className="panel label-panel">
          <h3>{t('record.label')}</h3>
          <LabelPreview data={label} withQr={withQr} />
          <label className="check"><input type="checkbox" checked={withQr} onChange={(e) => setWithQr(e.target.checked)} /> {t('record.includeQr')}</label>
          <div className="actions">
            <button className="primary" onClick={() => printLabel(label, withQr)}>{t('record.printLabel')}</button>
            <button onClick={() => downloadLabel(label, withQr)}>{t('record.downloadLabel')}</button>
          </div>
          <p className="muted small">{t('record.labelHint')}</p>
        </section>
      </div>

      <section className="panel">
        <h3>{t('record.composition')}</h3>
        <div className="grid-wrap">
          <table className="tbl">
            <thead><tr>
              <th>{t('col.material')}</th><th className="num">{t('col.strength')}</th>
              <th className="num">{t('record.originalTarget')}</th><th className="num">{t('record.currentTarget')}</th>
              <th className="num">{t('record.actual')}</th><th className="num">{t('record.delta')}</th>
              <th className="num">{t('record.pctBatch')}</th><th className="num">{t('col.parentG')}</th><th className="num">{t('record.lineCost')}</th>
            </tr></thead>
            <tbody>{comp.lines.map((l) => {
              const delta = l.actual.minus(l.currentTarget);
              return (
                <tr key={l.lineId} className={!delta.isZero() ? 'warn-row' : ''}>
                  <td>{l.materialName}</td>
                  <td className="num">{l.strength === null ? <span className="warn-text">{t('common.unknown')}</span> : pct(l.strength, 3)}</td>
                  <td className="num">{grams(l.originalTarget, places)}</td>
                  <td className="num">{grams(l.currentTarget, places)}</td>
                  <td className="num strong">{grams(l.actual, places)}</td>
                  <td className="num">{delta.isZero() ? '' : `${delta.greaterThan(0) ? '+' : ''}${grams(delta, places)}`}</td>
                  <td className="num">{l.actualPct ? pct(l.actualPct, 3) : ''}</td>
                  <td className="num">{l.parentGrams ? grams(l.parentGrams, 4) : <span className="muted">{t('common.unknown')}</span>}</td>
                  <td className="num">{l.cost === null ? <span className="muted">{t('common.unknown')}</span> : `${num(l.cost, 3)} ${l.currency ?? ''}`}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
        <p className="muted small">{t('record.compNote')}</p>
      </section>

      <section className="panel">
        <h3>{t('record.samples')}</h3>
        {samples.length === 0 ? <p className="muted">{batch.state === 'completed' ? t('record.noSamples') : t('record.samplesAfterComplete')}</p> : (
          <ul className="inline-list">{samples.map((s) => <li key={s.id}><a className="mono" href={`#/journal/${s.id}`}>{s.code}</a> · {s.batchPercent === null ? t('common.unknown') : pct(s.batchPercent, 2)} {s.diluent}</li>)}</ul>
        )}
      </section>

      <section className="panel">
        <h3>{t('record.events')}</h3>
        <table className="tbl small">
          <thead><tr><th>{t('bench.time')}</th><th>{t('col.material')}</th><th>{t('record.kind')}</th><th className="num">{t('bench.mass')}</th><th>{t('bench.lot')}</th><th>{t('common.reason')}</th></tr></thead>
          <tbody>{events.map((e) => (
            <tr key={e.id}><td>{dateTime(e.at)}</td><td>{lineName(e.lineId)}</td><td>{e.kind === 'correction' ? t('bench.correction') : t('record.addition')}</td>
              <td className="num">{grams(e.mass, places)}</td><td>{e.lotId ? state.lots[e.lotId]?.lotCode : t('bench.untrackedLot')}</td><td>{e.reason}</td></tr>
          ))}</tbody>
        </table>
        <h3>{t('record.history')}</h3>
        <ul className="audit">{auditRows.map((a) => <li key={a.id}><span className="muted">{dateTime(a.at)}</span> {a.action} {a.detail}</li>)}</ul>
      </section>

      {sampleModal && (
        <Modal title={t('record.createSample')} onClose={() => setSampleModal(false)} footer={<>
          <button onClick={() => setSampleModal(false)}>{t('common.cancel')}</button>
          <button className="primary" onClick={makeSample}>{t('common.create')}</button>
        </>}>
          <Field label={t('journal.samplePct')} hint={t('journal.samplePctHint')}><DecimalInput value={sp.pct} onValue={(v) => setSp({ ...sp, pct: v })} unit="%" /></Field>
          <Field label={t('journal.diluent')}><input value={sp.diluent} onChange={(e) => setSp({ ...sp, diluent: e.target.value })} /></Field>
          <Field label={t('col.note')}><input value={sp.notes} onChange={(e) => setSp({ ...sp, notes: e.target.value })} /></Field>
        </Modal>
      )}
    </div>
  );
}
