-- Shadow mode (2026): every week, each team's total from OUR scoring engine (MFL's
-- starters, nflverse stats) vs MFL's official total. Written nightly by
-- scripts/shadow.mts (service_role); shown on the Commish page.
-- Commissioner-only: it names starters before managers would otherwise compare notes,
-- and it's an admin check, not league data.
create table public.shadow_results (
  season int not null,
  week int not null check (week between 1 and 17),
  team_id text not null references public.teams (id),
  mfl_score numeric(7, 2) not null,
  our_score numeric(7, 2) not null,
  matched boolean not null,                -- |our - MFL| < 0.005
  details jsonb not null default '{}',     -- differing players: MFL vs ours, rule lines, plays; unmapped starters
  checked_at timestamptz not null default now(),
  primary key (season, week, team_id)
);

alter table public.shadow_results enable row level security;
create policy "commissioner reads" on public.shadow_results for select to authenticated
  using (private.is_commissioner());

-- Not auto-exposed: grant exactly what the policy is written for. Writes are service_role only.
grant select on public.shadow_results to authenticated;
grant all on public.shadow_results to service_role;
