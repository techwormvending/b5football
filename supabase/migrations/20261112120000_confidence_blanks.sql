-- Confidence Pool: a dropdown per game, blanks allowed (2026-11-01).
-- A game may have a winner without a confidence value, or a value without a winner, or nothing:
-- it scores 0 (src/league/pools.ts). A row needs at least one of the two. Each value is still used
-- once per team-week (the deferred unique key; nulls don't collide), every rule in the guard still
-- applies, and a game that has kicked off is locked: its row can't be changed or removed, so no
-- other game can take its value.
--
-- public.save_confidence_week(season, week, team, picks) saves the whole week as the editor shows it:
-- rows in the list are upserted (unchanged ones skipped), and the team's other rows for that week
-- (cleared games) are deleted. Runs as the caller, so RLS and the guard apply (a locked game can't be
-- changed or deleted). Returns when and by whom the week was last saved.

alter table public.confidence_picks alter column pick drop not null;
alter table public.confidence_picks alter column points drop not null;
alter table public.confidence_picks add constraint confidence_pick_or_points check (pick is not null or points is not null);

create function public.save_confidence_week(p_season int, p_week int, p_team text, p_picks jsonb)
returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
  x record;
  keep text[] := '{}';
  last record;
begin
  for x in select * from jsonb_to_recordset(coalesce(p_picks, '[]')) as t(game_key text, pick text, points int) loop
    if x.pick is null and x.points is null then continue; end if;
    keep := keep || x.game_key;
    -- Unchanged rows (locked games included) are skipped: the guard checks an insert before its conflict
    if exists (select 1 from public.confidence_picks c where c.season = p_season and c.week = p_week and c.team_id = p_team
               and c.game_key = x.game_key and c.pick is not distinct from x.pick and c.points is not distinct from x.points) then continue; end if;
    insert into public.confidence_picks (season, week, team_id, game_key, pick, points)
    values (p_season, p_week, p_team, x.game_key, x.pick, x.points)
    on conflict (season, week, team_id, game_key) do update
      set pick = excluded.pick, points = excluded.points
      where public.confidence_picks.pick is distinct from excluded.pick or public.confidence_picks.points is distinct from excluded.points;
  end loop;
  -- Cleared games: the team's other rows this week (a locked one is refused by the guard)
  delete from public.confidence_picks c
   where c.season = p_season and c.week = p_week and c.team_id = p_team and not (c.game_key = any (keep));
  select c.updated_at, c.set_by into last from public.confidence_picks c
   where c.season = p_season and c.week = p_week and c.team_id = p_team order by c.updated_at desc limit 1;
  return jsonb_build_object('saved_at', coalesce(last.updated_at, now()),
    'saved_by', (select p.display_name from public.profiles p where p.id = coalesce(last.set_by, (select auth.uid()))));
end;
$$;
revoke execute on function public.save_confidence_week(int, int, text, jsonb) from public, anon;
grant execute on function public.save_confidence_week(int, int, text, jsonb) to authenticated, service_role;
