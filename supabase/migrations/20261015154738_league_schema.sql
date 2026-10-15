-- B5 FFL core schema: accounts, teams, NFL players and games, rosters, lineups,
-- transactions, scores, standings, announcements, commissioner tables.
--
-- Security model (see CLAUDE.md, "Backend: Supabase"):
--   * RLS is enabled on EVERY table, with explicit policies. Tables are not
--     auto-exposed to the Data API, so every grant below is deliberate.
--   * anon (logged-out visitors) can read only public data: teams, NFL players
--     and games, rosters, matchups, standings, scores, score-week status,
--     published announcements.
--   * authenticated managers edit only their own team's lineups and
--     transactions. They can read league data, their own team's lineups, and
--     other teams' lineup slots once that player's game has kicked off.
--   * The commissioner (profiles.is_commissioner) can do everything.
--   * service_role (server-side jobs only; key lives in GitHub Actions secrets)
--     bypasses RLS.
--   * Policies can't compare old and new values, so triggers guard the columns
--     a manager must never change (commissioner flag, transaction decisions)
--     and enforce lineup rules (roster, slot position, kickoff lock).

-- =====================================================================
-- Private helpers (schema not exposed by the Data API)
-- =====================================================================
create schema if not exists private;
grant usage on schema private to anon, authenticated, service_role;

-- =====================================================================
-- Accounts
-- =====================================================================
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '',
  is_commissioner boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.teams (
  id text primary key check (id ~ '^[0-9]{4}$'),          -- franchise ID, e.g. '0005'
  name text not null,
  division text not null check (division in ('Black', 'Gold')),
  logo_url text,
  created_at timestamptz not null default now()
);

-- Who manages which team (co-managers allowed).
create table public.team_managers (
  team_id text not null references public.teams (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  primary key (team_id, user_id)
);
create index team_managers_user_idx on public.team_managers (user_id);

create function private.is_commissioner() returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((select p.is_commissioner from public.profiles p where p.id = (select auth.uid())), false)
$$;

create function private.manages_team(p_team text) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.team_managers tm where tm.team_id = p_team and tm.user_id = (select auth.uid()))
$$;

-- True for server-side jobs (service_role) and migrations (table owner).
create function private.is_privileged() returns boolean
language sql stable set search_path = ''
as $$
  select current_user in ('service_role', 'postgres', 'supabase_admin')
$$;

grant execute on function private.is_commissioner() to anon, authenticated, service_role;
grant execute on function private.manages_team(text) to anon, authenticated, service_role;
grant execute on function private.is_privileged() to anon, authenticated, service_role;

-- New sign-ups get a profile (never a commissioner).
create function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1), ''));
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();

-- Only the commissioner (or a server job) can grant or remove commissioner rights.
create function private.guard_profile() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.is_commissioner is distinct from old.is_commissioner
     and not (private.is_commissioner() or private.is_privileged()) then
    raise exception 'Only the commissioner can change commissioner rights' using errcode = '42501';
  end if;
  if new.id is distinct from old.id then
    raise exception 'Profile id cannot change' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger guard_profile before update on public.profiles
  for each row execute function private.guard_profile();

