-- Money is for league members only (2026-11-01).
-- Every dollar amount (prizes, winnings, fees, pots, balances, payouts) is readable only by signed-in
-- league members (a team owner or the commissioner) and officers (treasurers, administrators).
-- Logged-out visitors, and signed-in accounts that aren't on a team, get no amounts anywhere.
--
--   season_settings  the non-money columns stay public (season, team_count, the Empire defending
--                    team, and the pools / waivers / trades / notify / lineups settings pages need);
--                    buy_in, website_fee, empire_contribution, empire_carry_in, prizes and seed are no
--                    longer selectable by anon or authenticated. Members read them through
--                    public.season_money(season), which returns null for everyone else.
--   awards           members and officers only (was public).
--   team_fees, payout_payments, fee_payments, empire_ledger, payout_flags: already members/officers.
--   guillotine, team_scores, survivor_status, confidence_scores: points and standings, no amounts: public.
-- Server jobs (service_role) are unaffected.

create function private.sees_money() returns boolean
language sql stable security definer set search_path = ''
as $$
  select (select auth.uid()) is not null and (private.is_member() or private.is_treasurer() or private.is_admin())
$$;
grant execute on function private.sees_money() to anon, authenticated, service_role;

-- season_settings: column-level access
revoke select on public.season_settings from anon, authenticated;
grant select (season, team_count, empire_defending_team, pools, waivers, trades, notify, lineups, updated_at)
  on public.season_settings to anon, authenticated;

create function public.season_money(p_season int) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select case when private.sees_money() then
    (select jsonb_build_object('season', s.season, 'team_count', s.team_count, 'buy_in', s.buy_in, 'website_fee', s.website_fee,
      'empire_contribution', s.empire_contribution, 'empire_carry_in', s.empire_carry_in, 'empire_defending_team', s.empire_defending_team,
      'prizes', s.prizes, 'seed', s.seed, 'updated_at', s.updated_at)
     from public.season_settings s where s.season = p_season)
  end
$$;
revoke execute on function public.season_money(int) from public, anon;
grant execute on function public.season_money(int) to authenticated, service_role;

-- awards: members and officers only
drop policy "public read" on public.awards;
create policy "members read" on public.awards for select to authenticated using (private.sees_money());
revoke select on public.awards from anon;
