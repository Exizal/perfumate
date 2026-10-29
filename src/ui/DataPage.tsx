import { useState } from 'react';
import { useStore } from '../store/store';
import { useI18n } from '../i18n';
import { backupToState, buildBackup, BackupError, integrityProblems, parseBackup, SCHEMA_VERSION, type Backup } from '../domain/backup';
import { buildDemo, removeDemo } from '../domain/demo';
import { restoreDeleted } from '../domain/revisions';
import { D } from '../domain/decimal';
import { DecimalInput, download, Field, Modal } from './common';
import { exportWorkbook } from '../services/exporters';
import { AiSettings, BalanceProfiles, MergeSummary, SyncPanel } from './DataExtras';
import { mergeStates } from '../domain/merge';

export function DataPage() {
  const { state, run, replace, toast, errorText, persisted } = useStore();
  const { t, dateTime, grams } = useI18n();
  const s = state.settings;
  const [pending, setPending] = useState<{ backup: Backup; problems: string[] } | null>(null);
  const [restoreMode, setRestoreMode] = useState<'merge' | 'replace'>('merge');
  const [demoRemove, setDemoRemove] = useState<Record<string, number> | null>(null);
  const [persistState, setPersistState] = useState<boolean | null>(persisted);
  const [presets, setPresets] = useState(s.checkpointPresets.join(', '));
  const hasDemo = Object.values(state.projects).some((p) => p.demo);

  const doBackup = async () => {
    const at = new Date().toISOString();
    const b = buildBackup(state, at);
    download(`lab-journal-backup-${at.slice(0, 19).replace(/[:T]/g, '-')}.json`, JSON.stringify(b, null, 1), 'application/json');
    // Record the backup time only after the file has been produced.
    await run((st) => ({ settings: { ...st.settings, lastBackupAt: at } }));
    toast(t('data.backupDone'));
  };

  const onRestoreFile = async (f: File) => {
    try {
      const b = parseBackup(await f.text());
      setPending({ backup: b, problems: integrityProblems(backupToState(b)) });
    } catch (e) {
      toast(e instanceof BackupError ? t(`err.backup_${e.code}` as never) : errorText(e), 'error');
    }
  };

  const confirmRestore = async () => {
    if (!pending) return;
    if (restoreMode === 'merge') {
      const incoming = backupToState(pending.backup);
      const cs = await run((st) => mergeStates(st, incoming).cs);
      setPending(null);
      if (cs) toast(t('merge.done'));
      return;
    }
    const ok = await replace(backupToState(pending.backup));
    setPending(null);
    if (ok) toast(t('data.restored'));
  };

  const setSetting = (patch: Partial<typeof s>) => run((st) => ({ settings: { ...st.settings, ...patch } }));
  const deleted = [
    ...Object.values(state.projects).filter((p) => p.deletedAt).map((p) => ({ store: 'projects' as const, id: p.id, label: p.name, at: p.deletedAt! })),
    ...Object.values(state.revisions).filter((r) => r.deletedAt).map((r) => ({ store: 'revisions' as const, id: r.id, label: r.code, at: r.deletedAt! })),
  ];

  return (
    <div className="page">
      <div className="page-head"><h1>{t('nav.data')}</h1></div>

      <section className="panel">
        <h2>{t('data.backup')}</h2>
        <p>{t('data.backupExplain')}</p>
        <p className={s.lastBackupAt ? '' : 'warn-text'}>{s.lastBackupAt ? t('save.lastBackup', { when: dateTime(s.lastBackupAt) }) : t('save.noBackup')}</p>
        <div className="actions">
          <button className="primary" onClick={doBackup}>{t('data.downloadBackup')}</button>
          <label className="button">
            {t('data.restore')}
            <input type="file" accept=".json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onRestoreFile(f); e.target.value = ''; }} />
          </label>
          <button onClick={() => exportWorkbook(state)}>{t('data.exportWorkbook')}</button>
        </div>
        <p className="muted small">{t('data.storageNote')}</p>
        <p className="small">
          {persistState === true ? t('data.persistOn') : t('data.persistOff')}{' '}
          {persistState !== true && navigator.storage?.persist && (
            <button className="link" onClick={async () => setPersistState(await navigator.storage.persist())}>{t('data.requestPersist')}</button>
          )}
        </p>
      </section>

      <section className="panel">
        <h2>{t('data.settings')}</h2>
        <div className="form-row">
          <Field label={t('data.readability')} hint={t('data.readabilityHint')}>
            <DecimalInput value={s.balanceReadability} onValue={(v) => v && D(v).greaterThan(0) && setSetting({ balanceReadability: v })} unit="g" />
          </Field>
          <Field label={t('data.practicalMin')} hint={t('data.practicalMinHint')}>
            <DecimalInput value={s.practicalMin} onValue={(v) => v && D(v).greaterThanOrEqualTo(0) && setSetting({ practicalMin: v })} unit="g" />
          </Field>
          <Field label={t('data.currency')}>
            <input value={s.currency} maxLength={3} onChange={(e) => setSetting({ currency: e.target.value.toUpperCase() })} />
          </Field>
          <Field label={t('theme.label')}>
            <select value={s.theme ?? 'system'} onChange={(e) => setSetting({ theme: e.target.value as 'system' | 'light' | 'dark' })}>
              <option value="system">{t('theme.system')}</option>
              <option value="light">{t('theme.light')}</option>
              <option value="dark">{t('theme.dark')}</option>
            </select>
          </Field>
          <Field label={t('data.checkpoints')} hint={t('data.checkpointsHint')}>
            <input value={presets} onChange={(e) => setPresets(e.target.value)}
              onBlur={() => {
                const list = presets.split(/[,;\s]+/).map(Number).filter((n) => Number.isFinite(n) && n >= 0);
                if (list.length) setSetting({ checkpointPresets: [...new Set(list)].sort((a, b) => a - b) });
              }} />
          </Field>
        </div>
        <p className="muted small">{t('data.settingsNote', { read: grams(s.balanceReadability), min: grams(s.practicalMin) })}</p>
      </section>

      <BalanceProfiles />
      <SyncPanel />
      <AiSettings />

      <section className="panel">
        <h2>{t('data.demo')}</h2>
        <p>{t('demo.explain')}</p>
        <div className="actions">
          <button disabled={hasDemo} onClick={() => run((st) => buildDemo(st))}>{t('demo.load')}</button>
          <button className="danger" disabled={!hasDemo} onClick={() => setDemoRemove(removeDemo(state).counts)}>{t('demo.remove')}</button>
        </div>
      </section>

      <section className="panel">
        <h2>{t('data.deleted')}</h2>
        {deleted.length === 0 ? <p className="muted">{t('data.noDeleted')}</p> : (
          <table className="tbl small"><tbody>{deleted.map((d) => (
            <tr key={d.id}><td className="mono">{d.label}</td><td>{dateTime(d.at)}</td>
              <td><button onClick={() => run((st) => ({ [d.store]: [restoreDeleted(st[d.store][d.id])] }))}>{t('data.recover')}</button></td></tr>
          ))}</tbody></table>
        )}
      </section>

      <section className="panel">
        <h2>{t('data.about')}</h2>
        <p className="small">{t('data.aboutText', { v: SCHEMA_VERSION })}</p>
      </section>

      {pending && (
        <Modal title={t('data.restore')} onClose={() => setPending(null)} footer={<>
          <button onClick={() => setPending(null)}>{t('common.cancel')}</button>
          <button className={restoreMode === 'merge' ? 'primary' : 'danger'} onClick={confirmRestore}>{restoreMode === 'merge' ? t('merge.confirm') : t('data.restoreConfirm')}</button>
        </>}>
          <p>{t('data.restoreExplain', { when: dateTime(pending.backup.exportedAt), v: pending.backup.schemaVersion })}</p>
          <table className="tbl small"><tbody>
            {Object.entries(pending.backup.counts).filter(([, n]) => n > 0).map(([k, n]) => <tr key={k}><td>{k}</td><td className="num">{n}</td></tr>)}
          </tbody></table>
          {pending.problems.length > 0 && <div className="warn-box"><p>{t('data.integrity')}</p><ul>{pending.problems.slice(0, 10).map((p) => <li key={p}>{p}</li>)}</ul></div>}
          <fieldset className="radio-group">
            <legend>{t('merge.mode')}</legend>
            <label className="check"><input type="radio" name="rmode" checked={restoreMode === 'merge'} onChange={() => setRestoreMode('merge')} /> {t('merge.modeMerge')}</label>
            <label className="check"><input type="radio" name="rmode" checked={restoreMode === 'replace'} onChange={() => setRestoreMode('replace')} /> {t('merge.modeReplace')}</label>
          </fieldset>
          {restoreMode === 'merge' ? <MergeSummary r={mergeStates(state, backupToState(pending.backup))} /> : <p className="warn-text">{t('data.restoreWarn')}</p>}
        </Modal>
      )}
      {demoRemove && (
        <Modal title={t('demo.remove')} onClose={() => setDemoRemove(null)} footer={<>
          <button onClick={() => setDemoRemove(null)}>{t('common.cancel')}</button>
          <button className="danger" onClick={async () => { await run((st) => removeDemo(st).cs); setDemoRemove(null); }}>{t('demo.removeConfirm')}</button>
        </>}>
          <p>{t('demo.removeExplain')}</p>
          <table className="tbl small"><tbody>{Object.entries(demoRemove).map(([k, n]) => <tr key={k}><td>{k}</td><td className="num">{n}</td></tr>)}</tbody></table>
        </Modal>
      )}
    </div>
  );
}
