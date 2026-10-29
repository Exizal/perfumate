import { Component, lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from 'react';
import { useStore } from './store/store';
import { LOCALES, useI18n, type TKey } from './i18n';
import { go, Toasts, useRoute } from './ui/common';
import { parseLabelPayload } from './domain/ids';
import { ProjectsPage } from './ui/ProjectsPage';
import { canScan, ScanModal } from './ui/Scanner';
import { Tutorial, tutorialSeen } from './ui/Tutorial';

// Screens other than Projects load on first use to keep the initial download small.
const FormulasPage = lazy(() => import('./ui/FormulaPage').then((m) => ({ default: m.FormulasPage })));
const FormulaEditor = lazy(() => import('./ui/FormulaPage').then((m) => ({ default: m.FormulaEditor })));
const PlanBatchPage = lazy(() => import('./ui/PlanBatchPage').then((m) => ({ default: m.PlanBatchPage })));
const BenchList = lazy(() => import('./ui/BenchPage').then((m) => ({ default: m.BenchList })));
const BenchMode = lazy(() => import('./ui/BenchPage').then((m) => ({ default: m.BenchMode })));
const BatchRecordPage = lazy(() => import('./ui/BatchRecordPage').then((m) => ({ default: m.BatchRecordPage })));
const JournalPage = lazy(() => import('./ui/JournalPage').then((m) => ({ default: m.JournalPage })));
const ComparePage = lazy(() => import('./ui/ComparePage').then((m) => ({ default: m.ComparePage })));
const MaterialsPage = lazy(() => import('./ui/MaterialsPage').then((m) => ({ default: m.MaterialsPage })));
const ImportPage = lazy(() => import('./ui/ImportPage').then((m) => ({ default: m.ImportPage })));
const BlindListPage = lazy(() => import('./ui/BlindPage').then((m) => ({ default: m.BlindListPage })));
const BlindSessionPage = lazy(() => import('./ui/BlindPage').then((m) => ({ default: m.BlindSessionPage })));
const TeamPage = lazy(() => import('./ui/TeamPage').then((m) => ({ default: m.TeamPage })));
const TeamRoomPage = lazy(() => import('./ui/TeamPage').then((m) => ({ default: m.TeamRoomPage })));
const DataPage = lazy(() => import('./ui/DataPage').then((m) => ({ default: m.DataPage })));

/** A screen error must not take the whole app down: navigation, saving and backup stay usable. */
class PageBoundary extends Component<{ children: ReactNode; fallback: (e: Error) => ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() { return this.state.error ? this.props.fallback(this.state.error) : this.props.children; }
}

const NAV: Array<[string, TKey]> = [
  ['projects', 'nav.projects'],
  ['formulas', 'nav.formulas'],
  ['bench', 'nav.bench'],
  ['journal', 'nav.journal'],
  ['blind', 'nav.blind'],
  ['materials', 'nav.materials'],
  ['team', 'nav.team'],
];

function LabelLookup() {
  const { state, toast } = useStore();
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const [scanning, setScanning] = useState(false);
  const open = (text = q) => {
    const p = parseLabelPayload(text);
    const batch = (p.batchId && state.batches[p.batchId])
      || Object.values(state.batches).find((b) => b.code === p.code);
    const sample = !batch ? Object.values(state.samples).find((s) => s.code === p.code) : null;
    if (batch) { go(`batch/${batch.id}`); setQ(''); }
    else if (sample) { go(`journal/${sample.id}`); setQ(''); }
    else toast(t('lookup.notFound', { q: text }), 'error');
  };
  const onScan = useCallback((text: string) => { setScanning(false); open(text); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state]);
  return (
    <form className="lookup" onSubmit={(e) => { e.preventDefault(); open(); }}>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('lookup.placeholder')} aria-label={t('lookup.placeholder')} />
      <button type="submit" disabled={!q.trim()}>{t('lookup.open')}</button>
      {canScan() && <button type="button" onClick={() => setScanning(true)}>{t('scan.button')}</button>}
      {scanning && <ScanModal onResult={onScan} onClose={() => setScanning(false)} />}
    </form>
  );
}

