import { useState } from 'react';
import { useStore } from '../store/store';
import { useI18n } from '../i18n';
import { DemoBadge, Empty, Field, go, Modal, StateBadge, useNow } from './common';
import { createDraft, createProject, deleteProject, newLine, updateProject } from '../domain/revisions';
import type { Project } from '../domain/types';
import { dueEvaluations } from '../domain/journal';
import { buildDemo } from '../domain/demo';
import type { Batch } from '../domain/types';

export function NewProjectModal({ onClose, onCreated, project }: { onClose: () => void; onCreated?: (id: string) => void; project?: Project }) {
  const { run } = useStore();
  const { t } = useI18n();
  const [name, setName] = useState(project?.name ?? '');
  const [code, setCode] = useState(project?.code ?? '');
  const [objective, setObjective] = useState(project?.objective ?? '');
  const [isAccord, setIsAccord] = useState(!!project?.isAccord);
  const submit = async () => {
    let id = project?.id ?? '';
    const cs = await run((s) => {
      if (project) return updateProject(s, project.id, { name, objective });
      const r = createProject(s, { name, code, objective, isAccord });
      id = r.project.id;
      return r;
    });
    if (cs) { onClose(); onCreated?.(id); }
  };
  return (
    <Modal title={project ? t('projects.edit') : t('projects.new')} onClose={onClose} footer={<>
      <button onClick={onClose}>{t('common.cancel')}</button>
      <button className="primary" onClick={submit} disabled={!name.trim() || !code.trim()}>{project ? t('common.save') : t('common.create')}</button>
    </>}>
      <Field label={t('projects.name')}><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label={t('projects.code')} hint={project ? t('projects.codeFixed') : t('projects.codeHint')}>
        <input value={code} maxLength={6} disabled={!!project} onChange={(e) => setCode(e.target.value.toUpperCase())} />
      </Field>
      <Field label={t('projects.objective')}><textarea rows={2} value={objective} onChange={(e) => setObjective(e.target.value)} /></Field>
      {!project && (
        <label className="check"><input type="checkbox" checked={isAccord} onChange={(e) => setIsAccord(e.target.checked)} /> {t('accord.projectCheck')}</label>
      )}
      {!project && isAccord && <p className="muted small">{t('accord.projectHint')}</p>}
    </Modal>
  );
}

export function latestOpenBatch(batches: Batch[]): Batch | undefined {
  return batches
    .filter((b) => (b.state === 'in_progress' || b.state === 'paused') && !b.deletedAt)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
}

