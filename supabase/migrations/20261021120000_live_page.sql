-- Live Scoring page (#live): scoreboard, matchup detail, points breakdown, scoring-play feed.
-- Public read (no sign-in to watch). Only the Edge Function b5-live talks to ESPN; browsers
-- read these tables and subscribe to Supabase Realtime on score_weeks (one row per live pass).

-- 1. Points breakdown: the engine's score lines, described (src/scoring/explain.ts), stored
--    with every player score so the page never recalculates.
alter table public.player_scores add column lines jsonb not null default '[]';

-- 2. Game clock for the NFL strip (from ESPN's scoreboard, written by the live scorer).
alter table public.nfl_games
  add column period smallint,
  add column clock text,
  add column status_detail text,             -- ESPN short detail, e.g. "3rd 4:12", "Halftime", "Final/OT"
  add column updated_at timestamptz;

-- 3. Scoring-play feed: every live change in a player's points, with the lines that changed
--    and the game clock at the time. Written by a trigger on player_scores (no extra reads by
--    the live scorer). Final (nflverse) rewrites aren't plays and aren't logged.
create table public.score_events (
  id bigint generated always as identity primary key,
  season int not null,
  week int not null check (week between 1 and 18),
  player_id text not null references public.nfl_players (id),
  game_key text,
  at timestamptz not null default now(),
  period smallint,
  clock text,
  status_detail text,
  delta numeric(6, 2) not null,              -- change in the player's points
  points numeric(6, 2) not null,             -- his points after the play
  lines jsonb not null default '[]'          -- [{stat, delta, text}] lines that changed
);
create index score_events_week_idx on public.score_events (season, week, at desc);
alter table public.score_events enable row level security;
create policy "public read" on public.score_events for select to anon, authenticated using (true);
revoke all on public.score_events from anon, authenticated;
grant select on public.score_events to anon, authenticated;
grant all on public.score_events to service_role;

create function private.log_score_event() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  old_lines jsonb := case when tg_op = 'UPDATE' then old.lines else '[]'::jsonb end;
  old_pts numeric := case when tg_op = 'UPDATE' then old.points else 0 end;
  changed jsonb;
  g record;
begin
  if new.source <> 'live' or (tg_op = 'UPDATE' and old.source <> 'live') or new.points = old_pts then
    return new;
  end if;
  -- Per stat: points before and after, and the line texts that are new (or gone).
  with n as (
    select l->>'stat' as stat, sum((l->>'points')::numeric) as pts,
           string_agg(l->>'text', '; ') filter (where not old_lines @> jsonb_build_array(l)) as txt
    from jsonb_array_elements(new.lines) l group by 1
  ), o as (
    select l->>'stat' as stat, sum((l->>'points')::numeric) as pts,
           string_agg(l->>'text', '; ') filter (where not new.lines @> jsonb_build_array(l)) as txt
    from jsonb_array_elements(old_lines) l group by 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'stat', coalesce(n.stat, o.stat),
           'delta', coalesce(n.pts, 0) - coalesce(o.pts, 0),
           'text', coalesce(n.txt, 'Taken away: ' || o.txt, coalesce(n.stat, o.stat)))
         order by abs(coalesce(n.pts, 0) - coalesce(o.pts, 0)) desc), '[]')
    into changed
  from n full join o on o.stat = n.stat
  where coalesce(n.pts, 0) <> coalesce(o.pts, 0);
  select period, clock, status_detail into g from public.nfl_games
   where season = new.season and week = new.week and game_key = new.game_key;
  insert into public.score_events (season, week, player_id, game_key, at, period, clock, status_detail, delta, points, lines)
  values (new.season, new.week, new.player_id, new.game_key, new.updated_at, g.period, g.clock, g.status_detail,
          new.points - old_pts, new.points, changed);
  return new;
end;
$$;
revoke execute on function private.log_score_event() from public, anon, authenticated;
create trigger log_score_event after insert or update on public.player_scores
  for each row execute function private.log_score_event();

