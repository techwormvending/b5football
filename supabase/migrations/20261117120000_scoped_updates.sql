-- Fix (2026-11-02): "UPDATE requires a WHERE clause" when starting a practice draft. Supabase runs
-- pg-safeupdate for API requests, which refuses UPDATE/DELETE without a WHERE, also inside functions.
-- The Draft chat header (public.draft_state, ONE row: id = true) was updated without one in
-- draft_advance (start, every pick, undo), draft_control (pause, resume, extend, complete) and the
-- older draft_event. Every one is now scoped: "where id" (its single row) and, for the Draft Room,
-- only by the draft that owns the header (draft_state.draft_id): a practice draft never takes the
-- header from a real draft that's running, and nothing else of another draft is touched (all
-- other draft updates were already "where id = p_draft"). The safeupdate guard stays on.

alter table public.draft_state add column if not exists draft_id bigint references public.drafts (id) on delete set null;

-- May this draft write the chat header? Yes when nobody holds it, it already holds it, the holder
-- isn't running (setup/done/complete/deleted), or this is the real draft and the holder a practice one.
create function private.draft_owns_header(p_draft bigint) returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select s.draft_id is null or s.draft_id = p_draft
        or h.id is null or h.status not in ('live', 'paused', 'awaiting_order')
        or (h.kind = 'mock' and (select d.kind from public.drafts d where d.id = p_draft) = 'real')
    from public.draft_state s left join public.drafts h on h.id = s.draft_id where s.id), true)
$$;
revoke execute on function private.draft_owns_header(bigint) from public, anon;

create or replace function private.draft_advance(p_draft bigint) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  d public.drafts;
  nxt int;
  total int;
  s record;
  soon record;
  secs int;
begin
  select * into d from public.drafts where id = p_draft for update;
  total := cardinality(d.teams) * d.rounds;
  select min(o) into nxt from generate_series(1, total) o
   where not exists (select 1 from public.draft_selections x where x.draft_id = p_draft and x.overall = o);
  if nxt is null then
    update public.drafts set status = 'done', current_overall = null, clock_ends_at = null, paused_remaining = null, updated_at = now() where id = p_draft;
    perform private.chat_bot_post('draft', '🏁 ' || d.name || ': the draft is complete. The commissioner finalizes it to fill the rosters.', jsonb_build_object('kind', 'end', 'draft', p_draft));
    update public.draft_state set status = 'done', team_id = null, clock_ends_at = null, paused_remaining = null, updated_at = now(), draft_id = p_draft where id and private.draft_owns_header(p_draft);
    return;
  end if;
  s := private.draft_slot(p_draft, nxt);
  if s.owner is null then
    update public.drafts set status = 'awaiting_order', current_overall = nxt, clock_ends_at = null, paused_remaining = null, updated_at = now() where id = p_draft;
    perform private.chat_bot_post('draft', '🎩 Round ' || s.round || ' starts with a new order: waiting for the commissioner to draw it.', jsonb_build_object('kind', 'paused', 'draft', p_draft));
    update public.draft_state set status = 'paused', round = s.round, pick = s.pick, overall = nxt, team_id = null, clock_ends_at = null, updated_at = now(), draft_id = p_draft where id and private.draft_owns_header(p_draft);
    return;
  end if;
  secs := case when s.owner = any (d.bots) then 2 else d.timer_seconds end;
  update public.drafts set status = 'live', current_overall = nxt, clock_ends_at = now() + make_interval(secs => secs), paused_remaining = null, updated_at = now() where id = p_draft;
  update public.draft_state set status = 'live', season = d.season, round = s.round, pick = s.pick, overall = nxt, team_id = s.owner,
    clock_ends_at = now() + make_interval(secs => secs), paused_remaining = null, updated_at = now(), draft_id = p_draft where id and private.draft_owns_header(p_draft);
  if not (s.owner = any (d.bots)) then
    perform private.chat_bot_post('draft', '⏰ On the clock: ' || private.draft_name(s.owner) || ' (Round ' || s.round || ', Pick ' || s.pick ||
      case when s.owner <> s.original then ', from ' || private.draft_name(s.original) else '' end || ')',
      jsonb_build_object('kind', 'on_clock', 'draft', p_draft, 'overall', nxt, 'team', s.owner));
    perform private.draft_notify(s.owner, 'draft:' || p_draft || ':clock:' || nxt,
      jsonb_build_object('type', 'clock', 'draft', d.name, 'draft_id', p_draft, 'team', private.draft_name(s.owner), 'round', s.round, 'pick', s.pick, 'seconds', d.timer_seconds, 'link', '#draft/' || p_draft));
    if nxt + 2 <= total then
      soon := private.draft_slot(p_draft, nxt + 2);
      if soon.owner is not null and soon.owner <> s.owner and not (soon.owner = any (d.bots))
         and soon.owner <> (private.draft_slot(p_draft, nxt + 1)).owner then
        perform private.draft_notify(soon.owner, 'draft:' || p_draft || ':soon:' || (nxt + 2),
          jsonb_build_object('type', 'soon', 'draft', d.name, 'draft_id', p_draft, 'team', private.draft_name(soon.owner), 'round', soon.round, 'pick', soon.pick, 'link', '#draft/' || p_draft));
      end if;
    end if;
  end if;
