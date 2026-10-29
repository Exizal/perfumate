import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { gramsFromVolume, parseBalanceLine } from '../domain/units';
import { DecimalInput } from './common';

// Minimal Web Serial typing; the API exists in Chromium-based browsers and the desktop app.
interface SerialPortLike {
  open(o: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
}
interface SerialLike { requestPort(): Promise<SerialPortLike> }

function serial(): SerialLike | null {
  return (navigator as unknown as { serial?: SerialLike }).serial ?? null;
}

export function canReadBalance(): boolean {
  return typeof navigator !== 'undefined' && !!serial();
}

interface Reading { grams: string; stable: boolean; at: number }

/**
 * Reads lines a balance prints over a serial/USB connection. The reading is offered to the
 * user, never recorded on its own: the user confirms each addition.
 */
export function BalanceReader({ baudRate, disabled, onUse }: { baudRate: number; disabled: boolean; onUse: (grams: string, note: string) => void }) {
  const { t, grams } = useI18n();
  const [reading, setReading] = useState<Reading | null>(null);
  const [status, setStatus] = useState<'idle' | 'connected' | 'error'>('idle');
  const [error, setError] = useState('');
  const portRef = useRef<SerialPortLike | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<string> | null>(null);

  const disconnect = async () => {
    try { await readerRef.current?.cancel(); } catch { /* already closed */ }
    readerRef.current = null;
    try { await portRef.current?.close(); } catch { /* already closed */ }
    portRef.current = null;
    setStatus('idle');
  };
  useEffect(() => () => { void disconnect(); }, []);

  const connect = async () => {
    const api = serial();
    if (!api) return;
    try {
      const port = await api.requestPort();
      await port.open({ baudRate });
      portRef.current = port;
      setStatus('connected');
      setError('');
      const reader = port.readable!.pipeThrough(new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>).getReader();
      readerRef.current = reader;
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        const parts = buf.split(/\r?\n|\r/);
        buf = parts.pop() ?? '';
        for (const line of parts) {
          const r = parseBalanceLine(line);
          if (r) setReading({ ...r, at: Date.now() });
        }
      }
    } catch (e) {
      if ((e as Error)?.name !== 'NotFoundError') { setStatus('error'); setError(String((e as Error)?.message ?? e)); }
      else setStatus('idle');
    }
  };

  if (!canReadBalance()) return null;
  return (
    <div className="balance-reader">
      {status !== 'connected' ? (
        <button onClick={connect} disabled={disabled}>{t('balance.connect')}</button>
      ) : (
        <>
          <span className={`reading${reading?.stable ? '' : ' unstable'}`} aria-live="polite">
            {reading ? `${grams(reading.grams)} · ${reading.stable ? t('balance.stable') : t('balance.unstable')}` : t('balance.waiting')}
          </span>
          <button className="primary" disabled={disabled || !reading || !reading.stable || !(Number(reading.grams) > 0)}
            onClick={() => reading && onUse(reading.grams, t('balance.note'))}>{t('balance.useReading')}</button>
          <button className="link" onClick={disconnect}>{t('balance.disconnect')}</button>
        </>
      )}
      {status === 'error' && <span className="warn-text small">{t('balance.error', { e: error })}</span>}
      <span className="muted small">{t('balance.tareHint')}</span>
    </div>
  );
}

/** Converts a measured volume to grams using the material's recorded density. */
export function VolumeEntry({ density, disabled, onUse }: { density: string; disabled: boolean; onUse: (grams: string, note: string) => void }) {
  const { t, num, grams } = useI18n();
  const [ml, setMl] = useState<string | null>(null);
  const g = ml ? gramsFromVolume(ml, density) : null;
  return (
    <div className="volume-entry">
      <DecimalInput value={ml} onValue={setMl} unit="mL" ariaLabel={t('volume.ml')} disabled={disabled} />
      <span className="muted small">× {num(density)} g/mL = {g ? grams(g, 4) : '—'}</span>
      <button disabled={disabled || !g || !g.greaterThan(0)} onClick={() => {
        if (!g || !ml) return;
        onUse(g.toFixed(), t('volume.note', { ml, density }));
        setMl(null);
      }}>{t('volume.use')}</button>
    </div>
  );
}
