-- WallRush database schema (Supabase / PostgreSQL)
-- Accounts are handled by Supabase Auth (auth.users).
-- profiles: public game identity + stats for registered players.

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  nick text not null,
  wins integer not null default 0,
  losses integer not null default 0,
  created_at timestamptz not null default now()
);

-- case-insensitive nickname uniqueness
create unique index if not exists profiles_nick_unique on public.profiles (lower(nick));

alter table public.profiles enable row level security;

-- profiles are written only by the backend (service key bypasses RLS);
-- allow public read so nothing breaks if a client reads directly.
drop policy if exists "profiles are readable by everyone" on public.profiles;
create policy "profiles are readable by everyone"
  on public.profiles for select using (true);

-- atomic stats increment used by the game server
create or replace function public.add_result(uid uuid, is_win boolean)
returns void
language sql
security definer
set search_path = public
as $$
  update public.profiles
  set wins = wins + (case when is_win then 1 else 0 end),
      losses = losses + (case when is_win then 0 else 1 end)
  where id = uid;
$$;
