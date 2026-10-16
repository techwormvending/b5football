-- Save a whole starting lineup in one call (the My Team page's "Save lineup").
--
-- Writing slot by slot through the Data API can't swap two players (e.g. WR1 and
-- WR2): the first write trips the one-player-per-lineup unique key. This function
-- removes the slots that change, then inserts the new ones, in one transaction.
--
-- SECURITY INVOKER on purpose: it runs as the caller, so RLS and the guard_lineup
-- trigger apply exactly as for direct writes (own team only, player on the
-- roster, right position, locked at kickoff; the commissioner is exempt). If any
-- slot is refused, nothing is saved.
--
-- p_players: 9 nflverse player IDs (or null = empty) in slot order
-- QB RB RB WR WR WR TE K DEF. Unchanged slots are left alone, so a player whose
-- game has kicked off can stay where he is while the rest of the lineup changes.
create function public.save_lineup(p_season int, p_week int, p_team text, p_players text[])
returns setof public.lineup_slots
language plpgsql security invoker set search_path = ''
as $$
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

revoke execute on function public.save_lineup(int, int, text, text[]) from public, anon;
grant execute on function public.save_lineup(int, int, text, text[]) to authenticated, service_role;
