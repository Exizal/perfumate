// Shared formula sessions through the user's own Supabase project. The journal itself stays
// local; only what people put into a shared session is sent. See supabase/schema.sql.
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { D, canon } from '../domain/decimal';
import { newLine } from '../domain/revisions';
import type { AmountMode, FormulaLine } from '../domain/types';

export const TEAM_CONFIG_KEY = 'mblj.team';

export interface TeamConfig { url: string; anonKey: string; displayName: string }

export interface Room { id: string; code: string; name: string; amount_mode: AmountMode; created_by: string; created_at: string; closed_at: string | null }
export interface RoomMember { room_id: string; user_id: string; display_name: string; joined_at: string }
export interface RoomLine {
  id: string; room_id: string; position: number; material_name: string; amount: string | null; strength: string | null; note: string;
  added_by: string; added_by_name: string; updated_by_name: string; created_at: string; updated_at: string;
}
export interface RoomEvent {
  id: number; room_id: string; at: string; actor: string | null; actor_name: string; kind: 'added' | 'changed' | 'removed';
  line_id: string | null; material_name: string; before: Record<string, string | null> | null; after: Record<string, string | null> | null;
}

export type TeamErrorCode = 'not_configured' | 'bad_url' | 'anon_disabled' | 'unknown_code' | 'offline' | 'schema_missing' | 'not_allowed' | 'other';
export class TeamError extends Error {
  constructor(public code: TeamErrorCode, detail?: string) { super(detail ?? code); }
}

export function getTeamConfig(): TeamConfig | null {
  try {
    const raw = localStorage.getItem(TEAM_CONFIG_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as TeamConfig;
    return c.url && c.anonKey ? c : null;
  } catch { return null; }
}

export function setTeamConfig(c: TeamConfig | null): void {
  try {
    if (c) localStorage.setItem(TEAM_CONFIG_KEY, JSON.stringify(c));
    else localStorage.removeItem(TEAM_CONFIG_KEY);
  } catch { /* storage unavailable: config lasts for this session only */ }
  client = null;
}

/** Accepts a project URL with or without https:// and trailing slashes. */
export function normalizeUrl(u: string): string {
  let s = u.trim().replace(/\/+$/, '');
  if (s && !/^https?:\/\//i.test(s)) s = `https://${s}`;
  try { const x = new URL(s); if (!/^https?:$/.test(x.protocol)) throw new Error(); return x.origin; } catch { throw new TeamError('bad_url'); }
}

let client: { key: string; c: Promise<SupabaseClient> } | null = null;

async function sb(): Promise<SupabaseClient> {
  const cfg = getTeamConfig();
  if (!cfg) throw new TeamError('not_configured');
  const key = `${cfg.url}|${cfg.anonKey}`;
  if (!client || client.key !== key) {
    client = {
      key,
      c: import('@supabase/supabase-js').then(({ createClient }) =>
        createClient(cfg.url, cfg.anonKey, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'mblj.team.auth' } })),
    };
  }
  const c = await client.c;
  const { data } = await c.auth.getSession();
  if (!data.session) {
    const { error } = await c.auth.signInAnonymously();
    if (error) throw mapError(error);
  }
  return c;
}

export async function currentUserId(): Promise<string> {
  const c = await sb();
  const { data } = await c.auth.getUser();
  return data.user?.id ?? '';
}

function mapError(e: unknown): TeamError {
  if (e instanceof TeamError) return e;
  const err = e as { message?: string; code?: string; status?: number; name?: string };
  const msg = err?.message ?? String(e);
  if (/anonymous sign-ins are disabled/i.test(msg)) return new TeamError('anon_disabled', msg);
  if (/unknown code/i.test(msg)) return new TeamError('unknown_code', msg);
  if (err?.code === '42P01' || err?.code === 'PGRST202' || err?.code === 'PGRST205' || /does not exist|could not find the (function|table)/i.test(msg)) return new TeamError('schema_missing', msg);
  if (err?.code === '42501' || /row-level security|permission denied/i.test(msg)) return new TeamError('not_allowed', msg);
  if (/failed to fetch|networkerror|load failed|fetch failed/i.test(msg) || err?.name === 'AuthRetryableFetchError') return new TeamError('offline', msg);
  return new TeamError('other', msg);
}

async function call<T>(f: (c: SupabaseClient) => PromiseLike<{ data: T | null; error: unknown }>): Promise<T> {
  try {
    const c = await sb();
    const { data, error } = await f(c);
    if (error) throw mapError(error);
    return data as T;
  } catch (e) { throw mapError(e); }
}

/** Checks the connection and that the tables exist. */
export async function testConnection(): Promise<void> {
  await call((c) => c.from('rooms').select('id').limit(1));
}

export async function createRoom(name: string, displayName: string, mode: AmountMode, lines: FormulaLine[] = []): Promise<Room> {
  const room = await call<Room>((c) => c.rpc('create_room', { p_name: name.trim(), p_display_name: displayName.trim(), p_amount_mode: mode }));
  const rows = lines.filter((l) => l.materialName.trim() || l.amount).map((l, i) => lineRow(room.id, i + 1, l));
  if (rows.length) await call((c) => c.from('room_lines').insert(rows));
  return room;
}

export async function joinRoom(code: string, displayName: string): Promise<Room> {
  return call<Room>((c) => c.rpc('join_room', { p_code: code, p_display_name: displayName.trim() }));
}

