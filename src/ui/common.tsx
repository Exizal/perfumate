import { useEffect, useRef, useState, type ReactNode } from 'react';
import { parseUserNumber, useI18n } from '../i18n';

export function useRoute(): { path: string[]; query: URLSearchParams } {
  const read = () => {
    const h = window.location.hash.replace(/^#\/?/, '');
    const [p, q] = h.split('?');
    return { path: p ? p.split('/').map(decodeURIComponent) : [], query: new URLSearchParams(q ?? '') };
  };
  const [r, setR] = useState(read);
  useEffect(() => {
    const on = () => setR(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return r;
}

export function go(path: string): void {
  window.location.hash = path.startsWith('#') ? path : `#/${path.replace(/^\//, '')}`;
}

export function DemoBadge({ show = false }: { show?: boolean | undefined }) {
  const { t } = useI18n();
  if (!show) return null;
  return <span className="badge badge-demo" title={t('demo.tooltip')}>{t('demo.badge')}</span>;
}

export function StateBadge({ state }: { state: string }) {
  const { t } = useI18n();
  return <span className={`badge badge-${state}`}>{t(`state.${state}` as never)}</span>;
}

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Runs once per opening: focus moves in on open and back to the opener on close.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input, select, textarea, button.primary');
    first?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, []);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal${wide ? ' modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="ghost" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, hint, children, error }: { label: string; hint?: string; children: ReactNode; error?: string | null }) {
  return (
    <label className={`field${error ? ' field-error' : ''}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint && !error && <span className="field-hint">{hint}</span>}
      {error && <span className="field-err">{error}</span>}
    </label>
  );
}

/**
 * Decimal input. Shows the locale's decimal separator; accepts "." or ",".
 * Calls onValue with a canonical string, or null for blank (blank is not zero).
 */
export function DecimalInput({
  value, onValue, unit, placeholder, className, autoFocus, onEnter, disabled, ariaLabel, inputMode = 'decimal',
}: {
  value: string | null; onValue: (v: string | null) => void; unit?: string; placeholder?: string; className?: string;
  autoFocus?: boolean; onEnter?: () => void; disabled?: boolean; ariaLabel?: string; inputMode?: 'decimal' | 'numeric';
}) {
  const { toInput, t } = useI18n();
  const [text, setText] = useState(toInput(value));
  const [bad, setBad] = useState(false);
  const last = useRef(value);
  useEffect(() => {
    if (value !== last.current) { setText(toInput(value)); last.current = value; setBad(false); }
  }, [value, toInput]);
  const commit = (s: string) => {
    const p = parseUserNumber(s);
    if (!p.ok) { setBad(true); return; }
    setBad(false);
    last.current = p.value;
    onValue(p.value);
  };
  return (
    <span className={`dec-input${bad ? ' bad' : ''} ${className ?? ''}`}>
      <input
        type="text"
        inputMode={inputMode}
        value={text}
        placeholder={placeholder}
        autoFocus={autoFocus}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-invalid={bad}
        title={bad ? t('input.invalidNumber') : undefined}
        onChange={(e) => { setText(e.target.value); const p = parseUserNumber(e.target.value); if (p.ok) { setBad(false); last.current = p.value; onValue(p.value); } }}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { commit((e.target as HTMLInputElement).value); onEnter?.(); } }}
      />
      {unit && <span className="unit">{unit}</span>}
    </span>
  );
}

export function Toasts({ items, onDismiss }: { items: Array<{ id: number; kind: string; text: string }>; onDismiss: (id: number) => void }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((x) => (
        <div key={x.id} className={`toast toast-${x.kind}`} onClick={() => onDismiss(x.id)}>{x.text}</div>
      ))}
    </div>
  );
}

export function download(name: string, data: BlobPart, mime: string): void {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function useNow(intervalMs = 15000): Date {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
}

export function fromLocalInput(v: string): string {
  return new Date(v).toISOString();
}
