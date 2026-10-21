-- Injury status (Live page warnings). Source: nflverse (src/league/injuries.ts): the NFL's weekly
-- injury report (Out / Doubtful / Questionable) and roster status (injured reserve, PUP,
-- suspended, other reserve; current week only). Written nightly by scripts/sync-nfl.mts.
-- Public facts (the NFL publishes them): anyone reads; only server jobs write.
create table public.player_injuries (
  season int not null,
  week int not null check (week between 1 and 18),
  player_id text not null references public.nfl_players (id),
  status text not null check (status in ('IR', 'PUP', 'Suspended', 'Reserve', 'Out', 'Doubtful', 'Questionable')),
  injury text,                               -- e.g. "Ankle" (weekly report)
  practice text,                             -- e.g. "Limited Participation in Practice"
  source text not null check (source in ('report', 'roster')),
  updated_at timestamptz not null default now(),
  primary key (season, week, player_id)
);
alter table public.player_injuries enable row level security;
create policy "public read" on public.player_injuries for select to anon, authenticated using (true);
revoke all on public.player_injuries from anon, authenticated;
grant select on public.player_injuries to anon, authenticated;
grant all on public.player_injuries to service_role;

-- The nightly job replaces weeks >= p_from_week in one transaction (a player who dropped off the
-- report is healthy again; there's never a moment with no statuses). Earlier weeks are upserted.
create function public.replace_injuries(p_season int, p_from_week int, p_rows jsonb) returns int
language plpgsql set search_path = ''
as $$
declare
  n int;
begin
  delete from public.player_injuries where season = p_season and week >= p_from_week;
  insert into public.player_injuries (season, week, player_id, status, injury, practice, source, updated_at)
  select p_season, (r->>'week')::int, r->>'player_id', r->>'status', r->>'injury', r->>'practice', r->>'source', now()
  from jsonb_array_elements(p_rows) r
  on conflict (season, week, player_id) do update
    set status = excluded.status, injury = excluded.injury, practice = excluded.practice, source = excluded.source, updated_at = now();
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke execute on function public.replace_injuries(int, int, jsonb) from public, anon, authenticated;
grant execute on function public.replace_injuries(int, int, jsonb) to service_role;

-- live_lineups gains `injury` (that week's status). Like `bye`, it's shown for a hidden starter
-- too (a warning, not his name): the NFL publishes injury reports anyway.
drop function public.live_lineups(int, int);
create function public.live_lineups(p_season int, p_week int)
returns table (team_id text, slot smallint, player_id text, name text, pos text, nfl_team text, revealed boolean, bye boolean, injury text)
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
         v.bye,
         i.status
  from public.lineup_slots s
  join public.nfl_players p on p.id = s.player_id
  left join public.player_injuries i on i.season = s.season and i.week = s.week and i.player_id = s.player_id
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
