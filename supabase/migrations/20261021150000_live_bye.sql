-- Live page: starters on bye. A bye player's team has no game this week, so he never kicks
-- off and public.live_lineups would hide him from visitors all week. Now:
--   bye = true when his team has no game this week (while the week has games loaded). The
--         slot's "on bye" flag is shown to everyone (cards warn "⚠ 2 starters on bye"); his
--         name is not, since his manager can still swap him out (no kickoff lock).
--   revealed once the week's last game has kicked off (he can't be swapped in for anything
--         that's still to play), or as before to his team's managers and the commissioner.
drop function public.live_lineups(int, int);
create function public.live_lineups(p_season int, p_week int)
returns table (team_id text, slot smallint, player_id text, name text, pos text, nfl_team text, revealed boolean, bye boolean)
language sql stable security definer set search_path = ''
as $$
  with wk as (
    select max(g.kickoff) as last_kickoff, count(*) as games
    from public.nfl_games g where g.season = p_season and g.week = p_week
  )
  select s.team_id, s.slot,
         case when v.ok then s.player_id end,
         case when v.ok then p.name end,
         case when v.ok then p.position end,
         case when v.ok then p.nfl_team end,
         v.ok,
         v.bye
  from public.lineup_slots s
  join public.nfl_players p on p.id = s.player_id
  cross join wk
  cross join lateral (select private.player_kickoff(s.season, s.week, s.player_id) as k) ko
  cross join lateral (select (ko.k is null and wk.games > 0) as bye) b
  cross join lateral (select coalesce(ko.k <= now(), false)
                             or (b.bye and wk.last_kickoff <= now())
                             or private.manages_team(s.team_id) or private.is_commissioner() as ok, b.bye) v
  where s.season = p_season and s.week = p_week
  order by s.team_id, s.slot
$$;
revoke execute on function public.live_lineups(int, int) from public;
grant execute on function public.live_lineups(int, int) to anon, authenticated, service_role;
