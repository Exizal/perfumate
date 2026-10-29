export function uid(prefix = ''): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  const raw = c?.randomUUID ? c.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return prefix ? `${prefix}_${raw}` : raw;
}

export function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

export function revisionCode(projectCode: string, n: number): string {
  return `${projectCode}-F${pad3(n)}`;
}

export function batchCode(projectCode: string, n: number): string {
  return `${projectCode}-B${pad3(n)}`;
}

export function nowISO(): string {
  return new Date().toISOString();
}

/** QR payload format. Contains the stable batch id plus the human code. */
export function labelPayload(batchId: string, code: string): string {
  return `MBLJ:batch:${batchId}:${code}`;
}

export function parseLabelPayload(text: string): { batchId: string | null; code: string | null } {
  const t = text.trim();
  const m = /^MBLJ:batch:([^:]+):(.+)$/.exec(t);
  if (m) return { batchId: m[1], code: m[2] };
  return { batchId: null, code: t.toUpperCase() };
}
