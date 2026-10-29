import { useEffect, useState } from 'react';
import { useStore } from '../store/store';
import { useI18n } from '../i18n';
import { addObservation, amendObservation, batchAgeMs, compoundedAt, createApplication, elapsedSinceApplication, supersededIds } from '../domain/journal';
import { DemoBadge, Empty, Field, fromLocalInput, go, Modal, toLocalInput, useNow, useRoute } from './common';

const MEDIA = ['blotter', 'skin', 'fabric', 'other'];

export function JournalPage({ sampleId }: { sampleId?: string }) {
  const { state, run } = useStore();
  const { t, pct, dateTime, duration } = useI18n();
  const { query } = useRoute();
  const now = useNow(5000);
  const samples = Object.values(state.samples).filter((s) => !s.deletedAt).sort((a, b) => b.preparedAt.localeCompare(a.preparedAt));
  const sample = sampleId ? state.samples[sampleId] : undefined;
  const apps = sample ? Object.values(state.applications).filter((a) => a.sampleId === sample.id).sort((a, b) => b.appliedAt.localeCompare(a.appliedAt)) : [];
  const [appId, setAppId] = useState<string | null>(query.get('app'));
  const app = appId ? state.applications[appId] : apps[0];
  const batch = sample ? state.batches[sample.batchId] : undefined;

  const presets = state.settings.checkpointPresets;
  const [newApp, setNewApp] = useState({ medium: 'blotter', appliedAt: toLocalInput(new Date().toISOString()), evaluator: '', checkpoints: presets, notes: '' });
  const [obs, setObs] = useState({ text: '', intensity: null as number | null, descriptors: '', at: '', checkpoint: null as number | null });
  const [amend, setAmend] = useState<null | { id: string; text: string; intensity: number | null; descriptors: string; reason: string }>(null);
  const replaced = supersededIds(state);

  useEffect(() => { setAppId(query.get('app')); }, [sampleId, query]);

  const apply = async () => {
    if (!sample) return;
    let id = '';
    const cs = await run((s) => {
      const r = createApplication(s, { sampleId: sample.id, medium: newApp.medium, appliedAt: fromLocalInput(newApp.appliedAt), evaluator: newApp.evaluator, checkpoints: newApp.checkpoints, notes: newApp.notes });
      id = r.application.id;
      return r;
    });
    if (cs) { setAppId(id); setNewApp({ ...newApp, appliedAt: toLocalInput(new Date().toISOString()) }); }
  };

  const save = async () => {
    if (!app) return;
    const at = obs.at ? fromLocalInput(obs.at)
      : obs.checkpoint !== null ? new Date(new Date(app.appliedAt).getTime() + obs.checkpoint * 60000).toISOString()
        : new Date().toISOString();
    const cs = await run((s) => addObservation(s, {
      applicationId: app.id, at, text: obs.text, intensity: obs.intensity,
      descriptors: obs.descriptors.split(/[,;]/).map((d) => d.trim()).filter(Boolean), checkpointMin: obs.checkpoint,
    }));
    if (cs) setObs({ text: '', intensity: null, descriptors: '', at: '', checkpoint: null });
  };

  const observations = app ? Object.values(state.observations).filter((o) => o.applicationId === app.id).sort((a, b) => a.at.localeCompare(b.at)) : [];

  return (
    <div className="page">
      <div className="page-head"><h1>{t('nav.journal')}</h1></div>
      <div className="journal">
        <aside className="panel journal-side">
          <h3>{t('journal.samples')}</h3>
          {samples.length === 0 ? <p className="muted">{t('journal.noSamples')}</p> : (
            <ul className="side-list">
              {samples.map((s) => (
                <li key={s.id} className={s.id === sampleId ? 'active' : ''}>
                  <a href={`#/journal/${s.id}`}><span className="mono">{s.code}</span> <DemoBadge show={s.demo} /><br />
                    <span className="muted small">{s.batchPercent === null ? t('common.unknown') : pct(s.batchPercent, 1)} {s.diluent} · {state.batches[s.batchId]?.revisionCode}</span></a>
                </li>
              ))}
            </ul>
          )}
        </aside>
        <section className="journal-main">
          {!sample || !batch ? <Empty>{t('journal.pickSample')}</Empty> : (
            <>
              <section className="panel">
                <h2 className="mono">{sample.code} <DemoBadge show={sample.demo} /></h2>
                <dl className="kv">
                  <dt>{t('journal.batch')}</dt><dd><a className="mono" href={`#/batch/${batch.id}`}>{batch.code}</a> · <a className="mono" href={`#/formula/${batch.revisionId}`}>{batch.revisionCode}</a></dd>
                  <dt>{t('journal.compounded')}</dt><dd>{dateTime(compoundedAt(batch))}</dd>
                  <dt>{t('journal.batchAgeNow')}</dt><dd>{duration(batchAgeMs(batch, now.toISOString()))}</dd>
                  <dt>{t('journal.samplePct')}</dt><dd>{sample.batchPercent === null ? t('common.unknown') : pct(sample.batchPercent, 2)} · {sample.diluent || '—'}</dd>
                </dl>
              </section>

              <section className="panel">
                <h3>{t('journal.applyTitle')}</h3>
                <div className="form-row">
                  <Field label={t('journal.medium')}>
                    <select value={newApp.medium} onChange={(e) => setNewApp({ ...newApp, medium: e.target.value })}>
                      {MEDIA.map((m) => <option key={m} value={m}>{t(`medium.${m}` as never)}</option>)}
                    </select>
                  </Field>
                  <Field label={t('journal.appliedAt')}><input type="datetime-local" value={newApp.appliedAt} onChange={(e) => setNewApp({ ...newApp, appliedAt: e.target.value })} /></Field>
                  <Field label={t('journal.evaluator')}><input value={newApp.evaluator} onChange={(e) => setNewApp({ ...newApp, evaluator: e.target.value })} /></Field>
                </div>
                <div className="chips">
                  <span className="muted small">{t('journal.checkpoints')}:</span>
                  {presets.map((p) => (
                    <label key={p} className="chip">
                      <input type="checkbox" checked={newApp.checkpoints.includes(p)}
                        onChange={(e) => setNewApp({ ...newApp, checkpoints: e.target.checked ? [...newApp.checkpoints, p] : newApp.checkpoints.filter((x) => x !== p) })} />
                      {duration(p * 60000)}
                    </label>
                  ))}
                </div>
                <button className="primary" onClick={apply}>{t('journal.apply')}</button>
              </section>

              {apps.length > 0 && (
                <section className="panel">
                  <div className="tabs">
                    {apps.map((a) => (
                      <button key={a.id} className={app?.id === a.id ? 'active' : ''} onClick={() => setAppId(a.id)}>
                        {t(`medium.${a.medium}` as never)} · {dateTime(a.appliedAt)}
                      </button>
                    ))}
                  </div>
                  {app && (
                    <>
                      <div className="clocks">
                        <div className="clock"><span className="bn-l">{t('journal.batchAge')}</span><span className="bn-v">{duration(batchAgeMs(batch, now.toISOString()))}</span></div>
                        <div className="clock"><span className="bn-l">{t('journal.sinceApplication')}</span><span className="bn-v">{duration(elapsedSinceApplication(app, now.toISOString()))}</span></div>
                        <div className="muted small">{t(`medium.${app.medium}` as never)} · {app.evaluator || '—'} · {sample.batchPercent === null ? t('common.unknown') : pct(sample.batchPercent, 1)} {sample.diluent}</div>
                      </div>
                      <div className="chips">
                        <span className="muted small">{t('journal.checkpoint')}:</span>
                        <button className={obs.checkpoint === null && !obs.at ? 'chip active' : 'chip'} onClick={() => setObs({ ...obs, checkpoint: null, at: '' })}>{t('journal.now')}</button>
                        {app.checkpoints.map((c) => {
                          const done = observations.some((o) => o.checkpointMin === c);
                          return <button key={c} className={`chip${obs.checkpoint === c ? ' active' : ''}${done ? ' done' : ''}`} onClick={() => setObs({ ...obs, checkpoint: c, at: '' })}>{duration(c * 60000)}{done ? ' ✓' : ''}</button>;
                        })}
                      </div>
                      <Field label={t('journal.observation')} hint={t('journal.observationHint')}>
                        <textarea rows={3} value={obs.text} onChange={(e) => setObs({ ...obs, text: e.target.value })}
                          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save(); }} autoFocus />
                      </Field>
                      <div className="form-row">
                        <Field label={t('journal.intensity')} hint={t('common.optional')}>
                          <select value={obs.intensity ?? ''} onChange={(e) => setObs({ ...obs, intensity: e.target.value === '' ? null : Number(e.target.value) })}>
                            <option value="">—</option>
                            {[0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
                          </select>
                        </Field>
                        <Field label={t('journal.descriptors')} hint={t('journal.descriptorsHint')}>
                          <input value={obs.descriptors} onChange={(e) => setObs({ ...obs, descriptors: e.target.value })} />
                        </Field>
                        <Field label={t('journal.observedAt')} hint={t('journal.observedAtHint')}>
                          <input type="datetime-local" value={obs.at} onChange={(e) => setObs({ ...obs, at: e.target.value, checkpoint: null })} />
                        </Field>
                      </div>
                      <button className="primary" onClick={save}>{t('journal.saveObservation')}</button>

                      <table className="tbl obs-table">
                        <thead><tr><th>{t('journal.batchAge')}</th><th>{t('journal.sinceApplication')}</th><th>{t('journal.observation')}</th><th>{t('journal.intensity')}</th><th /></tr></thead>
                        <tbody>{observations.map((o) => (
                          <tr key={o.id} className={replaced.has(o.id) ? 'superseded' : ''}>
                            <td>{duration(o.batchAgeMs)}</td>
                            <td>{duration(o.elapsedMs)}</td>
                            <td>
                              <span className="obs-text">{o.text}</span> {o.descriptors.length > 0 && <span className="muted">[{o.descriptors.join(', ')}]</span>} <DemoBadge show={o.demo} />
                              {replaced.has(o.id) && <div className="small muted">{t('journal.replaced')}</div>}
                              {o.supersedesId && <div className="small muted">{t('journal.correctedBecause', { reason: o.amendReason ?? '' })}</div>}
                            </td>
                            <td>{o.intensity ?? '—'}</td>
                            <td>{!replaced.has(o.id) && <button className="link" onClick={() => setAmend({ id: o.id, text: o.text, intensity: o.intensity, descriptors: o.descriptors.join(', '), reason: '' })}>{t('journal.correct')}</button>}</td>
                          </tr>
                        ))}</tbody>
                      </table>
                      <p className="muted small">{t('journal.clocksNote')}</p>
                    </>
                  )}
                </section>
              )}
              <div className="actions"><button onClick={() => go(`compare?b=${batch.revisionId}`)}>{t('journal.compareRevision')}</button></div>
            </>
          )}
        </section>
      </div>
      {amend && (
        <Modal title={t('journal.correctTitle')} onClose={() => setAmend(null)} footer={<>
          <button onClick={() => setAmend(null)}>{t('common.cancel')}</button>
          <button className="primary" disabled={!amend.reason.trim()} onClick={async () => {
            const cs = await run((s) => amendObservation(s, {
              observationId: amend.id, text: amend.text, intensity: amend.intensity, reason: amend.reason,
              descriptors: amend.descriptors.split(/[,;]/).map((d) => d.trim()).filter(Boolean),
            }));
            if (cs) setAmend(null);
          }}>{t('journal.saveCorrection')}</button>
        </>}>
          <p className="small">{t('journal.correctExplain')}</p>
          <Field label={t('journal.observation')}><textarea rows={3} value={amend.text} onChange={(e) => setAmend({ ...amend, text: e.target.value })} /></Field>
          <div className="form-row">
            <Field label={t('journal.intensity')}>
              <select value={amend.intensity ?? ''} onChange={(e) => setAmend({ ...amend, intensity: e.target.value === '' ? null : Number(e.target.value) })}>
                <option value="">—</option>
                {[0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </Field>
            <Field label={t('journal.descriptors')}><input value={amend.descriptors} onChange={(e) => setAmend({ ...amend, descriptors: e.target.value })} /></Field>
          </div>
          <Field label={t('common.reason')}><input value={amend.reason} onChange={(e) => setAmend({ ...amend, reason: e.target.value })} /></Field>
        </Modal>
      )}
    </div>
  );
}
