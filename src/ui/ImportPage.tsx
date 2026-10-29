import { useMemo, useState } from 'react';
import { useStore } from '../store/store';
import { useI18n, type TKey } from '../i18n';
import { ImportError, parseDelimited, type Sheet } from '../import/grid';
import { readXlsx } from '../import/xlsx';
import { readOds } from '../import/ods';
import {
  blockingRows, buildPreview, conventionNeeded, FIELDS, guessAmountMode, guessHeaderRow, guessMapping, previewToLines,
  type PreviewRow, type RowFlag,
} from '../import/mapping';
import type { Convention } from '../import/numbers';
import { EXAMPLE_SHEET } from '../import/example';
import { createDraft, createProject } from '../domain/revisions';
import { audit } from '../domain/batch';
import { nowISO, uid } from '../domain/ids';
import { mergeChangesets, type AmountMode, type ImportMapping } from '../domain/types';
import { DemoBadge, Field, go } from './common';

export function ImportPage({ projectId }: { projectId: string | null }) {
  const { state, run, toast, errorText } = useStore();
  const { t, num } = useI18n();
  const projects = Object.values(state.projects).filter((p) => !p.deletedAt);
  const [target, setTarget] = useState<string>(projectId ?? projects[0]?.id ?? 'new');
  const [newProj, setNewProj] = useState({ name: '', code: '' });
  const [paste, setPaste] = useState('');
  const [sheets, setSheets] = useState<Sheet[] | null>(null);
  const [sourceName, setSourceName] = useState('');
  const [sheetIdx, setSheetIdx] = useState(0);
  const [headerRow, setHeaderRow] = useState(0);
  const [mapping, setMapping] = useState<string[]>([]);
  const [amountMode, setAmountMode] = useState<AmountMode>('g');
  const [convention, setConvention] = useState<Convention | null>(null);
  const [blankStrength, setBlankStrength] = useState<'unknown' | 'neat'>('unknown');
  const [overrides, setOverrides] = useState<Record<number, Partial<Pick<PreviewRow, 'include' | 'materialMatch'>>>>({});
  const [hints, setHints] = useState<Set<number>>(new Set());
  const [mappingName, setMappingName] = useState('');
  const [busy, setBusy] = useState(false);

  const sheet = sheets?.[sheetIdx] ?? null;
  const savedMappings = Object.values(state.importMappings);

  const loadSheets = (list: Sheet[], name: string) => {
    setSheets(list);
    setSourceName(name);
    setSheetIdx(0);
    initSheet(list[0]);
  };
  const initSheet = (s: Sheet) => {
    const h = guessHeaderRow(s);
    setHeaderRow(h);
    const m = guessMapping(s, h);
    setMapping(m);
    const amtCol = m.indexOf('amount');
    setAmountMode(amtCol >= 0 ? guessAmountMode(s.rows[h]?.[amtCol]?.text ?? '') : 'g');
    const need = conventionNeeded(s, h, m);
    setConvention(need.suggestion === 'point' || need.suggestion === 'comma' ? need.suggestion : null);
    setOverrides({});
    setHints(new Set());
  };

  const onFile = async (f: File) => {
    try {
      if (f.size > 10 * 1024 * 1024) throw new ImportError('file_too_large');
      if (/\.xlsx$/i.test(f.name)) {
        loadSheets(readXlsx(new Uint8Array(await f.arrayBuffer())), f.name);
      } else if (/\.ods$/i.test(f.name)) {
        loadSheets(readOds(new Uint8Array(await f.arrayBuffer())), f.name);
      } else if (/\.(xls|xlsm|xlsb)$/i.test(f.name)) {
        throw new ImportError('unsupported_format');
      } else {
        loadSheets([parseDelimited(await f.text()).sheet], f.name);
      }
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };

  const applySaved = (id: string) => {
    const m = state.importMappings[id];
    if (!m || !sheet) return;
    setHeaderRow(m.headerRow);
    const headers = (sheet.rows[m.headerRow] ?? []).map((c) => c.text.trim());
    setMapping(headers.map((h) => m.columns[h] ?? 'keep'));
    setConvention(m.convention);
    setAmountMode(m.amountMode);
  };

  const need = useMemo(() => (sheet ? conventionNeeded(sheet, headerRow, mapping) : null), [sheet, headerRow, mapping]);
  const rows = useMemo(() => {
    if (!sheet) return [];
    return buildPreview(sheet, { headerRow, mapping, convention, blankStrength, materials: Object.values(state.materials) })
      .map((r) => ({ ...r, ...overrides[r.rowIndex] }));
  }, [sheet, headerRow, mapping, convention, blankStrength, state.materials, overrides]);
  const blocking = blockingRows(rows);
  const included = rows.filter((r) => r.include);
  const conventionMissing = !!need && need.ambiguousCount > 0 && convention === null;
  const mixed = need?.suggestion === 'mixed';
  const hasMaterial = mapping.includes('material');
  const hasAmount = mapping.includes('amount');
  const canCommit = !!sheet && hasMaterial && hasAmount && included.length > 0 && blocking.length === 0 && !conventionMissing
    && (target !== 'new' || (newProj.name.trim() && newProj.code.trim()));

  const commit = async () => {
    if (!sheet) return;
    setBusy(true);
    let revId = '';
    const cs = await run((s) => {
      const at = nowISO();
      let projectCs = {};
      let pid = target;
      let st = s;
      if (target === 'new') {
        const p = createProject(s, { name: newProj.name, code: newProj.code, objective: '' }, at);
        pid = p.project.id;
        projectCs = p;
        st = { ...s, projects: { ...s.projects, [pid]: p.project } };
      }
      const importId = uid('imp');
      const lines = previewToLines(rows, s.settings.currency, hints);
      const d = createDraft(st, { projectId: pid, lines, amountMode, importId, notes: t('import.importedFrom', { name: sourceName }) }, at);
      revId = d.revision.id;
      const extra: Array<{ importMappings?: ImportMapping[] }> = [];
      if (mappingName.trim()) {
        const headers = (sheet.rows[headerRow] ?? []).map((c) => c.text.trim());
        const cols: Record<string, string> = {};
        headers.forEach((h, i) => { if (h) cols[h] = mapping[i]; });
        extra.push({ importMappings: [{ id: uid('map'), createdAt: at, name: mappingName.trim(), headerRow, columns: cols, convention: convention ?? 'point', amountMode }] });
      }
      return mergeChangesets(projectCs, d, ...extra, {
        audit: [audit('revision', d.revision.id, 'import', `${sourceName}: ${lines.length} rows, ${rows.length - lines.length} excluded`, at)],
      });
    });
    setBusy(false);
    if (cs) { toast(t('import.done')); go(`formula/${revId}`); }
  };

  const flagText = (f: RowFlag) => t(`flag.${f}` as TKey);
  const colLabel = (i: number) => sheet?.rows[headerRow]?.[i]?.text?.trim() || `${t('import.column')} ${i + 1}`;
  const width = sheet ? Math.max(...sheet.rows.slice(0, 40).map((r) => r?.length ?? 0), 0) : 0;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t('import.title')}</h1>
          <p className="muted small">{t('import.intro')}</p>
        </div>
      </div>

      <section className="panel">
        <h3>1 · {t('import.source')}</h3>
        <div className="form-row">
          <Field label={t('import.targetProject')}>
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.code}){p.demo ? ` · ${t('demo.badge')}` : ''}</option>)}
              <option value="new">{t('import.newProject')}</option>
            </select>
          </Field>
          {target === 'new' && <>
            <Field label={t('projects.name')}><input value={newProj.name} onChange={(e) => setNewProj({ ...newProj, name: e.target.value })} /></Field>
            <Field label={t('projects.code')} hint={t('projects.codeHint')}><input value={newProj.code} maxLength={6} onChange={(e) => setNewProj({ ...newProj, code: e.target.value.toUpperCase() })} /></Field>
          </>}
        </div>
        <div className="import-sources">
          <Field label={t('import.file')} hint={t('import.fileHint')}>
            <input type="file" accept=".xlsx,.ods,.csv,.tsv,.txt" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
          </Field>
          <Field label={t('import.paste')} hint={t('import.pasteHint')}>
            <textarea rows={4} value={paste} onChange={(e) => setPaste(e.target.value)} />
          </Field>
          <div className="stack">
            <button disabled={!paste.trim()} onClick={() => { try { loadSheets([parseDelimited(paste).sheet], t('import.pasted')); } catch (e) { toast(errorText(e), 'error'); } }}>{t('import.readPaste')}</button>
            <button onClick={() => { setPaste(EXAMPLE_SHEET); loadSheets([parseDelimited(EXAMPLE_SHEET).sheet], 'example-amber-tea.csv'); }}>{t('import.useExample')}</button>
            <DemoBadge show />
          </div>
        </div>
        <p className="muted small">{t('import.safety')}</p>
      </section>

      {sheet && (
        <section className="panel">
          <h3>2 · {t('import.structure')} <span className="muted small">{sourceName}</span></h3>
          <div className="form-row">
            {sheets && sheets.length > 1 && (
              <Field label={t('import.sheet')}>
                <select value={sheetIdx} onChange={(e) => { const i = Number(e.target.value); setSheetIdx(i); initSheet(sheets[i]); }}>
                  {sheets.map((s, i) => <option key={i} value={i}>{s.name}</option>)}
                </select>
              </Field>
            )}
            <Field label={t('import.headerRow')}>
              <select value={headerRow} onChange={(e) => { const h = Number(e.target.value); setHeaderRow(h); setMapping(guessMapping(sheet, h)); }}>
                {sheet.rows.slice(0, 25).map((r, i) => <option key={i} value={i}>{i + 1}: {(r ?? []).map((c) => c?.text).filter(Boolean).join(' | ').slice(0, 60)}</option>)}
              </select>
            </Field>
            {savedMappings.length > 0 && (
              <Field label={t('import.savedMapping')}>
                <select defaultValue="" onChange={(e) => e.target.value && applySaved(e.target.value)}>
                  <option value="">—</option>
                  {savedMappings.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </Field>
            )}
            <Field label={t('formula.amountMode')}>
              <select value={amountMode} onChange={(e) => setAmountMode(e.target.value as AmountMode)}>
                <option value="g">{t('mode.g')}</option><option value="pct">{t('mode.pct')}</option><option value="parts">{t('mode.parts')}</option>
              </select>
            </Field>
          </div>
          <div className="grid-wrap">
            <table className="tbl small mapping">
              <thead><tr>{Array.from({ length: width }, (_, i) => (
                <th key={i}>
                  <div className="muted">{colLabel(i)}</div>
                  <select value={mapping[i] ?? 'keep'} onChange={(e) => setMapping((m) => { const n = [...m]; while (n.length < width) n.push('keep'); n[i] = e.target.value; return n; })}>
                    {FIELDS.map((f) => <option key={f} value={f}>{t(`field.${f}` as TKey)}</option>)}
                  </select>
                </th>
              ))}</tr></thead>
              <tbody>{sheet.rows.slice(headerRow + 1, headerRow + 4).map((r, ri) => (
                <tr key={ri}>{Array.from({ length: width }, (_, i) => <td key={i}>{r?.[i]?.text ?? ''}</td>)}</tr>
              ))}</tbody>
            </table>
          </div>
          {!hasMaterial && <p className="warn-text">{t('import.needMaterial')}</p>}
          {!hasAmount && <p className="warn-text">{t('import.needAmount')}</p>}

          <div className="form-row">
            <fieldset className={`radio-group${conventionMissing ? ' needs' : ''}`}>
              <legend>{t('import.convention')}</legend>
              <label><input type="radio" checked={convention === 'point'} onChange={() => setConvention('point')} /> {t('import.convPoint')}</label>
              <label><input type="radio" checked={convention === 'comma'} onChange={() => setConvention('comma')} /> {t('import.convComma')}</label>
              <span className="small muted">
                {need?.suggestion === 'point' || need?.suggestion === 'comma' ? t('import.detected', { conv: need.suggestion === 'point' ? t('import.convPoint') : t('import.convComma') }) : ''}
                {mixed ? t('import.mixed') : ''}
                {need && need.ambiguousCount > 0 ? ` ${t('import.ambiguousCount', { n: need.ambiguousCount })}` : ''}
              </span>
            </fieldset>
            <fieldset className="radio-group">
              <legend>{t('import.blankStrength')}</legend>
              <label><input type="radio" checked={blankStrength === 'unknown'} onChange={() => setBlankStrength('unknown')} /> {t('import.blankUnknown')}</label>
              <label><input type="radio" checked={blankStrength === 'neat'} onChange={() => setBlankStrength('neat')} /> {t('import.blankNeat')}</label>
            </fieldset>
          </div>
        </section>
      )}

      {sheet && hasMaterial && hasAmount && (
        <section className="panel">
          <h3>3 · {t('import.review')}</h3>
          <p className="small">{t('import.summary', { inc: included.length, total: rows.length, blocking: blocking.length })}</p>
          <div className="grid-wrap">
            <table className="tbl small">
              <thead><tr>
                <th>{t('import.include')}</th><th>{t('import.row')}</th><th>{t('col.material')}</th><th>{t('import.materialMatch')}</th>
                <th className="num">{t('col.amount')}</th><th className="num">{t('col.strength')}</th><th>{t('col.carrier')}</th><th className="num">{t('col.costPerKg')}</th><th>{t('import.flags')}</th>
              </tr></thead>
              <tbody>{rows.map((r) => {
                const blockingRow = blocking.includes(r);
                const sameName = Object.values(state.materials).filter((m) => !m.deletedAt && m.name.toLowerCase() === r.name.toLowerCase());
                return (
                  <tr key={r.rowIndex} className={blockingRow ? 'warn-row' : r.include ? '' : 'excluded'}>
                    <td><input type="checkbox" checked={r.include} aria-label={t('import.include')} onChange={(e) => setOverrides((o) => ({ ...o, [r.rowIndex]: { ...o[r.rowIndex], include: e.target.checked } }))} /></td>
                    <td className="muted">{r.rowIndex + 1}</td>
                    <td>{r.name || <span className="muted">—</span>}</td>
                    <td>
                      <select value={r.materialMatch ?? ''} onChange={(e) => setOverrides((o) => ({ ...o, [r.rowIndex]: { ...o[r.rowIndex], materialMatch: e.target.value || null } }))}>
                        <option value="">{t('import.newMaterial')}</option>
                        {sameName.map((m) => <option key={m.id} value={m.id}>{m.name}{m.grade ? ` (${m.grade})` : ''}{m.supplier ? ` · ${m.supplier}` : ''}</option>)}
                      </select>
                    </td>
                    <td className="num">{r.amount.status === 'ok' ? num(r.amount.value) : <span className="warn-text">{r.amount.status === 'blank' ? t('common.blank') : `${r.amount.raw} ?`}</span>}</td>
                    <td className="num">{r.strength.status === 'ok' ? `${num(r.strength.value)} %` : r.strength.status === 'blank' ? <span className="muted">{t('common.unknown')}</span> : <span className="warn-text">{r.strength.raw} ?</span>}</td>
                    <td>{r.carrier}</td>
                    <td className="num">{r.cost.status === 'ok' ? num(r.cost.value) : r.cost.status === 'blank' ? '' : <span className="warn-text">{r.cost.raw} ?</span>}</td>
                    <td className="small">
                      {r.flags.map((f) => <span key={f} className={`flag flag-${f}`}>{flagText(f)}</span>)}
                      {r.flags.includes('strength_in_name') && r.strengthHint && (
                        <label className="check"><input type="checkbox" checked={hints.has(r.rowIndex)} onChange={(e) => setHints((h) => { const n = new Set(h); e.target.checked ? n.add(r.rowIndex) : n.delete(r.rowIndex); return n; })} />
                          {t('import.useHint', { s: r.strengthHint.strength, c: r.strengthHint.carrier ?? '' })}</label>
                      )}
                      {Object.keys(r.extra).length > 0 && <span className="muted"> {t('import.kept', { n: Object.keys(r.extra).length })}</span>}
                    </td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
          {conventionMissing && <p className="warn-box">{t('import.chooseConvention')}</p>}
          {blocking.length > 0 && <p className="warn-box">{t('import.resolveRows', { rows: blocking.map((r) => r.rowIndex + 1).join(', ') })}</p>}
          <div className="form-row">
            <Field label={t('import.saveMappingAs')} hint={t('common.optional')}><input value={mappingName} onChange={(e) => setMappingName(e.target.value)} /></Field>
          </div>
          <div className="actions">
            <button className="primary" disabled={!canCommit || busy} onClick={commit}>
              {t('import.commit', { n: included.length, code: target === 'new' ? `${newProj.code || '?'}-F001` : `${state.projects[target]?.code}-F${String(state.projects[target]?.nextRevisionNo ?? 1).padStart(3, '0')}` })}
            </button>
          </div>
          <p className="muted small">{t('import.commitNote')}</p>
        </section>
      )}
    </div>
  );
}
