-- 1) Lineups are public. B5 doesn't hide lineups: every team's submitted lineup is visible to
--    everyone (signed in or not), before and after kickoff. lineup_slots becomes public read and
--    live_lineups reveals every slot. public.lineup_status(season, week): when each team's lineup
--    was last submitted on the site and by whom (the name only for league members).
-- 2) More email types (same notify queue, Edge Function, toggles and one-click unsubscribe):
--    lineup_saved (default on: my team's lineup was saved; both owners; debounced 10 minutes),
--    league_lineups (off / digest / instant, optionally only my opponent: digest at 9 AM ET on game
--    days and 30 minutes before each game day's first kickoff; instant debounced 10 minutes per
--    team), league_trades (off: completed trades league-wide; pending proposals stay private),
--    waivers now default on (my results with the reason), league_waivers (off: each run's results),
--    league_moves (off: first-come-first-served adds/drops, one digest per hour), scoring (off:
--    after the nightly final scoring run for a day with games). Commissioner: email a team its
--    lineup, or remind teams that haven't submitted (sent as commissioner messages, audited).
-- 3) Priority under Resend's free tier (100/day): DMs, mentions, trades and commissioner messages
--    may use up to 95 a day; waivers and league trades/moves stop at 85; lineup emails at 75;
--    scoring digests at 60 (monthly: 2,900 / 2,700 / 2,500 / 2,200). Higher priority is claimed
--    first, so a digest never takes a DM's or a trade's place.
-- Lineup emails come only from saves on the site (lineup_meta / team_activity are written for
-- people, never for server jobs), so the 2026 MFL mirror sends nothing.

-- ---------------------------------------------------------------------------
-- 1) Public lineups
-- ---------------------------------------------------------------------------
drop policy "read own or locked" on public.lineup_slots;
create policy "everyone reads" on public.lineup_slots for select to anon, authenticated using (true);
grant select on public.lineup_slots to anon;

create or replace function public.live_lineups(p_season int, p_week int)
returns table (team_id text, slot smallint, player_id text, name text, pos text, nfl_team text, revealed boolean, bye boolean, injury text)
language sql stable security definer set search_path = ''
as $$
  with wk as (select count(*) as games from public.nfl_games g where g.season = p_season and g.week = p_week)
  select s.team_id, s.slot, s.player_id, p.name, p.position, p.nfl_team, true,
         (private.player_kickoff(s.season, s.week, s.player_id) is null and wk.games > 0), i.status
  from public.lineup_slots s
  join public.nfl_players p on p.id = s.player_id
  left join public.player_injuries i on i.season = s.season and i.week = s.week and i.player_id = s.player_id
  cross join wk
  where s.season = p_season and s.week = p_week
  order by s.team_id, s.slot
$$;

create function public.lineup_status(p_season int, p_week int)
returns table (team_id text, submitted_at timestamptz, submitted_by text, starters int)
language sql stable security definer set search_path = ''
as $$
  select t.id, m.changed_at,
         case when private.is_member() and m.changed_by is not null then coalesce(nullif(p.display_name, ''), 'an owner') end,
         (select count(*)::int from public.lineup_slots s where s.season = p_season and s.week = p_week and s.team_id = t.id and s.player_id is not null)
  from public.teams t
  left join public.lineup_meta m on m.season = p_season and m.week = p_week and m.team_id = t.id
  left join public.profiles p on p.id = m.changed_by
  order by t.id
$$;
revoke execute on function public.lineup_status(int, int) from public;
grant execute on function public.lineup_status(int, int) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2) Settings and kinds
-- ---------------------------------------------------------------------------
alter table public.notify_settings
  add column lineup_saved boolean not null default true,
  add column league_lineups text not null default 'off' check (league_lineups in ('off', 'digest', 'instant')),
  add column league_lineups_opponent boolean not null default false,
  add column league_trades boolean not null default false,
  add column league_waivers boolean not null default false,
  add column league_moves boolean not null default false,
  add column scoring boolean not null default false,
  alter column waivers set default true;

alter table public.notify_queue drop constraint notify_queue_kind_check;
alter table public.notify_queue add constraint notify_queue_kind_check check (kind in
  ('dm', 'mentions', 'trades', 'waivers', 'announcements', 'lineup', 'lineup_saved', 'league_lineups', 'league_trades', 'league_waivers', 'league_moves', 'scoring'));

