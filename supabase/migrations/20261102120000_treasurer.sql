-- Treasurer (2026-10-25): a third, optional role that keeps the league's books.
--
-- Treasurer: records league fees paid (fee_payments: amount, date, method), winnings paid out
-- (payout_payments: + method), the Empire pot ledger (empire_ledger), sees balances and exports; sees
-- and manages owners' payment preferences (payment_prefs). Can't decide awards (awards, overrides,
-- guillotine stay commissioner actions) or touch scores, rosters, trades or settings.
-- Commissioner: reads the ledger; writes it only while NO treasurer exists (fallback). Never sees
-- payment preferences except his own (unless he is also treasurer). Administrators: neither.
-- Bookkeeper = private.keeps_books() = a treasurer, or a commissioner while there's no treasurer.
-- Conflict of interest: a bookkeeper recording a payment to or from his OWN team records it as
-- pending; a commissioner who isn't the recorder and doesn't own that team confirms or rejects it
-- (public.confirm_payment). With no such commissioner it goes ahead, flagged in the audit log
-- (coi:own_team_unreviewed), as with the other own-team actions. Pending entries don't count.
-- Roles: commissioners grant/revoke treasurer (0 or more holders); audited and emailed like the others.
-- Emails (account notices, always sent): "Pay Mac Daddies $35 — Week 8 high score" when an award
-- becomes final, and a Monday "who's owed" summary; to treasurers, or commissioners when there's none.
-- PRIVACY (changed 2026-10-25 at the commissioner's request): payment handles and mailing addresses
-- are stored ONLY in payment_prefs, readable by the owner and treasurers; never public, never admins.

-- ---------------------------------------------------------------------------
-- Role
-- ---------------------------------------------------------------------------
alter table public.user_roles drop constraint user_roles_role_check;
alter table public.user_roles add constraint user_roles_role_check check (role in ('admin', 'commissioner', 'treasurer'));

create function private.is_treasurer() returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.user_roles r join public.profiles p on p.id = r.user_id
                 where r.user_id = (select auth.uid()) and r.role = 'treasurer' and not p.disabled)
$$;
create function private.keeps_books() returns boolean
language sql stable security definer set search_path = ''
as $$ select private.is_treasurer() or (private.is_commissioner() and private.active_holders('treasurer') = 0) $$;
grant execute on function private.is_treasurer(), private.keeps_books() to anon, authenticated, service_role;

create or replace function private.apply_role(p_user uuid, p_role text, p_grant boolean, p_actor uuid, p_via text) returns boolean
language plpgsql security definer set search_path = ''
as $$
declare by_name text;
begin
  if p_grant then
    insert into public.user_roles (user_id, role, granted_by) values (p_user, p_role, p_actor) on conflict do nothing;
    if not found then return false; end if;
  else
    -- Always at least one administrator and one commissioner; treasurers are optional.
    if p_role in ('admin', 'commissioner')
       and exists (select 1 from public.user_roles r join public.profiles p on p.id = r.user_id where r.user_id = p_user and r.role = p_role and not p.disabled)
       and private.active_holders(p_role) <= 1 then
      raise exception 'There must always be at least one %', case p_role when 'admin' then 'administrator' else 'commissioner' end using errcode = '42501';
    end if;
    delete from public.user_roles where user_id = p_user and role = p_role;
    if not found then return false; end if;
  end if;
  perform set_config('b5.role_sync', 'on', true);
  update public.profiles set
    is_commissioner = exists (select 1 from public.user_roles r where r.user_id = p_user and r.role = 'commissioner'),
    is_admin = exists (select 1 from public.user_roles r where r.user_id = p_user and r.role = 'admin')
  where id = p_user;
  perform set_config('b5.role_sync', 'off', true);
  insert into public.audit_log (actor, actor_label, action, details)
  values (p_actor, case when p_actor is null then p_via end, 'roles:' || case when p_grant then 'grant' else 'revoke' end,
          jsonb_build_object('user', p_user, 'role', p_role, 'via', p_via));
  select coalesce(nullif(display_name, ''), 'an officer') into by_name from public.profiles where id = p_actor;
  insert into public.notify_queue (user_id, kind, ref, due_at, payload)
  values (p_user, 'account', 'role:' || p_role || ':' || case when p_grant then 'grant' else 'revoke' end || ':' || extract(epoch from clock_timestamp())::bigint, now(),
          jsonb_build_object('type', 'role', 'role', p_role, 'action', case when p_grant then 'grant' else 'revoke' end, 'by', coalesce(by_name, 'the league')))
  on conflict do nothing;
  return true;
