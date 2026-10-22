-- Add/drop and waivers, B5 rules (MFL's behavior), all as season settings (season_settings.waivers):
--   * Each player locks at his own NFL kickoff; from then until his NFL week's last game ends he
--     can't be added or dropped directly (claims only).
--   * Monday 10 PM ET every free agent goes on waivers; Wednesday 5 PM ET claims process; then
--     first-come-first-served (instant) until each player's kickoff.
--   * Waiver order: ascending total points (lowest first); ties: head-to-head among the tied teams,
--     overall win %, division win % (each worse-first), then team id. Same order every round;
--     recomputed at each run from the standings.
--   * Up to 8 rounds per run. A claim = add + optional drop, ranked by the team. One win per team
--     per round; a claim that would exceed the roster max without a drop is skipped.
--   * A dropped player can't be added directly for 24 hours (claims only). Newly acquired players
--     can be dropped at once. Drop-only moves allowed. No fees, no position limits.
--   * Moves open N days before the season's first NFL game and close at closeAt.
--   * "live": false (2026, MFL is official) = nobody makes moves here; MFL's transactions are
--     imported so rosters and the log stay in sync. Live claims start in 2027.
-- Writes go through definer functions with explicit checks (owners of the team, or the
-- commissioner); claims are private to the team until processed.

alter table public.season_settings add column waivers jsonb not null default '{}';
update public.season_settings set waivers = '{"live": false, "closeAt": "2027-01-03T13:00:00-05:00"}' where season = 2026;

create function private.waiver_settings(p_season int) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select '{"live": false, "rosterMax": 18, "rounds": 8, "dropLockHours": 24, "reverseDropMinutes": 30,
           "waiversStart": {"isodow": 1, "time": "22:00"}, "process": {"isodow": 3, "time": "17:00"},
           "lockAfterLastKickoffHours": 4, "preseasonOpenDays": 2, "closeAt": null}'::jsonb
         || coalesce((select s.waivers from public.season_settings s where s.season = p_season), '{}'::jsonb)
$$;

-- Transactions: how a move happened, and links for undo / reversal.
alter table public.transactions
  add column via text not null default 'free_agent' check (via in ('free_agent', 'waiver', 'commissioner', 'mfl')),
  add column waiver_run_id bigint,
  add column mfl_key text unique,
  add column reverses_id bigint references public.transactions (id);

create table public.waiver_runs (
  id bigint generated always as identity primary key,
  season int not null,
  cycle timestamptz not null,               -- the scheduled processing time this run covers
  ran_at timestamptz not null default now(),
  ran_by uuid references public.profiles (id) on delete set null,   -- null = the schedule
  kind text not null check (kind in ('scheduled', 'forced')),
  status text not null default 'done' check (status in ('done', 'undone')),
  team_order text[] not null,
  rounds_used int not null default 0,
  won int not null default 0,
  undone_at timestamptz,
  undone_by uuid references public.profiles (id) on delete set null
);
create unique index waiver_runs_one_scheduled_per_cycle on public.waiver_runs (season, cycle) where kind = 'scheduled' and status = 'done';
alter table public.transactions add constraint transactions_waiver_run_fk foreign key (waiver_run_id) references public.waiver_runs (id);

create table public.waiver_claims (
  id bigint generated always as identity primary key,
  season int not null,
  team_id text not null references public.teams (id),
  add_player text not null references public.nfl_players (id),
  drop_player text references public.nfl_players (id),
  rank int not null,
  status text not null default 'pending' check (status in ('pending', 'won', 'lost', 'skipped', 'cancelled')),
  result text,
  run_id bigint references public.waiver_runs (id),
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz,
  processed_at timestamptz
);
create index waiver_claims_team_idx on public.waiver_claims (season, team_id, status, rank);
create unique index waiver_claims_one_pending on public.waiver_claims (season, team_id, add_player, coalesce(drop_player, '')) where status = 'pending';

