import { useState } from 'react';
import { useStore } from '../store/store';
import { useI18n } from '../i18n';
import { addBlindRating, blindResults, createBlindSession, revealBlindSession } from '../domain/blind';
import { DemoBadge, Empty, Field, go, Modal } from './common';

const MEDIA = ['blotter', 'skin', 'fabric', 'other'];

export function BlindListPage() {
  const { state } = useStore();
  const { t, dateTime } = useI18n();
  const [creating, setCreating] = useState(false);
  const sessions = Object.values(state.blindSessions).filter((s) => !s.deletedAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('blind.title')}</h1>
        <div className="actions"><button className="primary" onClick={() => setCreating(true)}>{t('blind.new')}</button></div>
      </div>
      <p className="muted">{t('blind.explain')}</p>
      {sessions.length === 0 ? <Empty>{t('blind.none')}</Empty> : (
        <table className="tbl">
          <thead><tr><th>{t('blind.name')}</th><th>{t('blind.samples')}</th><th>{t('blind.ratings')}</th><th>{t('blind.state')}</th><th>{t('blind.created')}</th></tr></thead>
          <tbody>{sessions.map((s) => (
            <tr key={s.id}>
              <td><a href={`#/blind/${s.id}`}>{s.name}</a></td>
              <td className="num">{s.items.length}</td>
              <td className="num">{s.ratings.length}</td>
              <td>{s.revealedAt ? t('blind.revealed') : t('blind.open')}</td>
              <td>{dateTime(s.createdAt)}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {creating && <NewBlindModal onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewBlindModal({ onClose }: { onClose: () => void }) {
  const { state, run } = useStore();
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [medium, setMedium] = useState('blotter');
  const [picked, setPicked] = useState<string[]>([]);
  const samples = Object.values(state.samples).filter((s) => !s.deletedAt).sort((a, b) => a.code.localeCompare(b.code));
  const create = async () => {
    let id = '';
    const cs = await run((s) => { const r = createBlindSession(s, { name, medium, sampleIds: picked }); id = r.session.id; return r; });
    if (cs) { onClose(); go(`blind/${id}`); }
  };
  return (
    <Modal title={t('blind.new')} onClose={onClose} footer={<>
      <button onClick={onClose}>{t('common.cancel')}</button>
      <button className="primary" disabled={!name.trim() || picked.length < 2} onClick={create}>{t('common.create')}</button>
    </>}>
      <Field label={t('blind.name')}><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label={t('journal.medium')}>
        <select value={medium} onChange={(e) => setMedium(e.target.value)}>
          {MEDIA.map((m) => <option key={m} value={m}>{t(`medium.${m}` as never)}</option>)}
        </select>
      </Field>
      <p className="field-label">{t('blind.pickSamples')}</p>
      {samples.length < 2 ? <p className="muted">{t('blind.needSamples')}</p> : (
        <div className="check-list">
          {samples.map((s) => (
            <label key={s.id} className="check">
              <input type="checkbox" checked={picked.includes(s.id)}
                onChange={(e) => setPicked(e.target.checked ? [...picked, s.id] : picked.filter((x) => x !== s.id))} />
              <span className="mono">{s.code}</span> <DemoBadge show={s.demo} />
            </label>
          ))}
        </div>
      )}
      <p className="muted small">{t('blind.prepHint')}</p>
    </Modal>
  );
}

export function BlindSessionPage({ sessionId }: { sessionId: string }) {
  const { state, run } = useStore();
  const { t, dateTime } = useI18n();
  const s = state.blindSessions[sessionId];
  const [evaluator, setEvaluator] = useState('');
  const [form, setForm] = useState<Record<string, { intensity: string; liking: string; text: string }>>({});
  const [confirmReveal, setConfirmReveal] = useState(false);
  const [showKey, setShowKey] = useState(false);
  if (!s) return <div className="page"><Empty>{t('common.notFound')}</Empty></div>;
  const revealed = !!s.revealedAt;
  const results = blindResults(s);
  const sampleCode = (id: string) => state.samples[id]?.code ?? id;
  const f = (code: string) => form[code] ?? { intensity: '', liking: '', text: '' };
  const saveRating = async (code: string) => {
    const v = f(code);
    const num = (x: string) => (x === '' ? null : Number(x));
    const cs = await run((st) => addBlindRating(st, s.id, { code, evaluator, intensity: num(v.intensity), liking: num(v.liking), text: v.text.trim() }));
    if (cs) setForm({ ...form, [code]: { intensity: '', liking: '', text: '' } });
  };
  const fmt = (n: number | null) => (n === null ? '—' : n.toFixed(1));

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="crumbs"><a href="#/blind">{t('blind.title')}</a></div>
          <h1>{s.name}</h1>
          <div className="muted small">{t(`medium.${s.medium}` as never)} · {dateTime(s.createdAt)} · {revealed ? t('blind.revealedAt', { when: dateTime(s.revealedAt) }) : t('blind.open')}</div>
        </div>
        <div className="actions">
          {!revealed && <button onClick={() => setShowKey(!showKey)}>{showKey ? t('blind.hideKey') : t('blind.prepKey')}</button>}
          {!revealed && <button className="primary" onClick={() => setConfirmReveal(true)} disabled={s.ratings.length === 0}>{t('blind.reveal')}</button>}
        </div>
      </div>

      {!revealed && showKey && (
        <div className="warn-box">
          <p>{t('blind.keyWarning')}</p>
          <table className="tbl small"><tbody>{s.items.map((i) => <tr key={i.code}><td className="mono strong">{i.code}</td><td className="mono">{sampleCode(i.sampleId)}</td></tr>)}</tbody></table>
        </div>
      )}

      {!revealed && (
        <section className="panel">
          <h2>{t('blind.rate')}</h2>
          <Field label={t('journal.evaluator')}><input value={evaluator} onChange={(e) => setEvaluator(e.target.value)} /></Field>
          <table className="tbl">
            <thead><tr><th>{t('blind.code')}</th><th>{t('journal.intensity')}</th><th>{t('blind.liking')}</th><th>{t('blind.note')}</th><th /></tr></thead>
            <tbody>{[...s.items].sort((a, b) => a.code.localeCompare(b.code)).map((i) => (
              <tr key={i.code}>
                <td className="mono strong big">{i.code}</td>
                <td><select value={f(i.code).intensity} aria-label={t('journal.intensity')} onChange={(e) => setForm({ ...form, [i.code]: { ...f(i.code), intensity: e.target.value } })}>
                  <option value="">—</option>{[0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}</select></td>
                <td><select value={f(i.code).liking} aria-label={t('blind.liking')} onChange={(e) => setForm({ ...form, [i.code]: { ...f(i.code), liking: e.target.value } })}>
                  <option value="">—</option>{[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => <option key={n} value={n}>{n}</option>)}</select></td>
                <td><input value={f(i.code).text} aria-label={t('blind.note')} onChange={(e) => setForm({ ...form, [i.code]: { ...f(i.code), text: e.target.value } })} /></td>
                <td><button disabled={!evaluator.trim() || (!f(i.code).intensity && !f(i.code).liking && !f(i.code).text.trim())} onClick={() => saveRating(i.code)}>{t('blind.saveRating')}</button></td>
              </tr>
            ))}</tbody>
          </table>
          <p className="muted small">{t('blind.ratingsSoFar', { n: s.ratings.length })}</p>
        </section>
      )}

      {revealed && (
        <section className="panel">
          <h2>{t('blind.results')}</h2>
          <table className="tbl">
            <thead><tr><th>{t('blind.code')}</th><th>{t('blind.sample')}</th><th className="num">n</th><th className="num">{t('journal.intensity')}</th><th className="num">{t('blind.liking')}</th></tr></thead>
            <tbody>{results.map((r) => (
              <tr key={r.code}><td className="mono">{r.code}</td><td><a className="mono" href={`#/journal/${r.sampleId}`}>{sampleCode(r.sampleId)}</a></td>
                <td className="num">{r.n}</td><td className="num">{fmt(r.meanIntensity)}</td><td className="num">{fmt(r.meanLiking)}</td></tr>
            ))}</tbody>
          </table>
          <p className="muted small">{t('blind.smallSample')}</p>
          <h3>{t('blind.allRatings')}</h3>
          <table className="tbl small">
            <tbody>{s.ratings.map((r) => {
              const item = s.items.find((i) => i.code === r.code);
              return <tr key={r.id}><td className="mono">{r.code}</td><td className="mono">{item ? sampleCode(item.sampleId) : ''}</td><td>{r.evaluator}</td>
                <td>{r.intensity ?? '—'}</td><td>{r.liking ?? '—'}</td><td>{r.text}</td><td>{dateTime(r.at)}</td></tr>;
            })}</tbody>
          </table>
        </section>
      )}

      {confirmReveal && (
        <Modal title={t('blind.reveal')} onClose={() => setConfirmReveal(false)} footer={<>
          <button onClick={() => setConfirmReveal(false)}>{t('common.cancel')}</button>
          <button className="primary" onClick={async () => { await run((st) => revealBlindSession(st, s.id)); setConfirmReveal(false); }}>{t('blind.revealConfirm')}</button>
        </>}>
          <p>{t('blind.revealExplain', { n: s.ratings.length })}</p>
        </Modal>
      )}
    </div>
  );
}