-- =====================================================================
-- NFL data (written by server jobs)
-- =====================================================================
create table public.nfl_players (
  id text primary key,                 -- nflverse GSIS ID, or 'DEF:<TEAM>' for team defenses
  espn_id text unique,
  name text not null,
  position text not null,              -- QB RB WR TE K DEF (others allowed; they can't start)
  nfl_team text,
  updated_at timestamptz not null default now()
);

create table public.nfl_games (
  season int not null,
  week int not null check (week between 1 and 18),
  game_key text not null,              -- 'AWAY@HOME'
  home text not null,
  away text not null,
  kickoff timestamptz,
  status text not null default 'scheduled' check (status in ('scheduled', 'in_progress', 'final')),
  primary key (season, week, game_key)
);

-- When does this player's game this week kick off? (null = bye / unknown)
create function private.player_kickoff(p_season int, p_week int, p_player text) returns timestamptz
language sql stable security definer set search_path = ''
as $$
  select min(g.kickoff)
  from public.nfl_players pl
  join public.nfl_games g on g.season = p_season and g.week = p_week and pl.nfl_team in (g.home, g.away)
  where pl.id = p_player
$$;
grant execute on function private.player_kickoff(int, int, text) to anon, authenticated, service_role;

-- =====================================================================
-- Rosters and lineups
-- =====================================================================
create table public.roster_entries (
  season int not null,
  team_id text not null references public.teams (id),
  player_id text not null references public.nfl_players (id),
  acquired text,                       -- e.g. '1.07' (round.pick) or 'Waiv'
  acquired_at timestamptz not null default now(),
  primary key (season, player_id)      -- a player is on at most one team per season
);
create index roster_entries_team_idx on public.roster_entries (season, team_id);

-- Starting lineup: 9 slots, in order QB RB RB WR WR WR TE K DEF (slot 0-8).
create table public.lineup_slots (
  season int not null,
  week int not null check (week between 1 and 18),
  team_id text not null references public.teams (id),
  slot smallint not null check (slot between 0 and 8),
  player_id text not null references public.nfl_players (id),
  set_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  primary key (season, week, team_id, slot),
  unique (season, week, team_id, player_id)
);

create function private.slot_position(p_slot smallint) returns text
language sql immutable set search_path = ''
as $$ select (array['QB','RB','RB','WR','WR','WR','TE','K','DEF'])[p_slot + 1] $$;

-- Lineup rules for managers (the commissioner and server jobs are exempt):
-- the player must be on that team's roster and fit the slot, and a player whose
-- game has kicked off can't be moved into or out of the lineup.
create function private.guard_lineup() returns trigger
language plpgsql set search_path = ''
as $$
declare
  k timestamptz;
  pos text;
begin
  if private.is_commissioner() or private.is_privileged() then
    return coalesce(new, old);
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    k := private.player_kickoff(old.season, old.week, old.player_id);
    if k is not null and k <= now()
       and (tg_op = 'DELETE' or new.player_id is distinct from old.player_id or new.slot is distinct from old.slot) then
      raise exception 'Player % is locked: his game has kicked off', old.player_id using errcode = '42501';
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    if not exists (select 1 from public.roster_entries r
                   where r.season = new.season and r.team_id = new.team_id and r.player_id = new.player_id) then
      raise exception 'Player % is not on team %''s roster', new.player_id, new.team_id using errcode = '23514';
    end if;
    select p.position into pos from public.nfl_players p where p.id = new.player_id;
    if pos is distinct from private.slot_position(new.slot) then
      raise exception 'Player % (%) cannot play the % slot', new.player_id, pos, private.slot_position(new.slot) using errcode = '23514';
    end if;
    if tg_op = 'INSERT' or new.player_id is distinct from old.player_id then
      k := private.player_kickoff(new.season, new.week, new.player_id);
      if k is not null and k <= now() then
        raise exception 'Player % is locked: his game has kicked off', new.player_id using errcode = '42501';
      end if;
    end if;
    new.set_by := (select auth.uid());
    new.updated_at := now();
    return new;
  end if;
  return old;
end;
$$;
create trigger guard_lineup before insert or update or delete on public.lineup_slots
  for each row execute function private.guard_lineup();

-- =====================================================================
-- Transactions (waivers, free agents, trades)
-- =====================================================================
create type public.transaction_type as enum ('add', 'drop', 'add_drop', 'trade');
create type public.transaction_status as enum ('pending', 'cancelled', 'approved', 'rejected', 'processed', 'reversed');

create table public.transactions (
  id bigint generated always as identity primary key,
  season int not null,
  team_id text not null references public.teams (id),
  type public.transaction_type not null,
  status public.transaction_status not null default 'pending',
  players_in text[] not null default '{}',
  players_out text[] not null default '{}',
  partner_team_id text references public.teams (id),       -- trades only
  note text,
  created_by uuid default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now(),
  decided_by uuid references public.profiles (id),
  decided_at timestamptz,
  check (type <> 'trade' or partner_team_id is not null)
);
create index transactions_team_idx on public.transactions (season, team_id);

-- Managers may only create pending transactions and edit or cancel their own
-- pending ones; deciding (approve/reject/process/reverse) is the commissioner's.
create function private.guard_transaction() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if private.is_commissioner() or private.is_privileged() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'pending' or new.decided_by is not null or new.decided_at is not null then
      raise exception 'New transactions must be pending' using errcode = '42501';
    end if;
    new.created_by := (select auth.uid());
    new.created_at := now();
    return new;
  end if;
  if new.status not in ('pending', 'cancelled') then
    raise exception 'Only the commissioner can % a transaction', new.status using errcode = '42501';
  end if;
  if new.team_id is distinct from old.team_id or new.season is distinct from old.season
     or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at
     or new.decided_by is distinct from old.decided_by or new.decided_at is distinct from old.decided_at then
    raise exception 'That transaction field can only be changed by the commissioner' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger guard_transaction before insert or update on public.transactions
  for each row execute function private.guard_transaction();

-- =====================================================================
-- Scores, matchups, standings (written by server jobs / commissioner)
-- =====================================================================
create table public.score_weeks (
  season int not null,
  week int not null check (week between 1 and 18),
  status text not null default 'live' check (status in ('live', 'pending_review', 'final')),
  live_delayed boolean not null default false,
  auto_finalize_at timestamptz,
  finalized_at timestamptz,
  finalized_by text,
  updated_at timestamptz not null default now(),
  primary key (season, week)
);

-- Effective fantasy points per player / defense per week (overrides already applied).
create table public.player_scores (
  season int not null,
  week int not null check (week between 1 and 18),
  player_id text not null references public.nfl_players (id),
  game_key text,
  points numeric(6, 2) not null,
  stats jsonb not null default '{}',
  source text not null check (source in ('live', 'final')),
  overridden boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (season, week, player_id)
);

create table public.matchups (
  season int not null,
  week int not null check (week between 1 and 17),
  home_team text not null references public.teams (id),
  away_team text not null references public.teams (id),
  home_score numeric(7, 2),
  away_score numeric(7, 2),
  is_playoff boolean not null default false,
  primary key (season, week, home_team),
  unique (season, week, away_team),
  check (home_team <> away_team)
);

create table public.standings (
  season int not null,
  team_id text not null references public.teams (id),
  wins int not null default 0,
  losses int not null default 0,
  ties int not null default 0,
  points_for numeric(8, 2) not null default 0,
  points_against numeric(8, 2) not null default 0,
  rank int,
  primary key (season, team_id)
);

create table public.announcements (
  id bigint generated always as identity primary key,
  title text not null,
  tag text not null default 'News',
  body_html text not null default '',       -- commissioner-authored HTML (sanitize on render)
  image_url text,
  published_at timestamptz,                 -- null = draft
  created_by uuid default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now()
);

-- Commissioner-only tables
create table public.score_overrides (
  id uuid primary key default gen_random_uuid(),
  season int not null,
  week int not null check (week between 1 and 18),
  target_key text not null,                 -- 'nflverse:<gsis>' or 'DEF:<TEAM>'
  type text not null check (type in ('stats', 'points')),
  stats jsonb,
  points numeric(6, 2),
  reason text not null check (length(btrim(reason)) > 0),
  created_by uuid default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now(),
  active boolean not null default true,
  removed_by uuid references public.profiles (id),
  removed_at timestamptz,
  removed_reason text
);

create table public.review_queue (
  provider text not null,
  provider_id text not null,
  name text not null,
  team text,
  first_week int,
  reason text not null,
  status text not null default 'open' check (status in ('open', 'resolved')),
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  primary key (provider, provider_id)
);

create table public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor uuid default auth.uid(),
  actor_label text,                          -- e.g. 'system', 'github-actions'
  action text not null,
  season int,
  week int,
  details jsonb not null default '{}'
);

