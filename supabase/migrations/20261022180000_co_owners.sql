-- Co-owners: a team can have up to N owners (league setting, default 2), each with his own login.
-- Both owners are equal: lineups, picks, trades and claims belong to the TEAM (team_managers
-- already gives every owner the same rights). The commissioner flag stays per USER
-- (profiles.is_commissioner): a co-owner of the commissioner's team gets no commissioner powers,
-- and the own-team audit rules keep applying to that team.
--   league_settings      max_owners_per_team (default 2); anyone reads, commissioner edits
--   team_managers        + one team per account (unique user_id), + owner limit (trigger)
--   invites              inviting to a team adds a co-owner; a 3rd owner is refused (trigger)
--   team_activity        who changed what: one entry per save (lineup, survivor, confidence)
--   lineup_meta          per team-week lineup version + last change (who, when)
--   save_lineup(...)     + p_expected_version: refuses a save when the other owner changed the
--                        lineup since the page loaded (resend with null to save anyway)
--   league_polls/votes   league votes: one vote per TEAM (either owner casts or changes it)

-- ---------------------------------------------------------------------------
-- League settings
-- ---------------------------------------------------------------------------
create table public.league_settings (
  id boolean primary key default true check (id),
  max_owners_per_team int not null default 2 check (max_owners_per_team between 1 and 4),
  updated_at timestamptz not null default now()
);
insert into public.league_settings default values;
alter table public.league_settings enable row level security;
create policy "public read" on public.league_settings for select to anon, authenticated using (true);
create policy "commissioner edits" on public.league_settings for update to authenticated
  using (private.is_commissioner()) with check (private.is_commissioner());
revoke all on public.league_settings from anon, authenticated;
grant select on public.league_settings to anon, authenticated;
grant update on public.league_settings to authenticated;
grant all on public.league_settings to service_role;

-- ---------------------------------------------------------------------------
-- Owners: one team per account; at most max_owners_per_team per team
-- ---------------------------------------------------------------------------
create unique index team_managers_one_team_per_account on public.team_managers (user_id);

create function private.owner_names(p_team text, p_except uuid default null) returns text
language sql stable security definer set search_path = ''
as $$
  select coalesce(string_agg(coalesce(nullif(p.display_name, ''), 'an owner'), ' & ' order by p.display_name), '')
  from public.team_managers tm join public.profiles p on p.id = tm.user_id
  where tm.team_id = p_team and tm.user_id is distinct from p_except
$$;

create function private.guard_team_owners() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  lim int := (select s.max_owners_per_team from public.league_settings s);
  team_name text;
  other text;
begin
  perform 1 from public.teams t where t.id = new.team_id for update;   -- one owner change per team at a time
  select t.name into team_name from public.teams t where t.id = new.team_id;
  select t.name into other from public.team_managers tm join public.teams t on t.id = tm.team_id
   where tm.user_id = new.user_id and tm.team_id <> new.team_id;
  if other is not null then
    raise exception 'That account already owns %. An account can own only one team.', other using errcode = '23505';
  end if;
  if (select count(*) from public.team_managers tm where tm.team_id = new.team_id and tm.user_id <> new.user_id) >= coalesce(lim, 2) then
    raise exception '% already has % owners (%). Remove one first.', team_name, coalesce(lim, 2), private.owner_names(new.team_id)
      using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger guard_team_owners before insert or update on public.team_managers
  for each row execute function private.guard_team_owners();

-- Inviting an email to a team = a new (co-)owner. Refused up front when the team is full
-- (owners + invites to it not yet accepted) or when that email's account owns another team.
create function private.guard_invite_owners() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  lim int := (select s.max_owners_per_team from public.league_settings s);
  acct uuid;
  team_name text;
  taken int;
  other text;
begin
  if new.team_id is null or (tg_op = 'UPDATE' and new.team_id is not distinct from old.team_id) then return new; end if;
  select au.id into acct from auth.users au where lower(btrim(au.email)) = new.email;
  select t.name into team_name from public.teams t where t.id = new.team_id;
  select t.name into other from public.team_managers tm join public.teams t on t.id = tm.team_id
   where tm.user_id = acct and tm.team_id <> new.team_id;
  if other is not null then
    raise exception '% already owns %. An account can own only one team.', new.email, other using errcode = '23505';
  end if;
  taken := (select count(*) from public.team_managers tm where tm.team_id = new.team_id and tm.user_id is distinct from acct)
         + (select count(*) from public.invites i where i.team_id = new.team_id and i.user_id is null and i.email <> new.email);
  if taken >= coalesce(lim, 2) then
    raise exception '% already has % owners%. Remove one first.', team_name, coalesce(lim, 2),
      coalesce(' (' || nullif(private.owner_names(new.team_id, acct), '') || ')', ' (counting invites not yet accepted)')
      using errcode = '23514';
  end if;
  return new;
end;
$$;
-- Fires before link_existing_user (triggers run in name order), so a refused invite links nothing.
create trigger guard_invite_owners before insert or update of team_id on public.invites
  for each row execute function private.guard_invite_owners();

