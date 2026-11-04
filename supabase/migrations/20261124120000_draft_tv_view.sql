-- Draft board views (2026-11-03): "By Team" (columns = teams) or "By Pick" (columns = picks 1-12 of each round).
-- Each viewer picks their own (remembered in their browser); the big screen (#draft/<id>/tv) shows what the
-- commissioner sets here ("TV view" on the Commissioner card; draft_settings key tv_view, audited like every
-- setting). Realtime on drafts updates the TV at once.

alter table public.drafts add column if not exists tv_view text not null default 'team' check (tv_view in ('team', 'pick'));

-- Settings: + tv_view ('team' or 'pick'), changeable any time.
create or replace function public.draft_settings(p_draft bigint, p_settings jsonb) returns void
language plpgsql security definer set search_path = ''
as $$
declare d public.drafts;
begin
  perform private.draft_need_commissioner();
  select * into d from public.drafts where id = p_draft for update;
  if d.status <> 'setup' and (p_settings ?| array['rounds', 'order_mode', 'bots']) then
    raise exception 'Rounds, order timing and bots can only change before the draft starts' using errcode = '42501';
  end if;
  if p_settings ? 'tv_view' and p_settings ->> 'tv_view' not in ('team', 'pick') then raise exception 'The TV view is team or pick' using errcode = '22023'; end if;
  if p_settings ? 'ranks' and p_settings ->> 'ranks' not in ('adp', 'custom') then raise exception 'Ranks are adp or custom' using errcode = '22023'; end if;
  update public.drafts set
    name = coalesce(p_settings ->> 'name', name),
    rounds = coalesce((p_settings ->> 'rounds')::int, rounds),
    timer_seconds = coalesce((p_settings ->> 'timer_seconds')::int, timer_seconds),
    order_mode = coalesce(p_settings ->> 'order_mode', order_mode),
    expiry = coalesce(p_settings ->> 'expiry', expiry),
    ranks = coalesce(p_settings ->> 'ranks', ranks),
    tv_view = coalesce(p_settings ->> 'tv_view', tv_view),
    bots = case when p_settings ? 'bots' then array(select jsonb_array_elements_text(p_settings -> 'bots')) else bots end,
    starts_at = case when p_settings ? 'starts_at' then (p_settings ->> 'starts_at')::timestamptz else starts_at end,
    reminded_at = case when p_settings ? 'starts_at' then null else reminded_at end,
    updated_at = now()
  where id = p_draft;
  if d.kind = 'real' and p_settings ? 'rounds' then perform private.ensure_draft_picks(d.season, (p_settings ->> 'rounds')::int); end if;
  perform private.draft_audit('settings', jsonb_build_object('draft', p_draft, 'settings', p_settings));
end;
$$;
