-- Payouts: replaces the league's payout spreadsheet. A LEDGER ONLY: no money moves
-- through the site, and no home addresses or payment handles are stored anywhere.
--
--   season_settings   pot and prize rules per season (public)
--   team_scores       each team's weekly total (public; written by the nightly shadow
--                     job and the live scorer)
--   awards            prize awards: auto (computed by src/league/payouts.ts), manual
--                     (pick'em, survivor) or override (commissioner, reason required) (public)
--   guillotine        weekly eliminations (public)
--   payout_flags      ties to decide, seed mismatches (commissioner only)
--   team_fees, payout_payments   the money ledger: commissioner edits; a manager sees
--                     only his own team's rows; league totals via payout_league_totals()
-- Every commissioner change to these tables is written to audit_log ("payouts:<table>:<op>").

create table public.season_settings (
  season int primary key,
  team_count int not null check (team_count > 0),
  buy_in numeric(8, 2) not null check (buy_in >= 0),
  website_fee numeric(8, 2) not null default 0,
  empire_contribution numeric(8, 2) not null default 0,  -- per season, out of the fees, into the Empire pot
  empire_carry_in numeric(8, 2) not null default 0,      -- Empire balance carried into this season
  empire_defending_team text references public.teams (id), -- last season's champion ("on Empire watch")
  prizes jsonb not null,
  seed jsonb not null default '{}',                      -- results from the old spreadsheet, checked by the job
  updated_at timestamptz not null default now()
);

create table public.team_scores (
  season int not null,
  week int not null check (week between 1 and 18),
  team_id text not null references public.teams (id),
  points numeric(7, 2) not null,
  status text not null check (status in ('live', 'pending_review', 'final')),
  updated_at timestamptz not null default now(),
  primary key (season, week, team_id)
);

create table public.awards (
  id bigint generated always as identity primary key,
  season int not null,
  kind text not null check (kind in ('weekly_high', 'playoff_r1', 'playoff_r2', 'champion', 'season_points', 'guillotine', 'manual', 'empire')),
  week int,
  place int,
  label text not null,
  team_id text not null references public.teams (id),
  amount numeric(8, 2) not null check (amount >= 0),
  status text not null check (status in ('projected', 'final')),
  source text not null check (source in ('auto', 'manual', 'override')),
  note text,
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  check (source <> 'override' or length(btrim(coalesce(note, ''))) > 0)   -- overrides need a reason
);
create index awards_season_idx on public.awards (season, kind, week);

create table public.guillotine (
  season int not null,
  week int not null check (week between 1 and 18),
  team_id text not null references public.teams (id),
  points numeric(7, 2),
  status text not null check (status in ('projected', 'final')),
  source text not null check (source in ('auto', 'override')),
  note text,
  updated_at timestamptz not null default now(),
  primary key (season, week),
  check (source <> 'override' or length(btrim(coalesce(note, ''))) > 0)
);

create table public.payout_flags (
  season int primary key,
  computed_at timestamptz not null default now(),
  flags jsonb not null default '[]'
);

create table public.team_fees (
  season int not null,
  team_id text not null references public.teams (id),
  amount_due numeric(8, 2) not null default 0,
  paid boolean not null default false,
  paid_at date,
  note text,
  updated_at timestamptz not null default now(),
  primary key (season, team_id)
);

create table public.payout_payments (
  id bigint generated always as identity primary key,
  season int not null,
  team_id text not null references public.teams (id),
  amount numeric(8, 2) not null check (amount > 0),
  paid_at date not null,
  note text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index payout_payments_team_idx on public.payout_payments (season, team_id);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.season_settings enable row level security;
alter table public.team_scores enable row level security;
alter table public.awards enable row level security;
alter table public.guillotine enable row level security;
alter table public.payout_flags enable row level security;
alter table public.team_fees enable row level security;
alter table public.payout_payments enable row level security;

do $$
declare t text;
begin
  foreach t in array array['season_settings', 'team_scores', 'awards', 'guillotine'] loop
    execute format('create policy "public read" on public.%I for select to anon, authenticated using (true)', t);
    execute format('create policy "commissioner writes" on public.%I for all to authenticated
                    using (private.is_commissioner()) with check (private.is_commissioner())', t);
  end loop;
  foreach t in array array['team_fees', 'payout_payments'] loop
    execute format('create policy "own team or commissioner reads" on public.%I for select to authenticated
                    using (private.is_commissioner() or private.manages_team(team_id))', t);
    execute format('create policy "commissioner writes" on public.%I for all to authenticated
                    using (private.is_commissioner()) with check (private.is_commissioner())', t);
  end loop;
end $$;
create policy "commissioner only" on public.payout_flags for all to authenticated
  using (private.is_commissioner()) with check (private.is_commissioner());

grant select on public.season_settings, public.team_scores, public.awards, public.guillotine to anon;
grant select, insert, update, delete on public.season_settings, public.team_scores, public.awards, public.guillotine,
  public.payout_flags, public.team_fees, public.payout_payments to authenticated;
grant all on public.season_settings, public.team_scores, public.awards, public.guillotine,
  public.payout_flags, public.team_fees, public.payout_payments to service_role;
grant usage on all sequences in schema public to authenticated, service_role;

-- League totals for members (a manager sees his own ledger rows, plus these sums).
create function public.payout_league_totals(p_season int) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select case when private.is_member() then jsonb_build_object(
    'fees_due', coalesce((select sum(amount_due) from public.team_fees where season = p_season), 0),
    'fees_paid', coalesce((select sum(amount_due) from public.team_fees where season = p_season and paid), 0),
    'teams_paid', (select count(*) from public.team_fees where season = p_season and paid),
    'teams_unpaid', (select count(*) from public.team_fees where season = p_season and not paid),
    'paid_out', coalesce((select sum(amount) from public.payout_payments where season = p_season), 0)
  ) end
$$;
revoke execute on function public.payout_league_totals(int) from public, anon;
grant execute on function public.payout_league_totals(int) to authenticated, service_role;

-- The nightly/live job replaces all AUTO awards and eliminations in one transaction
-- (readers never see an empty table). Overrides and manual awards are never touched.
create function public.replace_auto_payouts(p_season int, p_awards jsonb, p_guillotine jsonb, p_flags jsonb)
returns void
language plpgsql security invoker set search_path = ''
as $$
begin
  delete from public.awards where season = p_season and source = 'auto';
  insert into public.awards (season, kind, week, place, label, team_id, amount, status, source, note)
  select p_season, a.kind, a.week, a.place, a.label, a.team_id, a.amount, a.status, 'auto', a.note
  from jsonb_to_recordset(p_awards) as a(kind text, week int, place int, label text, team_id text, amount numeric, status text, note text);
  delete from public.guillotine where season = p_season and source = 'auto';
  insert into public.guillotine (season, week, team_id, points, status, source)
  select p_season, g.week, g.team_id, g.points, g.status, 'auto'
  from jsonb_to_recordset(p_guillotine) as g(week int, team_id text, points numeric, status text)
  where not exists (select 1 from public.guillotine o where o.season = p_season and o.week = g.week);
  insert into public.payout_flags (season, computed_at, flags) values (p_season, now(), p_flags)
  on conflict (season) do update set computed_at = excluded.computed_at, flags = excluded.flags;
end;
$$;
revoke execute on function public.replace_auto_payouts(int, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.replace_auto_payouts(int, jsonb, jsonb, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Audit every commissioner change (not server jobs). Runs as the caller, like the
-- own-team audit triggers (inside a definer function is_privileged() is always true).
-- ---------------------------------------------------------------------------
create function private.audit_payouts() returns trigger
language plpgsql set search_path = ''
as $$
declare
  o jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  n jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
begin
  if private.is_privileged() or not private.is_commissioner() then
    return null;
  end if;
  insert into public.audit_log (actor, action, season, week, details)
  values ((select auth.uid()), 'payouts:' || tg_table_name || ':' || lower(tg_op),
          coalesce((n ->> 'season')::int, (o ->> 'season')::int),
          coalesce((n ->> 'week')::int, (o ->> 'week')::int),
          jsonb_build_object('table', tg_table_name, 'op', lower(tg_op), 'old', o, 'new', n));
  return null;
end;
$$;
create trigger audit_payouts after insert or update or delete on public.awards for each row execute function private.audit_payouts();
create trigger audit_payouts after insert or update or delete on public.guillotine for each row execute function private.audit_payouts();
create trigger audit_payouts after insert or update or delete on public.season_settings for each row execute function private.audit_payouts();
create trigger audit_payouts after insert or update or delete on public.team_fees for each row execute function private.audit_payouts();
create trigger audit_payouts after insert or update or delete on public.payout_payments for each row execute function private.audit_payouts();

-- ---------------------------------------------------------------------------
-- 2026 settings (rules confirmed by the commissioner, 2026-10-20). Public information.
-- Pot: 12 x $360 = $4,320 - $80 website - $120 Empire = $4,120 paid out; the prizes below
-- add up to exactly $4,120. Seed = winners already recorded in the spreadsheet (team IDs).
-- ---------------------------------------------------------------------------
insert into public.season_settings (season, team_count, buy_in, website_fee, empire_contribution, empire_carry_in, prizes, seed)
select 2026, 12, 360, 80, 120, 240,
  '{
    "weekly_high":   { "amount": 35, "first_week": 1, "last_week": 17 },
    "playoffs":      { "r1": 60, "r1_games": 4, "r2": 120, "r2_games": 2, "champion": 240, "weeks": [15, 16, 17] },
    "season_points": { "amounts": [1075, 740, 390], "first_week": 1, "last_week": 17 },
    "guillotine":    { "amount": 120, "start_week": 2 },
    "manual": [
      { "key": "pickem_1", "label": "Pick''em 1st", "amount": 180 },
      { "key": "pickem_2", "label": "Pick''em 2nd", "amount": 60 },
      { "key": "survivor", "label": "Survivor", "amount": 240 }
    ]
  }'::jsonb,
  '{
    "weekly_high": { "1": "0005", "2": "0009", "3": "0004", "4": "0003", "5": "0008" },
    "guillotine":  { "2": "0011", "3": "0003", "4": "0012", "5": "0009" }
  }'::jsonb
where exists (select 1 from public.teams where id = '0002');

insert into public.awards (season, kind, label, team_id, amount, status, source, note)
select 2026, 'manual', 'Survivor', '0002', 240, 'final', 'manual', 'From the 2026 payout spreadsheet'
where exists (select 1 from public.teams where id = '0002');