-- A full team (or a second team) never blocks an account from being created: it just isn't linked.
create or replace function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  inv public.invites%rowtype;
begin
  select * into inv from public.invites i where i.email = lower(btrim(new.email));
  insert into public.profiles (id, display_name, is_commissioner)
  values (new.id,
          coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1), ''),
          coalesce(inv.is_commissioner, false));
  if inv.email is not null then
    if inv.team_id is not null then
      begin
        insert into public.team_managers (team_id, user_id) values (inv.team_id, new.id) on conflict do nothing;
      exception when check_violation or unique_violation then
        null;   -- the team filled up (or the account owns another): the commissioner sees it unassigned
      end;
    end if;
    update public.invites set user_id = new.id, accepted_at = new.last_sign_in_at where email = inv.email;
  end if;
  return new;
end;
$$;

revoke execute on function private.owner_names(text, uuid), private.guard_team_owners(), private.guard_invite_owners() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Team activity log: one entry per save, per team (both owners and the commissioner see it)
-- ---------------------------------------------------------------------------
create table public.team_activity (
  id bigint generated always as identity primary key,
  team_id text not null references public.teams (id) on delete cascade,
  season int not null,
  week int,
  kind text not null check (kind in ('lineup', 'survivor', 'confidence')),
  actor uuid references public.profiles (id) on delete set null,
  at timestamptz not null default now(),
  txid bigint not null default txid_current(),
  details jsonb not null default '{}'       -- lineup: {in: [{slot, player}], out: [...]}; picks: {picks: [...]}
);
create index team_activity_team_idx on public.team_activity (team_id, at desc);
alter table public.team_activity enable row level security;
create policy "owners and commissioner read" on public.team_activity for select to authenticated
  using (private.manages_team(team_id) or private.is_commissioner());
revoke all on public.team_activity from anon, authenticated;
grant select on public.team_activity to authenticated;
grant all on public.team_activity to service_role;

create table public.lineup_meta (
  season int not null,
  week int not null,
  team_id text not null references public.teams (id) on delete cascade,
  version int not null default 0,
  changed_by uuid references public.profiles (id) on delete set null,
  changed_at timestamptz,
  txid bigint,
  primary key (season, week, team_id)
);
alter table public.lineup_meta enable row level security;
create policy "owners and commissioner read" on public.lineup_meta for select to authenticated
  using (private.manages_team(team_id) or private.is_commissioner());
revoke all on public.lineup_meta from anon, authenticated;
grant select on public.lineup_meta to authenticated;
grant all on public.lineup_meta to service_role;

-- Append to this transaction's entry (same team, kind, week, person) or start one.
create function private.record_team_activity(p_team text, p_season int, p_week int, p_kind text, p_add jsonb) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.team_activity a
     set details = (select coalesce(jsonb_object_agg(k, coalesce(a.details -> k, '[]'::jsonb) || v), '{}'::jsonb) from jsonb_each(p_add) e(k, v))
                   || (select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from jsonb_each(a.details) e(k, v) where not p_add ? k),
         at = now()
   where a.team_id = p_team and a.kind = p_kind and a.week is not distinct from p_week and a.season = p_season
     and a.txid = txid_current() and a.actor is not distinct from (select auth.uid());
  if not found then
    insert into public.team_activity (team_id, season, week, kind, actor, details)
    values (p_team, p_season, p_week, p_kind, (select auth.uid()), p_add);
  end if;
  if p_kind = 'lineup' then
    insert into public.lineup_meta as m (season, week, team_id, version, changed_by, changed_at, txid)
    values (p_season, p_week, p_team, 1, (select auth.uid()), now(), txid_current())
    on conflict (season, week, team_id) do update
      set version = m.version + case when m.txid = txid_current() then 0 else 1 end,
          changed_by = excluded.changed_by, changed_at = excluded.changed_at, txid = excluded.txid;
  end if;
end;
$$;

-- Runs as the caller, so server jobs (the 2026 MFL mirror and imports) aren't logged as anyone.
create function private.log_team_change() returns trigger
language plpgsql set search_path = ''
as $$
declare
  r record := coalesce(new, old);
  kind text := case tg_table_name when 'lineup_slots' then 'lineup' when 'survivor_picks' then 'survivor' else 'confidence' end;
  add jsonb := '{}';
begin
  if private.is_privileged() then return null; end if;
  if kind = 'lineup' then
    if tg_op = 'UPDATE' and new.player_id is not distinct from old.player_id and new.slot = old.slot then return null; end if;
    if tg_op <> 'INSERT' then add := add || jsonb_build_object('out', jsonb_build_array(jsonb_build_object('slot', old.slot, 'player', old.player_id))); end if;
    if tg_op <> 'DELETE' then add := add || jsonb_build_object('in', jsonb_build_array(jsonb_build_object('slot', new.slot, 'player', new.player_id))); end if;
  elsif kind = 'survivor' then
    add := jsonb_build_object('picks', jsonb_build_array(jsonb_build_object('op', lower(tg_op), 'nfl_team', case when tg_op = 'DELETE' then old.nfl_team else new.nfl_team end)));
  else
    if tg_op = 'UPDATE' and new.pick is not distinct from old.pick and new.points = old.points then return null; end if;
    add := jsonb_build_object('picks', jsonb_build_array(case when tg_op = 'DELETE'
      then jsonb_build_object('op', 'delete', 'game', old.game_key)
      else jsonb_build_object('op', lower(tg_op), 'game', new.game_key, 'pick', new.pick, 'points', new.points) end));
  end if;
  perform private.record_team_activity(r.team_id, r.season, r.week, kind, add);
  return null;
