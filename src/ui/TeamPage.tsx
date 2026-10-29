import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store/store';
import { parseUserNumber, useI18n, type TKey } from '../i18n';
import { createDraft } from '../domain/revisions';
import { lineShares } from '../domain/formula';
import type { AmountMode } from '../domain/types';
import {
  addLine, createRoom, currentUserId, eventChanges, getTeamConfig, joinRoom, leaveRoom, loadRoom, myRooms, nextPosition, normalizeUrl,
  personSlot, removeLine, roomLinesToFormula, setTeamConfig, subscribeRoom, TeamError, testConnection, updateLine, upsertLine,
  type LinePatch, type PresencePerson, type Room, type RoomEvent, type RoomLine, type RoomMember, type RoomSnapshot,
} from '../services/team';
import schemaSql from '../../supabase/schema.sql?raw';
import { DecimalInput, Empty, Field, go, Modal } from './common';
import { MaterialInput, useCatalog } from './MaterialPicker';

function useTeamError() {
  const { toast } = useStore();
  const { t } = useI18n();
  return useCallback((e: unknown) => {
    const code = e instanceof TeamError ? e.code : 'other';
    toast(`${t(`team.err_${code}` as TKey)}${code === 'other' && e instanceof Error ? ` (${e.message})` : ''}`, 'error');
  }, [toast, t]);
}

