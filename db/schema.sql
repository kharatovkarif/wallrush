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

-- ---------------------------------------------------------------------------
-- Friends. Adding someone you have just played is mutual and immediate — you
-- were both there. Finding a stranger by nickname goes through friend_requests
-- below, so a name cannot be added to by anyone who can spell it.
-- Only between accounts — a guest is a different person after clearing the
-- browser, so there is nobody on the other side of the friendship tomorrow.
create table if not exists public.friends (
  user_id   uuid not null references public.profiles(id) on delete cascade,
  friend_id uuid not null references public.profiles(id) on delete cascade,
  added_at  timestamptz not null default now(),
  primary key (user_id, friend_id),
  check (user_id <> friend_id)
);
create index if not exists friends_user_idx on public.friends (user_id);
alter table public.friends enable row level security;

create or replace function public.friend_add(a uuid, b uuid)
returns void language sql security definer set search_path = public as $$
  insert into public.friends (user_id, friend_id) values (a, b), (b, a)
  on conflict do nothing
$$;

create or replace function public.friend_remove(a uuid, b uuid)
returns void language sql security definer set search_path = public as $$
  delete from public.friends
  where (user_id = a and friend_id = b) or (user_id = b and friend_id = a)
$$;

-- Online status is not here: the game server is the only thing that knows who
-- is connected, so it adds that to each row before sending the list out.
create or replace function public.friend_list(a uuid)
returns table (id uuid, nick text, points integer, streak integer,
               wins integer, losses integer, added_at timestamptz)
language sql security definer set search_path = public stable as $$
  select p.id, p.nick, p.points, p.streak, p.wins, p.losses, f.added_at
  from public.friends f
  join public.profiles p on p.id = f.friend_id
  where f.user_id = a
  order by p.points desc nulls last
  limit 200
$$;

revoke all on function public.friend_add(uuid, uuid) from anon, authenticated;
revoke all on function public.friend_remove(uuid, uuid) from anon, authenticated;
revoke all on function public.friend_list(uuid) from anon, authenticated;