export async function myRooms(): Promise<Room[]> {
  return call<Room[]>((c) => c.from('rooms').select('*').is('closed_at', null).order('created_at', { ascending: false }));
}

export interface RoomSnapshot { room: Room; members: RoomMember[]; lines: RoomLine[]; events: RoomEvent[] }

export async function loadRoom(id: string): Promise<RoomSnapshot> {
  const [rooms, members, lines, events] = await Promise.all([
    call<Room[]>((c) => c.from('rooms').select('*').eq('id', id)),
    call<RoomMember[]>((c) => c.from('room_members').select('*').eq('room_id', id).order('joined_at')),
    call<RoomLine[]>((c) => c.from('room_lines').select('*').eq('room_id', id).order('position')),
    call<RoomEvent[]>((c) => c.from('room_events').select('*').eq('room_id', id).order('id', { ascending: false }).limit(200)),
  ]);
  if (!rooms[0]) throw new TeamError('not_allowed');
  return { room: rooms[0], members, lines, events: events.reverse() };
}

function lineRow(roomId: string, position: number, l: Partial<FormulaLine>) {
  return {
    room_id: roomId, position, material_name: (l.materialName ?? '').trim(),
    amount: l.amount ? canon(D(l.amount)) : null, strength: l.strength ? canon(D(l.strength)) : null, note: l.note ?? '',
  };
}

export async function addLine(roomId: string, position: number, l: Partial<FormulaLine>): Promise<RoomLine> {
  const rows = await call<RoomLine[]>((c) => c.from('room_lines').insert(lineRow(roomId, position, l)).select());
  return rows[0];
}

export type LinePatch = Partial<Pick<RoomLine, 'material_name' | 'amount' | 'strength' | 'note'>>;

export async function updateLine(id: string, patch: LinePatch): Promise<RoomLine> {
  const rows = await call<RoomLine[]>((c) => c.from('room_lines').update(patch).eq('id', id).select());
  return rows[0];
}

export async function removeLine(id: string): Promise<void> {
  await call((c) => c.from('room_lines').delete().eq('id', id));
}

export async function leaveRoom(roomId: string): Promise<void> {
  const uid = await currentUserId();
  await call((c) => c.from('room_members').delete().eq('room_id', roomId).eq('user_id', uid));
}

export interface PresencePerson { user_id: string; name: string }

/**
 * Live updates for one session: line inserts and edits, activity records (which also carry
 * removals, since delete notifications cannot be filtered by session), members and who is online.
 */
export async function subscribeRoom(roomId: string, me: PresencePerson, h: {
  line: (l: RoomLine) => void;
  event: (e: RoomEvent) => void;
  member: (m: RoomMember) => void;
  presence: (people: PresencePerson[]) => void;
  status: (s: 'live' | 'reconnecting') => void;
}): Promise<() => void> {
  const c = await sb();
  const filter = `room_id=eq.${roomId}`;
  const ch: RealtimeChannel = c.channel(`room:${roomId}`, { config: { presence: { key: me.user_id } } })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'room_lines', filter }, (p) => h.line(p.new as RoomLine))
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'room_lines', filter }, (p) => h.line(p.new as RoomLine))
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'room_events', filter }, (p) => h.event(p.new as RoomEvent))
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'room_members', filter }, (p) => h.member(p.new as RoomMember))
    .on('presence', { event: 'sync' }, () => {
      const st = ch.presenceState<PresencePerson>();
      const seen = new Map<string, PresencePerson>();
      for (const list of Object.values(st)) for (const p of list) seen.set(p.user_id, { user_id: p.user_id, name: p.name });
      h.presence([...seen.values()]);
    });
  ch.subscribe(async (s) => {
    if (s === 'SUBSCRIBED') { h.status('live'); await ch.track(me); }
    else if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT' || s === 'CLOSED') h.status('reconnecting');
  });
  return () => { void c.removeChannel(ch); };
}

// ---------- pure helpers ----------

/** Applies an incoming line to the list, keeping order by position. */
export function upsertLine(lines: RoomLine[], l: RoomLine): RoomLine[] {
  const i = lines.findIndex((x) => x.id === l.id);
  const next = i >= 0 ? lines.map((x) => (x.id === l.id ? l : x)) : [...lines, l];
  return next.sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at));
}

export function nextPosition(lines: RoomLine[]): number {
  return lines.reduce((m, l) => Math.max(m, l.position), 0) + 1;
}

/** Turns the shared lines into lines for a local draft. */
export function roomLinesToFormula(lines: RoomLine[]): FormulaLine[] {
  return lines.filter((l) => l.material_name.trim() || l.amount).map((l) => newLine({
    materialName: l.material_name, amount: l.amount, strength: l.strength,
    note: [l.note, l.added_by_name ? `(${l.added_by_name})` : ''].filter(Boolean).join(' '),
  }));
}

/** A stable colour slot 0-7 for a person, so everyone sees the same colour for the same person. */
export function personSlot(userId: string): number {
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  return h % 8;
}

/** What changed in an activity record, as field/before/after triples. */
export function eventChanges(e: RoomEvent): Array<{ field: string; before: string | null; after: string | null }> {
  if (e.kind !== 'changed' || !e.before || !e.after) return [];
  return Object.keys(e.after)
    .filter((k) => (e.before![k] ?? null) !== (e.after![k] ?? null))
    .map((k) => ({ field: k, before: e.before![k] ?? null, after: e.after![k] ?? null }));
}