function Setup({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const { toast } = useStore();
  const fail = useTeamError();
  const cur = getTeamConfig();
  const [url, setUrl] = useState(cur?.url ?? '');
  const [key, setKey] = useState(cur?.anonKey ?? '');
  const [name, setName] = useState(cur?.displayName ?? '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const u = normalizeUrl(url);
      setTeamConfig({ url: u, anonKey: key.trim(), displayName: name.trim() });
      await testConnection();
      toast(t('team.connected'));
      onDone();
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  return (
    <section className="panel">
      <h2>{t('team.setupTitle')}</h2>
      <p>{t('team.setupExplain')}</p>
      <ol className="steps">
        <li>{t('team.step1')}</li>
        <li>{t('team.step2')} <button className="link" onClick={() => { void navigator.clipboard.writeText(schemaSql); toast(t('team.sqlCopied')); }}>{t('team.copySql')}</button></li>
        <li>{t('team.step3')}</li>
        <li>{t('team.step4')}</li>
      </ol>
      <div className="form-row">
        <Field label={t('team.url')} hint={t('team.urlHint')}><input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://xxxx.supabase.co" /></Field>
        <Field label={t('team.anonKey')} hint={t('team.anonKeyHint')}><input value={key} onChange={(e) => setKey(e.target.value)} /></Field>
        <Field label={t('team.yourName')} hint={t('team.yourNameHint')}><input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} /></Field>
      </div>
      <p className="muted small">{t('team.privacy')}</p>
      <div className="actions">
        <button className="primary" disabled={busy || !url.trim() || !key.trim() || !name.trim()} onClick={save}>{busy ? t('common.loading') : t('team.connect')}</button>
        {cur && <button onClick={onDone}>{t('common.cancel')}</button>}
      </div>
    </section>
  );
}

export function TeamPage() {
  const { state } = useStore();
  const { t, dateTime } = useI18n();
  const fail = useTeamError();
  const [cfg, setCfg] = useState(getTeamConfig());
  const [editing, setEditing] = useState(!cfg);
  const [rooms, setRooms] = useState<Room[] | null>(null);
  const [modal, setModal] = useState<null | 'new' | 'join'>(null);
  const [name, setName] = useState('');
  const [mode, setMode] = useState<AmountMode>('g');
  const [from, setFrom] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!cfg || editing) return;
    myRooms().then(setRooms).catch((e) => { setRooms([]); fail(e); });
  }, [cfg, editing, fail]);

  const revs = Object.values(state.revisions).filter((r) => !r.deletedAt).sort((a, b) => a.code.localeCompare(b.code));
  const start = async () => {
    setBusy(true);
    try {
      const rev = from ? state.revisions[from] : null;
      const r = await createRoom(name, cfg!.displayName, rev ? rev.amountMode : mode, rev ? rev.lines : []);
      go(`team/${r.id}`);
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const join = async () => {
    setBusy(true);
    try { const r = await joinRoom(code, cfg!.displayName); go(`team/${r.id}`); } catch (e) { fail(e); } finally { setBusy(false); }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t('team.title')}</h1>
          <p className="muted">{t('team.explain')}</p>
        </div>
        {cfg && !editing && (
          <div className="actions">
            <button className="primary" onClick={() => { setName(''); setFrom(''); setModal('new'); }}>{t('team.start')}</button>
            <button onClick={() => { setCode(''); setModal('join'); }}>{t('team.join')}</button>
            <button onClick={() => setEditing(true)}>{t('team.settings')}</button>
          </div>
        )}
      </div>
      {editing ? <Setup onDone={() => { setCfg(getTeamConfig()); setEditing(false); }} /> : (
        <section className="panel">
          <h2>{t('team.mySessions')}</h2>
          <p className="muted small">{t('team.signedInAs', { name: cfg!.displayName })}</p>
          {rooms === null ? <p className="muted">{t('common.loading')}</p> : rooms.length === 0 ? <Empty>{t('team.none')}</Empty> : (
            <table className="tbl">
              <thead><tr><th>{t('team.sessionName')}</th><th>{t('team.code')}</th><th>{t('formula.amountMode')}</th><th>{t('blind.created')}</th></tr></thead>
              <tbody>{rooms.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => go(`team/${r.id}`)}>
                  <td><a href={`#/team/${r.id}`}>{r.name}</a></td><td className="mono">{r.code}</td>
                  <td>{t(`mode.${r.amount_mode}` as TKey)}</td><td>{dateTime(r.created_at)}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </section>
      )}
      {modal === 'new' && (
        <Modal title={t('team.start')} onClose={() => setModal(null)} footer={<>
          <button onClick={() => setModal(null)}>{t('common.cancel')}</button>
          <button className="primary" disabled={busy || !name.trim()} onClick={start}>{t('team.startConfirm')}</button>
        </>}>
          <Field label={t('team.sessionName')}><input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></Field>
          <Field label={t('team.startFrom')} hint={t('team.startFromHint')}>
            <select value={from} onChange={(e) => setFrom(e.target.value)}>
              <option value="">{t('team.empty')}</option>
              {revs.map((r) => <option key={r.id} value={r.id}>{r.code} {state.projects[r.projectId]?.name ?? ''}</option>)}
            </select>
          </Field>
          {!from && (
            <Field label={t('formula.amountMode')}>
              <select value={mode} onChange={(e) => setMode(e.target.value as AmountMode)}>
                <option value="g">{t('mode.g')}</option><option value="pct">{t('mode.pct')}</option><option value="parts">{t('mode.parts')}</option>
              </select>
            </Field>
          )}
          <p className="muted small">{t('team.startPrivacy')}</p>
        </Modal>
      )}
      {modal === 'join' && (
        <Modal title={t('team.join')} onClose={() => setModal(null)} footer={<>
          <button onClick={() => setModal(null)}>{t('common.cancel')}</button>
          <button className="primary" disabled={busy || code.trim().length < 6} onClick={join}>{t('team.joinConfirm')}</button>
        </>}>
          <Field label={t('team.code')} hint={t('team.codeHint')}>
            <input className="mono code-input" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={12} autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter' && code.trim().length >= 6) join(); }} />
          </Field>
        </Modal>
      )}
    </div>
  );
}

function Person({ id, name }: { id: string; name: string }) {
  return <span className={`person p${personSlot(id)}`}><span className="person-dot" />{name || '—'}</span>;
}

/** One editable text or number cell in the shared table; commits on blur or Enter. */
function SharedCell({ value, onCommit, numeric, label }: { value: string; onCommit: (v: string) => void; numeric?: boolean; label: string }) {
  const [text, setText] = useState<string | null>(null);
  return (
    <input value={text ?? value} aria-label={label} inputMode={numeric ? 'decimal' : undefined} className={numeric ? 'num' : undefined}
      onFocus={(e) => { setText(value); e.target.select(); }}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => { if (text !== null && text !== value) onCommit(text); setText(null); }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setText(null); (e.target as HTMLInputElement).blur(); } }} />
  );
}

