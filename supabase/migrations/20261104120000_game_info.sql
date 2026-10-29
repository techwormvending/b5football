-- Game details for the Confidence Pool's game cards (2026-10-29): records, betting line, stadium
-- (roof, surface, international site) and kickoff forecast. Info only: picks are straight up.
-- Written by server jobs only (Edge job "game_info" every 3 hours in season; the live scorer also
-- refreshes records and lines each pass). Public read: browsers read this table and never call
-- ESPN or Open-Meteo themselves.

create table public.nfl_game_info (
  season int not null,
  week int not null,
  game_key text not null,                -- 'AWAY@HOME', as nfl_games
  away_record text,                      -- "5-2" or "4-2-1"
  home_record text,
  spread text,                           -- "KC -3.5", "Pick'em"; null = no line posted
  over_under numeric(5, 1),
  odds_provider text,                    -- e.g. "DraftKings" (via ESPN)
  odds_at timestamptz,                   -- when that line was read
  venue_name text,
  venue_city text,
  venue_country text,
  intl text,                             -- "London", "Munich", "Madrid"... for games outside the USA
  roof text check (roof in ('dome', 'retractable', 'outdoor')),
  surface text check (surface in ('grass', 'turf')),
  lat numeric(8, 4),
  lon numeric(8, 4),
  espn_weather jsonb,                    -- ESPN's own short forecast, when it has one
  weather jsonb,                         -- {temp_f, condition, icon, wind_mph, precip_pct, heavy, source}
  weather_at timestamptz,                -- "Forecast as of"
  updated_at timestamptz not null default now(),
  primary key (season, week, game_key)
);
alter table public.nfl_game_info enable row level security;
create policy "public read" on public.nfl_game_info for select to anon, authenticated using (true);
revoke all on public.nfl_game_info from anon, authenticated;
grant select on public.nfl_game_info to anon, authenticated;
grant all on public.nfl_game_info to service_role;

-- Every 3 hours, only in season (a game within the last 2 days or the next 10): ask the Edge
-- function to refresh this week and next. Same one-time-nonce call as the other jobs.
create function private.game_info_tick(p_now timestamptz default now()) returns text
language plpgsql security definer set search_path = ''
as $$
declare s int; n uuid;
begin
  select g.season into s from public.nfl_games g
   where g.kickoff between p_now - interval '2 days' and p_now + interval '10 days'
   order by g.kickoff limit 1;
  if s is null then return 'not in season'; end if;
  delete from public.live_nonces where created_at < now() - interval '10 minutes';
  insert into public.live_nonces default values returning nonce into n;
  perform net.http_post(
    url := 'https://kngwdttpbpezlvjrkrrg.supabase.co/functions/v1/b5-live',
    body := jsonb_build_object('nonce', n, 'job', 'game_info', 'season', s),
    headers := jsonb_build_object('Content-Type', 'application/json'),
    timeout_milliseconds := 120000
  );
  return 'requested ' || s;
end;
$$;
revoke execute on function private.game_info_tick(timestamptz) from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    perform cron.schedule('b5-game-info', '23 */3 * * *', 'select private.game_info_tick()');
  end if;
end $$;
