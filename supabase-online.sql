-- Online-Spiel: im Supabase-Dashboard -> SQL Editor -> einfügen -> Run (mehrfach ausführbar)

create table if not exists public.invites (
  id uuid primary key default gen_random_uuid(),
  from_id uuid not null references auth.users(id) on delete cascade,
  to_id uuid not null references auth.users(id) on delete cascade,
  from_name text not null,
  to_name text not null,
  created_at timestamptz not null default now(),
  unique (from_id, to_id)
);

create table if not exists public.online_games (
  id uuid primary key default gen_random_uuid(),
  white_id uuid not null references auth.users(id) on delete cascade,
  black_id uuid not null references auth.users(id) on delete cascade,
  white_name text not null,
  black_name text not null,
  data jsonb not null,
  turn text not null default 'w',
  status text not null default 'active',
  result text,
  reason text,
  draw_offer_by uuid,
  white_ack boolean not null default false,
  black_ack boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.timeouts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  until timestamptz not null
);

alter table public.invites enable row level security;
alter table public.online_games enable row level security;
alter table public.timeouts enable row level security;

-- Clients dürfen nur lesen (Teilnehmer); geschrieben wird ausschließlich über die Funktionen.
revoke all on public.invites from public, anon, authenticated;
revoke all on public.online_games from public, anon, authenticated;
revoke all on public.timeouts from public, anon, authenticated;
grant select on public.invites to authenticated;
grant select on public.online_games to authenticated;

drop policy if exists "invites participants read" on public.invites;
create policy "invites participants read" on public.invites
  for select to authenticated using (auth.uid() = from_id or auth.uid() = to_id);

drop policy if exists "online_games participants read" on public.online_games;
create policy "online_games participants read" on public.online_games
  for select to authenticated using (auth.uid() = white_id or auth.uid() = black_id);

-- Realtime (mit RLS und für DELETE-Events)
alter table public.invites replica identity full;
alter table public.online_games replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'invites') then
      alter publication supabase_realtime add table public.invites;
    end if;
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'online_games') then
      alter publication supabase_realtime add table public.online_games;
    end if;
  end if;
end $$;

-- Funktionen -----------------------------------------------------------

create or replace function public.list_players()
returns table(id uuid, name text)
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'Bitte zuerst anmelden';
  end if;
  delete from public.invites where created_at < now() - interval '24 hours';
  delete from public.online_games where status = 'finished' and updated_at < now() - interval '7 days';
  delete from public.timeouts where until < now();
  return query
    select p.id, p.name from public.profiles p
    where p.id <> auth.uid()
    order by lower(p.name), p.name;
end $$;