alter table public.waiver_runs enable row level security;
alter table public.waiver_claims enable row level security;
create policy "members read" on public.waiver_runs for select to authenticated using (private.is_member());
-- Pending claims are secret: the team's owners and the commissioner. Processed ones are the league's.
create policy "own team, or processed" on public.waiver_claims for select to authenticated
  using (private.manages_team(team_id) or private.is_commissioner() or (status <> 'pending' and private.is_member()));
revoke all on public.waiver_runs, public.waiver_claims from anon, authenticated;
grant select on public.waiver_runs, public.waiver_claims to authenticated;
grant all on public.waiver_runs, public.waiver_claims to service_role;

-- ---------------------------------------------------------------------------
-- Availability
-- ---------------------------------------------------------------------------
-- Is this player on any roster this season?
create function private.owner_of(p_season int, p_player text) returns text
language sql stable security definer set search_path = ''
as $$ select r.team_id from public.roster_entries r where r.season = p_season and r.player_id = p_player $$;

-- The waiver window around p_at: [Monday 10 PM, Wednesday 5 PM) ET by default.
create function private.waiver_window(p_season int, p_at timestamptz, out starts timestamptz, out ends timestamptz)
language plpgsql stable security definer set search_path = ''
as $$
declare
  s jsonb := private.waiver_settings(p_season);
  et timestamp := p_at at time zone 'America/New_York';
  st_dow int := (s #>> '{waiversStart,isodow}')::int;
  pr_dow int := (s #>> '{process,isodow}')::int;
  st_local timestamp;
  pr_local timestamp;
begin
  st_local := date_trunc('week', et) + (st_dow - 1) * interval '1 day' + (s #>> '{waiversStart,time}')::time;
  if st_local > et then st_local := st_local - interval '7 days'; end if;
  pr_local := date_trunc('day', st_local) + ((pr_dow - st_dow + 7) % 7) * interval '1 day' + (s #>> '{process,time}')::time;
  if pr_local <= st_local then pr_local := pr_local + interval '7 days'; end if;
  starts := st_local at time zone 'America/New_York';
  ends := pr_local at time zone 'America/New_York';
end;
$$;

-- What a free agent's status is at p_at:
--   closed  outside the season's add/drop window (before preseason opening, after closeAt)
--   claims  on waivers / locked / recently dropped: claims only, until `until`
--   fcfs    first-come-first-served: add now
-- (rostered players: status 'rostered')
create function private.move_status(p_season int, p_player text, p_at timestamptz default now(),
  out status text, out until timestamptz, out reason text)
language plpgsql stable security definer set search_path = ''
as $$
declare
  s jsonb := private.waiver_settings(p_season);
  first_kick timestamptz;
  w record;
  team text;
  g record;
  week_end timestamptz;
  dropped timestamptz;
begin
  if private.owner_of(p_season, p_player) is not null then status := 'rostered'; return; end if;
  select min(ng.kickoff) into first_kick from public.nfl_games ng where ng.season = p_season;
  if first_kick is null or p_at < first_kick - make_interval(days => (s ->> 'preseasonOpenDays')::int) then
    status := 'closed'; until := first_kick - make_interval(days => (s ->> 'preseasonOpenDays')::int); reason := 'Moves open before the season'; return;
  end if;
  if s ->> 'closeAt' is not null and p_at >= (s ->> 'closeAt')::timestamptz then
    status := 'closed'; reason := 'The season''s add/drop period is over'; return;
  end if;
  status := 'fcfs';
  -- Locked: his NFL game this week has kicked off and the week's last game hasn't ended.
  select p.nfl_team into team from public.nfl_players p where p.id = p_player;
  if p_player like 'DEF:%' then team := substr(p_player, 5); end if;
  select ng.week, ng.kickoff into g from public.nfl_games ng
   where ng.season = p_season and team in (ng.home, ng.away) and ng.kickoff <= p_at order by ng.kickoff desc limit 1;
  if g.week is not null then
    select max(ng.kickoff) + make_interval(hours => (s ->> 'lockAfterLastKickoffHours')::int) into week_end
      from public.nfl_games ng where ng.season = p_season and ng.week = g.week;
    if p_at < week_end then status := 'claims'; until := week_end; reason := 'Locked: his game has kicked off'; end if;
  end if;
  -- Waivers: Monday 10 PM to Wednesday 5 PM (from the first week on; preseason is first-come-first-served).
  select * into w from private.waiver_window(p_season, p_at);
  if p_at >= w.starts and p_at < w.ends and w.starts >= first_kick and (until is null or w.ends > until) then
    status := 'claims'; until := w.ends; reason := 'On waivers: claims process ' || to_char(w.ends at time zone 'America/New_York', 'Dy FMHH12:MI AM');
  end if;
  -- Dropped in the last 24 hours.
  select max(t.created_at) into dropped from public.transactions t
   where t.season = p_season and p_player = any (t.players_out) and t.status = 'processed';
  if dropped is not null and dropped + make_interval(hours => (s ->> 'dropLockHours')::int) > p_at
     and (until is null or dropped + make_interval(hours => (s ->> 'dropLockHours')::int) > until) then
    status := 'claims'; until := dropped + make_interval(hours => (s ->> 'dropLockHours')::int); reason := 'Dropped in the last ' || (s ->> 'dropLockHours') || ' hours';
  end if;
end;
$$;

-- Free agents for the page: every fantasy player not on a roster, with status and this season's points.
create function public.free_agents(p_season int)
returns table (player_id text, name text, pos text, nfl_team text, status text, until timestamptz, reason text, points numeric, live boolean)
language plpgsql stable security definer set search_path = ''
as $$
declare
  is_live boolean := coalesce((private.waiver_settings(p_season) ->> 'live')::boolean, false);
begin
  if not private.is_member() then return; end if;
  return query
    select p.id, p.name, p.position, p.nfl_team, ms.status, ms.until, ms.reason, coalesce(pts.points, 0)::numeric, is_live
    from public.nfl_players p
    cross join lateral private.move_status(p_season, p.id) ms
    left join lateral (select sum(ps.points) as points from public.player_scores ps where ps.season = p_season and ps.player_id = p.id) pts on true
    where p.position in ('QB', 'RB', 'WR', 'TE', 'K', 'DEF') and ms.status <> 'rostered'
    order by coalesce(pts.points, 0) desc, p.name;
end;
$$;

-- ---------------------------------------------------------------------------
-- Waiver order: ascending points for; ties by H2H among the tied, win %, division win %.
-- ---------------------------------------------------------------------------
create function public.waiver_order(p_season int)
returns table (place int, team_id text, points_for numeric, wins int, losses int, ties int, h2h_pct numeric, win_pct numeric, div_pct numeric)
language sql stable security definer set search_path = ''
as $$
  with st as (
    select t.id as team_id, t.division, coalesce(s.points_for, 0) as pf, coalesce(s.wins, 0) as w, coalesce(s.losses, 0) as l, coalesce(s.ties, 0) as tie
    from public.teams t left join public.standings s on s.team_id = t.id and s.season = p_season
  ), games as (
    select m.home_team as a, m.away_team as b, m.home_score as sa, m.away_score as sb from public.matchups m
     where m.season = p_season and not m.is_playoff and m.home_score is not null and m.away_score is not null
       and exists (select 1 from public.score_weeks sw where sw.season = p_season and sw.week = m.week and sw.status in ('pending_review', 'final'))
    union all
    select m.away_team, m.home_team, m.away_score, m.home_score from public.matchups m
     where m.season = p_season and not m.is_playoff and m.home_score is not null and m.away_score is not null
       and exists (select 1 from public.score_weeks sw where sw.season = p_season and sw.week = m.week and sw.status in ('pending_review', 'final'))
  ), rated as (
    select st.*,
      (select avg(case when g.sa > g.sb then 1 when g.sa = g.sb then 0.5 else 0 end) from games g join st o on o.team_id = g.b
        where g.a = st.team_id and o.pf = st.pf and o.team_id <> st.team_id) as h2h,
      case when st.w + st.l + st.tie > 0 then (st.w + 0.5 * st.tie) / (st.w + st.l + st.tie) end as wp,
      (select avg(case when g.sa > g.sb then 1 when g.sa = g.sb then 0.5 else 0 end) from games g join st o on o.team_id = g.b
        where g.a = st.team_id and o.division = st.division) as dp
    from st
  )
  select (row_number() over (order by pf, coalesce(h2h, 0.5), coalesce(wp, 0.5), coalesce(dp, 0.5), team_id))::int,
         team_id, pf, w, l, tie, round(h2h, 3), round(wp, 3), round(dp, 3)
  from rated order by 1
$$;

-- ---------------------------------------------------------------------------
-- Moves (definer: roster writes; every rule checked here)
-- ---------------------------------------------------------------------------
create function private.check_owner(p_team text) returns boolean
language sql stable security definer set search_path = ''
as $$ select private.manages_team(p_team) or private.is_commissioner() $$;

-- The commissioner fixing another team (not his own) isn't bound by timing; on his own team he
-- follows every manager rule (like lineups).
create function private.timing_exempt(p_team text) returns boolean
language sql stable security definer set search_path = ''
as $$ select private.is_commissioner() and not private.manages_team(p_team) $$;

create function private.roster_size(p_season int, p_team text) returns int
language sql stable security definer set search_path = ''
as $$ select count(*)::int from public.roster_entries r where r.season = p_season and r.team_id = p_team $$;

-- Add (first-come-first-served) and/or drop now. Returns the transaction id.
create function public.roster_move(p_season int, p_team text, p_add text default null, p_drop text default null)
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  s jsonb := private.waiver_settings(p_season);
  ms record;
  exempt boolean := private.timing_exempt(p_team);
  dk timestamptz;
  t bigint;
begin
  if not private.check_owner(p_team) then raise exception 'You can only move players on your own team' using errcode = '42501'; end if;
  if not coalesce((s ->> 'live')::boolean, false) then   -- (no server-job exception: inside a definer, is_privileged() is always true)
    raise exception 'Add/drops for % are made on MFL; they open on this site later', p_season using errcode = '42501';
  end if;
  if p_add is null and p_drop is null then raise exception 'Nothing to do' using errcode = '22023'; end if;
  perform 1 from public.teams tm where tm.id = p_team for update;
  if p_drop is not null then
    if private.owner_of(p_season, p_drop) is distinct from p_team then raise exception 'That player isn''t on your roster' using errcode = '22023'; end if;
    dk := private.player_kickoff_in_week(p_season, p_drop, now());
    if dk is not null and not exempt then
      raise exception 'Locked: his game has kicked off. You can drop him after the week''s last game.' using errcode = '42501';
    end if;
  end if;
  if p_add is not null then
    select * into ms from private.move_status(p_season, p_add);
    if ms.status = 'rostered' then raise exception 'That player is already on a roster' using errcode = '23505'; end if;
    if ms.status = 'closed' and not exempt then raise exception '%', ms.reason using errcode = '42501'; end if;
    if ms.status = 'claims' and not exempt then raise exception '% (claims only until %)', ms.reason, to_char(ms.until at time zone 'America/New_York', 'Dy FMHH12:MI AM') using errcode = '42501'; end if;
    if private.roster_size(p_season, p_team) + 1 - (case when p_drop is null then 0 else 1 end) > (s ->> 'rosterMax')::int then
      raise exception 'Your roster is full (% players): drop someone to add', (s ->> 'rosterMax') using errcode = '23514';
    end if;
  end if;
  if p_drop is not null then delete from public.roster_entries r where r.season = p_season and r.player_id = p_drop; end if;
  if p_add is not null then insert into public.roster_entries (season, team_id, player_id, acquired) values (p_season, p_team, p_add, 'FA'); end if;
  insert into public.transactions (season, team_id, type, status, players_in, players_out, via, created_by, decided_at)
  values (p_season, p_team, (case when p_add is not null and p_drop is not null then 'add_drop' when p_add is not null then 'add' else 'drop' end)::public.transaction_type,
          'processed', case when p_add is null then '{}' else array[p_add] end, case when p_drop is null then '{}' else array[p_drop] end,
          case when exempt then 'commissioner' else 'free_agent' end, (select auth.uid()), now())
  returning id into t;
  return t;
end;
$$;

-- His kickoff if he's locked right now (kicked off, week not over); else null.
create function private.player_kickoff_in_week(p_season int, p_player text, p_at timestamptz) returns timestamptz
language plpgsql stable security definer set search_path = ''
as $$
declare
  s jsonb := private.waiver_settings(p_season);
  team text;
  g record;
  week_end timestamptz;
begin
  select p.nfl_team into team from public.nfl_players p where p.id = p_player;
  if p_player like 'DEF:%' then team := substr(p_player, 5); end if;
  select ng.week, ng.kickoff into g from public.nfl_games ng
   where ng.season = p_season and team in (ng.home, ng.away) and ng.kickoff <= p_at order by ng.kickoff desc limit 1;
  if g.week is null then return null; end if;
  select max(ng.kickoff) + make_interval(hours => (s ->> 'lockAfterLastKickoffHours')::int) into week_end
    from public.nfl_games ng where ng.season = p_season and ng.week = g.week;
  return case when p_at < week_end then g.kickoff end;
end;
$$;

-- Claims: submit, reorder, change the drop, cancel. Either owner (shown as created_by / updated_by).
create function public.waiver_claim(p_season int, p_team text, p_add text, p_drop text default null) returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  s jsonb := private.waiver_settings(p_season);
  ms record;
  id bigint;
begin
  if not private.check_owner(p_team) then raise exception 'You can only claim for your own team' using errcode = '42501'; end if;
  if not coalesce((s ->> 'live')::boolean, false) then raise exception 'Waiver claims for % are made on MFL', p_season using errcode = '42501'; end if;
  select * into ms from private.move_status(p_season, p_add);
  if ms.status = 'rostered' then raise exception 'That player is already on a roster' using errcode = '23505'; end if;
  if ms.status = 'closed' then raise exception '%', ms.reason using errcode = '42501'; end if;
  if ms.status = 'fcfs' then raise exception 'He''s a free agent right now: add him directly' using errcode = '22023'; end if;
  if p_drop is not null and private.owner_of(p_season, p_drop) is distinct from p_team then raise exception 'That player isn''t on your roster' using errcode = '22023'; end if;
  insert into public.waiver_claims (season, team_id, add_player, drop_player, rank, created_by)
  values (p_season, p_team, p_add, p_drop,
          coalesce((select max(c.rank) from public.waiver_claims c where c.season = p_season and c.team_id = p_team and c.status = 'pending'), 0) + 1,
          (select auth.uid()))
  returning waiver_claims.id into id;
  return id;
end;
$$;

-- New order for a team's pending claims (ids in preference order; any left out keep their place after).
create function public.waiver_reorder(p_season int, p_team text, p_ids bigint[]) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.check_owner(p_team) then raise exception 'You can only reorder your own claims' using errcode = '42501'; end if;
  update public.waiver_claims c set rank = x.r, updated_by = (select auth.uid()), updated_at = now()
  from (select q.id, row_number() over (order by coalesce(array_position(p_ids, q.id), 1000000), q.rank) as r
        from public.waiver_claims q where q.season = p_season and q.team_id = p_team and q.status = 'pending') x
  where c.id = x.id and c.rank is distinct from x.r;
end;
$$;

create function public.waiver_update(p_claim bigint, p_drop text default null, p_cancel boolean default false) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  c public.waiver_claims%rowtype;
begin
  select * into c from public.waiver_claims w where w.id = p_claim;
  if c.id is null or not private.check_owner(c.team_id) then raise exception 'Not your claim' using errcode = '42501'; end if;
  if c.status <> 'pending' then raise exception 'That claim has already been processed' using errcode = '42501'; end if;
  if p_cancel then
    update public.waiver_claims set status = 'cancelled', updated_by = (select auth.uid()), updated_at = now() where id = p_claim;
  else
    if p_drop is not null and private.owner_of(c.season, p_drop) is distinct from c.team_id then raise exception 'That player isn''t on your roster' using errcode = '22023'; end if;
    update public.waiver_claims set drop_player = p_drop, updated_by = (select auth.uid()), updated_at = now() where id = p_claim;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Processing: rounds over the waiver order; one win per team per round.
-- ---------------------------------------------------------------------------
create function private.process_waivers(p_season int, p_cycle timestamptz, p_kind text, p_by uuid) returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  s jsonb := private.waiver_settings(p_season);
  max_r int := (s ->> 'rounds')::int;
  roster_max int := (s ->> 'rosterMax')::int;
  ord text[];
  run bigint;
  rnd int;
  tm text;
  c record;
  any_pending boolean;
  used int := 0;
  wins int := 0;
  owner text;
  tx bigint;
begin
  select array_agg(o.team_id order by o.place) into ord from public.waiver_order(p_season) o;
  insert into public.waiver_runs (season, cycle, ran_by, kind, team_order) values (p_season, p_cycle, p_by, p_kind, coalesce(ord, '{}')) returning id into run;
  for rnd in 1 .. max_r loop
    exit when not exists (select 1 from public.waiver_claims w where w.season = p_season and w.status = 'pending');
    used := rnd;
    foreach tm in array coalesce(ord, '{}') loop
      for c in select * from public.waiver_claims w where w.season = p_season and w.team_id = tm and w.status = 'pending' order by w.rank, w.id loop
        owner := private.owner_of(p_season, c.add_player);
        if owner is not null then
          update public.waiver_claims set status = 'lost', run_id = run, processed_at = now(),
            result = case when owner = tm then 'Already on your roster' else 'Claimed by ' || coalesce((select t.name from public.teams t where t.id = owner), owner) end
          where id = c.id;
          continue;
        end if;
        if c.drop_player is not null and private.owner_of(p_season, c.drop_player) is distinct from tm then
          update public.waiver_claims set status = 'skipped', run_id = run, processed_at = now(), result = 'The player to drop is no longer on the roster' where id = c.id;
          continue;
        end if;
        if c.drop_player is null and private.roster_size(p_season, tm) + 1 > roster_max then
          update public.waiver_claims set status = 'skipped', run_id = run, processed_at = now(), result = 'Roster full (' || roster_max || ') and no drop' where id = c.id;
          continue;
        end if;
        -- Winner: this team's one move this round.
        if c.drop_player is not null then delete from public.roster_entries r where r.season = p_season and r.player_id = c.drop_player; end if;
        insert into public.roster_entries (season, team_id, player_id, acquired) values (p_season, tm, c.add_player, 'Waiv');
        insert into public.transactions (season, team_id, type, status, players_in, players_out, via, waiver_run_id, created_by, decided_at)
        values (p_season, tm, (case when c.drop_player is null then 'add' else 'add_drop' end)::public.transaction_type, 'processed', array[c.add_player],
                case when c.drop_player is null then '{}' else array[c.drop_player] end, 'waiver', run, c.created_by, now())
        returning id into tx;
        update public.waiver_claims set status = 'won', run_id = run, processed_at = now(), result = 'Round ' || rnd where id = c.id;
        wins := wins + 1;
        exit;   -- next team
      end loop;
    end loop;
  end loop;
  update public.waiver_claims set status = 'lost', run_id = run, processed_at = now(), result = 'Not reached in ' || max_r || ' rounds'
   where season = p_season and status = 'pending';
  update public.waiver_runs set rounds_used = used, won = wins where id = run;
  return run;
end;
$$;

-- Scheduled: hourly on UTC Wednesdays/Thursdays; runs once per cycle, after its processing time (ET),
-- for seasons that are live and in their add/drop window.
create function private.waivers_tick(p_now timestamptz default now()) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  ss record;
  w record;
  v_cycle timestamptz;
  done text := '';
begin
  for ss in select s.season from public.season_settings s where coalesce((private.waiver_settings(s.season) ->> 'live')::boolean, false) loop
    -- The most recent processing time at or before now.
    select * into w from private.waiver_window(ss.season, p_now);
    v_cycle := case when p_now >= w.ends then w.ends else w.ends - interval '7 days' end;
    if p_now < v_cycle or p_now - v_cycle > interval '1 day' then continue; end if;
    if (select ms.status from private.move_status(ss.season, '__nobody__', v_cycle) ms) = 'closed' then continue; end if;
    if exists (select 1 from public.waiver_runs r where r.season = ss.season and r.cycle = v_cycle and r.kind = 'scheduled' and r.status = 'done') then continue; end if;
    perform private.process_waivers(ss.season, v_cycle, 'scheduled', null);
    done := done || ss.season || ' ';
  end loop;
  return coalesce(nullif(done, ''), 'nothing to do');
end;
$$;

-- Commissioner: process now (forced), undo a run, reverse a drop reported within 30 minutes.
create function public.run_waivers_now(p_season int) returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  run bigint;
begin
  if not private.is_commissioner() then raise exception 'Only the commissioner can process waivers' using errcode = '42501'; end if;
  run := private.process_waivers(p_season, now(), 'forced', (select auth.uid()));
  insert into public.audit_log (actor, action, season, details) values ((select auth.uid()), 'waivers:run', p_season, jsonb_build_object('run', run));
  return run;
end;
$$;

create function public.undo_waiver_run(p_run bigint) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  r public.waiver_runs%rowtype;
  t record;
  problems text[] := '{}';
begin
  if not private.is_commissioner() then raise exception 'Only the commissioner can undo a waiver run' using errcode = '42501'; end if;
  select * into r from public.waiver_runs w where w.id = p_run for update;
  if r.id is null or r.status <> 'done' then raise exception 'That run isn''t undoable' using errcode = '22023'; end if;
  for t in select * from public.transactions x where x.waiver_run_id = p_run and x.status = 'processed' order by x.id desc loop
    if private.owner_of(r.season, t.players_in[1]) = t.team_id then
      delete from public.roster_entries e where e.season = r.season and e.player_id = t.players_in[1];
    else
      problems := problems || (t.players_in[1] || ' is no longer on ' || t.team_id);
    end if;
    if array_length(t.players_out, 1) > 0 then
      if private.owner_of(r.season, t.players_out[1]) is null then
        insert into public.roster_entries (season, team_id, player_id, acquired) values (r.season, t.team_id, t.players_out[1], 'Restored');
      else
        problems := problems || (t.players_out[1] || ' was picked up by another team');
      end if;
    end if;
    update public.transactions set status = 'reversed', decided_by = (select auth.uid()), decided_at = now() where id = t.id;
  end loop;
  update public.waiver_claims set status = 'pending', run_id = null, processed_at = null, result = null where run_id = p_run;
  update public.waiver_runs set status = 'undone', undone_at = now(), undone_by = (select auth.uid()) where id = p_run;
  insert into public.audit_log (actor, action, season, details) values ((select auth.uid()), 'waivers:undo', r.season, jsonb_build_object('run', p_run, 'problems', problems));
  return case when array_length(problems, 1) > 0 then 'Undone, with problems: ' || array_to_string(problems, '; ') else 'Undone: claims are pending again' end;
end;
$$;

create function public.reverse_drop(p_transaction bigint, p_reported_at timestamptz default now()) returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  t public.transactions%rowtype;
  s jsonb;
  p text;
  nt bigint;
begin
  if not private.is_commissioner() then raise exception 'Only the commissioner can reverse a drop' using errcode = '42501'; end if;
  select * into t from public.transactions x where x.id = p_transaction for update;
  if t.id is null or coalesce(array_length(t.players_out, 1), 0) = 0 or t.status <> 'processed' then raise exception 'That isn''t a drop' using errcode = '22023'; end if;
  s := private.waiver_settings(t.season);
  if p_reported_at - t.created_at > make_interval(mins => (s ->> 'reverseDropMinutes')::int) or p_reported_at < t.created_at then
    raise exception 'Drops can be reversed only when reported within % minutes', (s ->> 'reverseDropMinutes') using errcode = '42501';
  end if;
  p := t.players_out[1];
  if private.owner_of(t.season, p) is not null then raise exception 'He has already been picked up' using errcode = '23505'; end if;
  insert into public.roster_entries (season, team_id, player_id, acquired) values (t.season, t.team_id, p, 'Restored');
  insert into public.transactions (season, team_id, type, status, players_in, via, reverses_id, note, created_by, decided_by, decided_at)
  values (t.season, t.team_id, 'add', 'processed', array[p], 'commissioner', t.id, 'Drop reversed (reported ' || to_char(p_reported_at at time zone 'America/New_York', 'FMHH12:MI AM') || ')',
          (select auth.uid()), (select auth.uid()), now())
  returning id into nt;
  -- The drop no longer counts toward the 24-hour drop lock.
  update public.transactions set status = 'reversed', decided_by = (select auth.uid()), decided_at = now() where id = t.id;
  insert into public.audit_log (actor, action, season, details)
  values ((select auth.uid()), 'waivers:reverse_drop', t.season, jsonb_build_object('transaction', t.id, 'player', p, 'team', t.team_id, 'dropped_at', t.created_at, 'reported_at', p_reported_at));
  return nt;
end;
$$;

-- 2026: MFL's transactions, imported by a server job (scripts/import-mfl-transactions.mts).
-- (service_role writes transactions directly; mfl_key keeps re-runs idempotent.)

revoke execute on function private.waiver_settings(int), private.owner_of(int, text), private.waiver_window(int, timestamptz),
  private.move_status(int, text, timestamptz), private.check_owner(text), private.timing_exempt(text), private.roster_size(int, text),
  private.player_kickoff_in_week(int, text, timestamptz), private.process_waivers(int, timestamptz, text, uuid), private.waivers_tick(timestamptz)
  from public, anon, authenticated;
revoke execute on function public.free_agents(int), public.waiver_order(int), public.roster_move(int, text, text, text),
  public.waiver_claim(int, text, text, text), public.waiver_reorder(int, text, bigint[]), public.waiver_update(bigint, text, boolean),
  public.run_waivers_now(int), public.undo_waiver_run(bigint), public.reverse_drop(bigint, timestamptz) from public, anon;
grant execute on function public.free_agents(int), public.waiver_order(int), public.roster_move(int, text, text, text),
  public.waiver_claim(int, text, text, text), public.waiver_reorder(int, text, bigint[]), public.waiver_update(bigint, text, boolean),
  public.run_waivers_now(int), public.undo_waiver_run(bigint), public.reverse_drop(bigint, timestamptz) to authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    perform cron.schedule('b5-waivers', '5 * * * 3,4', 'select private.waivers_tick()');
  end if;
end $$;
