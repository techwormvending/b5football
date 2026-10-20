-- Confidence Pool test mode (2026: MFL is official) and the weekly official import.
--
-- season_settings.pools.mode:
--   "test"     (2026) members may enter Confidence picks on the site to try it (source "test");
--              Survivor stays read-only. Every Tuesday 6:00 AM ET the official MFL picks for the
--              week that just finished replace that week's picks (source "mfl").
--   "official" (2027 on) site picks are the real picks (source "site"); no MFL import.
-- Pick sources: "test" | "mfl" | "site". MFL picks are read-only for everyone but the import job.

-- ---------------------------------------------------------------------------
-- Sources
-- ---------------------------------------------------------------------------
alter table public.survivor_picks drop constraint survivor_picks_source_check;
alter table public.confidence_picks drop constraint confidence_picks_source_check;
alter table public.survivor_picks disable trigger guard_survivor_pick;
alter table public.confidence_picks disable trigger guard_confidence_pick;
update public.survivor_picks set source = case source when 'mfl_import' then 'mfl' when 'commissioner' then 'site' else source end;
update public.confidence_picks set source = case source when 'mfl_import' then 'mfl' when 'commissioner' then 'site' else source end;
alter table public.survivor_picks enable trigger guard_survivor_pick;
alter table public.confidence_picks enable trigger guard_confidence_pick;
alter table public.survivor_picks add constraint survivor_picks_source_check check (source in ('test', 'mfl', 'site'));
alter table public.confidence_picks add constraint confidence_picks_source_check check (source in ('test', 'mfl', 'site'));
alter table public.survivor_picks alter column source set default 'site';
alter table public.confidence_picks alter column source set default 'site';

update public.season_settings
set pools = (pools - 'picking_open') || '{"mode": "test"}'::jsonb
where season = 2026;

create or replace function private.pools_mode(p_season int) returns text
language sql stable security definer set search_path = ''
as $$ select coalesce((select s.pools ->> 'mode' from public.season_settings s where s.season = p_season), 'closed') $$;
grant execute on function private.pools_mode(int) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Guards (replace the originals)
-- ---------------------------------------------------------------------------
create or replace function private.guard_survivor_pick() returns trigger
language plpgsql set search_path = ''
as $$
declare
  k timestamptz;
  r record := coalesce(new, old);
begin
  if private.is_privileged() then return coalesce(new, old); end if;   -- MFL import / server jobs
  if tg_op <> 'INSERT' and old.source = 'mfl' then
    raise exception 'This is an official MFL pick (read-only)' using errcode = '42501';
  end if;
  if private.commissioner_exempt(array[r.team_id]) then
    if tg_op <> 'DELETE' then new.source := 'site'; new.set_by := (select auth.uid()); new.updated_at := now(); end if;
    return coalesce(new, old);
  end if;
  if private.pools_mode(r.season) <> 'official' then
    raise exception 'Survivor picks for % are made on MFL this season (read-only here)', r.season using errcode = '42501';
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    k := private.team_game_kickoff(old.season, old.week, old.nfl_team);
    if k is not null and k <= now() and (tg_op = 'DELETE' or new.nfl_team is distinct from old.nfl_team) then
      raise exception 'Your week % pick (%) is locked: that game has kicked off', old.week, old.nfl_team using errcode = '42501';
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    k := private.team_game_kickoff(new.season, new.week, new.nfl_team);
    if k is null then
      raise exception '% doesn''t play in week %', new.nfl_team, new.week using errcode = '23514';
    end if;
    if k <= now() and (tg_op = 'INSERT' or new.nfl_team is distinct from old.nfl_team) then
      raise exception '% is locked: that game has kicked off', new.nfl_team using errcode = '42501';
    end if;
    new.source := 'site'; new.set_by := (select auth.uid()); new.updated_at := now();
    return new;
  end if;
  return old;
end;
$$;

create or replace function private.guard_confidence_pick() returns trigger
language plpgsql set search_path = ''
as $$
declare
  k timestamptz;
  n int;
  g record;
  m text;
  r record := coalesce(new, old);
begin
  if private.is_privileged() then return coalesce(new, old); end if;   -- MFL import / server jobs
  if tg_op <> 'INSERT' and old.source = 'mfl' then
    raise exception 'This is an official MFL pick (read-only)' using errcode = '42501';
  end if;
  m := private.pools_mode(r.season);
  if private.commissioner_exempt(array[r.team_id]) then
    if tg_op <> 'DELETE' then
      new.source := case m when 'test' then 'test' else 'site' end;
      new.set_by := (select auth.uid()); new.updated_at := now();
    end if;
    return coalesce(new, old);
  end if;
  if m not in ('test', 'official') then
    raise exception 'Confidence picks for % aren''t open on this site', r.season using errcode = '42501';
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    k := private.game_kickoff(old.season, old.week, old.game_key);
    if k is not null and k <= now() and (tg_op = 'DELETE' or new.pick is distinct from old.pick or new.points is distinct from old.points) then
      raise exception 'Your pick for % is locked: that game has kicked off', old.game_key using errcode = '42501';
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    if exists (select 1 from public.confidence_picks c where c.season = new.season and c.week = new.week and c.team_id = new.team_id and c.source = 'mfl') then
      raise exception 'Week % has the official MFL picks (read-only)', new.week using errcode = '42501';
    end if;
    select * into g from public.nfl_games x where x.season = new.season and x.week = new.week and x.game_key = new.game_key;
    if g.game_key is null then
      raise exception '% isn''t a week % game', new.game_key, new.week using errcode = '23514';
    end if;
    if new.pick not in (g.home, g.away) then
      raise exception '% doesn''t play in %', new.pick, new.game_key using errcode = '23514';
    end if;
    select count(*) into n from public.nfl_games x where x.season = new.season and x.week = new.week;
    if new.points > n then
      raise exception 'Confidence points run 1 to % in week %', n, new.week using errcode = '23514';
    end if;
    if g.kickoff is not null and g.kickoff <= now()
       and (tg_op = 'INSERT' or new.pick is distinct from old.pick or new.points is distinct from old.points) then
      raise exception '% is locked: that game has kicked off', new.game_key using errcode = '42501';
    end if;
    new.source := case m when 'test' then 'test' else 'site' end;
    new.set_by := (select auth.uid()); new.updated_at := now();
    return new;
  end if;
  return old;
