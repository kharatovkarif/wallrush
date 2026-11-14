---
name: report
description: One-shot health and growth report for WallRush — players per day, where new players come from, how many play a first game and come back, Premium sales, recent reviews, server errors. Use when the owner asks "как дела", "статистика", "что с игрой", "есть ли покупки", or before proposing improvements.
---

# WallRush report

Supabase project `ttmfcqmkdfbkweljrbrw` (MCP `mcp__Supabase__execute_sql`),
Railway via MCP `mcp__Railway__*`. Read-only: nothing here writes anywhere.
Times: the game counts days in Moscow time (UTC+3).

## Queries (run in parallel)

Players and games per day, last 9 days (permanent rollup):
```sql
select * from admin_days(current_date - 8, current_date) order by 1;
```
(`bucket` is days since 1970-01-01; 20770 = 13 Nov 2026.)

New players by source and day, 14 days — the drop of 10–11 Nov 2026 was
Instagram (`ig`), not Google:
```sql
with nd as (select (first_seen at time zone 'Europe/Moscow')::date d,
  coalesce(nullif(split_part(source, ':', 1), ''), 'direct') src, count(*) n
  from visitors where first_seen > now() - interval '14 days' group by 1,2)
select src, json_object_agg(to_char(d,'DD.MM'), n order by d) by_day, sum(n) total
from nd group by src order by total desc limit 10;
```

First game and coming back, by source (cohort 15→2 days ago):
```sql
select coalesce(nullif(split_part(source, ':', 1), ''), 'direct') src, count(*) n,
 round(100.0*count(*) filter (where games = 0)/count(*),1) zero_games,
 round(100.0*count(*) filter (where last_seen > first_seen + interval '1 day')/count(*),1) back_1d
from visitors where first_seen between now() - interval '15 days' and now() - interval '2 days'
group by 1 having count(*) > 100 order by n desc;
```
Baseline 14 Nov 2026: 25% never play a game (Google 9%, Facebook/Instagram
in-app ~45%); 15% come back next day, 3% after a week.

Premium:
```sql
select (select count(*) from profiles where premium_until > now()) premium_now,
 (select count(*) from premium_contracts where paid_until is null) opened_not_paid,
 (select json_agg(row_to_json(e)) from (select event_type, amount, currency, outcome, created_at
   from premium_events order by id desc limit 10) e) last_events,
 (select json_agg(row_to_json(h)) from (select at, status, reason from premium_hooks
   where reason <> 'sync_list' order by id desc limit 10) h) hooks;
```

Reviews with text, last 10 days (columns: stars, body, lang, hidden, reply):
```sql
select stars, lang, left(body, 200) body, created_at::date d, reply is not null replied
from reviews where created_at > now() - interval '10 days' and length(body) > 15
  and coalesce(hidden,false) = false order by stars, created_at desc limit 20;
```

Server: Railway logs for `[premium]`, `failed`, `error` in the last day, and
service metrics (RAM/CPU) — the owner pays for usage, so a climb matters.

## Writing it up

Short, in Russian, numbers in a small table, then what they mean and 2–3
concrete proposals. Say what is not known rather than guessing. Never put the
owner's name, email or country in anything that leaves the session.
