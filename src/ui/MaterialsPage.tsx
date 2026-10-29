import { useState } from 'react';
import { useStore } from '../store/store';
import { useI18n } from '../i18n';
import { D } from '../domain/decimal';
import { lotBalance, lotReserved } from '../domain/batch';
import { preparedStrength } from '../domain/formula';
import { adjustLot, createMaterial, prepareStock, receiveLot, updateMaterial, type NewLotInput } from '../domain/inventory';
import { nowISO, uid } from '../domain/ids';
import type { Attachment, Lot, Material } from '../domain/types';
import { DecimalInput, DemoBadge, download, Empty, Field, Modal } from './common';

type ModalState =
  | { kind: 'material'; material?: Material }
  | { kind: 'lot'; material: Material }
  | { kind: 'prepare'; lot: Lot }
  | { kind: 'adjust'; lot: Lot }
  | { kind: 'doc'; material: Material };

export function MaterialsPage() {
  const { state } = useStore();
  const { t, grams, pct, num, date } = useI18n();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [modal, setModal] = useState<ModalState | null>(null);
  const materials = Object.values(state.materials).filter((m) => !m.deletedAt && (!q || `${m.name} ${m.supplier} ${m.cas}`.toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => a.name.localeCompare(b.name));
  const lotsOf = (id: string) => Object.values(state.lots).filter((l) => l.materialId === id && !l.deletedAt);
  const docsOf = (id: string) => Object.values(state.attachments).filter((a) => a.materialId === id && !a.deletedAt);

  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('nav.materials')}</h1>
        <div className="actions">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('common.search')} aria-label={t('common.search')} />
          <button className="primary" onClick={() => setModal({ kind: 'material' })}>{t('materials.add')}</button>
        </div>
      </div>
      <p className="muted small">{t('materials.intro')}</p>
      {materials.length === 0 ? <Empty>{t('materials.empty')}</Empty> : (
        <table className="tbl">
          <thead><tr><th>{t('materials.name')}</th><th>{t('materials.grade')}</th><th>{t('materials.supplier')}</th><th>CAS</th><th className="num">{t('materials.lots')}</th><th /></tr></thead>
          <tbody>
            {materials.map((m) => {
              const lots = lotsOf(m.id);
              const docs = docsOf(m.id);
              return [
                <tr key={m.id} className="clickable" onClick={() => setOpen((o) => ({ ...o, [m.id]: !o[m.id] }))}>
                  <td>{m.name} <DemoBadge show={m.demo} /></td><td>{m.grade || '—'}</td><td>{m.supplier || '—'}</td><td className="mono">{m.cas || '—'}</td>
                  <td className="num">{lots.length}</td><td>{open[m.id] ? '▾' : '▸'}</td>
                </tr>,
                open[m.id] && (
                  <tr key={`${m.id}-d`} className="detail-row"><td colSpan={6}>
                    <div className="actions">
                      <button onClick={() => setModal({ kind: 'lot', material: m })}>{t('materials.addLot')}</button>
                      <button onClick={() => setModal({ kind: 'material', material: m })}>{t('materials.edit')}</button>
                      <button onClick={() => setModal({ kind: 'doc', material: m })}>{t('materials.attachDoc')}</button>
                    </div>
                    {lots.length === 0 ? <p className="muted">{t('materials.noLots')}</p> : (
                      <table className="tbl small">
                        <thead><tr><th>{t('materials.lot')}</th><th>{t('materials.kind')}</th><th className="num">{t('col.strength')}</th><th>{t('col.carrier')}</th>
                          <th className="num">{t('materials.quantity')}</th><th className="num">{t('col.costPerKg')}</th><th>{t('materials.provenance')}</th><th /></tr></thead>
                        <tbody>{lots.map((l) => {
                          const bal = lotBalance(state, l.id);
                          const reserved = bal === null ? null : lotReserved(state, l.id);
                          const src = l.sourceLotId ? state.lots[l.sourceLotId] : null;
                          return (
                            <tr key={l.id}>
                              <td className="mono">{l.lotCode} <DemoBadge show={l.demo} /></td>
                              <td>{l.kind === 'prepared_stock' ? t('materials.prepared') : t('materials.supplied')}</td>
                              <td className="num">{l.strength === null ? t('common.unknown') : pct(l.strength, 3)}</td>
                              <td>{l.carrier ?? '—'}</td>
                              <td className="num">{bal === null ? <span className="muted">{t('materials.untracked')}</span> : grams(bal)}{reserved && reserved.greaterThan(0) ? <div className="small muted">{t('materials.reserved', { g: grams(reserved) })}</div> : null}</td>
                              <td className="num">{l.costPerKg === null ? t('common.unknown') : `${num(l.costPerKg, 2)} ${l.currency ?? ''}`}</td>
                              <td className="small">{src ? t('materials.preparedFrom', { src: src.lotCode, sm: grams(l.sourceMass), cm: grams(l.carrierMass), carrier: l.carrier ?? '' }) : l.receivedAt ? date(l.receivedAt) : '—'}</td>
                              <td>
                                <button className="link" onClick={() => setModal({ kind: 'prepare', lot: l })}>{t('materials.prepare')}</button>{' '}
                                <button className="link" onClick={() => setModal({ kind: 'adjust', lot: l })}>{t('materials.adjust')}</button>
                              </td>
                            </tr>
                          );
                        })}</tbody>
                      </table>
                    )}
                    <h4>{t('materials.documents')}</h4>
                    {docs.length === 0 ? <p className="muted small">{t('materials.noDocs')}</p> : (
                      <table className="tbl small"><tbody>{docs.map((d) => (
                        <tr key={d.id}>
                          <td><button className="link" onClick={() => download(d.fileName, Uint8Array.from(atob(d.dataBase64), (c) => c.charCodeAt(0)), d.mime)}>{d.fileName}</button></td>
                          <td>{d.source || '—'}</td><td>{d.docDate || '—'}</td><td>{d.intendedUse || '—'}</td>
                          <td>{t(`materials.review.${d.reviewState}` as never)}</td>
                        </tr>
                      ))}</tbody></table>
                    )}
                    <p className="muted small">{t('materials.safetyNote')}</p>
                  </td></tr>
                ),
              ];
            })}
          </tbody>
        </table>
      )}
      {modal?.kind === 'material' && <MaterialModal material={modal.material} onClose={() => setModal(null)} />}
      {modal?.kind === 'lot' && <LotModal material={modal.material} onClose={() => setModal(null)} />}
      {modal?.kind === 'prepare' && <PrepareModal lot={modal.lot} onClose={() => setModal(null)} />}
      {modal?.kind === 'adjust' && <AdjustModal lot={modal.lot} onClose={() => setModal(null)} />}
      {modal?.kind === 'doc' && <DocModal material={modal.material} onClose={() => setModal(null)} />}
    </div>
  );
}