-- Server-job heartbeat (the nightly workflow touches it so the free-tier project stays awake).
create table public.heartbeats (
  name text primary key,
  at timestamptz not null default now()
);

-- =====================================================================
-- Row-level security: enabled on every table
-- =====================================================================
alter table public.profiles enable row level security;
alter table public.teams enable row level security;
alter table public.team_managers enable row level security;
alter table public.nfl_players enable row level security;
alter table public.nfl_games enable row level security;
alter table public.roster_entries enable row level security;
alter table public.lineup_slots enable row level security;
alter table public.transactions enable row level security;
alter table public.score_weeks enable row level security;
alter table public.player_scores enable row level security;
alter table public.matchups enable row level security;
alter table public.standings enable row level security;
alter table public.announcements enable row level security;
alter table public.score_overrides enable row level security;
alter table public.review_queue enable row level security;
alter table public.audit_log enable row level security;
alter table public.heartbeats enable row level security;   -- no policies: service_role only

-- Public data: anyone may read; only the commissioner may write.
do $$
declare t text;
begin
  foreach t in array array['teams', 'nfl_players', 'nfl_games', 'roster_entries', 'score_weeks',
                           'player_scores', 'matchups', 'standings'] loop
    execute format('create policy "public read" on public.%I for select to anon, authenticated using (true)', t);
    execute format('create policy "commissioner writes" on public.%I for all to authenticated
                    using (private.is_commissioner()) with check (private.is_commissioner())', t);
  end loop;
end $$;

-- Announcements: published ones are public; drafts only for the commissioner.
create policy "public read published" on public.announcements for select to anon, authenticated
  using (published_at is not null and published_at <= now());
create policy "commissioner writes" on public.announcements for all to authenticated
  using (private.is_commissioner()) with check (private.is_commissioner());

-- Profiles: league members can see each other; you can edit your own; commissioner anything.
create policy "members read" on public.profiles for select to authenticated using (true);
create policy "edit own profile" on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));
create policy "commissioner writes" on public.profiles for all to authenticated
  using (private.is_commissioner()) with check (private.is_commissioner());

