-- Player schedule pop-up (2026-10-25): fantasy points each NFL team allows to each position this season,
-- from our own scoring (player_scores x the player's position and game). One call per page load (the
-- pop-up caches it); public read like the scores it's built from.
-- avg = points scored by that position against the team, per game the team played (a week with only
-- some of that position's players scoring still counts as one game).
create function public.points_allowed(p_season int)
returns table (team text, pos text, games int, avg numeric)
language sql stable security definer set search_path = ''
as $$
  with s as (
    select ps.week, ps.points, np.position as pos, np.nfl_team,
           split_part(ps.game_key, '@', 1) as away, split_part(ps.game_key, '@', 2) as home
    from public.player_scores ps join public.nfl_players np on np.id = ps.player_id
    where ps.season = p_season and ps.game_key like '%@%' and np.position in ('QB', 'RB', 'WR', 'TE', 'K', 'DEF')
  )
  select case when s.nfl_team = s.away then s.home else s.away end as team, s.pos,
         count(distinct s.week)::int as games, round(sum(s.points) / count(distinct s.week), 1) as avg
  from s where s.nfl_team in (s.away, s.home)
  group by 1, 2
$$;
revoke execute on function public.points_allowed(int) from public;
grant execute on function public.points_allowed(int) to anon, authenticated, service_role;