function MaterialModal({ material, onClose }: { material?: Material; onClose: () => void }) {
  const { run } = useStore();
  const { t } = useI18n();
  const [m, setM] = useState(material
    ? { name: material.name, grade: material.grade, supplier: material.supplier, cas: material.cas, notes: material.notes,
      density: material.density ?? null, maxPct: material.maxPct ?? null, limitSource: material.limitSource ?? '' }
    : { name: '', grade: '', supplier: '', cas: '', notes: '', density: null as string | null, maxPct: null as string | null, limitSource: '' });
  const save = async () => {
    const cs = await run((s) => (material ? updateMaterial(s, material.id, m) : createMaterial(m)));
    if (cs) onClose();
  };
  return (
    <Modal title={material ? t('materials.edit') : t('materials.add')} onClose={onClose} footer={<>
      <button onClick={onClose}>{t('common.cancel')}</button>
      <button className="primary" disabled={!m.name.trim()} onClick={save}>{material ? t('common.save') : t('common.create')}</button>
    </>}>
      {material && <p className="muted small">{t('materials.editNote')}</p>}
      <Field label={t('materials.name')} hint={t('materials.nameHint')}><input value={m.name} onChange={(e) => setM({ ...m, name: e.target.value })} /></Field>
      <div className="form-row">
        <Field label={t('materials.grade')}><input value={m.grade} onChange={(e) => setM({ ...m, grade: e.target.value })} /></Field>
        <Field label={t('materials.supplier')}><input value={m.supplier} onChange={(e) => setM({ ...m, supplier: e.target.value })} /></Field>
        <Field label="CAS"><input value={m.cas} onChange={(e) => setM({ ...m, cas: e.target.value })} /></Field>
      </div>
      <div className="form-row">
        <Field label={t('materials.density')} hint={t('materials.densityHint')}>
          <DecimalInput value={m.density} onValue={(v) => setM({ ...m, density: v })} unit="g/mL" />
        </Field>
        <Field label={t('materials.maxPct')} hint={t('materials.maxPctHint')}>
          <DecimalInput value={m.maxPct} onValue={(v) => setM({ ...m, maxPct: v })} unit="%" />
        </Field>
        <Field label={t('materials.limitSource')}>
          <input value={m.limitSource} placeholder={t('materials.limitSourcePh')} onChange={(e) => setM({ ...m, limitSource: e.target.value })} />
        </Field>
      </div>
      <Field label={t('col.note')}><textarea rows={2} value={m.notes} onChange={(e) => setM({ ...m, notes: e.target.value })} /></Field>
    </Modal>
  );
}