function SaveIndicator() {
  const { status, state } = useStore();
  const { t, dateTime } = useI18n();
  const label = status === 'saved' ? t('save.saved') : status === 'saving' ? t('save.saving') : status === 'loading' ? t('save.loading') : t('save.error');
  return (
    <div className="save-ind">
      <span className={`dot dot-${status}`} />
      <span>{label}</span>
      <a href="#/data" className={`backup-ind${state.settings.lastBackupAt ? '' : ' warn'}`}>
        {state.settings.lastBackupAt ? t('save.lastBackup', { when: dateTime(state.settings.lastBackupAt) }) : t('save.noBackup')}
      </a>
    </div>
  );
}

export function App() {
  const { state, status, run, toasts, dismiss, lastError } = useStore();
  const { t } = useI18n();
  const { path, query } = useRoute();
  const section = path[0] || 'projects';
  const theme = state.settings.theme ?? 'system';
  const [tour, setTour] = useState(false);
  useEffect(() => { if (status === 'saved' && !tutorialSeen()) setTour(true); }, [status]);
  useEffect(() => {
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    };
    apply();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
  useEffect(() => { document.documentElement.lang = state.settings.locale; }, [state.settings.locale]);

  if (status === 'loading') return <div className="boot">{t('save.loading')}</div>;
  if (status === 'error' && Object.keys(state.projects).length === 0 && lastError) {
    return <div className="boot err">{t('save.dbError')}<pre>{lastError}</pre></div>;
  }

  let page;
  switch (section) {
    case 'formulas': page = <FormulasPage />; break;
    case 'formula': page = <FormulaEditor revisionId={path[1]} />; break;
    case 'plan': page = <PlanBatchPage revisionId={path[1]} />; break;
    case 'bench': page = path[1] ? <BenchMode batchId={path[1]} /> : <BenchList />; break;
    case 'batch': page = <BatchRecordPage batchId={path[1]} />; break;
    case 'journal': page = <JournalPage sampleId={path[1]} />; break;
    case 'compare': page = <ComparePage a={query.get('a')} b={query.get('b')} />; break;
    case 'materials': page = <MaterialsPage />; break;
    case 'import': page = <ImportPage projectId={query.get('project')} />; break;
    case 'data': page = <DataPage />; break;
    case 'team': page = path[1] ? <TeamRoomPage roomId={path[1]} /> : <TeamPage />; break;
    case 'blind': page = path[1] ? <BlindSessionPage sessionId={path[1]} /> : <BlindListPage />; break;
    default: page = <ProjectsPage />;
  }
  const navActive = section === 'formula' || section === 'plan' || section === 'compare' || section === 'import' ? 'formulas'
    : section === 'batch' ? 'bench' : section;

  return (
    <div className={`app${section === 'bench' && path[1] ? ' app-bench' : ''}`}>
      <a className="skip-link" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById('main')?.focus(); }}>{t('a11y.skip')}</a>
      <header className="top">
        <div className="brand">{t('app.name')}</div>
        <nav aria-label={t('a11y.mainNav')}>
          {NAV.map(([k, label]) => (
            <a key={k} href={`#/${k}`} className={navActive === k ? 'active' : ''} aria-current={navActive === k ? 'page' : undefined}>{t(label)}</a>
          ))}
          <a href="#/data" className={navActive === 'data' ? 'active' : ''}>{t('nav.data')}</a>
        </nav>
        <LabelLookup />
        <button className="help-btn" onClick={() => setTour(true)} title={t('tour.open')}>{t('tour.help')}</button>
        <select
          className="lang"
          aria-label={t('settings.language')}
          value={state.settings.locale}
          onChange={(e) => run((s) => ({ settings: { ...s.settings, locale: e.target.value } }))}
        >
          {LOCALES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
        </select>
      </header>
      <SaveIndicator />
      <main id="main" tabIndex={-1}>
        <PageBoundary key={window.location.hash} fallback={(e) => (
          <div className="page"><div className="warn-box">
            <p><strong>{t('crash.title')}</strong></p>
            <p>{t('crash.body')}</p>
            <pre className="small">{e.message}</pre>
            <div className="actions">
              <button onClick={() => go('projects')}>{t('nav.projects')}</button>
              <button onClick={() => go('data')}>{t('nav.data')}</button>
            </div>
          </div></div>
        )}>
          <Suspense fallback={<div className="page muted">{t('save.loading')}</div>}>{page}</Suspense>
        </PageBoundary>
      </main>
      {tour && <Tutorial onClose={() => setTour(false)} />}
      <Toasts items={toasts} onDismiss={dismiss} />
    </div>
  );
}
