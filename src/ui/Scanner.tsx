import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { Modal } from './common';

interface Detector {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
}
type DetectorCtor = new (opts: { formats: string[] }) => Detector;

/** Camera label scanning where the browser provides BarcodeDetector (Chromium-based browsers). */
export function canScan(): boolean {
  return typeof window !== 'undefined' && 'BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia;
}

export function ScanModal({ onResult, onClose }: { onResult: (text: string) => void; onClose: () => void }) {
  const { t } = useI18n();
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let done = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (!video.current) return;
        video.current.srcObject = stream;
        await video.current.play();
        const Ctor = (window as unknown as { BarcodeDetector: DetectorCtor }).BarcodeDetector;
        const detector = new Ctor({ formats: ['qr_code'] });
        timer = setInterval(async () => {
          if (done || !video.current) return;
          try {
            const codes = await detector.detect(video.current);
            if (codes[0]?.rawValue && !done) { done = true; onResult(codes[0].rawValue); }
          } catch { /* frame not ready */ }
        }, 300);
      } catch (e) {
        setError(String(e instanceof Error ? e.message : e));
      }
    })();
    return () => {
      done = true;
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach((tr) => tr.stop());
    };
  }, [onResult]);

  return (
    <Modal title={t('scan.title')} onClose={onClose} footer={<button onClick={onClose}>{t('common.cancel')}</button>}>
      {error ? <p className="warn-box">{t('scan.error', { e: error })}</p> : <p className="muted small">{t('scan.hint')}</p>}
      <video ref={video} className="scan-video" muted playsInline />
    </Modal>
  );
}