create or replace function private.notify_on(p_user uuid, p_kind text) returns boolean
language sql stable security definer set search_path = ''
as $$
  select case when s.user_id is null then p_kind in ('dm', 'trades', 'announcements', 'lineup_saved', 'waivers')
              when s.paused then false
              when p_kind = 'league_lineups' then s.league_lineups <> 'off'
              else coalesce((to_jsonb(s) ->> p_kind)::boolean, false) end
  from (select 1) one left join public.notify_settings s on s.user_id = p_user
$$;

-- Priority (1 = highest) and the daily / monthly cap each priority may use.
create function private.notify_priority(p_kind text) returns int
language sql immutable set search_path = ''
as $$ select case when p_kind in ('dm', 'mentions', 'trades', 'announcements') then 1
                  when p_kind in ('waivers', 'league_trades', 'league_waivers', 'league_moves') then 2
                  when p_kind in ('lineup_saved', 'league_lineups', 'lineup') then 3
                  else 4 end $$;
create function private.notify_cap(p_priority int, p_month boolean) returns int
language sql immutable set search_path = ''
as $$ select case when p_month then (array[2900, 2700, 2500, 2200])[p_priority] else (array[95, 85, 75, 60])[p_priority] end $$;

create or replace function public.notify_unsubscribe(p_token text) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  m text[] := regexp_match(coalesce(p_token, ''), '^([0-9a-f-]{36})\.([a-z_]+)\.([0-9a-f]{32})$');
  u uuid;
begin
  if m is null or m[2] not in ('dm', 'mentions', 'trades', 'waivers', 'announcements', 'lineup', 'lineup_saved', 'league_lineups', 'league_trades', 'league_waivers', 'league_moves', 'scoring') then
    raise exception 'That link isn''t valid' using errcode = '22023';
  end if;
  u := m[1]::uuid;
  if m[3] <> private.notify_sig(u, m[2]) or not exists (select 1 from public.profiles where id = u) then
    raise exception 'That link isn''t valid' using errcode = '22023';
  end if;
  insert into public.notify_settings (user_id) values (u) on conflict (user_id) do nothing;
  execute format('update public.notify_settings set %I = %L where user_id = %L', m[2], case when m[2] = 'league_lineups' then 'off' else 'false' end, u);
  update public.notify_queue set status = 'skipped', reason = 'unsubscribed', updated_at = now() where user_id = u and kind = m[2] and status = 'pending';
  return m[2];
end;
$$;

-- Debounced enqueue: a pending email for the same subject waits another p_delay (repeated changes = one email).
create function private.notify_enqueue_debounced(p_user uuid, p_kind text, p_ref text, p_delay interval) returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  if p_user is null or not private.notify_on(p_user, p_kind) then return false; end if;
  update public.notify_queue set due_at = now() + p_delay, updated_at = now()
   where user_id = p_user and kind = p_kind and ref = p_ref and status = 'pending';
  if found then return true; end if;
  return private.notify_enqueue(p_user, p_kind, p_ref, now() + p_delay);
end;
$$;

create function private.team_of(p_user uuid) returns text
language sql stable security definer set search_path = ''
as $$ select tm.team_id from public.team_managers tm where tm.user_id = p_user order by tm.team_id limit 1 $$;
create function private.opponent(p_season int, p_week int, p_team text) returns text
language sql stable security definer set search_path = ''
as $$ select case when m.home_team = p_team then m.away_team else m.home_team end from public.matchups m
      where m.season = p_season and m.week = p_week and p_team in (m.home_team, m.away_team) limit 1 $$;