end;
$$;

-- pools_open() is superseded by pools_mode()
drop function if exists private.pools_open(int);

-- ---------------------------------------------------------------------------
-- Weekly import log (commissioner only) and the atomic replace
-- ---------------------------------------------------------------------------
create table public.pool_imports (
  season int not null,
  week int not null,
  status text not null check (status in ('ok', 'failed')),
  source text check (source in ('export', 'page')),
  attempts int not null default 1,
  attempted_at timestamptz not null default now(),
  succeeded_at timestamptz,
  picks int not null default 0,
  teams int not null default 0,
  replaced_test int not null default 0,
  message text,
  compare jsonb not null default '{}',            -- our weekly totals and season standings vs MFL's results
  triggered_by text not null default 'schedule',  -- 'schedule' | 'commissioner' | 'backfill'
  primary key (season, week)
);
alter table public.pool_imports enable row level security;
create policy "commissioner reads" on public.pool_imports for select to authenticated using (private.is_commissioner());
grant select on public.pool_imports to authenticated;
grant all on public.pool_imports to service_role;

-- Replace a week's Confidence picks (test, site and MFL) with the official MFL picks, in one transaction.
create function public.replace_week_confidence(p_season int, p_week int, p_rows jsonb) returns int
language plpgsql security invoker set search_path = ''
as $$
declare
  removed int;
begin
  delete from public.confidence_picks where season = p_season and week = p_week and source = 'test';
  get diagnostics removed = row_count;
  delete from public.confidence_picks where season = p_season and week = p_week;
  insert into public.confidence_picks (season, week, team_id, game_key, pick, points, source)
  select p_season, p_week, x.team_id, x.game_key, x.pick, x.points, 'mfl'
  from jsonb_to_recordset(p_rows) as x(team_id text, game_key text, pick text, points int);
  return removed;
end;
$$;
revoke execute on function public.replace_week_confidence(int, int, jsonb) from public, anon, authenticated;
grant execute on function public.replace_week_confidence(int, int, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Schedule: Tuesdays from 6:00 AM ET, retried hourly that day until the import succeeds
-- ---------------------------------------------------------------------------
-- The week that just finished: the latest week whose last game kicked off over 5 hours ago.
create function private.last_finished_week(p_now timestamptz default now()) returns table (season int, week int)
language sql stable security definer set search_path = ''
as $$
  select g.season, g.week from public.nfl_games g
  group by g.season, g.week
  having max(g.kickoff) < p_now - interval '5 hours'
  order by max(g.kickoff) desc limit 1
$$;

create function private.request_pool_import(p_season int, p_week int, p_by text) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  n uuid;
begin
  delete from public.live_nonces where created_at < now() - interval '10 minutes';
  insert into public.live_nonces default values returning nonce into n;
  perform net.http_post(
    url := 'https://kngwdttpbpezlvjrkrrg.supabase.co/functions/v1/b5-live',
    body := jsonb_build_object('nonce', n, 'job', 'pool_import', 'season', p_season, 'week', p_week, 'by', p_by),
    headers := jsonb_build_object('Content-Type', 'application/json'),
    timeout_milliseconds := 120000
  );
end;
$$;

-- Hourly on UTC Tuesdays and Wednesdays; acts only on Tuesday (Eastern) from 6 AM on, so the
-- switch between EDT and EST needs no change. Test mode only.
create function private.pool_import_tick(p_now timestamptz default now()) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  et timestamp := p_now at time zone 'America/New_York';
  w record;
begin
  if extract(isodow from et) <> 2 or extract(hour from et) < 6 then
    return 'not Tuesday 6 AM ET or later';
  end if;
  select * into w from private.last_finished_week(p_now);
  if w.week is null then return 'no finished week'; end if;
  if private.pools_mode(w.season) <> 'test' then return 'not in test mode'; end if;
  if exists (select 1 from public.pool_imports i where i.season = w.season and i.week = w.week and i.status = 'ok'
             and i.succeeded_at >= date_trunc('day', et) at time zone 'America/New_York') then
    return 'already imported today';
  end if;
  perform private.request_pool_import(w.season, w.week, 'schedule');
  return 'requested ' || w.season || ' week ' || w.week;
end;
$$;

-- Commish "Run import now" (e.g. after stat corrections). Commissioner only.
create function public.run_pool_import(p_week int default null) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  w record;
begin
  if not private.is_commissioner() then
    raise exception 'Only the commissioner can run the pool import' using errcode = '42501';
  end if;
  select * into w from private.last_finished_week();
  if w.season is null then raise exception 'No finished NFL week yet' using errcode = '22023'; end if;
  perform private.request_pool_import(w.season, coalesce(p_week, w.week), 'commissioner');
  return 'Import requested for ' || w.season || ' week ' || coalesce(p_week, w.week);
end;
$$;
revoke execute on function public.run_pool_import(int) from public, anon;
grant execute on function public.run_pool_import(int) to authenticated;
revoke execute on function private.request_pool_import(int, int, text), private.pool_import_tick(timestamptz), private.last_finished_week(timestamptz) from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('b5-pool-import', '0 * * * 2,3', 'select private.pool_import_tick()');
  end if;
end $$;