-- 4. Lineups on the Live page, for everyone (signed out too): each starter is shown from his
--    game's kickoff on. Before that his slot comes back empty (player_id null), except to his
--    team's managers and the commissioner, who see their lineup in full. Same rule as the
--    members' lineup_slots policy, extended to visitors.
create function public.live_lineups(p_season int, p_week int)
returns table (team_id text, slot smallint, player_id text, name text, pos text, nfl_team text, revealed boolean)
language sql stable security definer set search_path = ''
as $$
  select s.team_id, s.slot,
         case when v.ok then s.player_id end,
         case when v.ok then p.name end,
         case when v.ok then p.position end,
         case when v.ok then p.nfl_team end,
         v.ok
  from public.lineup_slots s
  join public.nfl_players p on p.id = s.player_id
  cross join lateral (select coalesce(private.player_kickoff(s.season, s.week, s.player_id) <= now(), false)
                             or private.manages_team(s.team_id) or private.is_commissioner() as ok) v
  where s.season = p_season and s.week = p_week
  order by s.team_id, s.slot
$$;
revoke execute on function public.live_lineups(int, int) from public;
grant execute on function public.live_lineups(int, int) to anon, authenticated, service_role;

-- 5. TEMPORARY 2026 (MFL is official): our live totals vs MFL's live scoring (public export
--    TYPE=liveScoring), per team, written by the live scorer. Commissioner only.
create table public.live_compare (
  season int not null,
  week int not null check (week between 1 and 18),
  team_id text not null references public.teams (id),
  our_points numeric(7, 2) not null,
  mfl_points numeric(7, 2),
  players jsonb not null default '[]',       -- [{player_id, mfl_id, name, ours, mfl}] starters that differ
  diff_since timestamptz,                    -- when the current difference first appeared (null = equal)
  checked_at timestamptz not null default now(),
  primary key (season, week, team_id)
);
alter table public.live_compare enable row level security;
create policy "commissioner reads" on public.live_compare for select to authenticated using (private.is_commissioner());
revoke all on public.live_compare from anon, authenticated;
grant select on public.live_compare to authenticated;
grant all on public.live_compare to service_role;

-- 6. TEMPORARY 2026: MFL starters, refreshed until each player's kickoff. pg_cron calls
--    private.mfl_lineups_tick() every minute; it asks b5-live (job "mfl_lineups") every
--    minute in the 30 minutes before a kickoff, otherwise every 15 minutes, and only while
--    some game of the current week hasn't kicked off. During games the live pass mirrors too.
create function private.current_week(p_now timestamptz default now(), out season int, out week int)
language sql stable security definer set search_path = ''
as $$
  select g.season, g.week from public.nfl_games g
  group by g.season, g.week
  having max(g.kickoff) > p_now - interval '5 hours'
  order by g.season, g.week limit 1
$$;

create function private.request_job(p_body jsonb) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  n uuid;
begin
  delete from public.live_nonces where created_at < now() - interval '10 minutes';
  insert into public.live_nonces default values returning nonce into n;
  perform net.http_post(
    url := 'https://kngwdttpbpezlvjrkrrg.supabase.co/functions/v1/b5-live',
    body := p_body || jsonb_build_object('nonce', n),
    headers := jsonb_build_object('Content-Type', 'application/json'),
    timeout_milliseconds := 120000
  );
end;
$$;

create function private.mfl_lineups_tick(p_now timestamptz default now()) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  w record;
begin
  select * into w from private.current_week(p_now);
  if w.season is distinct from 2026 then return 'not the 2026 shadow season'; end if;
  if not exists (select 1 from public.nfl_games g where g.season = w.season and g.week = w.week and g.kickoff > p_now) then
    return 'every game has kicked off';
  end if;
  if extract(minute from p_now)::int % 15 <> 0
     and not exists (select 1 from public.nfl_games g where g.season = w.season and g.week = w.week
                     and g.kickoff > p_now and g.kickoff <= p_now + interval '30 minutes') then
    return 'waiting';
  end if;
  perform private.request_job(jsonb_build_object('job', 'mfl_lineups', 'season', w.season, 'week', w.week));
  return 'requested ' || w.season || ' week ' || w.week;
end;
$$;
revoke execute on function private.current_week(timestamptz), private.request_job(jsonb), private.mfl_lineups_tick(timestamptz)
  from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    perform cron.schedule('b5-mfl-lineups', '* * * * *', 'select private.mfl_lineups_tick()');
  end if;
end $$;

-- 7. Realtime: browsers on #live subscribe to score_weeks (the live scorer upserts one row per
--    pass), then re-read what changed. One small message per pass per viewer.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.score_weeks;
  end if;
end $$;