end;
$$;

create or replace function public.draft_control(p_draft bigint, p_action text, p_seconds int default null) returns text
language plpgsql security definer set search_path = ''
as $$
declare d public.drafts; r int; left_s int;
begin
  perform private.draft_need_commissioner();
  select * into d from public.drafts where id = p_draft for update;
  if p_action = 'start' then
    if d.status <> 'setup' then raise exception 'The draft has already started' using errcode = '42501'; end if;
    if d.order_mode = 'before' then
      for r in select g from generate_series(1, d.rounds, 2) g loop
        if not exists (select 1 from public.draft_orders o where o.draft_id = p_draft and o.round = r) then
          raise exception 'Set every odd round''s order first (round % is missing)', r using errcode = '42501';
        end if;
      end loop;
    end if;
    perform private.chat_bot_post('draft', '🏈 ' || d.name || ' is live!', jsonb_build_object('kind', 'start', 'draft', p_draft));
    perform private.draft_advance(p_draft);
  elsif p_action = 'pause' then
    if d.status <> 'live' then raise exception 'The draft isn''t live' using errcode = '42501'; end if;
    left_s := greatest(0, ceil(extract(epoch from d.clock_ends_at - now()))::int);
    update public.drafts set status = 'paused', paused_remaining = left_s, clock_ends_at = null, updated_at = now() where id = p_draft;
    update public.draft_state set status = 'paused', paused_remaining = left_s, clock_ends_at = null, updated_at = now(), draft_id = p_draft where id and private.draft_owns_header(p_draft);
    perform private.chat_bot_post('draft', '⏸️ The commissioner paused the draft', jsonb_build_object('kind', 'paused', 'draft', p_draft));
  elsif p_action = 'resume' then
    if d.status <> 'paused' then raise exception 'The draft isn''t paused' using errcode = '42501'; end if;
    update public.drafts set status = 'live', clock_ends_at = now() + make_interval(secs => greatest(coalesce(d.paused_remaining, d.timer_seconds), 10)), paused_remaining = null, updated_at = now() where id = p_draft;
    update public.draft_state set status = 'live', clock_ends_at = now() + make_interval(secs => greatest(coalesce(d.paused_remaining, d.timer_seconds), 10)), paused_remaining = null, updated_at = now(), draft_id = p_draft where id and private.draft_owns_header(p_draft);
    perform private.chat_bot_post('draft', '▶️ The draft resumed', jsonb_build_object('kind', 'resumed', 'draft', p_draft));
  elsif p_action = 'extend' then
    if d.status = 'live' then
      update public.drafts set clock_ends_at = clock_ends_at + make_interval(secs => coalesce(p_seconds, 60)), updated_at = now() where id = p_draft;
      update public.draft_state set clock_ends_at = clock_ends_at + make_interval(secs => coalesce(p_seconds, 60)), updated_at = now(), draft_id = p_draft where id and private.draft_owns_header(p_draft);
    elsif d.status = 'paused' then
      update public.drafts set paused_remaining = paused_remaining + coalesce(p_seconds, 60), updated_at = now() where id = p_draft;
    else raise exception 'The draft isn''t running' using errcode = '42501'; end if;
  elsif p_action = 'complete' then
    if d.status <> 'done' then raise exception 'Finish every pick first' using errcode = '42501'; end if;
    if exists (select 1 from public.draft_selections x where x.draft_id = p_draft and x.skipped) then
      raise exception 'Some skipped picks haven''t been made yet' using errcode = '42501';
    end if;
    if d.kind = 'real' then
      insert into public.roster_entries (season, team_id, player_id, acquired)
      select d.season, x.team_id, x.player_id, x.round || '.' || lpad(x.pick::text, 2, '0') from public.draft_selections x where x.draft_id = p_draft
      on conflict (season, player_id) do update set team_id = excluded.team_id, acquired = excluded.acquired, acquired_at = now();
    end if;
    update public.drafts set status = 'complete', completed_at = now(), updated_at = now() where id = p_draft;
    update public.draft_state set status = 'done', team_id = null, clock_ends_at = null, updated_at = now(), draft_id = p_draft where id and private.draft_owns_header(p_draft);
    -- Results email: every owner
    perform private.draft_notify(t, 'draft:' || p_draft || ':results', jsonb_build_object('type', 'results', 'draft', d.name, 'draft_id', p_draft, 'team', private.draft_name(t),
      'mock', d.kind = 'mock', 'link', '#draft/' || p_draft,
      'picks', (select jsonb_agg(jsonb_build_object('round', x.round, 'pick', x.pick, 'player', np.name, 'pos', np.position, 'nfl', np.nfl_team) order by x.overall)
                from public.draft_selections x join public.nfl_players np on np.id = x.player_id where x.draft_id = p_draft and x.team_id = t)))
      from unnest(d.teams) t where not (t = any (d.bots));
    perform private.chat_bot_post('draft', '🏆 ' || d.name || ' is final.' || case when d.kind = 'real' then ' Rosters are set.' else ' (practice: rosters untouched)' end, jsonb_build_object('kind', 'end', 'draft', p_draft));
  else
    raise exception 'Unknown action %', p_action using errcode = '22023';
  end if;
  perform private.draft_audit(p_action, jsonb_build_object('draft', p_draft, 'seconds', p_seconds));
  return p_action;
