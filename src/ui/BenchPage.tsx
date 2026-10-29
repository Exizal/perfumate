import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store/store';
import { useI18n, parseUserNumber } from '../i18n';
import { D, Dec, placesOf } from '../domain/decimal';
import {
  actualByLine, applyTopUp, batchEvents, cancelBatch, completeBatch, currentTarget, deviations, keepAsWeighed,
  lineStatus, lotAvailable, recordAddition, recordCorrection, setCurrentLine, setPaused, topUpPreview,
} from '../domain/batch';
import { uid } from '../domain/ids';
import { DecimalInput, DemoBadge, Empty, Field, go, Modal, StateBadge } from './common';
import { BalanceReader, VolumeEntry } from './BalanceReader';

export function BenchList() {
  const { state } = useStore();
  const { t, dateTime } = useI18n();
  const all = Object.values(state.batches).filter((b) => !b.deletedAt).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const open = all.filter((b) => b.state === 'in_progress' || b.state === 'paused');
  const done = all.filter((b) => b.state === 'completed' || b.state === 'cancelled').slice(0, 20);
  const frozen = Object.values(state.revisions).filter((r) => r.status === 'frozen' && !r.deletedAt).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <div className="page">
      <div className="page-head"><h1>{t('nav.bench')}</h1></div>
      <section className="panel">
        <h2>{t('bench.open')}</h2>
        {open.length === 0 ? <p className="muted">{t('bench.noneOpen')}</p> : (
          <div className="bench-cards">
            {open.map((b) => {
              const act = actualByLine(state, b.id);
              const doneN = b.lines.filter((l) => lineStatus(b, currentTarget(b, l), act[l.lineId] ?? D(0)) === 'done').length;
              return (
                <button key={b.id} className="bench-card" onClick={() => go(`bench/${b.id}`)}>
                  <span className="mono big">{b.code}</span>
                  <span>{b.revisionCode} · {t('bench.progress', { done: doneN, total: b.lines.length })}</span>
                  <StateBadge state={b.state} /> <DemoBadge show={b.demo} />
                </button>
              );
            })}
          </div>
        )}
      </section>
      <section className="panel">
        <h2>{t('bench.startNew')}</h2>
        {frozen.length === 0 ? <p className="muted">{t('bench.noFrozen')}</p> : (
          <ul className="inline-list">{frozen.slice(0, 12).map((r) => (
            <li key={r.id}><button onClick={() => go(`plan/${r.id}`)}>{t('bench.makeFrom', { code: r.code })}</button></li>
          ))}</ul>
        )}
      </section>
      <section className="panel">
        <h2>{t('bench.recent')}</h2>
        {done.length === 0 ? <p className="muted">—</p> : (
          <table className="tbl"><tbody>{done.map((b) => (
            <tr key={b.id} className="clickable" onClick={() => go(`batch/${b.id}`)}>
              <td className="mono"><a href={`#/batch/${b.id}`}>{b.code}</a> <DemoBadge show={b.demo} /></td>
              <td className="mono">{b.revisionCode}</td><td><StateBadge state={b.state} /></td><td>{dateTime(b.completedAt ?? b.cancelledAt)}</td>
            </tr>
          ))}</tbody></table>
        )}
      </section>
    </div>
  );
}

const KEYPAD = ['7', '8', '9', '4', '5', '6', '1', '2', '3', '0', '.', '⌫'];

