-- Treasurer: no commissioner confirmation (2026-11-01). A bookkeeper's entry for his own team saves
-- immediately like any other; the pending state and confirm_payment are gone. Every ledger change is
-- still audited (who, when, the row incl. amount); one touching the actor's own team is tagged:
-- action "own_team:payouts:<table>:<op>" and details.tag = "own team".

-- Any entries still waiting count now.
update public.fee_payments set status = 'confirmed', confirmed_by = coalesce(confirmed_by, created_by), confirmed_at = coalesce(confirmed_at, created_at) where status = 'pending';
update public.payout_payments set status = 'confirmed', confirmed_by = coalesce(confirmed_by, created_by), confirmed_at = coalesce(confirmed_at, now()) where status = 'pending';
update public.empire_ledger set status = 'confirmed', confirmed_by = coalesce(confirmed_by, created_by), confirmed_at = coalesce(confirmed_at, created_at) where status = 'pending';
alter table public.fee_payments drop constraint fee_payments_status_check, add constraint fee_payments_status_check check (status = 'confirmed');
alter table public.payout_payments drop constraint payout_payments_status_check, add constraint payout_payments_status_check check (status = 'confirmed');
alter table public.empire_ledger drop constraint empire_ledger_status_check, add constraint empire_ledger_status_check check (status = 'confirmed');

drop function public.confirm_payment(text, bigint, boolean);
drop function private.payment_confirmer_exists(text, uuid);

-- The guard now only stamps who recorded an entry (and keeps that from being rewritten).
create or replace function private.guard_ledger() returns trigger
language plpgsql set search_path = ''
as $$
declare me uuid := (select auth.uid());
begin
  if private.is_privileged() then return coalesce(new, old); end if;
  if tg_op = 'INSERT' then
    new.created_by := me; new.created_at := now();
    new.status := 'confirmed'; new.confirmed_by := me; new.confirmed_at := now();
    return new;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  if new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
    raise exception 'Who recorded an entry can''t be changed' using errcode = '42501';
  end if;
  new.status := 'confirmed';
  return new;
end;
$$;

-- Audit: unchanged, plus the own-team tag.
create or replace function private.audit_payouts() returns trigger
language plpgsql set search_path = ''
as $$
declare
  o jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  n jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  t text := coalesce(n ->> 'team_id', o ->> 'team_id');
  own boolean := t is not null and private.manages_team(t);
begin
  if private.is_privileged() or not (private.is_commissioner() or private.is_treasurer()) then
    return null;
  end if;
  insert into public.audit_log (actor, action, season, week, details)
  values ((select auth.uid()), case when own then 'own_team:' else '' end || 'payouts:' || tg_table_name || ':' || lower(tg_op),
          coalesce((n ->> 'season')::int, (o ->> 'season')::int),
          coalesce((n ->> 'week')::int, (o ->> 'week')::int),
          jsonb_build_object('table', tg_table_name, 'op', lower(tg_op), 'old', o, 'new', n, 'team', t) ||
            case when own then jsonb_build_object('tag', 'own team') else '{}' end);
  return null;
end;
$$;