create or replace function public.send_invite(p_to uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  my_name text;
  other_name text;
  new_id uuid;
begin
  if me is null then
    raise exception 'Bitte zuerst anmelden';
  end if;
  if p_to is null then
    raise exception 'Spieler nicht gefunden';
  end if;
  if p_to = me then
    raise exception 'Du kannst dich nicht selbst einladen';
  end if;
  select name into my_name from public.profiles where id = me;
  select name into other_name from public.profiles where id = p_to;
  if my_name is null or other_name is null then
    raise exception 'Spieler nicht gefunden';
  end if;
  delete from public.invites where created_at < now() - interval '24 hours';
  if exists (select 1 from public.invites
             where (from_id = me and to_id = p_to) or (from_id = p_to and to_id = me)) then
    raise exception 'Es gibt schon eine offene Einladung';
  end if;
  insert into public.invites (from_id, to_id, from_name, to_name)
    values (me, p_to, my_name, other_name)
    returning invites.id into new_id;
  return new_id;
end $$;

create or replace function public.cancel_invite(p_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'Bitte zuerst anmelden';
  end if;
  delete from public.invites where id = p_id and from_id = auth.uid();
  if not found then
    raise exception 'Einladung nicht gefunden';
  end if;
end $$;

create or replace function public.decline_invite(p_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'Bitte zuerst anmelden';
  end if;
  delete from public.invites where id = p_id and to_id = auth.uid();
  if not found then
    raise exception 'Einladung nicht gefunden';
  end if;
end $$;

create or replace function public.accept_invite(p_id uuid, p_data jsonb)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  inv public.invites%rowtype;
  ban timestamptz;
  game_id uuid;
  sender_white boolean;
begin
  if me is null then
    raise exception 'Bitte zuerst anmelden';
  end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' or pg_column_size(p_data) > 500000 then
    raise exception 'Ungültiges Spiel';
  end if;
  select until into ban from public.timeouts where user_id = me;
  if ban is not null and ban > now() then
    raise exception 'gesperrt bis %', to_char(ban at time zone 'Europe/Vienna', 'HH24:MI');
  end if;
  select * into inv from public.invites
    where id = p_id and to_id = me and created_at >= now() - interval '24 hours'
    for update;
  if not found then
    raise exception 'Einladung nicht gefunden';
  end if;
  sender_white := random() < 0.5;
  insert into public.online_games (white_id, black_id, white_name, black_name, data, turn)
    values (
      case when sender_white then inv.from_id else inv.to_id end,
      case when sender_white then inv.to_id else inv.from_id end,
      case when sender_white then inv.from_name else inv.to_name end,
      case when sender_white then inv.to_name else inv.from_name end,
      p_data, 'w')
    returning online_games.id into game_id;
  delete from public.invites where id = inv.id;
  return game_id;
end $$;

create or replace function public.submit_state(
  p_id uuid, p_data jsonb, p_turn text, p_status text, p_result text, p_reason text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  g public.online_games%rowtype;
  my_color text;
  owner boolean;
begin
  if me is null then
    raise exception 'Bitte zuerst anmelden';
  end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' or pg_column_size(p_data) > 500000 then
    raise exception 'Ungültiges Spiel';
  end if;
  if p_turn is null or p_turn not in ('w', 'b') then
    raise exception 'Ungültiger Zug';
  end if;
  if p_status is null or p_status not in ('active', 'finished') then
    raise exception 'Ungültiger Zug';
  end if;
  if p_status = 'finished' and (p_result is null or p_result not in ('w', 'b', 'draw')) then
    raise exception 'Ungültiges Ergebnis';
  end if;
  select * into g from public.online_games where id = p_id for update;
  if not found or (g.white_id <> me and g.black_id <> me) then
    raise exception 'Partie nicht gefunden';
  end if;
  if g.status <> 'active' then
    raise exception 'Die Partie ist schon zu Ende';
  end if;
  my_color := case when g.white_id = me then 'w' else 'b' end;
  if g.turn <> my_color then
    select coalesce(is_owner, false) into owner from public.profiles where id = me;
    if not coalesce(owner, false) then
      raise exception 'Du bist nicht am Zug';
    end if;
  end if;
  update public.online_games set
    data = p_data,
    turn = p_turn,
    status = p_status,
    result = case when p_status = 'finished' then p_result else null end,
    reason = case when p_status = 'finished' then left(p_reason, 200) else null end,
    draw_offer_by = null,
    updated_at = now()
  where id = p_id;
end $$;

create or replace function public.resign(p_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  g public.online_games%rowtype;
begin
  if me is null then
    raise exception 'Bitte zuerst anmelden';
  end if;
  select * into g from public.online_games where id = p_id for update;
  if not found or (g.white_id <> me and g.black_id <> me) then
    raise exception 'Partie nicht gefunden';
  end if;
  if g.status <> 'active' then
    raise exception 'Die Partie ist schon zu Ende';
  end if;
  update public.online_games set
    status = 'finished',
    result = case when g.white_id = me then 'b' else 'w' end,
    reason = 'Aufgegeben',
    draw_offer_by = null,
    updated_at = now()
  where id = p_id;
end $$;

create or replace function public.offer_draw(p_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  g public.online_games%rowtype;
begin
  if me is null then
    raise exception 'Bitte zuerst anmelden';
  end if;
  select * into g from public.online_games where id = p_id for update;
  if not found or (g.white_id <> me and g.black_id <> me) then
    raise exception 'Partie nicht gefunden';
  end if;
  if g.status <> 'active' then
    raise exception 'Die Partie ist schon zu Ende';
  end if;
  update public.online_games set draw_offer_by = me where id = p_id;
end $$;

create or replace function public.answer_draw(p_id uuid, p_accept boolean)
returns void
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  g public.online_games%rowtype;
begin
  if me is null then
    raise exception 'Bitte zuerst anmelden';
  end if;
  select * into g from public.online_games where id = p_id for update;
  if not found or (g.white_id <> me and g.black_id <> me) then
    raise exception 'Partie nicht gefunden';
  end if;
  if g.status <> 'active' then
    raise exception 'Die Partie ist schon zu Ende';
  end if;
  if g.draw_offer_by is null or g.draw_offer_by = me then
    raise exception 'Es gibt kein Remis-Angebot für dich';
  end if;
  if coalesce(p_accept, false) then
    update public.online_games set
      status = 'finished', result = 'draw', reason = 'Remis vereinbart',
      draw_offer_by = null, updated_at = now()
    where id = p_id;
  else
    update public.online_games set draw_offer_by = null where id = p_id;
  end if;
end $$;

create or replace function public.claim_win(p_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  g public.online_games%rowtype;
  my_color text;
  other uuid;
begin
  if me is null then
    raise exception 'Bitte zuerst anmelden';
  end if;
  select * into g from public.online_games where id = p_id for update;
  if not found or (g.white_id <> me and g.black_id <> me) then
    raise exception 'Partie nicht gefunden';
  end if;
  if g.status <> 'active' then
    raise exception 'Die Partie ist schon zu Ende';
  end if;
  my_color := case when g.white_id = me then 'w' else 'b' end;
  other := case when g.white_id = me then g.black_id else g.white_id end;
  if g.turn = my_color then
    raise exception 'Du bist selbst am Zug';
  end if;
  if g.updated_at > now() - interval '3 minutes' then
    raise exception 'Es ist noch zu früh. Warte bitte etwas';
  end if;
  update public.online_games set
    status = 'finished', result = my_color, reason = 'Gegner war weg',
    draw_offer_by = null, updated_at = now()
  where id = p_id;
  insert into public.timeouts (user_id, until)
    values (other, now() + interval '5 minutes')
    on conflict (user_id) do update set until = excluded.until;
end $$;

create or replace function public.ack_game(p_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  g public.online_games%rowtype;
begin
  if me is null then
    raise exception 'Bitte zuerst anmelden';
  end if;
  select * into g from public.online_games where id = p_id for update;
  if not found or (g.white_id <> me and g.black_id <> me) then
    raise exception 'Partie nicht gefunden';
  end if;
  if g.status <> 'finished' then
    raise exception 'Die Partie läuft noch';
  end if;
  if g.white_id = me then
    g.white_ack := true;
  else
    g.black_ack := true;
  end if;
  if g.white_ack and g.black_ack then
    delete from public.online_games where id = p_id;
  else
    update public.online_games set white_ack = g.white_ack, black_ack = g.black_ack where id = p_id;
  end if;
end $$;

create or replace function public.my_timeout()
returns timestamptz
language plpgsql security definer set search_path = public as $$
declare
  t timestamptz;
begin
  if auth.uid() is null then
    raise exception 'Bitte zuerst anmelden';
  end if;
  select until into t from public.timeouts where user_id = auth.uid() and until > now();
  return t;
end $$;

-- Nur angemeldete Spieler dürfen die Funktionen aufrufen
revoke all on function public.list_players() from public, anon;
revoke all on function public.send_invite(uuid) from public, anon;
revoke all on function public.cancel_invite(uuid) from public, anon;
revoke all on function public.decline_invite(uuid) from public, anon;
revoke all on function public.accept_invite(uuid, jsonb) from public, anon;
revoke all on function public.submit_state(uuid, jsonb, text, text, text, text) from public, anon;
revoke all on function public.resign(uuid) from public, anon;
revoke all on function public.offer_draw(uuid) from public, anon;
revoke all on function public.answer_draw(uuid, boolean) from public, anon;
revoke all on function public.claim_win(uuid) from public, anon;
revoke all on function public.ack_game(uuid) from public, anon;
revoke all on function public.my_timeout() from public, anon;

grant execute on function public.list_players() to authenticated;
grant execute on function public.send_invite(uuid) to authenticated;
grant execute on function public.cancel_invite(uuid) to authenticated;
grant execute on function public.decline_invite(uuid) to authenticated;
grant execute on function public.accept_invite(uuid, jsonb) to authenticated;
grant execute on function public.submit_state(uuid, jsonb, text, text, text, text) to authenticated;
grant execute on function public.resign(uuid) to authenticated;
grant execute on function public.offer_draw(uuid) to authenticated;
grant execute on function public.answer_draw(uuid, boolean) to authenticated;
grant execute on function public.claim_win(uuid) to authenticated;
grant execute on function public.ack_game(uuid) to authenticated;
grant execute on function public.my_timeout() to authenticated;
