-- Im Supabase-Dashboard: SQL Editor -> einfügen -> Run
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  is_owner boolean not null default false,
  settings jsonb not null default '{}'
);
create unique index profiles_name_key on public.profiles (lower(name));

create table public.games (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null,
  updated timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.games enable row level security;

create policy "own profile read" on public.profiles for select using (auth.uid() = id);
create policy "own games all" on public.games for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Nur settings darf der Benutzer ändern, nie is_owner oder name.
revoke update on public.profiles from anon, authenticated;
grant update (settings) on public.profiles to authenticated;
create policy "own settings update" on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);

-- Profil automatisch beim Registrieren anlegen (is_owner immer false)
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name) values (new.id, new.raw_user_meta_data->>'name');
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Nachdem du dich einmal als Bela_Owner registriert hast, einmalig ausführen:
-- update public.profiles set is_owner = true where lower(name) = 'bela_owner';
