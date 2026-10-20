-- TEMPORARY (2026 shadow season; drop with the other MFL code after the migration).
-- MFL player ID -> our player ID, for every rostered player (written nightly by
-- scripts/sync-mfl-rosters.mts). The live scorer uses it to mirror MFL's current-week
-- starters into lineup_slots without re-downloading the full ID map every minute.
create table public.mfl_player_map (
  mfl_id text primary key,
  player_id text not null references public.nfl_players (id),
  updated_at timestamptz not null default now()
);

alter table public.mfl_player_map enable row level security;
create policy "commissioner reads" on public.mfl_player_map for select to authenticated
  using (private.is_commissioner());

grant select on public.mfl_player_map to authenticated;
grant all on public.mfl_player_map to service_role;
