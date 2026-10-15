-- Supabase's default privileges grant anon and authenticated ALL on every new
-- table, sequence and function in public, even with "auto-expose new tables"
-- off (found on the live project 2026-10-15: anon could query profiles,
-- lineups, transactions and score_overrides; RLS still returned nothing).
-- RLS stays the main guard; this restores the second layer: each role gets
-- exactly the table privileges it needs, nothing by default.

-- 1. Stop future objects from being granted automatically.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from anon, authenticated, public;

-- 2. Remove everything granted so far ...
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- 3. ... and grant back exactly what the policies are written for.
-- anon: read-only public data.
grant select on public.teams, public.nfl_players, public.nfl_games, public.roster_entries, public.score_weeks,
  public.player_scores, public.matchups, public.standings, public.announcements to anon;

-- authenticated: RLS policies decide rows; the commissioner's policies cover the writes.
grant select on public.profiles, public.teams, public.team_managers, public.nfl_players, public.nfl_games,
  public.roster_entries, public.lineup_slots, public.transactions, public.score_weeks, public.player_scores,
  public.matchups, public.standings, public.announcements, public.score_overrides, public.review_queue,
  public.audit_log to authenticated;
grant insert, update, delete on public.teams, public.team_managers, public.nfl_players, public.nfl_games,
  public.roster_entries, public.lineup_slots, public.transactions, public.score_weeks, public.player_scores,
  public.matchups, public.standings, public.announcements, public.score_overrides, public.review_queue
  to authenticated;
grant update on public.profiles to authenticated;
grant insert on public.audit_log to authenticated;
-- heartbeats: service_role only (no grant to anon or authenticated).

grant usage on all sequences in schema public to authenticated;

-- service_role (server jobs) keeps everything.
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
