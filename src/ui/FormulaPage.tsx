import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store/store';
import { useI18n, type TKey } from '../i18n';
import { D, sum } from '../domain/decimal';
import { amountTotal, convertAmounts, lineShares, normalizePreview, revisionIssues, type RevisionIssue } from '../domain/formula';
import { createDraft, forkRevision, freezeRevision, newLine, softDelete, updateDraft } from '../domain/revisions';
import { parseNumber } from '../import/numbers';
import type { AmountMode, FormulaLine, FormulaRevision } from '../domain/types';
import { DemoBadge, Empty, Field, go, Modal, StateBadge } from './common';
import { exportRevisionCsv, exportRevisionXlsx } from '../services/exporters';
import { CompositionPanel, ImportShareModal, ShareModal } from './FormulaExtras';
import { LibraryModal, MaterialInput, useCatalog } from './MaterialPicker';

export function FormulasPage() {
  const { state, run } = useStore();
  const { t, dateTime } = useI18n();
  const projects = Object.values(state.projects).filter((p) => !p.deletedAt);
  const [pick, setPick] = useState(false);
  const [importShare, setImportShare] = useState(false);
  const batchCount = (id: string) => Object.values(state.batches).filter((b) => b.revisionId === id).length;
  const newBlank = async (projectId: string) => {
    let id = '';
    const cs = await run((s) => { const r = createDraft(s, { projectId, lines: [newLine(), newLine(), newLine()], amountMode: 'g' }); id = r.revision.id; return r; });
    if (cs) go(`formula/${id}`);
  };
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('nav.formulas')}</h1>
        <div className="actions">
          <button className="primary" onClick={() => go('import')}>{t('projects.importFormula')}</button>
          <button onClick={() => setPick(true)} disabled={!projects.length}>{t('formulas.newBlank')}</button>
          <button onClick={() => setImportShare(true)}>{t('share.importTitle')}</button>
          <button onClick={() => go('compare')}>{t('compare.title')}</button>
        </div>
        {importShare && <ImportShareModal onClose={() => setImportShare(false)} />}
      </div>
      {projects.length === 0 && <Empty>{t('formulas.noProjects')}</Empty>}
      {projects.map((p) => {
        const revs = Object.values(state.revisions).filter((r) => r.projectId === p.id && !r.deletedAt).sort((a, b) => b.number - a.number);
        return (
          <section key={p.id} className="panel">
            <h2>{p.name} <span className="mono muted">{p.code}</span> {p.isAccord && <span className="badge">{t('accord.badge')}</span>} <DemoBadge show={p.demo} /></h2>
            {revs.length === 0 ? <p className="muted">{t('formulas.none')}</p> : (
              <table className="tbl">
                <thead><tr>
                  <th>{t('formulas.revision')}</th><th>{t('formulas.status')}</th><th>{t('formulas.parent')}</th>
                  <th>{t('formulas.changeReason')}</th><th className="num">{t('formulas.lines')}</th><th className="num">{t('formulas.batches')}</th><th>{t('formulas.updated')}</th>
                </tr></thead>
                <tbody>
                  {revs.map((r) => (
                    <tr key={r.id} className="clickable" onClick={() => go(`formula/${r.id}`)}>
                      <td className="mono"><a href={`#/formula/${r.id}`}>{r.code}</a> <DemoBadge show={r.demo} /></td>
                      <td><StateBadge state={r.status} /></td>
                      <td className="mono">{r.parentRevisionId ? state.revisions[r.parentRevisionId]?.code : '—'}</td>
                      <td>{r.changeReason || '—'}</td>
                      <td className="num">{r.lines.filter((l) => l.materialName).length}</td>
                      <td className="num">{batchCount(r.id)}</td>
                      <td>{dateTime(r.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        );
      })}
      {pick && (
        <Modal title={t('formulas.newBlank')} onClose={() => setPick(false)}>
          <p>{t('formulas.pickProject')}</p>
          <div className="stack">
            {projects.map((p) => <button key={p.id} onClick={() => { setPick(false); newBlank(p.id); }}>{p.name} ({p.code})</button>)}
          </div>
        </Modal>
      )}
    </div>
  );
}

type ColKey = 'materialName' | 'strength' | 'carrier' | 'amount' | 'costPerKg' | 'currency' | 'note';
const COLS: Array<{ key: ColKey; numeric: boolean }> = [
  { key: 'materialName', numeric: false },
  { key: 'strength', numeric: true },
  { key: 'carrier', numeric: false },
  { key: 'amount', numeric: true },
  { key: 'costPerKg', numeric: true },
  { key: 'currency', numeric: false },
  { key: 'note', numeric: false },
];

function issueText(t: (k: TKey, v?: Record<string, string | number>) => string, i: RevisionIssue, lines: FormulaLine[]): string {
  const row = 'lineId' in i ? lines.findIndex((l) => l.id === i.lineId) + 1 : 0;
  switch (i.kind) {
    case 'pct_total': return t('issue.pctTotal', { total: i.total });
    case 'blank_amount': return t('issue.blankAmount', { row });
    case 'negative_amount': return t('issue.negative', { row });
    case 'no_name': return t('issue.noName', { row });
    case 'unknown_strength': return t('issue.unknownStrength', { row });
    case 'empty': return t('issue.empty');
  }
}

export function FormulaEditor({ revisionId }: { revisionId: string }) {
  const { state, run, toast } = useStore();
  const i18n = useI18n();
  const { t, num, pct, dateTime, decimalSep } = i18n;
  const rev = state.revisions[revisionId];
  const [lines, setLines] = useState<FormulaLine[]>(rev?.lines ?? []);
  const hist = useRef<{ past: FormulaLine[][]; future: FormulaLine[][] }>({ past: [], future: [] });
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [bad, setBad] = useState<Record<string, boolean>>({});
  const [dirty, setDirty] = useState(false);
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState<null | 'fork' | 'normalize' | 'mode' | 'freezeForBatch' | 'delete' | 'share' | 'library'>(null);
  const catalog = useCatalog();
  const [pendingMode, setPendingMode] = useState<AmountMode>('g');
  const [reason, setReason] = useState('');
  const pendingFocus = useRef<{ r: number; c: number } | null>(null);
  const gridRef = useRef<HTMLTableElement>(null);
  const linesRef = useRef(lines);
  linesRef.current = lines;

  // Reset local state when switching revisions.
  useEffect(() => {
    setLines(rev?.lines ?? []); hist.current = { past: [], future: [] }; setDrafts({}); setBad({}); setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revisionId]);

  const frozen = rev?.status === 'frozen';

  const save = useCallback(async () => {
    if (!rev || frozen) return;
    const cs = await run((s) => updateDraft(s, rev.id, { lines: linesRef.current }));
    if (cs) setDirty(false);
  }, [rev, frozen, run]);

  // Autosave drafts shortly after edits.
  useEffect(() => {
    if (!dirty) return;
    const id = setTimeout(save, 700);
    return () => clearTimeout(id);
  }, [dirty, lines, save]);

  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => { if (dirty) e.preventDefault(); };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [dirty]);

  useEffect(() => {
    if (!pendingFocus.current) return;
    const { r, c } = pendingFocus.current;
    pendingFocus.current = null;
    const el = gridRef.current?.querySelector<HTMLInputElement>(`input[data-r="${r}"][data-c="${c}"]`);
    el?.focus();
    el?.select();
  });

  const materialNames = useMemo(() => Object.values(state.materials).filter((m) => !m.deletedAt).map((m) => m.name).sort(), [state.materials]);
  const byName = useMemo(() => new Map(Object.values(state.materials).filter((m) => !m.deletedAt).map((m) => [m.name, m.id])), [state.materials]);

  if (!rev) return <div className="page"><Empty>{t('common.notFound')}</Empty></div>;
  const project = state.projects[rev.projectId];
  const batches = Object.values(state.batches).filter((b) => b.revisionId === rev.id);
  const parent = rev.parentRevisionId ? state.revisions[rev.parentRevisionId] : null;
  const children = Object.values(state.revisions).filter((r) => r.parentRevisionId === rev.id);

  const commitLines = (next: FormulaLine[]) => {
    if (frozen) return;
    hist.current.past = [...hist.current.past.slice(-99), linesRef.current];
    hist.current.future = [];
    setLines(next);
    linesRef.current = next;
    setDirty(true);
  };
  const undo = () => {
    const h = hist.current;
    const prev = h.past.pop();
    if (!prev) return;
    h.future.unshift(linesRef.current);
    linesRef.current = prev;
    setLines(prev); setDirty(true); setDrafts({}); setBad({});
  };
  const redo = () => {
    const h = hist.current;
    const nx = h.future.shift();
    if (!nx) return;
    h.past.push(linesRef.current);
    linesRef.current = nx;
    setLines(nx); setDirty(true); setDrafts({}); setBad({});
  };

  const cellKey = (lineId: string, col: ColKey) => `${lineId}:${col}`;
  const displayValue = (l: FormulaLine, col: ColKey): string => {
    const v = l[col];
    if (v === null || v === undefined) return '';
    return COLS.find((c) => c.key === col)!.numeric ? i18n.toInput(v as string) : String(v);
  };

  const setCell = (base: FormulaLine[], idx: number, col: ColKey, text: string): { lines: FormulaLine[]; ok: boolean } => {
    const l = base[idx];
    const meta = COLS.find((c) => c.key === col)!;
    let patch: Partial<FormulaLine>;
    if (meta.numeric) {
      const p = parseNumber(text, decimalSep === ',' ? 'comma' : 'point');
      if (p.status === 'invalid' || p.status === 'ambiguous') return { lines: base, ok: false };
      if (p.status === 'ok' && D(p.value!).isNegative()) return { lines: base, ok: false };
      patch = { [col]: p.status === 'blank' ? null : p.value } as Partial<FormulaLine>;
    } else if (col === 'materialName') {
      const name = text;
      patch = { materialName: name, materialId: byName.get(name.trim()) ?? null };
    } else {
      patch = { [col]: col === 'note' ? text : (text.trim() || null) } as Partial<FormulaLine>;
    }
    const next = base.slice();
    next[idx] = { ...l, ...patch };
    return { lines: next, ok: true };
  };

  const commitCell = (idx: number, col: ColKey) => {
    const l = linesRef.current[idx];
    if (!l) return;
    const k = cellKey(l.id, col);
    if (!(k in drafts)) return;
    const res = setCell(linesRef.current, idx, col, drafts[k]);
    if (!res.ok) { setBad((b) => ({ ...b, [k]: true })); return; }
    setBad((b) => { const n = { ...b }; delete n[k]; return n; });
    setDrafts((d) => { const n = { ...d }; delete n[k]; return n; });
    if (displayValue(l, col) !== drafts[k] || col === 'materialName') commitLines(res.lines);
  };

  const visible = lines.map((l, i) => ({ l, i })).filter(({ l }) => !search || l.materialName.toLowerCase().includes(search.toLowerCase()));

  const focusCell = (r: number, c: number) => { pendingFocus.current = { r, c }; setLines((x) => [...x]); };

  const onCellKey = (e: React.KeyboardEvent<HTMLInputElement>, vIdx: number, c: number) => {
    const idx = visible[vIdx].i;
    const col = COLS[c].key;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !(cellKey(lines[idx].id, col) in drafts)) {
      e.preventDefault(); e.shiftKey ? redo() : undo(); return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault(); commitCell(idx, col);
      const next = linesRef.current.slice(); next.splice(idx + 1, 0, newLine()); commitLines(next);
      focusCell(vIdx + 1, 0); return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Delete') {
      e.preventDefault(); removeRow(idx); focusCell(Math.max(0, vIdx - 1), c); return;
    }
    if (e.key === 'Enter' || (e.key === 'ArrowDown' && !e.altKey)) {
      e.preventDefault(); commitCell(idx, col);
      if (e.shiftKey) { if (vIdx > 0) focusCell(vIdx - 1, c); return; }
      if (vIdx === visible.length - 1 && !frozen) {
        if (search) setSearch('');
        commitLines([...linesRef.current, newLine()]);
        focusCell(linesRef.current.length, c);
      } else focusCell(vIdx + 1, c);
      return;
    }
    if (e.key === 'ArrowUp') { e.preventDefault(); commitCell(idx, col); if (vIdx > 0) focusCell(vIdx - 1, c); }
  };

  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>, idx: number, c: number) => {
    if (frozen) return;
    const text = e.clipboardData.getData('text/plain');
    if (!text.includes('\t') && !text.includes('\n')) return;
    e.preventDefault();
    const rows = text.replace(/\r/g, '').split('\n');
    while (rows.length && rows[rows.length - 1] === '') rows.pop();
    let next = linesRef.current.slice();
    const rejected: string[] = [];
    rows.forEach((row, dr) => {
      const r = idx + dr;
      while (next.length <= r) next.push(newLine());
      row.split('\t').forEach((cell, dc) => {
        const ci = c + dc;
        if (ci >= COLS.length) return;
        const res = setCell(next, r, COLS[ci].key, cell.trim());
        if (res.ok) next = res.lines;
        else rejected.push(`${r + 1}:${cell}`);
      });
    });
    commitLines(next);
    setDrafts({});
    toast(t('grid.pasted', { rows: rows.length, conv: decimalSep === ',' ? t('import.convComma') : t('import.convPoint') }));
    if (rejected.length) toast(t('grid.pasteRejected', { cells: rejected.slice(0, 6).join(', ') }), 'error');
  };

  const removeRow = (idx: number) => {
    const next = linesRef.current.slice();
    next.splice(idx, 1);
    commitLines(next.length ? next : [newLine()]);
  };

  const shares = new Map(lineShares({ amountMode: rev.amountMode, lines }).map((s) => [s.lineId, s]));
  const used = lines.filter((l) => l.materialName.trim() || l.amount !== null);
  const total = amountTotal(used);
  const issues = revisionIssues({ amountMode: rev.amountMode, lines: used });
  const unitLabel = rev.amountMode === 'g' ? 'g' : rev.amountMode === 'pct' ? '%' : t('unit.parts');
  const allCost = used.length > 0 && used.every((l) => l.costPerKg !== null && l.amount !== null);
  const currencies = new Set(used.map((l) => l.currency).filter(Boolean));
  const costPerKg = allCost && currencies.size === 1 && !total.isZero()
    ? sum(used.map((l) => D(l.costPerKg!).times(shares.get(l.id)!.pct!).dividedBy(100))) : null;
  const pctSum = sum(used.map((l) => shares.get(l.id)?.pct ?? D(0)));

  const doFreeze = async (thenPlan: boolean) => {
    await save();
    const cs = await run((s) => freezeRevision(s, rev.id));
    if (cs) {
      toast(t('formula.frozenToast', { code: rev.code }));
      if (thenPlan) go(`plan/${rev.id}`);
    }
    setModal(null);
  };
  const doFork = async () => {
    let id = '';
    const cs = await run((s) => { const r = forkRevision(s, rev.id, reason); id = r.revision.id; return r; });
    if (cs) { setModal(null); setReason(''); go(`formula/${id}`); }
  };
  const normPreview = normalizePreview({ amountMode: rev.amountMode, lines: used });

  const saveLabel = frozen ? t('formula.frozenReadOnly') : dirty ? t('formula.unsaved') : t('save.saved');

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="crumbs"><a href="#/formulas">{t('nav.formulas')}</a> / {project?.name}</div>
          <h1 className="mono">{rev.code} <StateBadge state={rev.status} /> <DemoBadge show={rev.demo} /></h1>
          <div className="muted small">
            {t('formula.basis')} · {parent ? <>{t('formulas.parent')}: <a href={`#/formula/${parent.id}`} className="mono">{parent.code}</a> · </> : null}
            {rev.frozenAt ? t('formula.frozenAt', { when: dateTime(rev.frozenAt) }) : t('formula.draftNote')}
          </div>
        </div>
        <div className="actions">
          {!frozen && <button onClick={() => doFreeze(false)} disabled={issues.some((i) => i.kind !== 'unknown_strength')}>{t('formula.freeze')}</button>}
          <button className="primary" onClick={() => (frozen ? go(`plan/${rev.id}`) : setModal('freezeForBatch'))}
            disabled={issues.some((i) => i.kind !== 'unknown_strength')}>{t('formula.makeBatch')}</button>
          <button onClick={() => setModal('fork')}>{t('formula.fork')}</button>
          {parent && <button onClick={() => go(`compare?a=${parent.id}&b=${rev.id}`)}>{t('formula.compareParent')}</button>}
          <button onClick={() => exportRevisionXlsx(state, rev)} title={t('formula.excelTip')}>{t('common.exportXlsx')}</button>
          <details className="menu">
            <summary className="button">{t('common.more')}</summary>
            <div className="menu-list" onClick={(e) => (e.currentTarget.parentElement as HTMLDetailsElement).open = false}>
              <button onClick={() => exportRevisionCsv(rev)}>{t('common.exportCsv')}</button>
              <button onClick={() => setModal('share')}>{t('share.button')}</button>
            </div>
          </details>
          {!frozen && <button className="danger" onClick={() => setModal('delete')}>{t('formula.deleteDraft')}</button>}
        </div>
      </div>

      {rev.changeReason && <p className="reason"><strong>{t('formulas.changeReason')}:</strong> {rev.changeReason}</p>}

      <div className="toolbar">
        <Field label={t('formula.amountMode')}>
          <select value={rev.amountMode} disabled={frozen}
            onChange={(e) => { setPendingMode(e.target.value as AmountMode); setModal('mode'); }}>
            <option value="g">{t('mode.g')}</option>
            <option value="pct">{t('mode.pct')}</option>
            <option value="parts">{t('mode.parts')}</option>
          </select>
        </Field>
        <Field label={t('common.search')}>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('formula.searchPh')} />
        </Field>
        <div className="toolbar-right">
          {!frozen && <>
            <button onClick={undo} disabled={!hist.current.past.length} title="Ctrl+Z">{t('grid.undo')}</button>
            <button onClick={redo} disabled={!hist.current.future.length} title="Ctrl+Y">{t('grid.redo')}</button>
            <button onClick={() => { commitLines([...lines, newLine()]); focusCell(lines.length, 0); }}>{t('grid.addRow')}</button>
            <button className="primary" onClick={() => setModal('library')}>{t('catalog.open')}</button>
          </>}
          <span className={`save-state${dirty ? ' unsaved' : ''}`}>{saveLabel}</span>
        </div>
      </div>

      {!frozen && (
        <div className="legend">
          <span><span className="sw sw-edit" aria-hidden="true">12.5</span>{t('grid.legendEdit')}</span>
          <span><span className="sw sw-calc" aria-hidden="true">41.7</span>{t('grid.legendCalc')}</span>
        </div>
      )}
      <div className="grid-wrap">
        <table className="grid" ref={gridRef}>
          <thead>
            <tr>
              <th className="rownum">#</th>
              <th>{t('col.material')}</th>
              <th className="num">{t('col.strength')}</th>
              <th>{t('col.carrier')}</th>
              <th className="num">{t('col.amount')} ({unitLabel})</th>
              <th className="num derived-head">{t('col.pctFormula')}</th>
              <th className="num derived-head">{t('col.parentPct')}</th>
              <th className="num">{t('col.costPerKg')}</th>
              <th>{t('col.currency')}</th>
              <th>{t('col.note')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {visible.map(({ l, i }, vIdx) => {
              const s = shares.get(l.id);
              const cellFor = (c: number) => {
                const col = COLS[c].key;
                const k = cellKey(l.id, col);
                const val = k in drafts ? drafts[k] : displayValue(l, col);
                if (col === 'materialName') {
                  return (
                    <td key={col} className={bad[k] ? 'bad' : ''}>
                      <MaterialInput
                        data-r={vIdx} data-c={c} id={`mat-${l.id}`}
                        value={val} readOnly={frozen}
                        ownNames={materialNames} catalog={frozen ? null : catalog}
                        aria-label={`${t('col.material')} ${i + 1}`}
                        placeholder={!frozen && !l.materialName ? t('catalog.cellPh') : undefined}
                        onText={(text) => setDrafts((d) => ({ ...d, [k]: text }))}
                        onPick={(name) => {
                          const res = setCell(linesRef.current, i, 'materialName', name);
                          setDrafts((d) => { const n = { ...d }; delete n[k]; return n; });
                          commitLines(res.lines);
                          focusCell(vIdx, 3);
                        }}
                        onBlur={() => commitCell(i, col)}
                        onKeyDown={(e) => onCellKey(e, vIdx, c)}
                        onPaste={(e) => onPaste(e, i, c)}
                        onFocus={(e) => e.target.select()}
                      />
                    </td>
                  );
                }
                return (
                  <td key={col} className={`${COLS[c].numeric ? 'num' : ''}${bad[k] ? ' bad' : ''}`}>
                    <input
                      data-r={vIdx} data-c={c}
                      value={val}
                      readOnly={frozen}
                      inputMode={COLS[c].numeric ? 'decimal' : undefined}
                      aria-label={`${t(`col.${col}` as TKey)} ${i + 1}`}
                      placeholder={col === 'strength' ? t('common.unknown') : undefined}
                      onChange={(e) => setDrafts((d) => ({ ...d, [k]: e.target.value }))}
                      onBlur={() => commitCell(i, col)}
                      onKeyDown={(e) => onCellKey(e, vIdx, c)}
                      onPaste={(e) => onPaste(e, i, c)}
                      onFocus={(e) => e.target.select()}
                    />
                  </td>
                );
              };
              return (
                <tr key={l.id}>
                  <td className="rownum">{i + 1}</td>
                  {cellFor(0)}
                  {cellFor(1)}
                  {cellFor(2)}
                  {cellFor(3)}
                  <td className="num derived">{s?.pct ? num(s.pct, 3) : l.amount === null && l.materialName ? <span className="warn-text">{t('common.blank')}</span> : ''}</td>
                  <td className="num derived">{s?.pct ? (s.parentPct ? num(s.parentPct, 3) : <span className="warn-text">{t('common.unknown')}</span>) : ''}</td>
                  {cellFor(4)}
                  {cellFor(5)}
                  {cellFor(6)}
                  <td className="row-tools">
                    {l.materialName && <span className={`tag ${l.materialId ? 'tag-linked' : 'tag-new'}`} title={l.materialId ? t('grid.linkedTip') : t('grid.newTip')}>{l.materialId ? t('grid.linked') : t('grid.new')}</span>}
                    {!frozen && <button className="ghost" onClick={() => removeRow(i)} aria-label={t('grid.deleteRow')} title={`${t('grid.deleteRow')} (Ctrl+Delete)`}>×</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td />
              <td>{t('grid.total')}</td>
              <td /><td />
              <td className={`num${rev.amountMode === 'pct' && !total.equals(100) ? ' warn-text' : ''}`}>{num(total)} {unitLabel}</td>
              <td className="num">{used.length ? num(pctSum, 3) : ''}</td>
              <td />
              <td className="num" colSpan={2}>{costPerKg ? `${num(costPerKg, 2)} ${[...currencies][0]}/kg` : used.length ? <span className="muted">{t('grid.costUnknown')}</span> : ''}</td>
              <td colSpan={2} />
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="muted small">{t('grid.keys')}</p>

      {issues.length > 0 && (
        <section className="panel issues">
          <h3>{t('formula.checks')}</h3>
          <ul>{issues.map((i, k) => <li key={k} className={i.kind === 'unknown_strength' ? 'muted' : 'warn-text'}>{issueText(t, i, used)}</li>)}</ul>
          {rev.amountMode === 'pct' && !total.equals(100) && !frozen && normPreview && (
            <button onClick={() => setModal('normalize')}>{t('formula.normalize')}</button>
          )}
        </section>
      )}

      <CompositionPanel rev={rev} lines={lines} />

      <section className="panel">
        <h3>{t('formula.experiments')}</h3>
        {batches.length === 0 ? <p className="muted">{t('formula.noBatches')}</p> : (
          <ul className="inline-list">{batches.map((b) => <li key={b.id}><a className="mono" href={`#/batch/${b.id}`}>{b.code}</a> <StateBadge state={b.state} /></li>)}</ul>
        )}
        {children.length > 0 && <p>{t('formula.children')}: {children.map((c) => <a key={c.id} className="mono" href={`#/formula/${c.id}`}>{c.code} </a>)}</p>}
      </section>

      {modal === 'share' && <ShareModal rev={rev} onClose={() => setModal(null)} />}
      {modal === 'library' && (
        <LibraryModal
          inFormula={new Set(lines.map((l) => l.materialName.trim().toLowerCase()).filter(Boolean))}
          onClose={() => setModal(null)}
          onAdd={(names) => {
            // Fill empty rows first, then append.
            const next = linesRef.current.slice();
            const queue = [...names];
            for (let r = 0; r < next.length && queue.length; r++) {
              if (!next[r].materialName.trim() && next[r].amount === null) next[r] = { ...next[r], materialName: queue[0], materialId: byName.get(queue.shift()!) ?? null };
            }
            for (const n of queue) next.push({ ...newLine(), materialName: n, materialId: byName.get(n) ?? null });
            commitLines(next);
            setModal(null);
            toast(t('catalog.added', { n: names.length }));
          }}
        />
      )}
      {modal === 'fork' && (
        <Modal title={t('formula.fork')} onClose={() => setModal(null)} footer={<>
          <button onClick={() => setModal(null)}>{t('common.cancel')}</button>
          <button className="primary" onClick={doFork} disabled={!reason.trim()}>{t('formula.forkConfirm')}</button>
        </>}>
          <p>{t('formula.forkExplain', { code: rev.code })}</p>
          <Field label={t('formulas.changeReason')}><textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        </Modal>
      )}
      {modal === 'freezeForBatch' && (
        <Modal title={t('formula.makeBatch')} onClose={() => setModal(null)} footer={<>
          <button onClick={() => setModal(null)}>{t('common.cancel')}</button>
          <button className="primary" onClick={() => doFreeze(true)}>{t('formula.freezeAndPlan')}</button>
        </>}>
          <p>{t('formula.freezeExplain', { code: rev.code })}</p>
        </Modal>
      )}
      {modal === 'normalize' && normPreview && (
        <Modal title={t('formula.normalize')} onClose={() => setModal(null)} footer={<>
          <button onClick={() => setModal(null)}>{t('common.cancel')}</button>
          <button className="primary" onClick={() => {
            const map = new Map(normPreview.lines.map((x) => [x.lineId, x.after]));
            commitLines(lines.map((l) => (map.has(l.id) ? { ...l, amount: map.get(l.id)! } : l)));
            setModal(null);
          }}>{t('formula.applyNormalize')}</button>
        </>}>
          <p>{t('formula.normalizeExplain', { total: num(total), factor: num(normPreview.factor, 6) })}</p>
          <table className="tbl">
            <thead><tr><th>{t('col.material')}</th><th className="num">{t('common.before')}</th><th className="num">{t('common.after')}</th></tr></thead>
            <tbody>{normPreview.lines.map((x) => (
              <tr key={x.lineId}><td>{lines.find((l) => l.id === x.lineId)?.materialName}</td><td className="num">{pct(x.before, 4)}</td><td className="num">{pct(x.after, 4)}</td></tr>
            ))}</tbody>
          </table>
          <p className="muted small">{t('formula.normalizeRounding')}</p>
        </Modal>
      )}
      {modal === 'mode' && (
        <Modal title={t('formula.amountMode')} onClose={() => setModal(null)} footer={<>
          <button onClick={() => setModal(null)}>{t('common.cancel')}</button>
          <button onClick={async () => { await run((s) => updateDraft(s, rev.id, { amountMode: pendingMode, lines: linesRef.current })); setDirty(false); setModal(null); }}>{t('formula.modeKeepNumbers')}</button>
          <button className="primary" onClick={async () => {
            const conv = convertAmounts(linesRef.current, rev.amountMode, pendingMode);
            setLines(conv); linesRef.current = conv;
            await run((s) => updateDraft(s, rev.id, { amountMode: pendingMode, lines: conv }));
            setDirty(false); setModal(null);
          }}>{t('formula.modeConvert')}</button>
        </>}>
          <p>{t('formula.modeExplain', { from: t(`mode.${rev.amountMode}` as TKey), to: t(`mode.${pendingMode}` as TKey) })}</p>
        </Modal>
      )}
      {modal === 'delete' && (
        <Modal title={t('formula.deleteDraft')} onClose={() => setModal(null)} footer={<>
          <button onClick={() => setModal(null)}>{t('common.cancel')}</button>
          <button className="danger" onClick={async () => { await run((s) => ({ revisions: [softDelete(s.revisions[rev.id])] })); go('formulas'); }}>{t('formula.deleteConfirm')}</button>
        </>}>
          <p>{t('formula.deleteExplain', { code: rev.code })}</p>
        </Modal>
      )}
    </div>
  );
}

export type { FormulaRevision };
