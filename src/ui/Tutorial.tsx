import { useEffect, useState } from 'react';
import { useI18n, type TKey } from '../i18n';
import { go } from './common';

export const TUTORIAL_KEY = 'mblj.tutorialDone';

/** Each step opens its screen behind the card so the user sees what is being described. */
const STEPS: Array<{ id: string; route: string | null }> = [
  { id: 'welcome', route: null },
  { id: 'projects', route: 'projects' },
  { id: 'formulas', route: 'formulas' },
  { id: 'clickable', route: null },
  { id: 'bench', route: 'bench' },
  { id: 'journal', route: 'journal' },
  { id: 'team', route: 'team' },
  { id: 'data', route: 'data' },
];

export function tutorialSeen(): boolean {
  try { return localStorage.getItem(TUTORIAL_KEY) === '1'; } catch { return true; }
}

export function Tutorial({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [i, setI] = useState(0);
  const step = STEPS[i];
  const last = i === STEPS.length - 1;
  const finish = () => { try { localStorage.setItem(TUTORIAL_KEY, '1'); } catch { /* ignore */ } onClose(); };
  useEffect(() => { if (step.route) go(step.route); }, [step.route]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish();
      else if (e.key === 'ArrowRight' && !last) setI(i + 1);
      else if (e.key === 'ArrowLeft' && i > 0) setI(i - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  return (
    <div className="tour" role="dialog" aria-modal="false" aria-labelledby="tour-title">
      <div className="tour-head">
        <span className="muted small">{t('tour.progress', { n: i + 1, total: STEPS.length })}</span>
        <button className="link" onClick={finish}>{t('tour.skip')}</button>
      </div>
      <h2 id="tour-title">{t(`tour.${step.id}_title` as TKey)}</h2>
      <p>{t(`tour.${step.id}_body` as TKey)}</p>
      <div className="tour-dots" aria-hidden="true">{STEPS.map((s, k) => <span key={s.id} className={k === i ? 'on' : ''} />)}</div>
      <div className="tour-foot">
        <button onClick={() => setI(i - 1)} disabled={i === 0}>{t('tour.back')}</button>
        {last
          ? <button className="primary" onClick={finish} autoFocus>{t('tour.done')}</button>
          : <button className="primary" onClick={() => setI(i + 1)} autoFocus>{t('tour.next')}</button>}
      </div>
    </div>
  );
}