end;
$$;
create trigger log_team_change after insert or update or delete on public.lineup_slots
  for each row execute function private.log_team_change();
create trigger log_team_change after insert or update or delete on public.survivor_picks
  for each row execute function private.log_team_change();
create trigger log_team_change after insert or update or delete on public.confidence_picks
  for each row execute function private.log_team_change();
revoke execute on function private.record_team_activity(text, int, int, text, jsonb), private.log_team_change() from public, anon;
grant execute on function private.record_team_activity(text, int, int, text, jsonb) to authenticated, service_role;

-- save_lineup + conflict check. p_expected_version = lineup_meta.version when the page loaded
-- (0 = no change yet). If another person has saved since, nothing is saved and the error names
-- who and when; resend with p_expected_version null to save anyway (last save wins).
drop function public.save_lineup(int, int, text, text[]);
create function public.save_lineup(p_season int, p_week int, p_team text, p_players text[], p_expected_version int default null)
returns setof public.lineup_slots
language plpgsql security invoker set search_path = ''
as $$
declare
  m record;
begin
  if coalesce(array_length(p_players, 1), 0) <> 9 then
    raise exception 'A lineup has 9 slots (QB RB RB WR WR WR TE K DEF)' using errcode = '22023';
  end if;
  if not (private.manages_team(p_team) or private.is_commissioner() or private.is_privileged()) then
    raise exception 'You can only set your own team''s lineup' using errcode = '42501';
  end if;
  if (select count(x) <> count(distinct x) from unnest(p_players) x) then
    raise exception 'A player can only start once' using errcode = '23514';
  end if;
  if p_expected_version is not null then
    perform 1 from public.teams t where t.id = p_team for update;   -- two owners saving at once: one waits
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
revoke execute on function public.save_lineup(int, int, text, text[], int) from public, anon;
grant execute on function public.save_lineup(int, int, text, text[], int) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- League votes: one vote per team. Either owner casts or changes it; the commissioner creates
-- polls (and votes only for his own team).
-- ---------------------------------------------------------------------------
create table public.league_polls (
  id bigint generated always as identity primary key,
  title text not null check (char_length(btrim(title)) between 1 and 200),
  options text[] not null check (array_length(options, 1) between 2 and 10),
  closes_at timestamptz,
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create table public.league_votes (
  poll_id bigint not null references public.league_polls (id) on delete cascade,
  team_id text not null references public.teams (id) on delete cascade,
  choice int not null,
  voted_by uuid default auth.uid() references public.profiles (id) on delete set null,
  voted_at timestamptz not null default now(),
  primary key (poll_id, team_id)              -- one vote per team
);
alter table public.league_polls enable row level security;
alter table public.league_votes enable row level security;
create policy "members read" on public.league_polls for select to authenticated using (private.is_member());
create policy "commissioner writes" on public.league_polls for all to authenticated
  using (private.is_commissioner()) with check (private.is_commissioner());
create policy "members read" on public.league_votes for select to authenticated using (private.is_member());
create policy "owners vote for their team" on public.league_votes for insert to authenticated with check (private.manages_team(team_id));
create policy "owners change their team's vote" on public.league_votes for update to authenticated
  using (private.manages_team(team_id)) with check (private.manages_team(team_id));
revoke all on public.league_polls, public.league_votes from anon, authenticated;
grant select, insert, update, delete on public.league_polls to authenticated;
grant select, insert, update on public.league_votes to authenticated;
grant all on public.league_polls, public.league_votes to service_role;

create function private.guard_vote() returns trigger
language plpgsql set search_path = ''
as $$
declare
  p record;
begin
  select * into p from public.league_polls lp where lp.id = new.poll_id;
  if p.closes_at is not null and p.closes_at <= now() then raise exception 'Voting has closed' using errcode = '42501'; end if;
  if new.choice < 1 or new.choice > array_length(p.options, 1) then raise exception 'Not one of the options' using errcode = '22023'; end if;
  if tg_op = 'UPDATE' and (new.poll_id <> old.poll_id or new.team_id <> old.team_id) then raise exception 'Only the choice can change' using errcode = '42501'; end if;
  new.voted_by := (select auth.uid()); new.voted_at := now();
  return new;
end;
$$;
create trigger guard_vote before insert or update on public.league_votes
  for each row execute function private.guard_vote();
revoke execute on function private.guard_vote() from public, anon;
