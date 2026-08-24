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

-- ---------------------------------------------------------------------------
-- Analytics rollup for the /admin dashboard.
--
-- "How many people came in this window" used to be read off visitors.last_seen,
-- but that column only ever holds a person's MOST RECENT visit, so every past
-- window silently dropped everyone who came back later — yesterday reported
-- 2855 people when the truth was 4052. Counting distinct devices straight out
-- of visit_log is correct but takes ~7.7s over 30 days, far too slow for a page
-- that refreshes every minute.
--
-- visitor_days is one row per device per MSK day: ~4k rows/day instead of ~46k,
-- 19 MB instead of 288 MB, and every window becomes an index scan of a small
-- table. It is also permanent history — visit_log gets trimmed, this does not.
create table if not exists public.visitor_days (
  day       date not null,
  device_id text not null,
  games     integer not null default 0,
  primary key (day, device_id)
);
create index if not exists visitor_days_day_idx on public.visitor_days (day);
alter table public.visitor_days enable row level security;

-- Maintained by the log itself, so no application code can forget to write it.
-- Wrapped in an exception block: statistics must never be able to take the site
-- down, so a failed rollup is swallowed and the visit is still recorded.
create or replace function public.visit_log_rollup() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  begin
    insert into public.visitor_days (day, device_id, games)
    values ((new.at at time zone 'Europe/Moscow')::date, new.device_id,
            case when new.kind = 'game' then 1 else 0 end)
    on conflict (day, device_id) do update
      set games = visitor_days.games + case when new.kind = 'game' then 1 else 0 end;
  exception when others then
    null;
  end;
  return new;
end $$;

drop trigger if exists visit_log_rollup_t on public.visit_log;
create trigger visit_log_rollup_t after insert on public.visit_log
  for each row execute function public.visit_log_rollup();

-- backfill (safe to re-run)
insert into public.visitor_days (day, device_id, games)
select (at at time zone 'Europe/Moscow')::date, device_id,
       count(*) filter (where kind = 'game')
from public.visit_log group by 1, 2
on conflict (day, device_id) do update set games = greatest(visitor_days.games, excluded.games);

-- All four dashboard numbers for one window in a single round trip. A window
-- that snaps to MSK midnights is answered from the daily rollup; a partial one
-- ("today so far", "yesterday up to this hour") falls back to the raw log.
create or replace function public.admin_period_stats(from_ts timestamptz, to_ts timestamptz)
returns table (new_people bigint, active bigint, games bigint, humans bigint)
language plpgsql security definer set search_path = public stable as $$
declare
  d0 date := (from_ts at time zone 'Europe/Moscow')::date;
  d1 date := (to_ts   at time zone 'Europe/Moscow')::date;
  whole_days boolean :=
    from_ts = (d0::timestamp at time zone 'Europe/Moscow') and
    to_ts   = (d1::timestamp at time zone 'Europe/Moscow');
begin
  if whole_days then
    select coalesce(count(distinct vd.device_id), 0), coalesce(sum(vd.games), 0)
      into active, games
      from public.visitor_days vd where vd.day >= d0 and vd.day < d1;
  else
    select coalesce(count(distinct vl.device_id), 0),
           coalesce(count(*) filter (where vl.kind = 'game'), 0)
      into active, games
      from public.visit_log vl where vl.at >= from_ts and vl.at < to_ts;
  end if;

  select count(*) into new_people from public.visitors v
    where v.first_seen >= from_ts and v.first_seen < to_ts;
  select count(*) into humans from public.human_matches hm
    where hm.at >= from_ts and hm.at < to_ts;
  return next;
end $$;
revoke all on function public.admin_period_stats(timestamptz, timestamptz) from anon, authenticated;

-- The first day with any history, so the dashboard can refuse to print a
-- percentage against a window that predates the data instead of inventing one.
create or replace function public.admin_data_start() returns date
language sql security definer set search_path = public stable as $$
  select min(day) from public.visitor_days $$;
revoke all on function public.admin_data_start() from anon, authenticated;

-- Per-day people and games from the permanent rollup. visit_log now keeps only
-- 7 days of raw events (at ~90k games/day, 60 days of them filled the whole
-- 500 MB database), so the Дни section reads its history from here instead.
create or replace function public.admin_days(from_day date, to_day date)
returns table (bucket integer, people bigint, games bigint)
language sql security definer set search_path = public stable as $$
  select (vd.day - date '1970-01-01')::integer as bucket,
         count(distinct vd.device_id)::bigint  as people,
         coalesce(sum(vd.games), 0)::bigint    as games
  from public.visitor_days vd
  where vd.day >= from_day and vd.day <= to_day
  group by 1
  order by 1
$$;
revoke all on function public.admin_days(date, date) from anon, authenticated;

-- visits per day as well as games, so one person's day-by-day history survives
-- the 7-day trim of the raw log the same way their games already do.
alter table public.visitor_days add column if not exists visits integer not null default 0;

create or replace function public.visit_log_rollup() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  begin
    insert into public.visitor_days (day, device_id, games, visits)
    values ((new.at at time zone 'Europe/Moscow')::date, new.device_id,
            case when new.kind = 'game'  then 1 else 0 end,
            case when new.kind = 'visit' then 1 else 0 end)
    on conflict (day, device_id) do update
      set games  = visitor_days.games  + case when new.kind = 'game'  then 1 else 0 end,
          visits = visitor_days.visits + case when new.kind = 'visit' then 1 else 0 end;
  exception when others then
    null;   -- statistics must never be able to take the site down
  end;
  return new;
end $$;

-- Lifetime figures that do not depend on the raw log. "Games for all time" was
-- counted straight out of visit_log, which now keeps only 7 days: it read
-- 244,777 when the real figure was 1,639,335.
create or replace function public.admin_totals()
returns table (people bigint, games bigint, humans bigint, installs bigint, regs bigint)
language sql security definer set search_path = public stable as $$
  select (select count(*) from public.visitors),
         (select coalesce(sum(games), 0) from public.visitor_days),
         (select count(*) from public.human_matches),
         (select count(*) from public.visitors where installed_at is not null),
         (select count(*) from public.visitors where user_id is not null)
$$;
revoke all on function public.admin_totals() from anon, authenticated;

-- One person's day-by-day history, from the permanent rollup.
create or replace function public.admin_person_days(dev text)
returns table (day date, visits integer, games integer)
language sql security definer set search_path = public stable as $$
  select vd.day, vd.visits, vd.games
  from public.visitor_days vd
  where vd.device_id = dev
  order by vd.day desc
  limit 400
$$;
revoke all on function public.admin_person_days(text) from anon, authenticated;