export function ProjectsPage() {
  const { state, run } = useStore();
  const { t, dateTime, duration } = useI18n();
  const now = useNow();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState<Project | null>(null);
  const projects = Object.values(state.projects).filter((p) => !p.deletedAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const batches = Object.values(state.batches);
  const open = latestOpenBatch(batches);
  const due = dueEvaluations(state, now);

  const newFormula = async (projectId: string) => {
    let id = '';
    const cs = await run((s) => {
      const r = createDraft(s, { projectId, lines: [newLine(), newLine(), newLine()], amountMode: 'g' });
      id = r.revision.id;
      return r;
    });
    if (cs) go(`formula/${id}`);
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('nav.projects')}</h1>
        <div className="actions">
          <button className="primary" onClick={() => go('import')}>{t('projects.importFormula')}</button>
          <button className="primary" disabled={!open} onClick={() => open && go(`bench/${open.id}`)}
            title={open ? open.code : t('projects.noOpenBatch')}>
            {open ? t('projects.continueBatch', { code: open.code }) : t('projects.continueBatchNone')}
          </button>
          <button onClick={() => setCreating(true)}>{t('projects.new')}</button>
        </div>
      </div>

      {projects.length === 0 && (
        <Empty>
          <p>{t('projects.empty')}</p>
          <div className="actions">
            <button className="primary" onClick={() => go('import')}>{t('projects.importFormula')}</button>
            <button onClick={() => run((s) => buildDemo(s))}>{t('demo.load')}</button>
          </div>
          <p className="muted">{t('demo.explain')}</p>
        </Empty>
      )}

      {due.length > 0 && (
        <section className="panel">
          <h2>{t('projects.evaluationsDue')}</h2>
          <table className="tbl">
            <thead><tr><th>{t('journal.sample')}</th><th>{t('journal.medium')}</th><th>{t('journal.checkpoint')}</th><th>{t('journal.due')}</th><th /></tr></thead>
            <tbody>
              {due.slice(0, 8).map((d) => (
                <tr key={`${d.application.id}-${d.checkpointMin}`}>
                  <td className="mono">{d.sample.code} <DemoBadge show={d.sample.demo} /></td>
                  <td>{t(`medium.${d.application.medium}` as never)}</td>
                  <td>{duration(d.checkpointMin * 60000)}</td>
                  <td>{dateTime(d.dueAt.toISOString())}{d.dueAt > now ? '' : ` · ${t('journal.dueNow')}`}</td>
                  <td><button onClick={() => go(`journal/${d.sample.id}?app=${d.application.id}`)}>{t('journal.record')}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <div className="cards">
        {projects.map((p) => {
          const revs = Object.values(state.revisions).filter((r) => r.projectId === p.id && !r.deletedAt).sort((a, b) => b.number - a.number);
          const pb = batches.filter((b) => b.projectId === p.id).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
          const wip = pb.filter((b) => b.state === 'in_progress' || b.state === 'paused');
          const latest = pb[0];
          return (
            <section key={p.id} className="card">
              <div className="card-head">
                <h2>{p.name} <span className="mono muted">{p.code}</span>{p.isAccord && <span className="badge">{t('accord.badge')}</span>}</h2>
                <DemoBadge show={p.demo} />
              </div>
              {p.objective && <p className="muted">{p.objective}</p>}
              <dl className="kv">
                <dt>{t('projects.latestRevision')}</dt>
                <dd>{revs[0] ? <a href={`#/formula/${revs[0].id}`} className="mono">{revs[0].code}</a> : '—'} {revs[0] && <StateBadge state={revs[0].status} />}</dd>
                <dt>{t('projects.latestExperiment')}</dt>
                <dd>{latest ? <><a href={`#/batch/${latest.id}`} className="mono">{latest.code}</a> <StateBadge state={latest.state} /> <span className="muted">{dateTime(latest.startedAt)}</span></> : '—'}</dd>
                <dt>{t('projects.inProgress')}</dt>
                <dd>{wip.length === 0 ? '—' : wip.map((b) => (
                  <button key={b.id} className="link" onClick={() => go(`bench/${b.id}`)}>{t('projects.continueBatch', { code: b.code })}</button>
                ))}</dd>
              </dl>
              <div className="actions">
                <button onClick={() => go(`import?project=${p.id}`)}>{t('projects.importFormula')}</button>
                <button onClick={() => newFormula(p.id)}>{t('formulas.newBlank')}</button>
                {revs.length >= 2 && <button onClick={() => go(`compare?a=${revs[1].id}&b=${revs[0].id}`)}>{t('compare.title')}</button>}
                <button onClick={() => setEditing(p)}>{t('projects.edit')}</button>
                <button className="danger" onClick={() => setDeleting(p)}>{t('projects.delete')}</button>
              </div>
            </section>
          );
        })}
      </div>
      {creating && <NewProjectModal onClose={() => setCreating(false)} />}
      {editing && <NewProjectModal project={editing} onClose={() => setEditing(null)} />}
      {deleting && (
        <Modal title={t('projects.delete')} onClose={() => setDeleting(null)} footer={<>
          <button onClick={() => setDeleting(null)}>{t('common.cancel')}</button>
          <button className="danger" onClick={async () => { if (await run((s) => deleteProject(s, deleting.id))) setDeleting(null); }}>{t('formula.deleteConfirm')}</button>
        </>}>
          <p>{t('projects.deleteExplain', { name: deleting.name })}</p>
        </Modal>
      )}
    </div>
  );
}
