-- Survivor and Confidence pools (replace MFL's pools; feed Payouts).
--
-- Settings: season_settings.pools (MFL league 22689, read 2026-10-20: survivorPool Yes,
-- survivorPoolStartWeek 1, survivorPoolEndWeek 17, nflPoolType Confidence, nflPoolStartWeek 1,
-- nflPoolEndWeek 17, vs_spread 0). "picking_open" is false for 2026 (MFL official; picks are
-- imported read-only) and true from 2027.
--
-- Rules enforced here (src/league/pools.ts scores them):
--   * Picks lock per game at that game's kickoff (not the start of the week).
--   * Survivor: one NFL team per week; never the same team twice in a season.
--   * Confidence: one pick per game, points 1..N (N = games that week), each value once.
--   * Others' picks for a game are hidden until it kicks off (then members see everyone's).
--   * Managers pick only for their own team and only while picking is open; the commissioner
--     can enter or fix any pick (audited, "pools:<table>:<op>"), but on a team he manages he
--     follows the manager rules. Server jobs (MFL import) are exempt.

alter table public.nfl_games add column if not exists home_score int, add column if not exists away_score int;
alter table public.season_settings add column if not exists pools jsonb not null default '{}';

create table public.survivor_picks (
  season int not null,
  week int not null check (week between 1 and 18),
  team_id text not null references public.teams (id),
  nfl_team text not null,
  source text not null default 'site' check (source in ('site', 'mfl_import', 'commissioner')),
  set_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  primary key (season, week, team_id),
  unique (season, team_id, nfl_team)          -- never the same NFL team twice in a season
);

create table public.confidence_picks (
  season int not null,
  week int not null check (week between 1 and 18),
  team_id text not null references public.teams (id),
  game_key text not null,                     -- 'AWAY@HOME'
  pick text not null,
  points int not null check (points >= 1),
  source text not null default 'site' check (source in ('site', 'mfl_import', 'commissioner')),
  set_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  primary key (season, week, team_id, game_key),
  -- each confidence value once per week; deferred so a save can swap two values
  constraint confidence_points_unique unique (season, week, team_id, points) deferrable initially deferred
);

