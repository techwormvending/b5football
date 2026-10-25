-- 2026 TEST lineups (same pattern as the Confidence Pool's test mode; the switch is the same season
-- setting: season_settings.pools.mode = 'test').
--
-- public.test_lineups: one row per team-week (9 player IDs in slot order QB RB RB WR WR WR TE K DEF),
-- who saved it and when; status 'test' during the week, 'archived' once the official lineups replace
-- it (kept next to the official one, so owners can see "your test lineup would have scored X").
-- Public read, like every lineup. Written only by public.save_test_lineup (either co-owner, or a
-- commissioner), which enforces on the server:
--   * test mode, and the week open (not over; it opens once the previous week's official lineups
--     were imported on Tuesday, or 36 hours after that week's last kickoff if the import keeps failing)
--   * a full lineup unless season_settings.lineups.allowPartial (default false): every slot filled
--   * players on the team's roster, in the right position, starting once
--   * per-player kickoff locks against the current lineup (the team's test lineup, or its official
--     one before the first test save): a starter whose game started stays in his slot; a player whose
--     game started can't move into the lineup; anyone else can move until his own kickoff.
-- Official lineups stay in lineup_slots (the MFL mirror during the week); scores, matchups, standings,
-- payouts and the guillotine read only lineup_slots, so test lineups never count.
-- Tuesday (the 6 AM ET pool-import job): the official MFL starting lineups of the finished week are
-- imported; only if that succeeds public.replace_week_lineups swaps them in (source MFL), archives the
-- week's test lineups and recomputes the week's matchup and team totals; the comparison with MFL's
-- weekly results is logged in public.lineup_imports (failed imports too: Admin shows them, the job
-- retries hourly that day).

alter table public.season_settings add column lineups jsonb not null default '{}';

create function private.lineup_allow_partial(p_season int) returns boolean
language sql stable security definer set search_path = ''
as $$ select coalesce((select (s.lineups ->> 'allowPartial')::boolean from public.season_settings s where s.season = p_season), false) $$;

create table public.test_lineups (
  season int not null,
  week int not null check (week between 1 and 18),
  team_id text not null references public.teams (id) on delete cascade,
  players text[] not null check (cardinality(players) = 9),
  saved_by uuid references public.profiles (id) on delete set null,
  saved_at timestamptz not null default now(),
  status text not null default 'test' check (status in ('test', 'archived')),
  archived_at timestamptz,
  primary key (season, week, team_id)
);
alter table public.test_lineups enable row level security;
create policy "everyone reads" on public.test_lineups for select to anon, authenticated using (true);
revoke all on public.test_lineups from anon, authenticated;
grant select on public.test_lineups to anon, authenticated;
grant all on public.test_lineups to service_role;

create table public.lineup_imports (
  season int not null,
  week int not null,
  status text not null check (status in ('ok', 'failed')),
  attempts int not null default 1,
  attempted_at timestamptz not null default now(),
  succeeded_at timestamptz,
  triggered_by text,
  teams int not null default 0,
  archived_test int not null default 0,
  message text,
  compare jsonb not null default '{}',
  primary key (season, week)
);
alter table public.lineup_imports enable row level security;
create policy "officers read" on public.lineup_imports for select to authenticated using (private.is_commissioner() or private.is_admin());
revoke all on public.lineup_imports from anon, authenticated;
grant select on public.lineup_imports to authenticated;
grant all on public.lineup_imports to service_role;

-- ---------------------------------------------------------------------------
-- Which week takes test lineups
-- ---------------------------------------------------------------------------
-- null = open; otherwise why not.
create function private.test_week_status(p_season int, p_week int, p_now timestamptz default now()) returns text
language plpgsql stable security definer set search_path = ''
as $$
declare last_k timestamptz; prev_k timestamptz;
begin
  if private.pools_mode(p_season) <> 'test' then return 'Test lineups are only for a test season'; end if;
  select max(g.kickoff) into last_k from public.nfl_games g where g.season = p_season and g.week = p_week;
  if last_k is null then return 'No NFL games in week ' || p_week; end if;
  if p_now >= last_k + interval '4 hours' then return 'Week ' || p_week || ' is over'; end if;
  select max(g.kickoff) into prev_k from public.nfl_games g where g.season = p_season and g.week = p_week - 1;
  if prev_k is not null and p_now < prev_k + interval '36 hours'
     and not exists (select 1 from public.lineup_imports i where i.season = p_season and i.week = p_week - 1 and i.status = 'ok') then
    return 'Week ' || p_week || ' opens after Tuesday''s import of the official week ' || (p_week - 1) || ' lineups';
  end if;
  return null;
end;
$$;
create function public.test_lineup_week(p_season int) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare w int; why text;
begin
  select g.week into w from public.nfl_games g where g.season = p_season group by g.week having max(g.kickoff) + interval '4 hours' > now() order by g.week limit 1;
  if w is null then return jsonb_build_object('week', null, 'open', false, 'reason', 'No weeks left this season'); end if;
  why := private.test_week_status(p_season, w);
  return jsonb_build_object('week', w, 'open', why is null, 'reason', why, 'test_mode', private.pools_mode(p_season) = 'test');
end;
$$;

-- ---------------------------------------------------------------------------
-- Saving a test lineup (every rule on the server)
-- ---------------------------------------------------------------------------
create function private.slot_pos(p_slot int) returns text
language sql immutable set search_path = ''
as $$ select (array['QB','RB','RB','WR','WR','WR','TE','K','DEF'])[p_slot + 1] $$;

create function public.save_test_lineup(p_season int, p_week int, p_team text, p_players text[]) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  why text;
  base text[];
  missing text[];
  i int;
  p text;
  pos text;
  nm text;
  locked_old boolean;
  locked_new boolean;
  row public.test_lineups;
begin
  if not (private.manages_team(p_team) or private.is_commissioner()) then
    raise exception 'You can only set your own team''s lineup' using errcode = '42501';
  end if;
  why := private.test_week_status(p_season, p_week);
  if why is not null then raise exception '%', why using errcode = '42501'; end if;
  if coalesce(cardinality(p_players), 0) <> 9 then raise exception 'A lineup has 9 slots (QB RB RB WR WR WR TE K DEF)' using errcode = '22023'; end if;
  p_players := array(select nullif(btrim(x), '') from unnest(p_players) x);
  missing := array(select private.slot_pos(k - 1) from generate_subscripts(p_players, 1) k where p_players[k] is null);
  if cardinality(missing) > 0 and not private.lineup_allow_partial(p_season) then
    raise exception 'Fill every slot before saving: missing %', array_to_string(missing, ', ') using errcode = '23514';
  end if;
  if (select count(x) <> count(distinct x) from unnest(p_players) x) then raise exception 'A player can only start once' using errcode = '23514'; end if;
  perform 1 from public.teams t where t.id = p_team for update;   -- two owners saving at once: one waits
  -- The lineup as it stands: the test lineup, or the official (MFL) one before the first test save.
  select tl.players into base from public.test_lineups tl where tl.season = p_season and tl.week = p_week and tl.team_id = p_team and tl.status = 'test';
  if base is null then
    base := array(select (select s.player_id from public.lineup_slots s where s.season = p_season and s.week = p_week and s.team_id = p_team and s.slot = k) from generate_series(0, 8) k);
  end if;
  for i in 1..9 loop
    p := p_players[i];
    if p is not null then
      select np.position, np.name into pos, nm from public.nfl_players np join public.roster_entries r on r.player_id = np.id and r.season = p_season and r.team_id = p_team where np.id = p;
      if pos is null then raise exception '% isn''t on your roster', p using errcode = '23514'; end if;
      if pos <> private.slot_pos(i - 1) then raise exception '% (%) can''t play %', nm, pos, private.slot_pos(i - 1) using errcode = '23514'; end if;
    end if;
    locked_old := base[i] is not null and coalesce(private.player_kickoff(p_season, p_week, base[i]) <= now(), false);
    locked_new := p is not null and coalesce(private.player_kickoff(p_season, p_week, p) <= now(), false);
    if locked_old and p is distinct from base[i] then
      raise exception '% is locked in the % slot: his game has started', coalesce((select name from public.nfl_players where id = base[i]), base[i]), private.slot_pos(i - 1) using errcode = '42501';
    end if;
    if locked_new and p is distinct from base[i] then
      raise exception '% can''t move into the lineup: his game has started', coalesce(nm, p) using errcode = '42501';
    end if;
  end loop;
  insert into public.test_lineups (season, week, team_id, players, saved_by, saved_at, status)
  values (p_season, p_week, p_team, p_players, (select auth.uid()), now(), 'test')
  on conflict (season, week, team_id) do update set players = excluded.players, saved_by = excluded.saved_by, saved_at = excluded.saved_at, status = 'test', archived_at = null
  returning * into row;
  return jsonb_build_object('saved_at', row.saved_at, 'saved_by', (select display_name from public.profiles where id = row.saved_by));
end;
$$;

-- 2027 (site lineups official): the same full-lineup rule for save_lineup.
create or replace function public.save_lineup(p_season int, p_week int, p_team text, p_players text[], p_expected_version int default null)
returns setof public.lineup_slots
language plpgsql security invoker set search_path = ''
as $$
declare
  m record;
  missing text[];
begin
  if coalesce(array_length(p_players, 1), 0) <> 9 then
    raise exception 'A lineup has 9 slots (QB RB RB WR WR WR TE K DEF)' using errcode = '22023';
  end if;
  if not (private.manages_team(p_team) or private.is_commissioner() or private.is_privileged()) then
    raise exception 'You can only set your own team''s lineup' using errcode = '42501';
  end if;
  missing := array(select private.slot_pos(k - 1) from generate_subscripts(p_players, 1) k where p_players[k] is null);
  if cardinality(missing) > 0 and not private.lineup_allow_partial(p_season) and not private.is_privileged() then
    raise exception 'Fill every slot before saving: missing %', array_to_string(missing, ', ') using errcode = '23514';
  end if;
  if (select count(x) <> count(distinct x) from unnest(p_players) x) then
    raise exception 'A player can only start once' using errcode = '23514';
  end if;
  if p_expected_version is not null then
    perform 1 from public.teams t where t.id = p_team for update;
    select lm.version, lm.changed_at, coalesce(nullif(p.display_name, ''), 'Someone') as who, lm.changed_by
      into m from public.lineup_meta lm left join public.profiles p on p.id = lm.changed_by
     where lm.season = p_season and lm.week = p_week and lm.team_id = p_team;
    if coalesce(m.version, 0) <> p_expected_version and m.changed_by is distinct from (select auth.uid()) then
      raise exception 'Lineup changed by % at % since you opened it', m.who,
        to_char(m.changed_at at time zone 'America/New_York', 'FMHH12:MI AM') using errcode = '40001';
    end if;
  end if;
  delete from public.lineup_slots s
  where s.season = p_season and s.week = p_week and s.team_id = p_team
    and s.player_id is distinct from p_players[s.slot + 1];
  insert into public.lineup_slots (season, week, team_id, slot, player_id)
  select p_season, p_week, p_team, i - 1, p_players[i]
  from generate_subscripts(p_players, 1) i
  where p_players[i] is not null
    and not exists (select 1 from public.lineup_slots s
                    where s.season = p_season and s.week = p_week and s.team_id = p_team and s.slot = i - 1);
  return query
    select * from public.lineup_slots s
    where s.season = p_season and s.week = p_week and s.team_id = p_team
    order by s.slot;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reading test lineups (public, like every lineup)
-- ---------------------------------------------------------------------------
create function public.test_lineup_slots(p_season int, p_week int)
returns table (team_id text, slot smallint, player_id text, name text, pos text, nfl_team text, revealed boolean, bye boolean, injury text, points numeric,
               status text, saved_at timestamptz, saved_by text)
language sql stable security definer set search_path = ''
as $$
  with wk as (select count(*) as games from public.nfl_games g where g.season = p_season and g.week = p_week)
  select tl.team_id, (k - 1)::smallint, tl.players[k], np.name, np.position, np.nfl_team, true,
         (tl.players[k] is not null and private.player_kickoff(p_season, p_week, tl.players[k]) is null and wk.games > 0),
         i.status, ps.points, tl.status, tl.saved_at,
         case when private.is_member() then (select coalesce(nullif(p.display_name, ''), 'an owner') from public.profiles p where p.id = tl.saved_by) end
  from public.test_lineups tl
  cross join generate_series(1, 9) k
  cross join wk
  left join public.nfl_players np on np.id = tl.players[k]
  left join public.player_injuries i on i.season = p_season and i.week = p_week and i.player_id = tl.players[k]
  left join public.player_scores ps on ps.season = p_season and ps.week = p_week and ps.player_id = tl.players[k]
  where tl.season = p_season and tl.week = p_week
  order by tl.team_id, k
$$;

-- "Your test lineup would have scored X": test vs official totals for a week.
create function public.test_lineup_scores(p_season int, p_week int)
returns table (team_id text, test_points numeric, official_points numeric, has_test boolean)
language sql stable security definer set search_path = ''
as $$
  select t.id,
         (select sum(coalesce(ps.points, 0)) from public.test_lineups tl cross join unnest(tl.players) x
            left join public.player_scores ps on ps.season = p_season and ps.week = p_week and ps.player_id = x
          where tl.season = p_season and tl.week = p_week and tl.team_id = t.id and x is not null),
         coalesce((select sum(ps.points) from public.lineup_slots s join public.player_scores ps on ps.season = s.season and ps.week = s.week and ps.player_id = s.player_id
                   where s.season = p_season and s.week = p_week and s.team_id = t.id), 0),
         exists (select 1 from public.test_lineups tl where tl.season = p_season and tl.week = p_week and tl.team_id = t.id)
  from public.teams t order by t.id
$$;

-- ---------------------------------------------------------------------------
-- Tuesday: swap in the official lineups (server jobs only)
-- ---------------------------------------------------------------------------
create function private.team_week_total(p_season int, p_week int, p_team text) returns numeric
language sql stable security definer set search_path = ''
as $$
  select coalesce(sum(ps.points), 0) from public.lineup_slots s join public.player_scores ps on ps.season = s.season and ps.week = s.week and ps.player_id = s.player_id
  where s.season = p_season and s.week = p_week and s.team_id = p_team
$$;
create function public.replace_week_lineups(p_season int, p_week int, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare archived int; st text;
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'No lineups to import' using errcode = '22023'; end if;
  delete from public.lineup_slots where season = p_season and week = p_week;
  insert into public.lineup_slots (season, week, team_id, slot, player_id)
  select p_season, p_week, r ->> 'team_id', (r ->> 'slot')::int, r ->> 'player_id' from jsonb_array_elements(p_rows) r;
  update public.test_lineups set status = 'archived', archived_at = now() where season = p_season and week = p_week and status = 'test';
  get diagnostics archived = row_count;
  -- Official totals from the official lineups (player_scores already has overrides applied).
  update public.matchups m set home_score = private.team_week_total(p_season, p_week, m.home_team), away_score = private.team_week_total(p_season, p_week, m.away_team)
   where m.season = p_season and m.week = p_week;
  select coalesce(sw.status, 'pending_review') into st from public.score_weeks sw where sw.season = p_season and sw.week = p_week;
  insert into public.team_scores (season, week, team_id, points, status)
  select p_season, p_week, x.team_id, private.team_week_total(p_season, p_week, x.team_id), coalesce(st, 'pending_review')
  from (select distinct r ->> 'team_id' as team_id from jsonb_array_elements(p_rows) r) x
  on conflict (season, week, team_id) do update set points = excluded.points, updated_at = now();
  return jsonb_build_object('archived_test', archived,
    'totals', (select jsonb_object_agg(t.id, private.team_week_total(p_season, p_week, t.id)) from public.teams t));
end;
$$;

-- The Tuesday job keeps retrying that day until both the picks and the lineups are in.
create or replace function private.pool_import_tick(p_now timestamptz default now()) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  et timestamp := p_now at time zone 'America/New_York';
  w record;
  since timestamptz := date_trunc('day', et) at time zone 'America/New_York';
begin
  if extract(isodow from et) <> 2 or extract(hour from et) < 6 then
    return 'not Tuesday 6 AM ET or later';
  end if;
  select * into w from private.last_finished_week(p_now);
  if w.week is null then return 'no finished week'; end if;
  if private.pools_mode(w.season) <> 'test' then return 'not in test mode'; end if;
  if exists (select 1 from public.pool_imports i where i.season = w.season and i.week = w.week and i.status = 'ok' and i.succeeded_at >= since)
     and exists (select 1 from public.lineup_imports l where l.season = w.season and l.week = w.week and l.status = 'ok' and l.succeeded_at >= since) then
    return 'already imported today';
  end if;
  perform private.request_pool_import(w.season, w.week, 'schedule');
  return 'requested ' || w.season || ' week ' || w.week;
end;
$$;

-- ---------------------------------------------------------------------------
-- Lineup confirmation emails for test lineups (same setting: "My lineup confirmation")
-- ---------------------------------------------------------------------------
create function private.test_lineup_payload(p_season int, p_week int, p_team text) returns jsonb
language sql stable security definer set search_path = ''
as $$
  with tl as (select * from public.test_lineups where season = p_season and week = p_week and team_id = p_team),
  wk as (select count(*) as games from public.nfl_games g where g.season = p_season and g.week = p_week),
  st as (select k - 1 as slot, tl.players[k] as id from tl cross join generate_series(1, 9) k where tl.players[k] is not null)
  select jsonb_build_object('team', private.team_name(p_team), 'week', p_week, 'test', true,
    'starters', (select jsonb_agg(jsonb_build_object('slot', private.slot_pos(st.slot), 'name', np.name, 'nfl', np.nfl_team) order by st.slot) from st join public.nfl_players np on np.id = st.id),
    'bench', (select jsonb_agg(jsonb_build_object('pos', np.position, 'name', np.name, 'nfl', np.nfl_team) order by np.position, np.name)
              from public.roster_entries r join public.nfl_players np on np.id = r.player_id
              where r.season = p_season and r.team_id = p_team and r.player_id not in (select id from st)),
    'warnings', (select jsonb_agg(jsonb_build_object('name', np.name, 'pos', np.position,
                   'problem', case when private.player_kickoff(p_season, p_week, st.id) is null then 'bye' else lower(i.status) end))
                 from st join public.nfl_players np on np.id = st.id cross join wk
                 left join public.player_injuries i on i.season = p_season and i.week = p_week and i.player_id = st.id
                 where (private.player_kickoff(p_season, p_week, st.id) is null and wk.games > 0) or i.status in ('IR', 'PUP', 'Suspended', 'Reserve', 'Out')),
    'saved_by', (select coalesce(nullif(p.display_name, ''), 'an owner') from tl left join public.profiles p on p.id = tl.saved_by),
    'saved_at', (select saved_at from tl))
$$;
create function private.notify_on_test_lineup() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare u uuid;
begin
  if new.status <> 'test' or (tg_op = 'UPDATE' and new.saved_at is not distinct from old.saved_at) then return null; end if;
  for u in select private.team_owner_ids(array[new.team_id]) loop
    perform private.notify_enqueue_debounced(u, 'lineup_saved', 'tsaved:' || new.season || ':' || new.week || ':' || new.team_id, interval '10 minutes');
  end loop;
  return null;
end;
$$;
create trigger notify_on_test_lineup after insert or update on public.test_lineups for each row execute function private.notify_on_test_lineup();

-- notify_claim: "tsaved" confirmations read the test lineup.
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
    if q.kind <> 'account' and q.user_id not in (select private.member_ids()) then perform private.notify_skip(q, 'not a member'); continue; end if;
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
      d := case when parts[1] = 'tsaved' then private.test_lineup_payload(parts[2]::int, parts[3]::int, parts[4])
                else private.lineup_payload(parts[2]::int, parts[3]::int, parts[4]) end || jsonb_build_object('link', '#myteam');
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
    elsif q.kind = 'account' then
      d := coalesce(q.payload, '{}'::jsonb) || jsonb_build_object('link', '#account');
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


revoke execute on function private.lineup_allow_partial(int), private.test_week_status(int, int, timestamptz), private.slot_pos(int), private.team_week_total(int, int, text),
  private.test_lineup_payload(int, int, text), private.notify_on_test_lineup() from public, anon;
revoke execute on function public.save_test_lineup(int, int, text, text[]), public.replace_week_lineups(int, int, jsonb) from public, anon, authenticated;
grant execute on function public.save_test_lineup(int, int, text, text[]) to authenticated, service_role;
grant execute on function public.replace_week_lineups(int, int, jsonb) to service_role;
grant execute on function private.slot_pos(int), private.lineup_allow_partial(int) to authenticated;
revoke execute on function public.test_lineup_week(int), public.test_lineup_slots(int, int), public.test_lineup_scores(int, int) from public;
grant execute on function public.test_lineup_week(int), public.test_lineup_slots(int, int), public.test_lineup_scores(int, int) to anon, authenticated, service_role;