export function TeamRoomPage({ roomId }: { roomId: string }) {
  const { state, run, toast } = useStore();
  const i18n = useI18n();
  const { t, num, dateTime, toInput } = i18n;
  const fail = useTeamError();
  const catalog = useCatalog();
  const cfg = getTeamConfig();
  const [snap, setSnap] = useState<RoomSnapshot | null>(null);
  const [online, setOnline] = useState<PresencePerson[]>([]);
  const [live, setLive] = useState<'live' | 'reconnecting' | 'connecting'>('connecting');
  const [me, setMe] = useState('');
  const [newName, setNewName] = useState('');
  const [newAmount, setNewAmount] = useState<string | null>(null);
  const [newNote, setNewNote] = useState('');
  const [save, setSave] = useState(false);
  const [projectId, setProjectId] = useState('');
  const [flash, setFlash] = useState<Record<string, number>>({});
  const nameRef = useRef<HTMLDivElement>(null);

  const reload = useCallback(() => loadRoom(roomId).then(setSnap).catch(fail), [roomId, fail]);

  useEffect(() => {
    if (!cfg) return;
    let stop: (() => void) | null = null;
    let alive = true;
    (async () => {
      try {
        const uid = await currentUserId();
        if (!alive) return;
        setMe(uid);
        await reload();
        stop = await subscribeRoom(roomId, { user_id: uid, name: cfg.displayName }, {
          line: (l) => {
            setSnap((s) => (s ? { ...s, lines: upsertLine(s.lines, l) } : s));
            setFlash((f) => ({ ...f, [l.id]: Date.now() }));
          },
          event: (ev) => setSnap((s) => {
            if (!s || s.events.some((x) => x.id === ev.id)) return s;
            const lines = ev.kind === 'removed' && ev.line_id ? s.lines.filter((l) => l.id !== ev.line_id) : s.lines;
            return { ...s, lines, events: [...s.events, ev].slice(-300) };
          }),
          member: (m) => setSnap((s) => (s && !s.members.some((x) => x.user_id === m.user_id) ? { ...s, members: [...s.members, m] } : s)),
          presence: setOnline,
          status: (st) => {
            setLive((prev) => { if (prev === 'reconnecting' && st === 'live') void reload(); return st; });
          },
        });
        if (!alive) stop();
      } catch (e) { fail(e); }
    })();
    return () => { alive = false; stop?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  const shares = useMemo(() => {
    if (!snap) return new Map<string, string>();
    const lines = roomLinesToFormula(snap.lines);
    const ids = snap.lines.filter((l) => l.material_name.trim() || l.amount).map((l) => l.id);
    const sh = lineShares({ amountMode: snap.room.amount_mode, lines });
    return new Map(sh.map((s, i) => [ids[i], s.pct ? num(s.pct, 2) : '']));
  }, [snap, num]);

  if (!cfg) return <div className="page"><Empty>{t('team.err_not_configured')} <a href="#/team">{t('team.title')}</a></Empty></div>;
  if (!snap) return <div className="page muted">{t('common.loading')}</div>;
  const { room, members, lines, events } = snap;
  const unit = room.amount_mode === 'g' ? 'g' : room.amount_mode === 'pct' ? '%' : t('unit.parts');
  const names = Object.values(state.materials).filter((m) => !m.deletedAt).map((m) => m.name);
  const projects = Object.values(state.projects).filter((p) => !p.deletedAt);
  const onlineIds = new Set(online.map((p) => p.user_id));

  const patch = async (l: RoomLine, p: LinePatch) => {
    // Show the edit at once; the server copy replaces it when it arrives.
    setSnap((s) => (s ? { ...s, lines: s.lines.map((x) => (x.id === l.id ? { ...x, ...p } : x)) } : s));
    try { const r = await updateLine(l.id, p); setSnap((s) => (s ? { ...s, lines: upsertLine(s.lines, r) } : s)); } catch (e) { fail(e); void reload(); }
  };
  const numPatch = (l: RoomLine, field: 'amount' | 'strength', text: string) => {
    const p = parseUserNumber(text);
    if (!p.ok) { toast(t('input.invalidNumber'), 'error'); return; }
    void patch(l, { [field]: p.value } as LinePatch);
  };
  const add = async () => {
    if (!newName.trim()) return;
    try {
      const r = await addLine(room.id, nextPosition(lines), { materialName: newName, amount: newAmount, note: newNote });
      setSnap((s) => (s ? { ...s, lines: upsertLine(s.lines, r) } : s));
      setNewName(''); setNewAmount(null); setNewNote('');
      nameRef.current?.querySelector('input')?.focus();
    } catch (e) { fail(e); }
  };
  const saveDraft = async () => {
    let id = '';
    const cs = await run((s) => {
      const r = createDraft(s, { projectId, lines: roomLinesToFormula(lines), amountMode: room.amount_mode, changeReason: t('team.savedReason', { name: room.name }) });
      id = r.revision.id; return r;
    });
    if (cs) { setSave(false); go(`formula/${id}`); }
  };
  const fieldLabel = (f: string) => t(f === 'material_name' ? 'col.material' : f === 'amount' ? 'col.amount' : f === 'strength' ? 'col.strength' : 'col.note');
  const show = (f: string, v: string | null) => (v === null || v === '' ? '—' : f === 'amount' || f === 'strength' ? toInput(v) : v);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="crumbs"><a href="#/team">{t('team.title')}</a></div>
          <h1>{room.name}</h1>
          <div className="muted small">
            {t('team.codeLabel')} <strong className="mono code-chip">{room.code}</strong>{' '}
            <button className="link" onClick={() => { void navigator.clipboard.writeText(room.code); toast(t('team.codeCopied')); }}>{t('team.copyCode')}</button>
            {' · '}{t(`mode.${room.amount_mode}` as TKey)}
            {' · '}<span className={`live live-${live}`}>{t(`team.status_${live}` as TKey)}</span>
          </div>
        </div>
        <div className="actions">
          <button className="primary" disabled={!lines.length} onClick={() => { setProjectId(projects[0]?.id ?? ''); setSave(true); }}>{t('team.saveDraft')}</button>
          <button onClick={async () => { try { await leaveRoom(room.id); go('team'); } catch (e) { fail(e); } }}>{t('team.leave')}</button>
        </div>
      </div>

      <div className="people">
        <span className="muted small">{t('team.people')}</span>
        {members.map((m: RoomMember) => (
          <span key={m.user_id} className={onlineIds.has(m.user_id) ? 'is-online' : 'is-away'} title={onlineIds.has(m.user_id) ? t('team.online') : t('team.away')}>
            <Person id={m.user_id} name={m.display_name + (m.user_id === me ? ` (${t('team.you')})` : '')} />
          </span>
        ))}
      </div>

      <div className="room">
        <section className="panel room-lines">
          <table className="grid">
            <thead><tr>
              <th className="rownum">#</th><th>{t('col.material')}</th><th className="num">{t('col.amount')} ({unit})</th>
              <th className="num derived-head">{t('col.pctFormula')}</th><th className="num">{t('col.strength')}</th><th>{t('col.note')}</th>
              <th>{t('team.addedBy')}</th><th />
            </tr></thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={l.id} className={flash[l.id] && Date.now() - flash[l.id] < 2500 ? 'flash' : undefined}>
                  <td className="rownum">{i + 1}</td>
                  <td><SharedCell value={l.material_name} label={`${t('col.material')} ${i + 1}`} onCommit={(v) => patch(l, { material_name: v.trim() })} /></td>
                  <td className="num"><SharedCell numeric value={toInput(l.amount)} label={`${t('col.amount')} ${i + 1}`} onCommit={(v) => numPatch(l, 'amount', v)} /></td>
                  <td className="num derived">{shares.get(l.id) ?? ''}</td>
                  <td className="num"><SharedCell numeric value={toInput(l.strength)} label={`${t('col.strength')} ${i + 1}`} onCommit={(v) => numPatch(l, 'strength', v)} /></td>
                  <td><SharedCell value={l.note} label={`${t('col.note')} ${i + 1}`} onCommit={(v) => patch(l, { note: v })} /></td>
                  <td className="by">
                    <Person id={l.added_by} name={l.added_by_name} />
                    {l.updated_by_name && l.updated_by_name !== l.added_by_name && <div className="muted small">{t('team.changedBy', { name: l.updated_by_name })}</div>}
                  </td>
                  <td className="row-tools"><button className="ghost" aria-label={t('grid.deleteRow')} title={t('grid.deleteRow')}
                    onClick={async () => { try { await removeLine(l.id); setSnap((s) => (s ? { ...s, lines: s.lines.filter((x) => x.id !== l.id) } : s)); } catch (e) { fail(e); } }}>×</button></td>
                </tr>
              ))}
              {lines.length === 0 && <tr><td colSpan={8} className="muted center">{t('team.noLines')}</td></tr>}
            </tbody>
          </table>
          <div className="add-line">
            <div className="add-name" ref={nameRef}>
              <Field label={t('team.addMaterial')}>
                <MaterialInput id="team-add" value={newName} onText={setNewName} onPick={setNewName} ownNames={names} catalog={catalog}
                  placeholder={t('catalog.cellPh')} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void add(); } }} />
              </Field>
            </div>
            <Field label={`${t('col.amount')} (${unit})`}><DecimalInput value={newAmount} onValue={setNewAmount} onEnter={() => void add()} /></Field>
            <Field label={t('col.note')}><input value={newNote} onChange={(e) => setNewNote(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void add(); }} /></Field>
            <button className="primary" disabled={!newName.trim()} onClick={() => void add()}>{t('team.addLine')}</button>
          </div>
        </section>

        <aside className="panel activity" aria-live="polite">
          <h3>{t('team.activity')}</h3>
          {events.length === 0 ? <p className="muted small">{t('team.noActivity')}</p> : (
            <ol className="feed">
              {[...events].reverse().map((ev: RoomEvent) => (
                <li key={ev.id}>
                  <div><Person id={ev.actor ?? ''} name={ev.actor_name} /> <span className={`ev ev-${ev.kind}`}>{t(`team.ev_${ev.kind}` as TKey)}</span> <strong>{ev.material_name || '—'}</strong></div>
                  {ev.kind === 'added' && ev.after?.amount && <div className="small">{toInput(ev.after.amount)} {unit}</div>}
                  {eventChanges(ev).map((c) => (
                    <div key={c.field} className="small">{fieldLabel(c.field)}: <span className="before">{show(c.field, c.before)}</span> → <span className="after">{show(c.field, c.after)}</span></div>
                  ))}
                  <div className="muted small">{dateTime(ev.at)}</div>
                </li>
              ))}
            </ol>
          )}
        </aside>
      </div>

      {save && (
        <Modal title={t('team.saveDraft')} onClose={() => setSave(false)} footer={<>
          <button onClick={() => setSave(false)}>{t('common.cancel')}</button>
          <button className="primary" disabled={!projectId} onClick={saveDraft}>{t('team.saveConfirm')}</button>
        </>}>
          <p>{t('team.saveExplain', { n: lines.length })}</p>
          {projects.length === 0 ? <p className="warn-text">{t('formulas.noProjects')}</p> : (
            <Field label={t('nav.projects')}>
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.code})</option>)}
              </select>
            </Field>
          )}
        </Modal>
      )}
    </div>
  );
}
