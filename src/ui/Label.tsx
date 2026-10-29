import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { labelPayload } from '../domain/ids';
import type { Batch, DataState } from '../domain/types';
import { batchActualTotal } from '../domain/batch';
import { canon } from '../domain/decimal';
import { download } from './common';

export interface LabelData {
  code: string;
  project: string;
  revision: string;
  date: string;
  mass: string;
  payload: string;
  demo: boolean;
}

export function labelData(state: DataState, batch: Batch): LabelData {
  const date = (batch.completedAt ?? batch.startedAt).slice(0, 10);
  return {
    code: batch.code,
    project: state.projects[batch.projectId]?.name ?? '',
    revision: batch.revisionCode,
    date,
    mass: `${canon(batchActualTotal(state, batch).toDecimalPlaces(3))} g`,
    payload: labelPayload(batch.id, batch.code),
    demo: !!batch.demo,
  };
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 50 x 25 mm label as SVG: human-readable batch ID first; QR is optional. */
export async function labelSvg(d: LabelData, withQr: boolean): Promise<string> {
  let qr = '';
  if (withQr) {
    const seg = QRCode.create(d.payload, { errorCorrectionLevel: 'M' });
    const n = seg.modules.size;
    const size = 21;
    const cell = size / n;
    const rects: string[] = [];
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      if (seg.modules.get(x, y)) rects.push(`<rect x="${(27.5 + x * cell).toFixed(3)}" y="${(2 + y * cell).toFixed(3)}" width="${cell.toFixed(3)}" height="${cell.toFixed(3)}"/>`);
    }
    qr = `<g fill="#000">${rects.join('')}</g>`;
  }
  const w = withQr ? 26 : 46;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="50mm" height="25mm" viewBox="0 0 50 25">
<rect width="50" height="25" fill="#fff"/>
<g font-family="Arial, Helvetica, sans-serif" fill="#000">
<text x="2" y="7" font-size="5.2" font-weight="700" textLength="${Math.min(w, d.code.length * 3.2)}">${esc(d.code)}</text>
<text x="2" y="11.5" font-size="2.6">${esc(d.project.slice(0, 22))}</text>
<text x="2" y="15" font-size="2.6">${esc(d.revision)} · ${esc(d.mass)}</text>
<text x="2" y="18.5" font-size="2.6">${esc(d.date)}</text>
${d.demo ? '<text x="2" y="22.5" font-size="2.4" font-weight="700">DEMO DATA</text>' : ''}
</g>${qr}</svg>`;
}

export function LabelPreview({ data, withQr }: { data: LabelData; withQr: boolean }) {
  const [svg, setSvg] = useState('');
  useEffect(() => { labelSvg(data, withQr).then(setSvg); }, [data, withQr]);
  return <div className="label-preview" dangerouslySetInnerHTML={{ __html: svg }} />;
}

export async function printLabel(data: LabelData, withQr: boolean): Promise<void> {
  const svg = await labelSvg(data, withQr);
  const w = window.open('', '_blank', 'width=420,height=300');
  if (!w) {
    // Pop-up blocked: fall back to a download the user can print.
    download(`${data.code}-label.svg`, svg, 'image/svg+xml');
    return;
  }
  w.document.write(`<!doctype html><html><head><title>${esc(data.code)}</title><style>@page{size:50mm 25mm;margin:0}html,body{margin:0}svg{display:block}</style></head><body>${svg}<script>window.onload=function(){window.print();}</script></body></html>`);
  w.document.close();
}

export async function downloadLabel(data: LabelData, withQr: boolean): Promise<void> {
  download(`${data.code}-label.svg`, await labelSvg(data, withQr), 'image/svg+xml');
}