-- ---------- reviews ----------
-- A star out of five from a player, and words if they felt like writing any.
-- Four and five are shown at /reviews, the page search engines read; one to
-- three stay private and appear only in the admin page, because a low rating
-- is a bug report addressed to us rather than something to hang on the wall.
create table if not exists reviews (
  id          bigserial primary key,
  device_id   text not null,
  user_id     uuid,
  nick        text,
  stars       smallint not null check (stars between 1 and 5),
  body        text,
  lang        text,
  is_public   boolean not null default false,   -- 4-5 stars: their words are printed
  hidden      boolean not null default false,   -- moderation, or a foul word caught on the way in
  likes       int not null default 0,
  reply       text,                             -- the owner's answer, shown under the review
  reply_at    timestamptz
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- one review per person; sending another replaces it
create unique index if not exists reviews_device_uq on reviews (device_id);
create index if not exists reviews_public_idx on reviews (created_at desc) where is_public and not hidden;
create index if not exists reviews_recent_idx on reviews (created_at desc);

-- ---------- task of the day ----------
-- One row per player per local day: which task they were given, how far along
-- they are, and whether the reward has already been paid. The task itself is
-- not stored anywhere — it is decided by the date alone (public/js/daily.js),
-- so server and client always agree on what today's task is.
create table if not exists daily_progress (
  key        text not null,      -- 'u:<user id>' for an account, 'd:<device>' for a guest
  day        date not null,      -- the player's own local day, as the streak counts it
  task_id    text not null,
  progress   int  not null default 0,
  done       boolean not null default false,
  rewarded   boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (key, day)
);

create index if not exists daily_progress_day_idx on daily_progress (day);

-- Adds to a player's progress and reports whether this call is the one that
-- finished the task, so the reward is paid exactly once however many matches
-- land at the same moment.
create or replace function daily_bump(k text, d date, tid text, inc int, tgt int)
returns table(progress int, done boolean, awarded_now boolean)
language plpgsql
as $$
declare
  p int; dn boolean; rw boolean;
begin
  insert into daily_progress (key, day, task_id, progress, done, rewarded, updated_at)
  values (k, d, tid, least(inc, tgt), inc >= tgt, false, now())
  on conflict (key, day) do update set
    -- a different task means the day's task changed under them: start over
    progress = case when daily_progress.task_id = excluded.task_id
                    then least(daily_progress.progress + inc, tgt) else least(inc, tgt) end,
    done     = case when daily_progress.task_id = excluded.task_id
                    then (daily_progress.progress + inc) >= tgt else inc >= tgt end,
    rewarded = case when daily_progress.task_id = excluded.task_id
                    then daily_progress.rewarded else false end,
    task_id  = excluded.task_id,
    updated_at = now()
  returning daily_progress.progress, daily_progress.done, daily_progress.rewarded
  into p, dn, rw;

  if dn and not rw then
    update daily_progress set rewarded = true where daily_progress.key = k and daily_progress.day = d;
    awarded_now := true;
  else
    awarded_now := false;
  end if;

  progress := p;
  done := dn;
  return next;
end $$;

-- ---------------------------------------------------------------------------
-- Friend requests: only for people found by name, never for an opponent you
-- have just played.
create table if not exists public.friend_requests (
  from_id uuid not null references public.profiles(id) on delete cascade,
  to_id   uuid not null references public.profiles(id) on delete cascade,
  at      timestamptz not null default now(),
  primary key (from_id, to_id),
  check (from_id <> to_id)
);
create index if not exists friend_requests_to_idx on public.friend_requests (to_id);
alter table public.friend_requests enable row level security;

-- Exact match, case-insensitive: a search that returns lists of half-matching
-- strangers is a way to pester people, not a way to find the one you just met.
create or replace function public.friend_find(q text, me uuid)
returns table (id uuid, nick text, points integer, streak integer, already boolean, pending boolean)
language sql security definer set search_path = public stable as $$
  select p.id, p.nick, p.points, p.streak,
         exists (select 1 from public.friends f where f.user_id = me and f.friend_id = p.id) as already,
         exists (select 1 from public.friend_requests r
                 where (r.from_id = me and r.to_id = p.id) or (r.from_id = p.id and r.to_id = me)) as pending
  from public.profiles p
  where lower(p.nick) = lower(trim(q)) and p.id <> me
  limit 1
$$;

create or replace function public.friend_request_add(a uuid, b uuid)
returns void language sql security definer set search_path = public as $$
  insert into public.friend_requests (from_id, to_id)
  select a, b
  where not exists (select 1 from public.friends f where f.user_id = a and f.friend_id = b)
  on conflict do nothing
$$;

-- Both directions go: two people who asked each other are simply friends.
create or replace function public.friend_request_accept(me uuid, other uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from public.friend_requests
   where (from_id = other and to_id = me) or (from_id = me and to_id = other);
  insert into public.friends (user_id, friend_id) values (me, other), (other, me)
  on conflict do nothing;
end $$;

create or replace function public.friend_request_decline(me uuid, other uuid)
returns void language sql security definer set search_path = public as $$
  delete from public.friend_requests where from_id = other and to_id = me
$$;

create or replace function public.friend_requests_in(me uuid)
returns table (id uuid, nick text, points integer, streak integer, at timestamptz)
language sql security definer set search_path = public stable as $$
  select p.id, p.nick, p.points, p.streak, r.at
  from public.friend_requests r
  join public.profiles p on p.id = r.from_id
  where r.to_id = me
  order by r.at desc
  limit 50
$$;

create or replace function public.friend_count(me uuid)
returns integer language sql security definer set search_path = public stable as $$
  select count(*)::int from public.friends where user_id = me
$$;

revoke all on function public.friend_find(text, uuid) from anon, authenticated;
revoke all on function public.friend_request_add(uuid, uuid) from anon, authenticated;
revoke all on function public.friend_request_accept(uuid, uuid) from anon, authenticated;
revoke all on function public.friend_request_decline(uuid, uuid) from anon, authenticated;
revoke all on function public.friend_requests_in(uuid) from anon, authenticated;
revoke all on function public.friend_count(uuid) from anon, authenticated;

-- One like per person per review, so the count means something.
create table if not exists review_likes (
  review_id bigint not null references reviews(id) on delete cascade,
  device_id text not null,
  at timestamptz not null default now(),
  primary key (review_id, device_id)
);

-- Tapping again takes the like back. The count on the review is kept in step
-- inside the same call, so the two can never drift apart.
create or replace function review_like(rid bigint, dev text)
returns table(likes int, liked boolean)
language plpgsql as $$
declare had boolean;
begin
  select exists (select 1 from review_likes l where l.review_id = rid and l.device_id = dev) into had;
  if had then
    delete from review_likes l where l.review_id = rid and l.device_id = dev;
  else
    insert into review_likes (review_id, device_id) values (rid, dev) on conflict do nothing;
  end if;
  update reviews r
     set likes = (select count(*) from review_likes l where l.review_id = rid)
   where r.id = rid
  returning r.likes into likes;
  liked := not had;
  return next;
end $$;

-- ---------- advertising ----------
-- Yesterday by timezone, for the numbers on the advertising page: a day that
-- has finished, counted from the same statistics the owner reads.
create or replace function ads_day_stats(d date)
returns table(tz text, people bigint, games bigint)
language sql stable as $$
  select coalesce(v.tz, '') as tz,
         count(*)::bigint as people,
         coalesce(sum(vd.games), 0)::bigint as games
  from visitor_days vd
  join visitors v on v.device_id = vd.device_id
  where vd.day = d
  group by 1
$$;

-- Someone who wants to advertise leaves a way to reach them. No payment here:
-- there is nothing to take money with yet, and a dead pay button would lose
-- the enquiry as well as the payment.
create table if not exists ad_requests (
  id         bigserial primary key,
  pack       text,
  contact    text not null,
  about      text,
  lang       text,
  device_id  text,
  handled    boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists ad_requests_new_idx on ad_requests (created_at desc);
