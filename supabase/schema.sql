-- Micro-Batch Lab Journal: shared formula sessions.
-- Run this once in your Supabase project (SQL editor), then enable anonymous sign-ins
-- (Authentication > Sign In / Providers > Allow anonymous sign-ins).
--
-- What is stored: session name, join code, member display names, and the formula lines
-- people add to the shared session. Nothing else from the journal leaves the device.
-- Access: only members of a session can read or change it. People become members by
-- entering the session's join code.


create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null check (char_length(name) between 1 and 120),
  amount_mode text not null default 'g' check (amount_mode in ('g', 'pct', 'parts')),
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  closed_at timestamptz
);

create table if not exists public.room_members (
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null,
  display_name text not null check (char_length(display_name) between 1 and 60),
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

create table if not exists public.room_lines (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  position double precision not null default 0,
  material_name text not null default '' check (char_length(material_name) <= 200),
  amount text check (amount is null or amount ~ '^[0-9]+(\.[0-9]+)?$'),
  strength text check (strength is null or strength ~ '^[0-9]+(\.[0-9]+)?$'),
  note text not null default '' check (char_length(note) <= 1000),
  added_by uuid not null default auth.uid(),
  added_by_name text not null default '',
  updated_by_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists room_lines_room on public.room_lines(room_id);

create table if not exists public.room_events (
  id bigint generated always as identity primary key,
  room_id uuid not null references public.rooms(id) on delete cascade,
  at timestamptz not null default now(),
  actor uuid,
  actor_name text not null default '',
  kind text not null,
  line_id uuid,
  material_name text not null default '',
  before jsonb,
  after jsonb
);
create index if not exists room_events_room on public.room_events(room_id, id);

-- Membership check used by every policy. security definer avoids policy recursion.
create or replace function public.is_room_member(r uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.room_members m where m.room_id = r and m.user_id = auth.uid());
$$;

create or replace function public.member_name(r uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select display_name from public.room_members m where m.room_id = r and m.user_id = auth.uid()), '');
$$;

-- Create a session and join it. Returns the new room.
create or replace function public.create_room(p_name text, p_display_name text, p_amount_mode text default 'g')
returns public.rooms language plpgsql security definer set search_path = public as $$
declare
  r public.rooms;
  c text;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  loop
    -- 8 characters from an alphabet without look-alikes (no 0/O, 1/I/L).
    c := (select string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + floor(random() * 31)::int, 1), '') from generate_series(1, 8));
    exit when not exists (select 1 from public.rooms where code = c);
  end loop;
  insert into public.rooms (code, name, amount_mode, created_by) values (c, p_name, p_amount_mode, auth.uid()) returning * into r;
  insert into public.room_members (room_id, user_id, display_name) values (r.id, auth.uid(), p_display_name);
  return r;
end $$;

-- Join with a code. Returns the room, or raises if the code is unknown or closed.
create or replace function public.join_room(p_code text, p_display_name text)
returns public.rooms language plpgsql security definer set search_path = public as $$
declare r public.rooms;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into r from public.rooms where code = upper(trim(p_code)) and closed_at is null;
  if not found then raise exception 'unknown code'; end if;
  insert into public.room_members (room_id, user_id, display_name) values (r.id, auth.uid(), p_display_name)
    on conflict (room_id, user_id) do update set display_name = excluded.display_name;
  return r;
end $$;

-- Stamp who added or changed a line, and write the activity record. Clients cannot
-- write room_events directly, so the activity log reflects what actually happened.
create or replace function public.room_lines_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.added_by := auth.uid();
    new.added_by_name := public.member_name(new.room_id);
    new.updated_by_name := new.added_by_name;
  elsif tg_op = 'UPDATE' then
    new.room_id := old.room_id;
    new.added_by := old.added_by;
    new.added_by_name := old.added_by_name;
    new.created_at := old.created_at;
    new.updated_by_name := public.member_name(new.room_id);
    new.updated_at := now();
  end if;
  return new;
end $$;

create or replace function public.room_lines_log() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into public.room_events (room_id, actor, actor_name, kind, line_id, material_name, after)
    values (new.room_id, auth.uid(), public.member_name(new.room_id), 'added', new.id, new.material_name,
      jsonb_build_object('amount', new.amount, 'strength', new.strength, 'note', new.note));
    return new;
  elsif tg_op = 'UPDATE' then
    if (old.material_name, old.amount, old.strength, old.note) is distinct from (new.material_name, new.amount, new.strength, new.note) then
      insert into public.room_events (room_id, actor, actor_name, kind, line_id, material_name, before, after)
      values (new.room_id, auth.uid(), public.member_name(new.room_id), 'changed', new.id, new.material_name,
        jsonb_build_object('material_name', old.material_name, 'amount', old.amount, 'strength', old.strength, 'note', old.note),
        jsonb_build_object('material_name', new.material_name, 'amount', new.amount, 'strength', new.strength, 'note', new.note));
    end if;
    return new;
  else
    insert into public.room_events (room_id, actor, actor_name, kind, line_id, material_name, before)
    values (old.room_id, auth.uid(), public.member_name(old.room_id), 'removed', old.id, old.material_name,
      jsonb_build_object('amount', old.amount, 'strength', old.strength, 'note', old.note));
    return old;
  end if;
end $$;

drop trigger if exists room_lines_stamp on public.room_lines;
create trigger room_lines_stamp before insert or update on public.room_lines for each row execute function public.room_lines_stamp();
drop trigger if exists room_lines_log on public.room_lines;
create trigger room_lines_log after insert or update or delete on public.room_lines for each row execute function public.room_lines_log();

alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.room_lines enable row level security;
alter table public.room_events enable row level security;

drop policy if exists rooms_read on public.rooms;
create policy rooms_read on public.rooms for select using (public.is_room_member(id));
drop policy if exists rooms_close on public.rooms;
create policy rooms_close on public.rooms for update using (created_by = auth.uid()) with check (created_by = auth.uid());

drop policy if exists members_read on public.room_members;
create policy members_read on public.room_members for select using (public.is_room_member(room_id));
drop policy if exists members_leave on public.room_members;
create policy members_leave on public.room_members for delete using (user_id = auth.uid());

drop policy if exists lines_read on public.room_lines;
create policy lines_read on public.room_lines for select using (public.is_room_member(room_id));
drop policy if exists lines_add on public.room_lines;
create policy lines_add on public.room_lines for insert with check (public.is_room_member(room_id));
drop policy if exists lines_edit on public.room_lines;
create policy lines_edit on public.room_lines for update using (public.is_room_member(room_id)) with check (public.is_room_member(room_id));
drop policy if exists lines_remove on public.room_lines;
create policy lines_remove on public.room_lines for delete using (public.is_room_member(room_id));

drop policy if exists events_read on public.room_events;
create policy events_read on public.room_events for select using (public.is_room_member(room_id));

grant execute on function public.create_room(text, text, text) to authenticated;
grant execute on function public.join_room(text, text) to authenticated;

-- Live updates.
do $$ begin
  begin alter publication supabase_realtime add table public.room_lines; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.room_events; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.room_members; exception when duplicate_object then null; end;
end $$;