end;
$$;

create or replace function public.grant_role(p_user uuid, p_role text) returns text
language plpgsql security definer set search_path = ''
as $$
begin
  if p_role not in ('admin', 'commissioner', 'treasurer') then raise exception 'Unknown role' using errcode = '22023'; end if;
  if p_role in ('commissioner', 'treasurer') and not private.is_commissioner() then raise exception 'Only a commissioner can grant the % role', p_role using errcode = '42501'; end if;
  if p_role = 'admin' and not private.is_admin() then raise exception 'Only an administrator can grant the administrator role' using errcode = '42501'; end if;
  if not exists (select 1 from public.profiles where id = p_user) then raise exception 'No such account' using errcode = '22023'; end if;
  return case when private.apply_role(p_user, p_role, true, (select auth.uid()), 'officers') then 'Granted' else 'Already held' end;
end;
$$;
create or replace function public.revoke_role(p_user uuid, p_role text) returns text
language plpgsql security definer set search_path = ''
as $$
begin
  if p_role in ('commissioner', 'treasurer') and not private.is_commissioner() then raise exception 'Only a commissioner can revoke the % role', p_role using errcode = '42501'; end if;
  if p_role = 'admin' and not private.is_admin() then raise exception 'Only an administrator can revoke the administrator role' using errcode = '42501'; end if;
  return case when private.apply_role(p_user, p_role, false, (select auth.uid()), 'officers') then 'Revoked' else 'Not held' end;
end;
$$;

-- ---------------------------------------------------------------------------
-- Ledger tables
-- ---------------------------------------------------------------------------
create table public.fee_payments (
  id bigint generated always as identity primary key,
  season int not null,
  team_id text not null references public.teams (id),
  amount numeric(8, 2) not null check (amount > 0),
  paid_at date not null,
  method text check (method is null or length(method) <= 40),
  note text check (note is null or length(note) <= 200),
  status text not null default 'confirmed' check (status in ('confirmed', 'pending')),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  confirmed_by uuid,
  confirmed_at timestamptz
);
create index fee_payments_team_idx on public.fee_payments (season, team_id);
alter table public.payout_payments
  add column method text check (method is null or length(method) <= 40),
  add column status text not null default 'confirmed' check (status in ('confirmed', 'pending')),
  add column confirmed_by uuid,
  add column confirmed_at timestamptz;
create table public.empire_ledger (
  id bigint generated always as identity primary key,
  season int not null,
  kind text not null check (kind in ('carry_in', 'contribution', 'payout', 'rollover', 'adjustment')),
  amount numeric(8, 2) not null,                   -- signed: payouts and rollovers out are negative
  team_id text references public.teams (id),       -- payouts: the repeat champion
  entry_date date not null default (now() at time zone 'America/New_York')::date,
  note text check (note is null or length(note) <= 200),
  status text not null default 'confirmed' check (status in ('confirmed', 'pending')),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  confirmed_by uuid,
  confirmed_at timestamptz,
  check (kind <> 'payout' or team_id is not null)
);