-- Team managers: members can see who manages what; commissioner assigns.
create policy "members read" on public.team_managers for select to authenticated using (true);
create policy "commissioner writes" on public.team_managers for all to authenticated
  using (private.is_commissioner()) with check (private.is_commissioner());

-- Lineups: your own team's lineup, plus other teams' slots once that player's game has kicked off.
create policy "read own or locked" on public.lineup_slots for select to authenticated
  using (private.manages_team(team_id)
         or private.is_commissioner()
         or coalesce(private.player_kickoff(season, week, player_id) <= now(), false));
create policy "manager inserts own" on public.lineup_slots for insert to authenticated
  with check (private.manages_team(team_id));
create policy "manager updates own" on public.lineup_slots for update to authenticated
  using (private.manages_team(team_id)) with check (private.manages_team(team_id));
create policy "manager deletes own" on public.lineup_slots for delete to authenticated
  using (private.manages_team(team_id));
create policy "commissioner writes" on public.lineup_slots for all to authenticated
  using (private.is_commissioner()) with check (private.is_commissioner());

-- Transactions: members see decided ones league-wide, plus pending ones involving their team.
create policy "members read" on public.transactions for select to authenticated
  using (status in ('approved', 'processed', 'reversed')
         or private.manages_team(team_id)
         or (partner_team_id is not null and private.manages_team(partner_team_id))
         or private.is_commissioner());
create policy "manager creates own" on public.transactions for insert to authenticated
  with check (private.manages_team(team_id));
create policy "manager edits own pending" on public.transactions for update to authenticated
  using (private.manages_team(team_id) and status = 'pending')
  with check (private.manages_team(team_id));
create policy "commissioner writes" on public.transactions for all to authenticated
  using (private.is_commissioner()) with check (private.is_commissioner());

-- Commissioner-only tables
create policy "commissioner only" on public.score_overrides for all to authenticated
  using (private.is_commissioner()) with check (private.is_commissioner());
create policy "commissioner only" on public.review_queue for all to authenticated
  using (private.is_commissioner()) with check (private.is_commissioner());
create policy "commissioner reads" on public.audit_log for select to authenticated
  using (private.is_commissioner());
create policy "commissioner appends" on public.audit_log for insert to authenticated
  with check (private.is_commissioner());

-- =====================================================================
-- Grants (new tables are NOT auto-exposed; RLS still decides which rows)
-- =====================================================================
grant usage on schema public to anon, authenticated, service_role;

grant select on public.teams, public.nfl_players, public.nfl_games, public.roster_entries, public.score_weeks,
  public.player_scores, public.matchups, public.standings, public.announcements to anon;

grant select on all tables in schema public to authenticated;
grant insert, update, delete on public.teams, public.team_managers, public.nfl_players, public.nfl_games,
  public.roster_entries, public.lineup_slots, public.transactions, public.score_weeks, public.player_scores,
  public.matchups, public.standings, public.announcements, public.score_overrides, public.review_queue
  to authenticated;
grant update on public.profiles to authenticated;
grant insert on public.audit_log to authenticated;
revoke all on public.heartbeats from anon, authenticated;

grant all on all tables in schema public to service_role;
grant usage on all sequences in schema public to authenticated, service_role;
