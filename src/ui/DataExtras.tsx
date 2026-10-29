import { useState } from 'react';
import { useStore } from '../store/store';
import { useI18n } from '../i18n';
import { D } from '../domain/decimal';
import { uid } from '../domain/ids';
import { backupToState, buildBackup, parseBackup } from '../domain/backup';
import { mergeStates, type MergeResult } from '../domain/merge';
import { applyChangeset, type BalanceProfile, type DataState } from '../domain/types';
import { desktop } from '../services/desktop';
import { DecimalInput, Field } from './common';
import { AI_KEY_STORAGE, getAiKey } from '../services/ai';

export const SYNC_FILE = 'lab-journal-sync.json';

export function BalanceProfiles() {
  const { state, run } = useStore();
  const { t, grams } = useI18n();
  const list = state.settings.balances ?? [];
  const save = (next: BalanceProfile[]) => run((s) => ({ settings: { ...s.settings, balances: next } }));
  const patch = (id: string, p: Partial<BalanceProfile>) => save(list.map((b) => (b.id === id ? { ...b, ...p } : b)));
  return (
    <section className="panel">
      <h2>{t('balance.title')}</h2>
      <p className="muted small">{t('balance.explain')}</p>
      <Field label={t('balance.defaultName')}>
        <input value={state.settings.defaultBalanceName ?? ''} onChange={(e) => run((s) => ({ settings: { ...s.settings, defaultBalanceName: e.target.value } }))} />
      </Field>
      <p className="muted small">{t('balance.defaultUses', { read: grams(state.settings.balanceReadability), min: grams(state.settings.practicalMin) })}</p>
      {list.length > 0 && (
        <table className="tbl small">
          <thead><tr><th>{t('balance.name')}</th><th>{t('data.readability')}</th><th>{t('data.practicalMin')}</th><th>{t('balance.baud')}</th><th /></tr></thead>
          <tbody>{list.map((b) => (
            <tr key={b.id}>
              <td><input value={b.name} aria-label={t('balance.name')} onChange={(e) => patch(b.id, { name: e.target.value })} /></td>
              <td><DecimalInput value={b.readability} ariaLabel={t('data.readability')} unit="g" onValue={(v) => v && D(v).greaterThan(0) && patch(b.id, { readability: v })} /></td>
              <td><DecimalInput value={b.practicalMin} ariaLabel={t('data.practicalMin')} unit="g" onValue={(v) => v && D(v).greaterThanOrEqualTo(0) && patch(b.id, { practicalMin: v })} /></td>
              <td>
                <select value={b.baudRate} aria-label={t('balance.baud')} onChange={(e) => patch(b.id, { baudRate: Number(e.target.value) })}>
                  {[1200, 2400, 4800, 9600, 19200, 38400].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </td>
              <td><button className="danger" onClick={() => save(list.filter((x) => x.id !== b.id))}>{t('common.remove')}</button></td>
            </tr>
          ))}</tbody>
        </table>
      )}
      <div className="actions">
        <button onClick={() => save([...list, { id: uid('bal'), name: t('balance.newName', { n: list.length + 2 }), readability: '0.001', practicalMin: '0.010', baudRate: 9600 }])}>{t('balance.add')}</button>
      </div>
      <p className="muted small">{t('balance.historyNote')}</p>
    </section>
  );
}

export function MergeSummary({ r }: { r: MergeResult }) {
  const { t } = useI18n();
  const added = Object.entries(r.added).filter(([, n]) => n);
  return (
    <div>
      <p>{t('merge.summary', { added: added.reduce((a, [, n]) => a + (n ?? 0), 0), updated: r.updated, conflicts: r.conflicts.length })}</p>
      {added.length > 0 && <table className="tbl small"><tbody>{added.map(([k, n]) => <tr key={k}><td>{k}</td><td className="num">+{n}</td></tr>)}</tbody></table>}
      {r.conflicts.length > 0 && (
        <div className="warn-box small"><p>{t('merge.conflicts')}</p><ul>{r.conflicts.slice(0, 12).map((c) => <li key={c.store + c.id}>{c.store}: {c.label}</li>)}</ul></div>
      )}
      {r.duplicateCodes.length > 0 && <p className="warn-text small">{t('merge.duplicates', { codes: r.duplicateCodes.slice(0, 8).join(', ') })}</p>}
    </div>
  );
}

export function SyncPanel() {
  const { state, run, toast, errorText } = useStore();
  const { t, dateTime } = useI18n();
  const bridge = desktop();
  const [last, setLast] = useState<MergeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const folder = state.settings.syncFolder ?? null;

  const choose = async () => {
    const f = await bridge?.pickFolder();
    if (f) await run((s) => ({ settings: { ...s.settings, syncFolder: f } }));
  };

  const syncNow = async () => {
    if (!bridge || !folder) return;
    setBusy(true);
    try {
      const path = bridge.joinPath(folder, SYNC_FILE);
      const text = await bridge.readText(path);
      const incoming = text ? backupToState(parseBackup(text)) : null;
      let merged: DataState | null = null;
      let result: MergeResult | null = null;
      const at = new Date().toISOString();
      const cs = await run((s) => {
        result = incoming ? mergeStates(s, incoming) : { cs: {}, added: {}, updated: 0, conflicts: [], duplicateCodes: [] };
        const settings = { ...s.settings, lastSyncAt: at };
        merged = applyChangeset(s, { ...result.cs, settings });
        return { ...result.cs, settings };
      });
      if (cs && merged) {
        await bridge.writeText(path, JSON.stringify(buildBackup(merged, at), null, 1));
        setLast(result);
        toast(t('sync.done'));
      }
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <h2>{t('sync.title')}</h2>
      <p>{t('sync.explain')}</p>
      {!bridge ? <p className="muted">{t('sync.desktopOnly')}</p> : (
        <>
          <p className="small">{folder ? <>{t('sync.folder')}: <span className="mono">{folder}</span></> : t('sync.noFolder')}</p>
          {state.settings.lastSyncAt && <p className="small muted">{t('sync.last', { when: dateTime(state.settings.lastSyncAt) })}</p>}
          <div className="actions">
            <button onClick={choose}>{t('sync.choose')}</button>
            <button className="primary" disabled={!folder || busy} onClick={syncNow}>{busy ? t('save.saving') : t('sync.now')}</button>
          </div>
          {last && <MergeSummary r={last} />}
        </>
      )}
      <p className="muted small">{t('sync.note')}</p>
    </section>
  );
}

export function AiSettings() {
  const { t } = useI18n();
  const [key, setKey] = useState(getAiKey() ?? '');
  const [saved, setSaved] = useState(!!getAiKey());
  const store = (v: string | null) => {
    try {
      if (v) localStorage.setItem(AI_KEY_STORAGE, v); else localStorage.removeItem(AI_KEY_STORAGE);
    } catch { /* storage blocked */ }
    setSaved(!!v);
  };
  return (
    <section className="panel">
      <h2>{t('ai.settingsTitle')}</h2>
      <p>{t('ai.settingsExplain')}</p>
      <Field label={t('ai.key')} hint={saved ? t('ai.keySaved') : t('ai.keyHint')}>
        <input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} />
      </Field>
      <div className="actions">
        <button onClick={() => store(key.trim() || null)} disabled={!key.trim()}>{t('common.save')}</button>
        <button className="danger" disabled={!saved} onClick={() => { store(null); setKey(''); }}>{t('common.remove')}</button>
      </div>
      <p className="muted small">{t('ai.privacy')}</p>
    </section>
  );
}