-- RLS: officers (commissioner, treasurer) and the team's own managers read; bookkeepers write.
drop policy "own team or commissioner reads" on public.team_fees;
drop policy "commissioner writes" on public.team_fees;
drop policy "own team or commissioner reads" on public.payout_payments;
drop policy "commissioner writes" on public.payout_payments;
alter table public.fee_payments enable row level security;
alter table public.empire_ledger enable row level security;
do $$
declare t text;
begin
  foreach t in array array['team_fees', 'payout_payments', 'fee_payments'] loop
    execute format('create policy "officers and own team read" on public.%I for select to authenticated
                    using (private.is_commissioner() or private.is_treasurer() or private.manages_team(team_id))', t);
    execute format('create policy "bookkeepers insert" on public.%I for insert to authenticated with check (private.keeps_books())', t);
    execute format('create policy "bookkeepers update" on public.%I for update to authenticated using (private.keeps_books()) with check (private.keeps_books())', t);
    execute format('create policy "bookkeepers delete" on public.%I for delete to authenticated using (private.keeps_books())', t);
  end loop;
end $$;
create policy "members read" on public.empire_ledger for select to authenticated using (private.is_member() or private.is_treasurer());
create policy "bookkeepers insert" on public.empire_ledger for insert to authenticated with check (private.keeps_books());
create policy "bookkeepers update" on public.empire_ledger for update to authenticated using (private.keeps_books()) with check (private.keeps_books());
create policy "bookkeepers delete" on public.empire_ledger for delete to authenticated using (private.keeps_books());
revoke all on public.fee_payments, public.empire_ledger from anon, authenticated;
grant select, insert, update, delete on public.fee_payments, public.empire_ledger to authenticated;
grant all on public.fee_payments, public.empire_ledger to service_role;

-- ---------------------------------------------------------------------------
-- Conflict of interest on own-team payments (runs as the caller)
-- ---------------------------------------------------------------------------
-- A commissioner who could confirm a payment for p_team recorded by p_by.
create function private.payment_confirmer_exists(p_team text, p_by uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.user_roles r join public.profiles p on p.id = r.user_id
                 where r.role = 'commissioner' and not p.disabled and r.user_id is distinct from p_by
                   and not exists (select 1 from public.team_managers tm where tm.user_id = r.user_id and tm.team_id = p_team))
$$;
create function private.guard_ledger() returns trigger
language plpgsql set search_path = ''
as $$
declare me uuid := (select auth.uid());
begin
  if private.is_privileged() then return coalesce(new, old); end if;
  if tg_op = 'INSERT' then
    new.created_by := me; new.created_at := now();
    if new.team_id is not null and private.manages_team(new.team_id) then
      if private.payment_confirmer_exists(new.team_id, me) then
        new.status := 'pending'; new.confirmed_by := null; new.confirmed_at := null;
      else
        new.status := 'confirmed'; new.confirmed_by := me; new.confirmed_at := now();
        insert into public.audit_log (actor, action, season, details)
        values (me, 'coi:own_team_unreviewed', new.season, jsonb_build_object('table', tg_table_name, 'team', new.team_id, 'amount', new.amount,
                'note', 'No other commissioner can confirm it'));
      end if;
    else
      new.status := 'confirmed'; new.confirmed_by := me; new.confirmed_at := now();
    end if;
    return new;
  end if;
  -- Changing or deleting: never your own team's entry (except withdrawing your own pending one);
  -- confirmation fields only change through confirm_payment.
  if tg_op = 'DELETE' then
    if old.team_id is not null and private.manages_team(old.team_id) and not (old.status = 'pending' and old.created_by = me) then
      raise exception 'That''s your own team''s payment: ask a commissioner or another treasurer to change it' using errcode = '42501';
    end if;
    return old;
  end if;
  if (old.team_id is not null and private.manages_team(old.team_id)) or (new.team_id is not null and private.manages_team(new.team_id)) then
    raise exception 'That''s your own team''s payment: ask a commissioner or another treasurer to change it' using errcode = '42501';
  end if;
  if new.status is distinct from old.status or new.confirmed_by is distinct from old.confirmed_by or new.created_by is distinct from old.created_by then
    raise exception 'Payments are confirmed with confirm_payment' using errcode = '42501';
  end if;
  return new;
end;
$$;
grant execute on function private.payment_confirmer_exists(text, uuid) to authenticated, service_role;
create trigger guard_ledger before insert or update or delete on public.fee_payments for each row execute function private.guard_ledger();
create trigger guard_ledger before insert or update or delete on public.payout_payments for each row execute function private.guard_ledger();
create trigger guard_ledger before insert or update or delete on public.empire_ledger for each row execute function private.guard_ledger();

-- A commissioner confirms (or rejects = deletes) a pending own-team payment.
create function public.confirm_payment(p_table text, p_id bigint, p_approve boolean) returns text
language plpgsql security definer set search_path = ''
as $$
declare me uuid := (select auth.uid()); r record;
begin
  if p_table not in ('fee_payments', 'payout_payments', 'empire_ledger') then raise exception 'Unknown ledger' using errcode = '22023'; end if;
  if not private.is_commissioner() then raise exception 'Only a commissioner can confirm a payment' using errcode = '42501'; end if;
  execute format('select id, season, team_id, amount, status, created_by from public.%I where id = $1 for update', p_table) into r using p_id;
  if r.id is null then raise exception 'No such payment' using errcode = '22023'; end if;
  if r.status <> 'pending' then raise exception 'That payment isn''t waiting for confirmation' using errcode = '22023'; end if;
  if r.created_by = me then raise exception 'Another commissioner has to confirm your own entry' using errcode = '42501'; end if;
  if exists (select 1 from public.team_managers tm where tm.user_id = me and tm.team_id = r.team_id) then
    raise exception 'You own that team: another commissioner has to confirm it' using errcode = '42501';
  end if;
  if p_approve then
    execute format('update public.%I set status = ''confirmed'', confirmed_by = $1, confirmed_at = now() where id = $2', p_table) using me, p_id;
  else
    execute format('delete from public.%I where id = $1', p_table) using p_id;
  end if;
  insert into public.audit_log (actor, action, season, details)
  values (me, 'coi:payment_' || case when p_approve then 'confirmed' else 'rejected' end, r.season,
          jsonb_build_object('table', p_table, 'id', p_id, 'team', r.team_id, 'amount', r.amount, 'recorded_by', r.created_by));
  return case when p_approve then 'Confirmed' else 'Rejected' end;
end;
$$;

-- team_fees.paid / paid_at follow the confirmed fee payments (the fee row keeps the amount due).
create function private.sync_team_fee() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare s int := coalesce(new.season, old.season); t text := coalesce(new.team_id, old.team_id); total numeric; last date;
begin
  select coalesce(sum(x.amount), 0), max(x.paid_at) into total, last from public.fee_payments x where x.season = s and x.team_id = t and x.status = 'confirmed';
  insert into public.team_fees (season, team_id, amount_due, paid, paid_at)
  values (s, t, coalesce((select buy_in from public.season_settings where season = s), 0), false, null)
  on conflict (season, team_id) do nothing;
  update public.team_fees f set paid = f.amount_due > 0 and total >= f.amount_due, paid_at = case when total > 0 then last end, updated_at = now()
   where f.season = s and f.team_id = t;
  return null;
end;
$$;
create trigger sync_team_fee after insert or update or delete on public.fee_payments for each row execute function private.sync_team_fee();

-- Every bookkeeper change is audited (commissioners' and treasurers'); server jobs aren't.
create or replace function private.audit_payouts() returns trigger
language plpgsql set search_path = ''
as $$
declare
  o jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  n jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
begin
  if private.is_privileged() or not (private.is_commissioner() or private.is_treasurer()) then
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
create trigger audit_payouts after insert or update or delete on public.fee_payments for each row execute function private.audit_payouts();
create trigger audit_payouts after insert or update or delete on public.empire_ledger for each row execute function private.audit_payouts();

-- An auto award replaced by a commissioner override for the same prize doesn't count.
create function private.award_superseded(a public.awards) returns boolean
language sql stable security definer set search_path = ''
as $$
  select a.source = 'auto' and exists (select 1 from public.awards o where o.season = a.season and o.kind = a.kind and o.source = 'override'
    and o.week is not distinct from a.week and o.place is not distinct from a.place)
$$;
-- Balances: officers see every team, a manager his own; confirmed entries only.
create function public.treasury_balances(p_season int)
returns table (team_id text, fee_due numeric, fee_paid numeric, won numeric, projected numeric, paid_out numeric, owed numeric, pending int)
language sql stable security definer set search_path = ''
as $$
  select t.id,
    coalesce((select f.amount_due from public.team_fees f where f.season = p_season and f.team_id = t.id), (select s.buy_in from public.season_settings s where s.season = p_season), 0),
    coalesce((select sum(x.amount) from public.fee_payments x where x.season = p_season and x.team_id = t.id and x.status = 'confirmed'), 0),
    coalesce((select sum(a.amount) from public.awards a where a.season = p_season and a.team_id = t.id and a.status = 'final' and not private.award_superseded(a)), 0),
    coalesce((select sum(a.amount) from public.awards a where a.season = p_season and a.team_id = t.id and a.status = 'projected' and not private.award_superseded(a)), 0),
    coalesce((select sum(x.amount) from public.payout_payments x where x.season = p_season and x.team_id = t.id and x.status = 'confirmed'), 0),
    coalesce((select sum(a.amount) from public.awards a where a.season = p_season and a.team_id = t.id and a.status = 'final' and not private.award_superseded(a)), 0)
      - coalesce((select sum(x.amount) from public.payout_payments x where x.season = p_season and x.team_id = t.id and x.status = 'confirmed'), 0),
    ((select count(*) from public.fee_payments x where x.season = p_season and x.team_id = t.id and x.status = 'pending')
      + (select count(*) from public.payout_payments x where x.season = p_season and x.team_id = t.id and x.status = 'pending'))::int
  from public.teams t
  where private.is_commissioner() or private.is_treasurer() or private.manages_team(t.id)
  order by t.id
$$;
revoke execute on function public.treasury_balances(int), public.confirm_payment(text, bigint, boolean) from public, anon;
grant execute on function public.treasury_balances(int), public.confirm_payment(text, bigint, boolean) to authenticated, service_role;

create or replace function public.payout_league_totals(p_season int) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select case when private.is_member() or private.is_treasurer() then jsonb_build_object(
    'fees_due', coalesce((select sum(amount_due) from public.team_fees where season = p_season), 0),
    'fees_paid', coalesce((select sum(amount_due) from public.team_fees where season = p_season and paid), 0),
    'teams_paid', (select count(*) from public.team_fees where season = p_season and paid),
    'teams_unpaid', (select count(*) from public.team_fees where season = p_season and not paid),
    'paid_out', coalesce((select sum(amount) from public.payout_payments where season = p_season and status = 'confirmed'), 0)
  ) end
$$;

-- Who keeps the books right now (for the pages).
create function public.treasury_info() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('treasurers', private.active_holders('treasurer'), 'keeps_books', private.keeps_books(),
    'is_treasurer', private.is_treasurer(), 'can_view', private.is_treasurer() or private.is_commissioner())
$$;
revoke execute on function public.treasury_info() from public;
grant execute on function public.treasury_info() to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Payment preferences (private: the owner and treasurers only)
-- ---------------------------------------------------------------------------
create table public.payment_prefs (
  user_id uuid primary key references public.profiles (id) on delete cascade default auth.uid(),
  venmo text check (venmo is null or (length(venmo) <= 40 and venmo !~ '[<>"\s]')),
  paypal text check (paypal is null or (length(paypal) <= 120 and paypal !~ '[<>"\s]')),
  mailing_address text check (mailing_address is null or length(mailing_address) <= 300),
  in_person boolean not null default false,
  note text check (note is null or length(note) <= 200),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);
alter table public.payment_prefs enable row level security;
create policy "own or treasurer reads" on public.payment_prefs for select to authenticated using (user_id = (select auth.uid()) or private.is_treasurer());
create policy "own or treasurer inserts" on public.payment_prefs for insert to authenticated with check (user_id = (select auth.uid()) or private.is_treasurer());
create policy "own or treasurer updates" on public.payment_prefs for update to authenticated
  using (user_id = (select auth.uid()) or private.is_treasurer()) with check (user_id = (select auth.uid()) or private.is_treasurer());
create policy "own or treasurer deletes" on public.payment_prefs for delete to authenticated using (user_id = (select auth.uid()) or private.is_treasurer());
revoke all on public.payment_prefs from anon, authenticated;
grant select, insert, update, delete on public.payment_prefs to authenticated;
grant all on public.payment_prefs to service_role;

create function private.guard_payment_prefs() returns trigger
language plpgsql set search_path = ''
as $$
declare me uuid := (select auth.uid());
begin
  if private.is_privileged() then return new; end if;
  if tg_op = 'INSERT' and new.user_id is null then new.user_id := me; end if;
  if tg_op = 'UPDATE' and new.user_id is distinct from old.user_id then raise exception 'A payment preference can''t move to another account' using errcode = '42501'; end if;
  new.updated_at := now(); new.updated_by := me;
  if new.user_id is distinct from me then   -- a treasurer editing someone's: audited, without the contents
    insert into public.audit_log (actor, action, details) values (me, 'treasury:payment_prefs:' || lower(tg_op), jsonb_build_object('user', new.user_id));
  end if;
  return new;
end;
$$;
create trigger guard_payment_prefs before insert or update on public.payment_prefs for each row execute function private.guard_payment_prefs();

-- ---------------------------------------------------------------------------
-- Treasurer emails (account notices: always sent)
-- ---------------------------------------------------------------------------
create table public.treasury_notices (
  key text primary key,
  at timestamptz not null default now()
);
alter table public.treasury_notices enable row level security;
revoke all on public.treasury_notices from anon, authenticated;
grant all on public.treasury_notices to service_role;

create function private.treasury_recipients() returns setof uuid
language sql stable security definer set search_path = ''
as $$
  select r.user_id from public.user_roles r join public.profiles p on p.id = r.user_id where r.role = 'treasurer' and not p.disabled
  union
  select r.user_id from public.user_roles r join public.profiles p on p.id = r.user_id
  where r.role = 'commissioner' and not p.disabled and private.active_holders('treasurer') = 0
$$;
create function private.award_notice_key(a public.awards) returns text
language sql immutable set search_path = ''
as $$ select concat_ws(':', 'pay', a.season, a.kind, coalesce(a.week, 0), coalesce(a.place, 0), a.team_id, a.label, a.amount) $$;

-- An award that becomes final -> "Pay Mac Daddies $35 — Week 8 high score" (once per award).
create function private.notify_award_final() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare k text; u uuid;
begin
  if new.status <> 'final' or new.amount <= 0 or private.award_superseded(new) then return null; end if;
  k := private.award_notice_key(new);
  insert into public.treasury_notices (key) values (k) on conflict do nothing;
  if not found then return null; end if;
  for u in select private.treasury_recipients() loop
    insert into public.notify_queue (user_id, kind, ref, due_at, payload)
    values (u, 'account', k, now() + interval '5 minutes',
            jsonb_build_object('type', 'pay', 'team', private.team_name(new.team_id), 'amount', new.amount, 'label', new.label, 'season', new.season))
    on conflict do nothing;
  end loop;
  return null;
end;
$$;
create trigger notify_award_final after insert or update of status on public.awards for each row execute function private.notify_award_final();
-- Awards already final today were handled by hand: no flood on the first nightly refresh.
insert into public.treasury_notices (key) select private.award_notice_key(a) from public.awards a where a.status = 'final' on conflict do nothing;

-- Mondays from 9 AM ET: "who's owed" (once a week, only when something is owed or unpaid).
create function private.treasury_weekly_tick(p_now timestamptz default now()) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  et timestamp := p_now at time zone 'America/New_York';
  k text := 'weekly:' || to_char(et, 'IYYY-IW');
  s int := (select max(season) from public.season_settings where season <= extract(year from et)::int);
  owed jsonb; u uuid;
begin
  if extract(isodow from et) <> 1 or extract(hour from et) < 9 then return 'not Monday 9 AM ET or later'; end if;
  if s is null then return 'no season'; end if;
  if exists (select 1 from public.treasury_notices where key = k) then return 'already sent'; end if;
  select jsonb_agg(jsonb_build_object('team', private.team_name(b.team_id), 'owed', b.owed, 'fee_unpaid', greatest(b.fee_due - b.fee_paid, 0), 'pending', b.pending) order by b.owed desc)
    into owed
  from (select t.id as team_id,
          coalesce((select f.amount_due from public.team_fees f where f.season = s and f.team_id = t.id), (select buy_in from public.season_settings where season = s)) as fee_due,
          coalesce((select sum(x.amount) from public.fee_payments x where x.season = s and x.team_id = t.id and x.status = 'confirmed'), 0) as fee_paid,
          coalesce((select sum(a.amount) from public.awards a where a.season = s and a.team_id = t.id and a.status = 'final' and not private.award_superseded(a)), 0)
            - coalesce((select sum(x.amount) from public.payout_payments x where x.season = s and x.team_id = t.id and x.status = 'confirmed'), 0) as owed,
          ((select count(*) from public.fee_payments x where x.season = s and x.team_id = t.id and x.status = 'pending')
            + (select count(*) from public.payout_payments x where x.season = s and x.team_id = t.id and x.status = 'pending'))::int as pending
        from public.teams t) b
  where b.owed > 0 or b.fee_due > b.fee_paid or b.pending > 0;
  insert into public.treasury_notices (key) values (k);
  if owed is null then return 'nothing owed'; end if;
  for u in select private.treasury_recipients() loop
    insert into public.notify_queue (user_id, kind, ref, due_at, payload)
    values (u, 'account', k, now(), jsonb_build_object('type', 'owed', 'season', s, 'teams', owed)) on conflict do nothing;
  end loop;
  return 'sent';
end;
$$;
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    perform cron.schedule('b5-treasury-weekly', '20 * * * 1', 'select private.treasury_weekly_tick()');
  end if;
end $$;

revoke execute on function private.is_treasurer(), private.keeps_books() from public;
grant execute on function private.is_treasurer(), private.keeps_books() to anon, authenticated, service_role;
revoke execute on function private.treasury_recipients(), private.treasury_weekly_tick(timestamptz),
  private.notify_award_final(), private.sync_team_fee(), private.award_superseded(public.awards) from public, anon, authenticated;

-- Treasurers' changes are audited from triggers that run as the caller.
create policy "treasurers append" on public.audit_log for insert to authenticated with check (private.is_treasurer());