function LotModal({ material, onClose }: { material: Material; onClose: () => void }) {
  const { run, state } = useStore();
  const { t } = useI18n();
  const [l, setL] = useState<NewLotInput>({
    materialId: material.id, lotCode: '', supplier: material.supplier, strength: '100', carrier: null, costPerKg: null,
    currency: state.settings.currency, tracked: false, initialQty: null, containerCapacity: null, receivedAt: nowISO(), notes: '',
  });
  return (
    <Modal title={`${t('materials.addLot')} · ${material.name}`} onClose={onClose} footer={<>
      <button onClick={onClose}>{t('common.cancel')}</button>
      <button className="primary" disabled={!l.lotCode.trim()} onClick={async () => { if (await run((s) => receiveLot(s, { ...l, currency: l.costPerKg ? l.currency : null }))) onClose(); }}>{t('common.create')}</button>
    </>}>
      <div className="form-row">
        <Field label={t('materials.lot')} hint={t('materials.lotHint')}><input value={l.lotCode} onChange={(e) => setL({ ...l, lotCode: e.target.value })} /></Field>
        <Field label={t('materials.supplier')}><input value={l.supplier} onChange={(e) => setL({ ...l, supplier: e.target.value })} /></Field>
      </div>
      <div className="form-row">
        <Field label={t('col.strength')} hint={t('materials.strengthHint')}><DecimalInput value={l.strength} onValue={(v) => setL({ ...l, strength: v })} unit="%" placeholder={t('common.unknown')} /></Field>
        <Field label={t('col.carrier')}><input value={l.carrier ?? ''} onChange={(e) => setL({ ...l, carrier: e.target.value || null })} /></Field>
      </div>
      <div className="form-row">
        <Field label={t('col.costPerKg')} hint={t('common.optional')}><DecimalInput value={l.costPerKg} onValue={(v) => setL({ ...l, costPerKg: v })} placeholder={t('common.unknown')} /></Field>
        <Field label={t('col.currency')}><input value={l.currency ?? ''} maxLength={3} onChange={(e) => setL({ ...l, currency: e.target.value.toUpperCase() })} /></Field>
      </div>
      <label className="check"><input type="checkbox" checked={l.tracked} onChange={(e) => setL({ ...l, tracked: e.target.checked })} /> {t('materials.track')}</label>
      {l.tracked && (
        <div className="form-row">
          <Field label={t('materials.initialQty')}><DecimalInput value={l.initialQty} onValue={(v) => setL({ ...l, initialQty: v })} unit="g" /></Field>
          <Field label={t('plan.capacity')} hint={t('common.optional')}><DecimalInput value={l.containerCapacity} onValue={(v) => setL({ ...l, containerCapacity: v })} unit="g" /></Field>
        </div>
      )}
    </Modal>
  );
}