-- ---------------------------------------------------------------------------
-- Event triggers
-- ---------------------------------------------------------------------------
-- A lineup saved on the site (lineup_meta is written only for people's saves).
create function private.notify_on_lineup_saved() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare u uuid; r text := new.season || ':' || new.week || ':' || new.team_id;
begin
  if tg_op = 'UPDATE' and new.changed_at is not distinct from old.changed_at then return null; end if;
  for u in select private.team_owner_ids(array[new.team_id]) loop
    perform private.notify_enqueue_debounced(u, 'lineup_saved', 'lsaved:' || r, interval '10 minutes');
  end loop;
  for u in select ns.user_id from public.notify_settings ns
           where ns.league_lineups = 'instant' and not ns.paused
             and ns.user_id not in (select private.team_owner_ids(array[new.team_id]))
             and (not ns.league_lineups_opponent or private.opponent(new.season, new.week, private.team_of(ns.user_id)) = new.team_id) loop
    if u in (select private.member_ids()) then perform private.notify_enqueue_debounced(u, 'league_lineups', 'linst:' || r, interval '10 minutes'); end if;
  end loop;
  return null;
end;
$$;
create trigger notify_on_lineup_saved after insert or update on public.lineup_meta for each row execute function private.notify_on_lineup_saved();

-- Trades: my trades as before; completed trades also league-wide (pending proposals stay private).
create or replace function private.notify_on_trade() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare u uuid; who uuid[];
begin
  if tg_op = 'UPDATE' and new.status = old.status then return null; end if;
  who := case new.status
    when 'proposed' then array(select private.team_owner_ids(array[new.to_team]))
    when 'accepted' then array(select private.team_owner_ids(array[new.from_team])
                               union select p.id from public.profiles p where p.is_commissioner)
    else array(select private.team_owner_ids(array[new.from_team, new.to_team])) end;
  foreach u in array who loop
    if u is distinct from (select auth.uid()) then
      perform private.notify_enqueue(u, 'trades', 'trade:' || new.id || ':' || new.status, now() + interval '1 minute');
    end if;
  end loop;
  if new.status = 'approved' then
    for u in select private.member_ids() loop
      if u not in (select private.team_owner_ids(array[new.from_team, new.to_team])) then
        perform private.notify_enqueue(u, 'league_trades', 'trade:' || new.id || ':approved', now() + interval '1 minute');
      end if;
    end loop;
  end if;
  return null;
end;
$$;

-- League-wide waiver results: one email per run.
create function private.notify_on_waiver_run() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare u uuid;
begin
  for u in select private.member_ids() loop perform private.notify_enqueue(u, 'league_waivers', 'lrun:' || new.id, now() + interval '3 minutes'); end loop;
  return null;
end;
$$;
create trigger notify_on_waiver_run after insert on public.waiver_runs for each row execute function private.notify_on_waiver_run();

-- First-come-first-served adds/drops league-wide: one digest per clock hour.
create function private.notify_on_move() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare u uuid; h timestamptz := date_trunc('hour', now());
begin
  if new.status <> 'processed' or new.via not in ('free_agent', 'commissioner') or new.type = 'trade' then return null; end if;
  for u in select private.member_ids() loop
    perform private.notify_enqueue(u, 'league_moves', 'moves:' || extract(epoch from h)::bigint, h + interval '1 hour');
  end loop;
  return null;
end;
$$;
create trigger notify_on_move after insert on public.transactions for each row execute function private.notify_on_move();

-- Other teams' lineups, digest mode (cron every 15 minutes): 9 AM ET on game days and 30 minutes
-- before each game day's first kickoff.
create function private.enqueue_lineup_digests(p_now timestamptz default now()) returns int
language plpgsql security definer set search_path = ''
as $$
declare t timestamptz; u uuid; n int := 0;
begin
  for t in
    with days as (select (g.kickoff at time zone 'America/New_York')::date as d, min(g.kickoff) as first_kick
                  from public.nfl_games g where g.kickoff between p_now - interval '1 day' and p_now + interval '2 days' group by 1)
    select distinct x.t from (select ((d + time '09:00') at time zone 'America/New_York') as t from days
                              union select first_kick - interval '30 minutes' from days) x
    where p_now >= x.t and p_now < x.t + interval '15 minutes'
  loop
    for u in select ns.user_id from public.notify_settings ns where ns.league_lineups = 'digest' and not ns.paused loop
      if u in (select private.member_ids()) and private.notify_enqueue(u, 'league_lineups', 'ldig:' || extract(epoch from t)::bigint, p_now) then n := n + 1; end if;
    end loop;
  end loop;
  return n;
end;
$$;

-- Daily scoring update: called by the nightly workflow when final scoring is done. The game day is
-- the Eastern date before the run; nothing on days without games; once per game day.
create table private.scoring_runs (
  game_day date primary key,
  season int not null,
  week int not null,
  corrections jsonb not null default '[]',
  at timestamptz not null default now()
);
create table private.scoring_snapshot (season int, week int, results jsonb not null, primary key (season, week));
revoke all on private.scoring_runs, private.scoring_snapshot from public, anon, authenticated;

create function public.enqueue_scoring_update(p_now timestamptz default now()) returns int
language plpgsql security definer set search_path = ''
as $$
declare
  gday date := (p_now at time zone 'America/New_York')::date - 1;
  g record;
  cur jsonb;
  prev jsonb;
  corr jsonb := '[]';
  u uuid;
  n int := 0;
begin
  select ng.season, ng.week into g from public.nfl_games ng where (ng.kickoff at time zone 'America/New_York')::date = gday order by ng.kickoff limit 1;
  if g.season is null or exists (select 1 from private.scoring_runs r where r.game_day = gday) then return 0; end if;
  -- Results now vs the last update: a stat correction that flipped a game.
  select coalesce(jsonb_object_agg(m.away_team || '-' || m.home_team,
           case when m.away_score > m.home_score then m.away_team when m.home_score > m.away_score then m.home_team else 'tie' end), '{}')
    into cur from public.matchups m where m.season = g.season and m.week = g.week and m.away_score is not null and m.home_score is not null;
  select s.results into prev from private.scoring_snapshot s where s.season = g.season and s.week = g.week;
  if prev is not null then
    select coalesce(jsonb_agg(jsonb_build_object('game', k, 'was', prev ->> k, 'now', cur ->> k)), '[]') into corr
      from jsonb_object_keys(cur) k where prev ? k and prev ->> k <> cur ->> k;
  end if;
  insert into private.scoring_snapshot (season, week, results) values (g.season, g.week, cur)
    on conflict (season, week) do update set results = excluded.results;
  insert into private.scoring_runs (game_day, season, week, corrections) values (gday, g.season, g.week, corr);
  for u in select private.member_ids() loop
    if private.notify_enqueue(u, 'scoring', 'score:' || gday, p_now) then n := n + 1; end if;
  end loop;
  return n;
end;
$$;

-- Commissioner: email a team's owners its current lineup; remind teams that haven't submitted.
-- Sent as commissioner messages (the "announcements" setting). Audited.
create function public.commish_email_lineup(p_season int, p_week int, p_team text) returns int
language plpgsql security definer set search_path = ''
as $$
declare u uuid; n int := 0; e bigint := extract(epoch from now())::bigint;
begin
  if not private.is_commissioner() then raise exception 'Only the commissioner sends these' using errcode = '42501'; end if;
  for u in select private.team_owner_ids(array[p_team]) loop
    if private.notify_enqueue(u, 'announcements', 'clineup:' || p_season || ':' || p_week || ':' || p_team || ':' || e, now()) then n := n + 1; end if;
  end loop;
  insert into public.audit_log (actor, action, season, week, details) values ((select auth.uid()), 'notify:lineup_email', p_season, p_week, jsonb_build_object('team', p_team, 'emails', n));
  return n;
end;
$$;
create function public.commish_lineup_reminders(p_season int, p_week int) returns int
language plpgsql security definer set search_path = ''
as $$
declare t text; u uuid; n int := 0; teams text[] := '{}'; e bigint := extract(epoch from now())::bigint;
begin
  if not private.is_commissioner() then raise exception 'Only the commissioner sends these' using errcode = '42501'; end if;
  for t in select tm.id from public.teams tm where not exists (select 1 from public.lineup_meta m where m.season = p_season and m.week = p_week and m.team_id = tm.id) loop
    teams := teams || t;
    for u in select private.team_owner_ids(array[t]) loop
      if private.notify_enqueue(u, 'announcements', 'cremind:' || p_season || ':' || p_week || ':' || t || ':' || e, now()) then n := n + 1; end if;
    end loop;
  end loop;
  insert into public.audit_log (actor, action, season, week, details) values ((select auth.uid()), 'notify:lineup_reminder', p_season, p_week, jsonb_build_object('teams', teams, 'emails', n));
  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- Payloads
-- ---------------------------------------------------------------------------
create function private.lineup_payload(p_season int, p_week int, p_team text) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('team', private.team_name(p_team), 'week', p_week,
    'starters', (select jsonb_agg(jsonb_build_object('slot', (array['QB','RB','RB','WR','WR','WR','TE','K','DEF'])[s.slot + 1], 'name', np.name, 'nfl', np.nfl_team) order by s.slot)
                 from public.lineup_slots s join public.nfl_players np on np.id = s.player_id
                 where s.season = p_season and s.week = p_week and s.team_id = p_team),
    'bench', (select jsonb_agg(jsonb_build_object('pos', np.position, 'name', np.name, 'nfl', np.nfl_team) order by np.position, np.name)
              from public.roster_entries r join public.nfl_players np on np.id = r.player_id
              where r.season = p_season and r.team_id = p_team
                and r.player_id not in (select s.player_id from public.lineup_slots s where s.season = p_season and s.week = p_week and s.team_id = p_team and s.player_id is not null)),
    'warnings', (select jsonb_agg(jsonb_build_object('name', lp.name, 'pos', lp.pos, 'problem', lp.problem)) from private.lineup_problems(p_season, p_week, p_team) lp),
    'saved_by', (select coalesce(nullif(p.display_name, ''), 'an owner') from public.lineup_meta m left join public.profiles p on p.id = m.changed_by
                 where m.season = p_season and m.week = p_week and m.team_id = p_team),
    'saved_at', (select m.changed_at from public.lineup_meta m where m.season = p_season and m.week = p_week and m.team_id = p_team))
$$;

-- Lineup changes by other teams since p_since (team_activity: people's saves only).
create function private.lineup_changes(p_user uuid, p_since timestamptz, p_until timestamptz, p_only_team text default null) returns jsonb
language sql stable security definer set search_path = ''
as $$
  with mine as (select private.team_of(p_user) as team),
  ch as (
    select a.team_id, a.season, a.week, max(a.at) as at,
           (array_agg(coalesce(nullif(p.display_name, ''), 'an owner') order by a.at desc))[1] as by
    from public.team_activity a left join public.profiles p on p.id = a.actor
    where a.kind = 'lineup' and a.at > p_since and a.at <= p_until
      and a.team_id is distinct from (select team from mine)
      and (p_only_team is null or a.team_id = p_only_team)
    group by a.team_id, a.season, a.week)
  select coalesce(jsonb_agg(private.lineup_payload(ch.season, ch.week, ch.team_id) || jsonb_build_object('by', ch.by, 'at', ch.at) order by ch.at), '[]')
  from ch, (select ns.league_lineups_opponent as opp from public.notify_settings ns where ns.user_id = p_user) s
  where not s.opp or ch.team_id = private.opponent(ch.season, ch.week, (select team from mine))
$$;

create function private.scoring_payload(p_user uuid, p_day date) returns jsonb
language sql stable security definer set search_path = ''
as $$
  with r as (select * from private.scoring_runs where game_day = p_day),
  mine as (select private.team_of(p_user) as team),
  ms as (select m.* from public.matchups m, r where m.season = r.season and m.week = r.week),
  ts as (select s.* from public.team_scores s, r where s.season = r.season and s.week = r.week),
  alive as (select t.id from public.teams t, r where t.id not in (select g.team_id from public.guillotine g where g.season = r.season and g.week < r.week))
  select jsonb_build_object('day', p_day, 'week', r.week,
    'unofficial', coalesce((select sw.status from public.score_weeks sw where sw.season = r.season and sw.week = r.week), 'live') <> 'final',
    'mine', (select jsonb_build_object('team', private.team_name((select team from mine)),
               'us', case when ms.home_team = (select team from mine) then ms.home_score else ms.away_score end,
               'opp', private.team_name(case when ms.home_team = (select team from mine) then ms.away_team else ms.home_team end),
               'them', case when ms.home_team = (select team from mine) then ms.away_score else ms.home_score end)
             from ms where (select team from mine) in (ms.home_team, ms.away_team) limit 1),
    'matchups', (select jsonb_agg(jsonb_build_object('away', private.team_name(ms.away_team), 'away_score', ms.away_score, 'home', private.team_name(ms.home_team), 'home_score', ms.home_score) order by ms.away_team) from ms),
    'high', (select jsonb_build_object('team', private.team_name(ts.team_id), 'points', ts.points) from ts order by ts.points desc limit 1),
    'danger', (select jsonb_build_object('team', private.team_name(ts.team_id), 'points', ts.points) from ts where ts.team_id in (select id from alive) and (select count(*) from alive) > 1 order by ts.points asc limit 1),
    'corrections', (select coalesce(jsonb_agg(jsonb_build_object('game', c ->> 'game', 'was', private.team_name(c ->> 'was'), 'now', private.team_name(c ->> 'now'))), '[]') from jsonb_array_elements(r.corrections) c),
    'link', '#live/' || r.week)
  from r
$$;

-- ---------------------------------------------------------------------------
-- Claim: priority order and per-priority caps; new kinds' payloads.
-- ---------------------------------------------------------------------------
create or replace function public.notify_claim(p_limit int default 25, p_now timestamptz default now())
returns table (id bigint, user_id uuid, kind text, email text, token text, data jsonb)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  q public.notify_queue;
  addr text;
  d jsonb;
  unread int;
  last_sent timestamptz;
  ref_id bigint;
  t public.trades;
  parts text[];
  day_count int;
  month_count int;
  pri int;
  claimed int := 0;
  mode text;
begin
  update public.notify_queue nq set status = 'pending', updated_at = p_now where nq.status = 'sending' and nq.updated_at < p_now - interval '10 minutes';
  select count(*) filter (where l.at >= date_trunc('day', p_now)), count(*) into day_count, month_count
    from public.email_log l where l.status = 'sent' and l.at >= date_trunc('month', p_now);
  for q in select * from public.notify_queue nq where nq.status = 'pending' and nq.due_at <= p_now
           order by private.notify_priority(nq.kind), nq.due_at limit p_limit for update skip locked loop
    select u.email into addr from auth.users u where u.id = q.user_id;
    if addr is null then perform private.notify_skip(q, 'no email'); continue; end if;
    if q.user_id not in (select private.member_ids()) then perform private.notify_skip(q, 'not a member'); continue; end if;
    if not private.notify_on(q.user_id, q.kind) then perform private.notify_skip(q, 'turned off'); continue; end if;
    pri := private.notify_priority(q.kind);
    if day_count + claimed >= private.notify_cap(pri, false) or month_count + claimed >= private.notify_cap(pri, true) then
      perform private.notify_skip(q, 'free-tier limit'); continue;
    end if;
    d := null;
    parts := string_to_array(q.ref, ':');
    ref_id := case when parts[2] ~ '^\d+$' then parts[2]::bigint end;

    if q.kind in ('dm', 'mentions') and exists (select 1 from public.user_presence pr where pr.user_id = q.user_id and pr.seen_at > p_now - interval '2 minutes') then
      perform private.notify_skip(q, 'active on the site'); continue;
    end if;

    if q.kind = 'dm' then
      select count(*) into unread from public.dm_messages m
       where m.conversation_id = ref_id and not m.is_bot and m.author_id is distinct from q.user_id
         and m.created_at > coalesce((select r.read_at from public.dm_reads r where r.conversation_id = ref_id and r.user_id = q.user_id), '-infinity');
      if unread = 0 then perform private.notify_skip(q, 'already read'); continue; end if;
      select max(l.at) into last_sent from public.email_log l where l.user_id = q.user_id and l.kind = 'dm' and l.ref = q.ref and l.status = 'sent';
      if last_sent is not null and last_sent > p_now - interval '30 minutes' then
        update public.notify_queue nq set due_at = last_sent + interval '30 minutes', updated_at = p_now where nq.id = q.id;
        continue;
      end if;
      d := jsonb_build_object('count', unread, 'link', '#dm/' || ref_id,
        'senders', (select jsonb_agg(distinct private.person(m.author_id)) from public.dm_messages m
                    where m.conversation_id = ref_id and not m.is_bot and m.author_id is distinct from q.user_id
                      and m.created_at > coalesce((select r.read_at from public.dm_reads r where r.conversation_id = ref_id and r.user_id = q.user_id), '-infinity')),
        'preview', (select private.preview(m.body) from public.dm_messages m where m.conversation_id = ref_id and not m.is_bot and m.author_id is distinct from q.user_id order by m.id desc limit 1));
    elsif q.kind = 'mentions' then
      if parts[1] = 'chat' then
        select jsonb_build_object('where', 'Chat', 'from', private.person(m.author_id), 'preview', private.preview(m.body), 'link', '#chat/' || m.room_id)
          into d from public.chat_messages m where m.id = ref_id;
      else
        select jsonb_build_object('where', 'the Message Board', 'from', private.person(p.author_id), 'preview', private.preview(p.body), 'link', '#board/' || p.thread_id,
          'title', (select th.title from public.board_threads th where th.id = p.thread_id))
          into d from public.board_posts p where p.id = ref_id;
      end if;
      if d is null then perform private.notify_skip(q, 'deleted'); continue; end if;
    elsif q.kind in ('trades', 'league_trades') then
      select * into t from public.trades tr where tr.id = ref_id;
      if t.id is null then perform private.notify_skip(q, 'deleted'); continue; end if;
      d := jsonb_build_object('status', parts[3], 'test', t.test, 'summary', private.trade_summary(t), 'note', t.note, 'decision_note', t.decision_note,
        'from_team', private.team_name(t.from_team), 'to_team', private.team_name(t.to_team), 'expires_at', t.expires_at,
        'commissioner_party', t.commissioner_party, 'link', '#trades');
    elsif q.kind = 'waivers' then
      d := jsonb_build_object('link', '#players/results', 'claims', (select jsonb_agg(jsonb_build_object('player', coalesce(np.name, c.add_player), 'drop', dp.name,
               'status', c.status, 'result', c.result) order by c.rank)
             from public.waiver_claims c left join public.nfl_players np on np.id = c.add_player left join public.nfl_players dp on dp.id = c.drop_player
             where c.run_id = ref_id and c.team_id = parts[3]));
      if d ->> 'claims' is null then perform private.notify_skip(q, 'undone'); continue; end if;
    elsif q.kind = 'league_waivers' then
      d := jsonb_build_object('link', '#players/results', 'won', (select jsonb_agg(jsonb_build_object('team', private.team_name(c.team_id), 'player', coalesce(np.name, c.add_player), 'drop', dp.name) order by c.team_id)
             from public.waiver_claims c left join public.nfl_players np on np.id = c.add_player left join public.nfl_players dp on dp.id = c.drop_player
             join public.waiver_runs wr on wr.id = c.run_id and wr.status = 'done'
             where c.run_id = ref_id and c.status = 'won'),
           'claims', (select count(*) from public.waiver_claims c where c.run_id = ref_id));
      if d ->> 'won' is null then perform private.notify_skip(q, 'no claims won'); continue; end if;
    elsif q.kind = 'league_moves' then
      d := jsonb_build_object('link', '#players/log', 'moves', (select jsonb_agg(jsonb_build_object('team', private.team_name(x.team_id),
               'added', (select string_agg(coalesce(np.name, a), ', ') from unnest(x.players_in) a left join public.nfl_players np on np.id = a),
               'dropped', (select string_agg(coalesce(np.name, b), ', ') from unnest(x.players_out) b left join public.nfl_players np on np.id = b)) order by x.created_at)
             from public.transactions x where x.status = 'processed' and x.via in ('free_agent', 'commissioner') and x.type <> 'trade'
               and x.created_at >= to_timestamp(ref_id) and x.created_at < to_timestamp(ref_id) + interval '1 hour'));
      if d ->> 'moves' is null then perform private.notify_skip(q, 'no moves'); continue; end if;
    elsif q.kind = 'lineup_saved' then
      d := private.lineup_payload(parts[2]::int, parts[3]::int, parts[4]) || jsonb_build_object('link', '#myteam');
      if d ->> 'starters' is null then perform private.notify_skip(q, 'empty lineup'); continue; end if;
    elsif q.kind = 'league_lineups' then
      select ns.league_lineups into mode from public.notify_settings ns where ns.user_id = q.user_id;
      if (parts[1] = 'ldig' and mode <> 'digest') or (parts[1] = 'linst' and mode <> 'instant') then perform private.notify_skip(q, 'mode changed'); continue; end if;
      if parts[1] = 'ldig' then
        select max(l.at) into last_sent from public.email_log l where l.user_id = q.user_id and l.kind = 'league_lineups' and l.status = 'sent';
        d := jsonb_build_object('mode', 'digest', 'link', '#teams', 'teams', private.lineup_changes(q.user_id, coalesce(last_sent, p_now - interval '7 days'), p_now));
      else
        d := jsonb_build_object('mode', 'instant', 'link', '#team/' || parts[4],
          'teams', private.lineup_changes(q.user_id, p_now - interval '1 day', p_now, parts[4]));
      end if;
      if jsonb_array_length(d -> 'teams') = 0 then perform private.notify_skip(q, 'no changes'); continue; end if;
    elsif q.kind = 'scoring' then
      d := private.scoring_payload(q.user_id, parts[2]::date);
      if d is null then perform private.notify_skip(q, 'no scoring run'); continue; end if;
    elsif q.kind = 'announcements' then
      if parts[1] = 'board' then
        select jsonb_build_object('title', th.title, 'preview', private.preview((select p.body from public.board_posts p where p.thread_id = th.id and p.is_opener limit 1)), 'link', '#board/' || th.id)
          into d from public.board_threads th where th.id = ref_id;
      elsif parts[1] = 'clineup' then
        d := private.lineup_payload(parts[2]::int, parts[3]::int, parts[4]) || jsonb_build_object('commissioner', 'lineup', 'link', '#myteam');
      elsif parts[1] = 'cremind' then
        d := jsonb_build_object('commissioner', 'reminder', 'team', private.team_name(parts[4]), 'week', parts[3]::int, 'link', '#myteam',
          'first_kickoff', (select min(g.kickoff) from public.nfl_games g where g.season = parts[2]::int and g.week = parts[3]::int and g.kickoff > p_now));
        if exists (select 1 from public.lineup_meta m where m.season = parts[2]::int and m.week = parts[3]::int and m.team_id = parts[4]) then
          perform private.notify_skip(q, 'submitted since'); continue;
        end if;
      else
        select jsonb_build_object('title', a.title, 'preview', private.preview(regexp_replace(a.body_html, '<[^>]*>', ' ', 'g')), 'link', '#home')
          into d from public.announcements a where a.id = ref_id and a.published_at is not null;
      end if;
      if d is null then perform private.notify_skip(q, 'deleted'); continue; end if;
    elsif q.kind = 'lineup' then
      d := jsonb_build_object('week', parts[3]::int, 'team', private.team_name(parts[4]), 'link', '#myteam',
        'players', (select jsonb_agg(jsonb_build_object('name', lp.name, 'pos', lp.pos, 'problem', lp.problem, 'deadline', lp.deadline))
                    from private.lineup_problems(parts[2]::int, parts[3]::int, parts[4]) lp));
      if d ->> 'players' is null then perform private.notify_skip(q, 'lineup fixed'); continue; end if;
    end if;

    update public.notify_queue nq set status = 'sending', attempts = nq.attempts + 1, updated_at = p_now where nq.id = q.id;
    claimed := claimed + 1;
    id := q.id; user_id := q.user_id; kind := q.kind; email := addr; token := private.notify_token(q.user_id, q.kind); data := d;
    return next;
  end loop;
end;
$$;

-- Commish: today's sends by priority (for the near-the-limit warning).
create function public.notify_usage() returns table (priority int, today int, month int)
language sql stable security definer set search_path = ''
as $$
  select p, (select count(*)::int from public.email_log l where l.status = 'sent' and private.notify_priority(l.kind) = p and l.at >= date_trunc('day', now())),
            (select count(*)::int from public.email_log l where l.status = 'sent' and private.notify_priority(l.kind) = p and l.at >= date_trunc('month', now()))
  from generate_series(1, 4) p where private.is_commissioner()
$$;

revoke execute on function private.notify_priority(text), private.notify_cap(int, boolean), private.notify_enqueue_debounced(uuid, text, text, interval),
  private.team_of(uuid), private.opponent(int, int, text), private.notify_on_lineup_saved(), private.notify_on_waiver_run(), private.notify_on_move(),
  private.enqueue_lineup_digests(timestamptz), private.lineup_payload(int, int, text), private.lineup_changes(uuid, timestamptz, timestamptz, text),
  private.scoring_payload(uuid, date) from public, anon, authenticated;
grant execute on function private.enqueue_lineup_digests(timestamptz) to service_role;
revoke execute on function public.enqueue_scoring_update(timestamptz), public.commish_email_lineup(int, int, text), public.commish_lineup_reminders(int, int), public.notify_usage() from public, anon, authenticated;
grant execute on function public.enqueue_scoring_update(timestamptz) to service_role;
grant execute on function public.commish_email_lineup(int, int, text), public.commish_lineup_reminders(int, int), public.notify_usage() to authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    perform cron.schedule('b5-lineup-digests', '*/15 * * * *', 'select private.enqueue_lineup_digests()');
  end if;
end $$;