export function BenchMode({ batchId }: { batchId: string }) {
  const { state, run, toast } = useStore();
  const { t, grams, num, pct, dateTime, decimalSep, toInput } = useI18n();
  const batch = state.batches[batchId];
  const [entry, setEntry] = useState('');
  const [restored, setRestored] = useState(false);
  const [entryNote, setEntryNote] = useState('');
  const [lotId, setLotId] = useState<string | null>(null);
  const [modal, setModal] = useState<null | 'topup' | 'complete' | 'cancel' | 'correct' | 'list'>(null);
  const [factor, setFactor] = useState<string | null>(null);
  const [disposition, setDisposition] = useState('');
  const [correcting, setCorrecting] = useState<{ eventId: string; mass: string | null; reason: string } | null>(null);
  const keyRef = useRef(uid('w'));
  const entryRef = useRef<HTMLInputElement>(null);

  // Current line is local so switching is instant; the position is saved in the background.
  const [localIdx, setLocalIdx] = useState<number | null>(null);
  const idx = batch ? Math.min(localIdx ?? batch.currentLineIndex, batch.lines.length - 1) : 0;
  const line = batch?.lines[idx];
  const draftKey = line ? `bench:${batchId}:${line.lineId}` : '';

  // Local autosave of the number being typed, per line.
  useEffect(() => {
    if (!line) return;
    let saved = '';
    try { saved = localStorage.getItem(draftKey) ?? ''; } catch { /* storage unavailable */ }
    setEntry(saved);
    setRestored(saved !== '');
    setLotId(line.plannedLotId);
    keyRef.current = uid('w');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [line?.lineId]);
  useEffect(() => {
    if (!draftKey) return;
    try { entry ? localStorage.setItem(draftKey, entry) : localStorage.removeItem(draftKey); } catch { /* storage unavailable */ }
  }, [entry, draftKey]);

  const act = useMemo(() => (batch ? actualByLine(state, batch.id) : {}), [state, batch]);
  if (!batch || !line) return <div className="page"><Empty>{t('common.notFound')}</Empty></div>;

  const places = placesOf(batch.balanceReadability);
  const locked = batch.state === 'completed' || batch.state === 'cancelled';
  const paused = batch.state === 'paused';
  const target = currentTarget(batch, line);
  const actual = act[line.lineId] ?? D(0);
  const remaining = Dec.max(target.minus(actual), 0);
  const over = actual.minus(target);
  const isOver = lineStatus(batch, target, actual) === 'over';
  const devs = deviations(state, batch, false);
  const events = batchEvents(state, batch.id).filter((e) => e.lineId === line.lineId);
  const lots = Object.values(state.lots).filter((l) => l.materialId === line.materialId && !l.deletedAt);
  const parsed = parseUserNumber(entry);
  const entryVal = parsed.ok && parsed.value ? D(parsed.value) : null;
  const belowMin = entryVal && entryVal.greaterThan(0) && entryVal.lessThan(D(batch.practicalMin));
  const targetBelowMin = !target.isZero() && target.lessThan(D(batch.practicalMin));

  const goLine = (i: number) => {
    if (i < 0 || i >= batch.lines.length) return;
    setLocalIdx(i);
    run((s) => setCurrentLine(s, batch.id, i));
  };
  const record = async () => {
    if (!parsed.ok) { toast(t('input.invalidNumber'), 'error'); return; }
    if (!parsed.value || !D(parsed.value).greaterThan(0)) { toast(t('err.invalid_mass'), 'error'); return; }
    const key = keyRef.current;
    const cs = await run((s) => recordAddition(s, { batchId: batch.id, lineId: line.lineId, mass: parsed.value!, lotId, idempotencyKey: key, note: entryNote }));
    if (cs) {
      keyRef.current = uid('w');
      setEntry('');
      setEntryNote('');
      setRestored(false);
      toast(t('bench.recorded', { mass: grams(parsed.value, places), name: line.materialName }));
      entryRef.current?.focus();
    }
  };
  const press = (k: string) => {
    if (k === '⌫') setEntry((e) => e.slice(0, -1));
    else if (k === '.') setEntry((e) => (e.includes(decimalSep) || e.includes('.') ? e : (e || '0') + decimalSep));
    else setEntry((e) => e + k);
    entryRef.current?.focus();
  };

  const preview = modal === 'topup' ? topUpPreview(state, batch, factor ?? undefined) : null;

  const statusOf = (i: number) => {
    const l = batch.lines[i];
    return lineStatus(batch, currentTarget(batch, l), act[l.lineId] ?? D(0));
  };

  const lineList = (
    <ol className="bench-list">
      {batch.lines.map((l, i) => {
        const st = statusOf(i);
        return (
          <li key={l.lineId} className={`${i === idx ? 'current' : ''} st-${st}`}>
            <button onClick={() => { goLine(i); setModal(null); }}>
              <span className="bl-name">{l.materialName}</span>
              <span className="bl-num">{grams(act[l.lineId] ?? D(0), places)} / {grams(currentTarget(batch, l), places)}</span>
              <span className="bl-st">{t(`bench.st.${st}` as never)}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );

  return (
    <div className="bench">
      <div className="bench-top">
        <div>
          <span className="mono big">{batch.code}</span> <StateBadge state={batch.state} /> <DemoBadge show={batch.demo} />
          <div className="muted small">{batch.revisionCode} · {t('bench.size', { size: grams(D(batch.targetSize).times(batch.planFactor), places) })}{batch.planFactor !== '1' ? ` (×${num(batch.planFactor)})` : ''}</div>
        </div>
        <div className="actions">
          <button className="only-narrow" onClick={() => setModal('list')}>{t('bench.allLines')}</button>
          {!locked && (paused
            ? <button className="primary big-btn" onClick={() => run((s) => setPaused(s, batch.id, false))}>{t('bench.resume')}</button>
            : <button className="big-btn" onClick={() => run((s) => setPaused(s, batch.id, true))}>{t('bench.pause')}</button>)}
          {!locked && <button className="primary big-btn" onClick={() => setModal('complete')}>{t('bench.complete')}</button>}
          <button onClick={() => go(`batch/${batch.id}`)}>{t('bench.record')}</button>
          {!locked && <button className="danger" onClick={() => setModal('cancel')}>{t('bench.cancelBatch')}</button>}
        </div>
      </div>

      {locked && <p className="warn-box">{t('bench.locked')} <a href={`#/batch/${batch.id}`}>{t('bench.openRecord')}</a></p>}

      {devs.length > 0 && !locked && (
        <div className="deviation">
          <div>
            <strong>{t('bench.deviation', { n: devs.length })}</strong>{' '}
            {devs.map((d) => `${d.materialName}: ${grams(d.actual, places)} / ${grams(d.target, places)}`).join(' · ')}
            {batch.deviationDecision && <span className="muted"> · {t(`bench.decision.${batch.deviationDecision}` as never)}</span>}
          </div>
          <div className="actions">
            <button onClick={() => run((s) => keepAsWeighed(s, batch.id))}>{t('bench.keepAsWeighed')}</button>
            <button className="primary" onClick={() => { setFactor(null); setModal('topup'); }}>{t('bench.previewTopUp')}</button>
          </div>
        </div>
      )}

      <div className="bench-body">
        <aside className="bench-side">{lineList}</aside>
        <section className="bench-main">
          <div className="bench-line-head">
            <span className="muted">{t('bench.lineOf', { n: idx + 1, total: batch.lines.length })}</span>
            <h1 className="bench-material">{line.materialName}</h1>
            <div className="bench-stock">
              {line.strength === null ? t('bench.strengthUnknown') : t('bench.strength', { s: pct(line.strength, 3) })}
              {line.carrier ? ` · ${line.carrier}` : ''}
            </div>
          </div>
          <div className="bench-nums">
            <div className="bn"><span className="bn-l">{t('bench.target')}</span><span className="bn-v">{grams(target, places)}</span>
              {batch.planFactor !== '1' && <span className="bn-s">{t('bench.originalTarget', { v: grams(line.targetGrams, places) })}</span>}</div>
            <div className="bn"><span className="bn-l">{t('bench.added')}</span><span className="bn-v">{grams(actual, places)}</span></div>
            <div className={`bn${isOver ? ' bn-over' : ''}`}>
              <span className="bn-l">{isOver ? t('bench.over') : t('bench.remaining')}</span>
              <span className="bn-v">{grams(isOver ? over : remaining, places)}</span>
            </div>
          </div>
          {targetBelowMin && <p className="warn-box">{t('bench.targetBelowMin', { min: grams(batch.practicalMin, places) })}</p>}
          {target.isZero() && <p className="warn-box">{t('bench.zeroTarget')}</p>}

          <div className={`bench-entry${paused || locked ? ' disabled' : ''}`}>
            <Field label={t('bench.lot')}>
              <select value={lotId ?? ''} onChange={(e) => setLotId(e.target.value || null)} disabled={paused || locked}>
                <option value="">{t('bench.untrackedLot')}</option>
                {lots.map((l) => {
                  const bal = lotAvailable(state, l.id, batch.id);
                  return <option key={l.id} value={l.id}>{l.lotCode} · {l.strength === null ? '?' : `${num(l.strength, 3)} %`} · {bal === null ? t('common.unknown') : grams(bal, places)}</option>;
                })}
              </select>
            </Field>
            <label className="bench-input">
              <span>{t('bench.addition')}</span>
              <span className="dec-input big">
                <input ref={entryRef} value={entry} inputMode="decimal" autoFocus disabled={paused || locked}
                  aria-label={t('bench.addition')}
                  onFocus={(e) => { if (restored) e.target.select(); }}
                  onChange={(e) => { setEntry(e.target.value); setRestored(false); setEntryNote(''); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); record(); } }} />
                <span className="unit">g</span>
              </span>
            </label>
            {entryNote && entry && <p className="muted small">{entryNote}</p>}
            <BalanceReader disabled={paused || locked}
              baudRate={state.settings.balances?.find((b) => b.name === batch.balanceName)?.baudRate ?? 9600}
              onUse={(g, note) => { setEntry(toInput(g)); setEntryNote(note); setRestored(false); entryRef.current?.focus(); }} />
            {line.materialId && state.materials[line.materialId]?.density && (
              <VolumeEntry density={state.materials[line.materialId].density!} disabled={paused || locked}
                onUse={(g, note) => { setEntry(toInput(g)); setEntryNote(note); setRestored(false); entryRef.current?.focus(); }} />
            )}
            {restored && entry && <p className="muted">{t('bench.restoredDraft')} <button className="link" onClick={() => { setEntry(''); setRestored(false); }}>{t('bench.clearDraft')}</button></p>}
            {!parsed.ok && <p className="warn-text">{t('input.invalidNumber')}</p>}
            {belowMin && <p className="warn-text">{t('bench.entryBelowMin', { min: grams(batch.practicalMin, places) })}</p>}
            <div className="keypad">
              {KEYPAD.map((k) => <button key={k} onClick={() => press(k)} disabled={paused || locked}>{k === '.' ? decimalSep : k}</button>)}
            </div>
            <button className="primary record-btn" onClick={record} disabled={paused || locked || !entryVal || !entryVal.greaterThan(0)}>
              {t('bench.recordAddition')}
            </button>
            {paused && <p className="muted">{t('bench.pausedNote')}</p>}
          </div>

          <div className="bench-nav">
            <button className="big-btn" onClick={() => goLine(idx - 1)} disabled={idx === 0}>{t('bench.prev')}</button>
            <button className={`big-btn${lineStatus(batch, target, actual) === 'done' ? ' primary' : ''}`} onClick={() => goLine(idx + 1)} disabled={idx >= batch.lines.length - 1}>{t('bench.next')}</button>
          </div>

          {events.length > 0 && (
            <table className="tbl small">
              <thead><tr><th>{t('bench.time')}</th><th className="num">{t('bench.mass')}</th><th>{t('bench.lot')}</th><th /></tr></thead>
              <tbody>{events.map((e) => (
                <tr key={e.id}>
                  <td>{dateTime(e.at)}</td>
                  <td className="num">{e.kind === 'correction' ? `${t('bench.correction')} ${grams(e.mass, places)}` : grams(e.mass, places)}</td>
                  <td>{e.lotId ? state.lots[e.lotId]?.lotCode : t('bench.untrackedLot')}{e.reason ? ` · ${e.reason}` : ''}</td>
                  <td>{e.kind === 'addition' && !locked && <button className="link" onClick={() => { setCorrecting({ eventId: e.id, mass: e.mass, reason: '' }); setModal('correct'); }}>{t('bench.correct')}</button>}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </section>
      </div>

      {modal === 'list' && <Modal title={t('bench.allLines')} onClose={() => setModal(null)}>{lineList}</Modal>}

      {modal === 'topup' && preview && (
        <Modal wide title={t('bench.topUpTitle')} onClose={() => setModal(null)} footer={<>
          <button onClick={() => setModal(null)}>{t('common.cancel')}</button>
          <button className="primary" disabled={preview.unrepairable.length > 0}
            onClick={async () => { const cs = await run((s) => applyTopUp(s, batch.id, preview.factor.toFixed())); if (cs) setModal(null); }}>
            {t('bench.applyPlan', { size: grams(preview.newSize, places) })}
          </button>
        </>}>
          <p>{t('bench.topUpExplain', { min: num(preview.minFactor, 4), size: grams(preview.newSize, places) })}</p>
          {preview.unrepairable.length > 0 && <p className="warn-box">{t('bench.unrepairable', { names: preview.unrepairable.join(', ') })}</p>}
          {preview.capacityExceeded && <p className="warn-box">{t('bench.capacityExceeded', { cap: grams(batch.containerCapacity, places) })}</p>}
          <Field label={t('bench.factor')} hint={t('bench.factorHint', { min: num(preview.minFactor, 4) })}>
            <DecimalInput value={factor ?? preview.minFactor.toFixed()} onValue={setFactor} unit="×" />
          </Field>
          <table className="tbl">
            <thead><tr>
              <th>{t('col.material')}</th><th className="num">{t('bench.originalTargetCol')}</th><th className="num">{t('bench.newTarget')}</th>
              <th className="num">{t('bench.added')}</th><th className="num">{t('bench.stillNeeded')}</th><th className="num">{t('plan.available')}</th>
            </tr></thead>
            <tbody>{preview.lines.map((l) => (
              <tr key={l.lineId} className={l.stockShort ? 'warn-row' : ''}>
                <td>{l.materialName}</td><td className="num">{grams(l.originalTarget, places)}</td><td className="num">{grams(l.newTarget, places)}</td>
                <td className="num">{grams(l.alreadyAdded, places)}</td><td className="num strong">{grams(l.stillNeeded, places)}</td>
                <td className="num">{l.lotId ? grams(l.available, places) : t('common.unknown')}{l.stockShort ? ` · ${t('plan.wStockShort')}` : ''}</td>
              </tr>
            ))}</tbody>
          </table>
          <p className="muted small">{t('bench.topUpNote')}</p>
        </Modal>
      )}

      {modal === 'complete' && (
        <Modal title={t('bench.complete')} onClose={() => setModal(null)} footer={<>
          <button onClick={() => setModal(null)}>{t('common.cancel')}</button>
          <button className="primary" onClick={async () => { const cs = await run((s) => completeBatch(s, batch.id)); if (cs) go(`batch/${batch.id}`); }}>{t('bench.completeConfirm')}</button>
        </>}>
          <p>{t('bench.completeExplain')}</p>
          {(() => {
            const all = deviations(state, batch, true);
            return all.length ? (
              <ul>{all.map((d) => <li key={d.lineId} className="warn-text">{d.materialName}: {grams(d.actual, places)} / {grams(d.target, places)} ({t(`bench.dev.${d.kind}` as never)})</li>)}</ul>
            ) : <p>{t('bench.noDeviations')}</p>;
          })()}
          {devs.length > 0 && !batch.deviationDecision && <p className="muted">{t('bench.completeKeeps')}</p>}
        </Modal>
      )}

      {modal === 'cancel' && (
        <Modal title={t('bench.cancelBatch')} onClose={() => setModal(null)} footer={<>
          <button onClick={() => setModal(null)}>{t('common.back')}</button>
          <button className="danger" disabled={!disposition.trim()} onClick={async () => { const cs = await run((s) => cancelBatch(s, batch.id, disposition)); if (cs) go(`batch/${batch.id}`); }}>{t('bench.cancelConfirm')}</button>
        </>}>
          <p>{t('bench.cancelExplain')}</p>
          <Field label={t('bench.disposition')}><textarea rows={3} value={disposition} onChange={(e) => setDisposition(e.target.value)} placeholder={t('bench.dispositionPh')} /></Field>
        </Modal>
      )}

      {modal === 'correct' && correcting && (
        <Modal title={t('bench.correctTitle')} onClose={() => setModal(null)} footer={<>
          <button onClick={() => setModal(null)}>{t('common.cancel')}</button>
          <button className="primary" disabled={!correcting.reason.trim() || correcting.mass === null}
            onClick={async () => {
              const cs = await run((s) => recordCorrection(s, { eventId: correcting.eventId, correctMass: correcting.mass!, reason: correcting.reason, idempotencyKey: uid('corr') }));
              if (cs) setModal(null);
            }}>{t('bench.saveCorrection')}</button>
        </>}>
          <p>{t('bench.correctExplain')}</p>
          <Field label={t('bench.correctMass')}><DecimalInput value={correcting.mass} onValue={(v) => setCorrecting({ ...correcting, mass: v })} unit="g" /></Field>
          <Field label={t('common.reason')}><input value={correcting.reason} onChange={(e) => setCorrecting({ ...correcting, reason: e.target.value })} /></Field>
        </Modal>
      )}
    </div>
  );
}