end;
$$;

create or replace function private.draft_event_apply(p_kind text, p_payload jsonb) returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  s public.draft_state%rowtype;
  team text := p_payload ->> 'team';
  tname text;
  body text;
  left_s int;
begin
  select * into s from public.draft_state where id for update;
  tname := coalesce((select t.name from public.teams t where t.id = coalesce(team, s.team_id)), team, s.team_id, 'Next team');
  if p_kind in ('start', 'on_clock') then
    update public.draft_state set status = 'live', season = coalesce((p_payload ->> 'season')::int, season),
      round = (p_payload ->> 'round')::int, pick = (p_payload ->> 'pick')::int, overall = (p_payload ->> 'overall')::int,
      team_id = team, clock_ends_at = now() + make_interval(secs => coalesce((p_payload ->> 'seconds')::int, 120)),
      paused_remaining = null, updated_at = now() where id;
    body := case when p_kind = 'start' then '🏈 The draft is live! ' else '' end ||
            '⏰ On the clock: ' || tname || ' (Round ' || (p_payload ->> 'round') || ', Pick ' || (p_payload ->> 'pick') || ')';
  elsif p_kind = 'pick' then
    body := '✅ ' || tname || ' select ' || coalesce(p_payload ->> 'player', '?') ||
            coalesce(', ' || nullif(btrim(concat_ws(' ', p_payload ->> 'pos', p_payload ->> 'nfl')), ''), '');
  elsif p_kind = 'timer' then
    body := '⏳ ' || coalesce(p_payload ->> 'seconds', '?') || ' seconds left for ' || tname;
  elsif p_kind = 'paused' then
    left_s := greatest(0, ceil(extract(epoch from s.clock_ends_at - now()))::int);
    update public.draft_state set status = 'paused', paused_remaining = left_s, clock_ends_at = null, updated_at = now() where id;
    body := '⏸️ The commissioner paused the draft';
  elsif p_kind = 'resumed' then
    update public.draft_state set status = 'live', clock_ends_at = now() + make_interval(secs => coalesce(s.paused_remaining, 0)),
      paused_remaining = null, updated_at = now() where id;
    body := '▶️ The draft resumed: ' || tname || ' is on the clock';
  elsif p_kind = 'end' then
    update public.draft_state set status = 'done', team_id = null, clock_ends_at = null, paused_remaining = null, updated_at = now() where id;
    body := '🏁 The draft is complete';
  else
    raise exception 'Unknown draft event %', p_kind using errcode = '22023';
  end if;
  return private.chat_bot_post('draft', body, p_payload || jsonb_build_object('kind', p_kind));
end;
$$;

-- Technical errors from the pages (e.g. a database error behind a button): the page shows a friendly
-- message and logs the details here, for administrators (audit log, action 'client_error').
create function public.log_client_error(p_where text, p_message text) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if (select auth.uid()) is null then return; end if;
  if (select count(*) from public.audit_log a where a.actor = (select auth.uid()) and a.action = 'client_error' and a.at > now() - interval '1 minute') >= 10 then return; end if;
  insert into public.audit_log (actor, action, details)
  values ((select auth.uid()), 'client_error', jsonb_build_object('where', left(coalesce(p_where, ''), 80), 'message', left(coalesce(p_message, ''), 500)));
end;
$$;
revoke execute on function public.log_client_error(text, text) from public, anon;
grant execute on function public.log_client_error(text, text) to authenticated, service_role;