-- Computed by the nightly job / live scorer (src/league/pools.ts). Public: standings, not picks.
create table public.survivor_status (
  season int not null,
  team_id text not null references public.teams (id),
  alive boolean not null,
  eliminated_week int,
  reason text,                                -- 'loss' | 'tie' | 'no pick'
  winner boolean not null default false,
  picks_used int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (season, team_id)
);
create table public.confidence_scores (
  season int not null,
  week int not null,
  team_id text not null references public.teams (id),
  points int not null,
  correct int not null,
  decided int not null,                       -- games with a result
  games int not null,
  updated_at timestamptz not null default now(),
  primary key (season, week, team_id)
);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create function private.team_game_kickoff(p_season int, p_week int, p_team text) returns timestamptz
language sql stable security definer set search_path = ''
as $$ select min(g.kickoff) from public.nfl_games g where g.season = p_season and g.week = p_week and p_team in (g.home, g.away) $$;
create function private.game_kickoff(p_season int, p_week int, p_game text) returns timestamptz
language sql stable security definer set search_path = ''
as $$ select g.kickoff from public.nfl_games g where g.season = p_season and g.week = p_week and g.game_key = p_game $$;
create function private.pools_open(p_season int) returns boolean
language sql stable security definer set search_path = ''
as $$ select coalesce((select (s.pools ->> 'picking_open')::boolean from public.season_settings s where s.season = p_season), false) $$;
grant execute on function private.team_game_kickoff(int, int, text), private.game_kickoff(int, int, text), private.pools_open(int) to anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- Guards (managers; the commissioner on a team he doesn't manage and server jobs are exempt)
-- ---------------------------------------------------------------------------
create function private.guard_survivor_pick() returns trigger
language plpgsql set search_path = ''
as $$
declare
  k timestamptz;
  r record := coalesce(new, old);
begin
  if private.is_privileged() or private.commissioner_exempt(array[r.team_id]) then
    if tg_op <> 'DELETE' and not private.is_privileged() then new.source := 'commissioner'; new.set_by := (select auth.uid()); new.updated_at := now(); end if;
    return coalesce(new, old);
  end if;
  if not private.pools_open(r.season) then
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
create trigger guard_survivor_pick before insert or update or delete on public.survivor_picks
  for each row execute function private.guard_survivor_pick();

create function private.guard_confidence_pick() returns trigger
language plpgsql set search_path = ''
as $$
declare
  k timestamptz;
  n int;
  g record;
  r record := coalesce(new, old);
begin
  if private.is_privileged() or private.commissioner_exempt(array[r.team_id]) then
    if tg_op <> 'DELETE' and not private.is_privileged() then new.source := 'commissioner'; new.set_by := (select auth.uid()); new.updated_at := now(); end if;
    return coalesce(new, old);
  end if;
  if not private.pools_open(r.season) then
    raise exception 'Confidence picks for % are made on MFL this season (read-only here)', r.season using errcode = '42501';
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    k := private.game_kickoff(old.season, old.week, old.game_key);
    if k is not null and k <= now() and (tg_op = 'DELETE' or new.pick is distinct from old.pick or new.points is distinct from old.points) then
      raise exception 'Your pick for % is locked: that game has kicked off', old.game_key using errcode = '42501';
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
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
    new.source := 'site'; new.set_by := (select auth.uid()); new.updated_at := now();
    return new;
  end if;
  return old;
end;
$$;
create trigger guard_confidence_pick before insert or update or delete on public.confidence_picks
  for each row execute function private.guard_confidence_pick();

-- Save a week's confidence picks in one transaction (swaps work: the unique key is deferred).
-- Runs as the caller, so RLS and the guard apply. Unchanged rows (e.g. locked games) are skipped.
create function public.save_confidence(p_season int, p_week int, p_team text, p_picks jsonb)
returns setof public.confidence_picks
language plpgsql security invoker set search_path = ''
as $$
declare
  x record;
begin
  for x in select * from jsonb_to_recordset(p_picks) as t(game_key text, pick text, points int) loop
    insert into public.confidence_picks (season, week, team_id, game_key, pick, points)
    values (p_season, p_week, p_team, x.game_key, x.pick, x.points)
    on conflict (season, week, team_id, game_key) do update
      set pick = excluded.pick, points = excluded.points
      where public.confidence_picks.pick is distinct from excluded.pick or public.confidence_picks.points is distinct from excluded.points;
  end loop;
  return query select * from public.confidence_picks c where c.season = p_season and c.week = p_week and c.team_id = p_team order by c.points desc;
end;
$$;
revoke execute on function public.save_confidence(int, int, text, jsonb) from public, anon;
grant execute on function public.save_confidence(int, int, text, jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- RLS: your own picks any time; everyone's once that game kicks off (members only)
-- ---------------------------------------------------------------------------
alter table public.survivor_picks enable row level security;
alter table public.confidence_picks enable row level security;
alter table public.survivor_status enable row level security;
alter table public.confidence_scores enable row level security;

create policy "own, or after kickoff" on public.survivor_picks for select to authenticated
  using (private.is_commissioner() or private.manages_team(team_id)
         or (private.is_member() and coalesce(private.team_game_kickoff(season, week, nfl_team) <= now(), false)));
create policy "own team writes" on public.survivor_picks for all to authenticated
  using (private.manages_team(team_id) or private.is_commissioner())
  with check (private.manages_team(team_id) or private.is_commissioner());
create policy "own, or after kickoff" on public.confidence_picks for select to authenticated
  using (private.is_commissioner() or private.manages_team(team_id)
         or (private.is_member() and coalesce(private.game_kickoff(season, week, game_key) <= now(), false)));
create policy "own team writes" on public.confidence_picks for all to authenticated
  using (private.manages_team(team_id) or private.is_commissioner())
  with check (private.manages_team(team_id) or private.is_commissioner());

do $$
declare t text;
begin
  foreach t in array array['survivor_status', 'confidence_scores'] loop
    execute format('create policy "public read" on public.%I for select to anon, authenticated using (true)', t);
    execute format('create policy "commissioner writes" on public.%I for all to authenticated
                    using (private.is_commissioner()) with check (private.is_commissioner())', t);
  end loop;
end $$;

grant select on public.survivor_status, public.confidence_scores to anon;
grant select, insert, update, delete on public.survivor_picks, public.confidence_picks, public.survivor_status, public.confidence_scores to authenticated;
grant all on public.survivor_picks, public.confidence_picks, public.survivor_status, public.confidence_scores to service_role;

-- Audit commissioner pick changes (runs as the caller; see private.audit_payouts).
create function private.audit_pools() returns trigger
language plpgsql set search_path = ''
as $$
declare
  o jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  n jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
begin
  if private.is_privileged() or not private.is_commissioner() then
    return null;
  end if;
  insert into public.audit_log (actor, action, season, week, details)
  values ((select auth.uid()), 'pools:' || tg_table_name || ':' || lower(tg_op),
          coalesce((n ->> 'season')::int, (o ->> 'season')::int), coalesce((n ->> 'week')::int, (o ->> 'week')::int),
          jsonb_build_object('table', tg_table_name, 'op', lower(tg_op), 'old', o, 'new', n));
  return null;
end;
$$;
create trigger audit_pools after insert or update or delete on public.survivor_picks for each row execute function private.audit_pools();
create trigger audit_pools after insert or update or delete on public.confidence_picks for each row execute function private.audit_pools();

-- ---------------------------------------------------------------------------
-- Payout handoff: Survivor and Pick'em become computed prizes
-- ---------------------------------------------------------------------------
alter table public.awards drop constraint awards_kind_check;
alter table public.awards add constraint awards_kind_check
  check (kind in ('weekly_high', 'playoff_r1', 'playoff_r2', 'champion', 'season_points', 'guillotine', 'manual', 'empire', 'survivor', 'pickem'));

update public.season_settings
set prizes = (prizes - 'manual')
             || '{"survivor": {"amount": 240}, "pickem": {"amounts": [180, 60]}, "manual": []}'::jsonb,
    pools = '{
      "picking_open": false,
      "survivor":   { "start_week": 1, "end_week": 17, "missed_pick_eliminates": true },
      "confidence": { "start_week": 1, "end_week": 17, "type": "confidence", "vs_spread": false },
      "source": "MFL league 22689 settings, read 2026-10-20"
    }'::jsonb
where season = 2026;

-- The spreadsheet's Survivor result stands as the commissioner's decision for 2026.
update public.awards
set kind = 'survivor', source = 'override', note = coalesce(note, 'From the 2026 payout spreadsheet')
where season = 2026 and kind = 'manual' and label = 'Survivor';
