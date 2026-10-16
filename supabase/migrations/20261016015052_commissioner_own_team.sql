-- The commissioner can also manage a team (e.g. Mac Daddies). Being commissioner
-- must not help your own team:
--
-- 1. Lineups: on a team you manage, the commissioner exemption does NOT apply.
--    Roster, slot position and the kickoff lock are enforced exactly as for any
--    manager. (On other teams the commissioner can still fix lineups, even locked.)
-- 2. Transactions: a transaction involving your own team must be created as
--    pending, like every manager's.
-- 3. Every commissioner-only write that touches a team you manage is written to
--    audit_log (action 'own_team:<table>:<op>'): deciding a transaction, roster
--    changes, matchup scores, standings, score overrides on your players, and
--    assigning yourself to (or removing yourself from) a team. Server jobs
--    (service_role) and ordinary manager actions are not logged here.

-- ---------------------------------------------------------------------------
-- 1. Lineups
-- ---------------------------------------------------------------------------
-- True when the commissioner exemption applies to a row of these teams: the caller
-- is the commissioner and manages none of them.
create function private.commissioner_exempt(p_teams text[]) returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.is_commissioner()
     and not exists (select 1 from unnest(p_teams) t where t is not null and private.manages_team(t))
$$;
grant execute on function private.commissioner_exempt(text[]) to authenticated, service_role;

create or replace function private.guard_lineup() returns trigger
language plpgsql set search_path = ''
as $$
declare
  k timestamptz;
  pos text;
  teams text[];
begin
  if tg_op = 'INSERT' then teams := array[new.team_id];
  elsif tg_op = 'UPDATE' then teams := array[old.team_id, new.team_id];
  else teams := array[old.team_id];
  end if;
  if private.is_privileged() or private.commissioner_exempt(teams) then
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

-- ---------------------------------------------------------------------------
-- 2. Transactions: own-team ones start as pending
-- ---------------------------------------------------------------------------
create function private.guard_own_transaction() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if private.is_commissioner() and not private.is_privileged()
     and not private.commissioner_exempt(array[new.team_id, new.partner_team_id])
     and new.status <> 'pending' then
    raise exception 'Transactions for your own team start as pending, like every manager''s' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger guard_own_transaction before insert on public.transactions
  for each row execute function private.guard_own_transaction();

-- ---------------------------------------------------------------------------
-- 3. Audit log for commissioner writes that touch your own team
-- ---------------------------------------------------------------------------
-- Trigger arguments: the row's team-id column names (e.g. 'home_team', 'away_team').
-- The audit functions run as the caller (NOT security definer): inside a definer function
-- current_user is the owner, so private.is_privileged() would always be true. The
-- commissioner may append to audit_log (policy "commissioner appends").
create function private.audit_own_team() returns trigger
language plpgsql set search_path = ''
as $$
declare
  o jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  n jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  teams text[] := '{}';
  col text;
begin
  if not private.is_commissioner() or private.is_privileged() then
    return null;
  end if;
  foreach col in array tg_argv loop
    teams := teams || array[o ->> col, n ->> col];
  end loop;
  if private.commissioner_exempt(teams) then   -- touches no team you manage
    return null;
  end if;
  insert into public.audit_log (actor, action, season, week, details)
  values ((select auth.uid()), 'own_team:' || tg_table_name || ':' || lower(tg_op),
          coalesce((n ->> 'season')::int, (o ->> 'season')::int),
          coalesce((n ->> 'week')::int, (o ->> 'week')::int),
          jsonb_build_object('table', tg_table_name, 'op', lower(tg_op), 'old', o, 'new', n));
  return null;
end;
$$;

-- Manager actions on transactions (create / edit / cancel your own pending one) aren't
-- commissioner powers; only log deciding, deleting, or changing someone else's fields.
create function private.audit_own_transaction() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if not private.is_commissioner() or private.is_privileged()
     or private.commissioner_exempt(array[old.team_id, old.partner_team_id,
                                          case when tg_op = 'UPDATE' then new.team_id end,
                                          case when tg_op = 'UPDATE' then new.partner_team_id end]) then
    return null;
  end if;
  if tg_op = 'UPDATE' and new.status in ('pending', 'cancelled') and private.manages_team(old.team_id)
     and new.decided_by is not distinct from old.decided_by and new.decided_at is not distinct from old.decided_at then
    return null;   -- editing or cancelling your own pending request, as any manager may
  end if;
  insert into public.audit_log (actor, action, season, details)
  values ((select auth.uid()), 'own_team:transactions:' || lower(tg_op), old.season,
          jsonb_build_object('table', 'transactions', 'op', lower(tg_op), 'old', to_jsonb(old),
                             'new', case when tg_op = 'UPDATE' then to_jsonb(new) end));
  return null;
end;
$$;

-- Score overrides name a player ('nflverse:<gsis>' or 'DEF:<TEAM>'); it's your team if he's on your roster that season.
create function private.audit_own_override() returns trigger
language plpgsql set search_path = ''
as $$
declare
  r record := coalesce(new, old);
  owner text;
begin
  if not private.is_commissioner() or private.is_privileged() then
    return null;
  end if;
  select re.team_id into owner from public.roster_entries re
  where re.season = r.season and re.player_id = regexp_replace(r.target_key, '^nflverse:', '');
  if owner is null or private.commissioner_exempt(array[owner]) then
    return null;
  end if;
  insert into public.audit_log (actor, action, season, week, details)
  values ((select auth.uid()), 'own_team:score_overrides:' || lower(tg_op), r.season, r.week,
          jsonb_build_object('table', 'score_overrides', 'op', lower(tg_op), 'team_id', owner,
                             'old', case when tg_op <> 'INSERT' then to_jsonb(old) end,
                             'new', case when tg_op <> 'DELETE' then to_jsonb(new) end));
  return null;
end;
$$;

-- Assigning or removing YOURSELF as a team's manager.
create function private.audit_self_assignment() returns trigger
language plpgsql set search_path = ''
as $$
declare
  r record := coalesce(new, old);
begin
  if not private.is_commissioner() or private.is_privileged() or r.user_id is distinct from (select auth.uid()) then
    return null;
  end if;
  insert into public.audit_log (actor, action, details)
  values ((select auth.uid()), 'own_team:team_managers:' || lower(tg_op),
          jsonb_build_object('table', 'team_managers', 'op', lower(tg_op), 'team_id', r.team_id, 'user_id', r.user_id));
  return null;
end;
$$;

create trigger audit_own_team after insert or update or delete on public.roster_entries
  for each row execute function private.audit_own_team('team_id');
create trigger audit_own_team after insert or update or delete on public.matchups
  for each row execute function private.audit_own_team('home_team', 'away_team');
create trigger audit_own_team after insert or update or delete on public.standings
  for each row execute function private.audit_own_team('team_id');
create trigger audit_own_team after update or delete on public.transactions
  for each row execute function private.audit_own_transaction();
create trigger audit_own_team after insert or update or delete on public.score_overrides
  for each row execute function private.audit_own_override();
create trigger audit_self_assignment after insert or delete on public.team_managers
  for each row execute function private.audit_self_assignment();
