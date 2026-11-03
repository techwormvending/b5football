-- Draft chat: "⏳ 30 seconds left" / "⏳ 10 seconds left" warnings from B5 Bot (2026-11-03), so the docked
-- Draft chat (and the regular Chat page's Draft room) shows them with the picks, on-the-clock posts, draws
-- and pause/resume. Posted by the existing 5-second tick (pg_cron b5-draft-tick) while a human team is on
-- the clock: the 30 s warning only when a pick gets more than 45 s, the 10 s warning when it gets more than
-- 15 s; once each per pick (drafts.warned_overall / warned_secs). Bots pick in ~2 s and get none.

alter table public.drafts add column if not exists warned_overall int, add column if not exists warned_secs int;

create function private.draft_warn() returns int
language plpgsql security definer set search_path = ''
as $$
declare d public.drafts; s record; left_s numeric; at int; n int := 0;
begin
  for d in select * from public.drafts where status = 'live' and clock_ends_at > now() and clock_ends_at <= now() + interval '31 seconds'
             for update skip locked loop
    s := private.draft_slot(d.id, d.current_overall);
    if s.owner is null or s.owner = any (d.bots) then continue; end if;
    left_s := extract(epoch from d.clock_ends_at - now());
    at := case when left_s <= 10 and d.timer_seconds > 15 then 10 when left_s <= 30 and d.timer_seconds > 45 then 30 end;
    if at is null then continue; end if;
    if d.warned_overall = d.current_overall and d.warned_secs is not null and d.warned_secs <= at then continue; end if;
    update public.drafts set warned_overall = d.current_overall, warned_secs = at where id = d.id;
    perform private.chat_bot_post('draft', '⏳ ' || at || ' seconds left for ' || private.draft_name(s.owner) || ' (Round ' || s.round || ', Pick ' || s.pick || ')',
      jsonb_build_object('kind', 'timer', 'draft', d.id, 'overall', d.current_overall, 'team', s.owner, 'seconds', at));
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke execute on function private.draft_warn() from public, anon, authenticated;

create or replace function public.draft_tick(p_draft bigint default null) returns int
language plpgsql security definer set search_path = ''
as $$
declare r record; n int := 0; d public.drafts;
begin
  if (select auth.uid()) is not null and not private.is_member() then return 0; end if;
  for r in select id from public.drafts where status = 'live' and clock_ends_at <= now() and (p_draft is null or id = p_draft) loop
    if private.draft_tick_one(r.id) then n := n + 1; end if;
  end loop;
  if p_draft is null then
    -- Clock warnings in the Draft chat (30 s, 10 s)
    perform private.draft_warn();
    -- Start reminders: once, an hour before a scheduled start
    for d in select * from public.drafts where status = 'setup' and starts_at is not null and reminded_at is null
               and starts_at between now() and now() + interval '1 hour' for update skip locked loop
      update public.drafts set reminded_at = now() where id = d.id;
      perform private.draft_notify(t, 'draft:' || d.id || ':start', jsonb_build_object('type', 'start', 'draft', d.name, 'draft_id', d.id, 'starts_at', d.starts_at, 'link', '#draft/' || d.id))
        from unnest(d.teams) t where not (t = any (d.bots));
    end loop;
  end if;
  return n;
end;
$$;