function PrepareModal({ lot, onClose }: { lot: Lot; onClose: () => void }) {
  const { run } = useStore();
  const { t, pct } = useI18n();
  const [sm, setSm] = useState<string | null>('1');
  const [cm, setCm] = useState<string | null>('9');
  const [carrier, setCarrier] = useState('DPG');
  const [code, setCode] = useState(`${lot.lotCode}-10`);
  const key = useState(() => uid('prep'))[0];
  const strength = sm && cm ? preparedStrength(sm, lot.strength, cm) : null;
  return (
    <Modal title={t('materials.prepare')} onClose={onClose} footer={<>
      <button onClick={onClose}>{t('common.cancel')}</button>
      <button className="primary" disabled={!sm || !cm || !code.trim() || !D(sm).greaterThan(0)}
        onClick={async () => { if (await run((s) => prepareStock(s, { sourceLotId: lot.id, sourceMass: sm!, carrier, carrierMass: cm!, lotCode: code, idempotencyKey: key }))) onClose(); }}>
        {t('materials.prepareConfirm')}
      </button>
    </>}>
      <p>{t('materials.prepareExplain', { lot: lot.lotCode })}</p>
      <div className="form-row">
        <Field label={t('materials.sourceMass')}><DecimalInput value={sm} onValue={setSm} unit="g" /></Field>
        <Field label={t('col.carrier')}><input value={carrier} onChange={(e) => setCarrier(e.target.value)} /></Field>
        <Field label={t('materials.carrierMass')}><DecimalInput value={cm} onValue={setCm} unit="g" /></Field>
      </div>
      <Field label={t('materials.newLotCode')}><input value={code} onChange={(e) => setCode(e.target.value)} /></Field>
      <p className="strong">{t('materials.resultStrength')}: {strength ? pct(strength, 4) : t('common.unknown')}</p>
    </Modal>
  );
}

function AdjustModal({ lot, onClose }: { lot: Lot; onClose: () => void }) {
  const { run } = useStore();
  const { t } = useI18n();
  const [delta, setDelta] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const key = useState(() => uid('adj'))[0];
  return (
    <Modal title={`${t('materials.adjust')} · ${lot.lotCode}`} onClose={onClose} footer={<>
      <button onClick={onClose}>{t('common.cancel')}</button>
      <button className="primary" disabled={!delta || !reason.trim()} onClick={async () => { if (await run((s) => adjustLot(s, { lotId: lot.id, delta: delta!, reason, idempotencyKey: key }))) onClose(); }}>{t('common.save')}</button>
    </>}>
      <p>{t('materials.adjustExplain')}</p>
      <Field label={t('materials.delta')} hint={t('materials.deltaHint')}><DecimalInput value={delta} onValue={setDelta} unit="g" /></Field>
      <Field label={t('common.reason')}><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    </Modal>
  );
}

function DocModal({ material, onClose }: { material: Material; onClose: () => void }) {
  const { run, toast } = useStore();
  const { t } = useI18n();
  const [file, setFile] = useState<File | null>(null);
  const [meta, setMeta] = useState({ source: '', docDate: '', intendedUse: '', reviewState: 'not_reviewed' as Attachment['reviewState'] });
  const save = async () => {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { toast(t('err.file_too_large'), 'error'); return; }
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    const att: Attachment = {
      id: uid('att'), createdAt: nowISO(), materialId: material.id, lotId: null, fileName: file.name,
      mime: file.type || 'application/octet-stream', dataBase64: btoa(bin), ...meta,
    };
    if (await run(() => ({ attachments: [att] }))) onClose();
  };
  return (
    <Modal title={`${t('materials.attachDoc')} · ${material.name}`} onClose={onClose} footer={<>
      <button onClick={onClose}>{t('common.cancel')}</button>
      <button className="primary" disabled={!file} onClick={save}>{t('common.save')}</button>
    </>}>
      <Field label={t('materials.file')}><input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
      <div className="form-row">
        <Field label={t('materials.docSource')}><input value={meta.source} onChange={(e) => setMeta({ ...meta, source: e.target.value })} /></Field>
        <Field label={t('materials.docDate')}><input type="date" value={meta.docDate} onChange={(e) => setMeta({ ...meta, docDate: e.target.value })} /></Field>
      </div>
      <Field label={t('materials.intendedUse')}><input value={meta.intendedUse} onChange={(e) => setMeta({ ...meta, intendedUse: e.target.value })} /></Field>
      <Field label={t('materials.reviewState')}>
        <select value={meta.reviewState} onChange={(e) => setMeta({ ...meta, reviewState: e.target.value as Attachment['reviewState'] })}>
          {(['not_reviewed', 'reviewed', 'superseded'] as const).map((r) => <option key={r} value={r}>{t(`materials.review.${r}` as never)}</option>)}
        </select>
      </Field>
      <p className="muted small">{t('materials.safetyNote')}</p>
    </Modal>
  );
}
