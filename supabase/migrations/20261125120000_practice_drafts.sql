-- Practice drafts for every member (2026-11-08). Any signed-in league member can create one and is its HOST.
-- In a practice draft the host and everyone who has joined it hold the full controls (start, pause, resume,
-- orders, picks for any seat, undo, edit, timer, bots, end/reset); every action is written to the draft's own
-- log with who did it. The host can switch to "host-only controls". The host or any commissioner can delete it.
--
-- Strict separation: drafts.is_practice (generated from kind). Every draft RPC goes through
-- private.draft_need_control: non-commissioners ONLY when is_practice; real drafts stay commissioner-only.
-- A practice draft never touches rosters, draft_picks, transactions, payouts or the league "Draft" chat room or
-- its header (draft_state). It gets its OWN chat room (chat_rooms.kind 'practice', draft_id), readable only by the
-- people in that draft (commissioners included: they join like anyone else), and emails only its participants.
-- private.chat_bot_post routes every B5 Bot post of a practice draft to that room, so no call site can leak.
--
-- Housekeeping (free tier): 3 active practice drafts per host; deleted after 14 days without activity, the host
-- warned 2 days before (pg_cron b5-practice-housekeeping, hourly).

alter table public.drafts
  add column is_practice boolean generated always as (kind = 'mock') stored,
  add column host uuid references public.profiles (id) on delete set null,
  add column host_only boolean not null default false,
  add column last_activity_at timestamptz not null default now(),
  add column expiry_warned_at timestamptz;
update public.drafts set host = created_by where kind = 'mock';

create table public.draft_participants (
  draft_id bigint not null references public.drafts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (draft_id, user_id)
);
create table public.draft_log (
  id bigint generated always as identity primary key,
  draft_id bigint not null references public.drafts (id) on delete cascade,
  at timestamptz not null default now(),
  actor uuid,
  actor_name text not null,
  action text not null
);
create index draft_log_draft_idx on public.draft_log (draft_id, id desc);
alter table public.draft_participants enable row level security;
alter table public.draft_log enable row level security;
create policy "members read" on public.draft_participants for select to authenticated using (private.is_member());
create policy "members read" on public.draft_log for select to authenticated using (private.is_member());
grant select on public.draft_participants, public.draft_log to authenticated;
grant all on public.draft_participants, public.draft_log to service_role;
insert into public.draft_participants (draft_id, user_id) select id, host from public.drafts where kind = 'mock' and host is not null on conflict do nothing;
do $do$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.draft_participants;
  end if;
end $do$;

-- Each practice draft's own chat room
alter table public.chat_rooms add column draft_id bigint references public.drafts (id) on delete cascade;
alter table public.chat_rooms drop constraint chat_rooms_kind_check;
alter table public.chat_rooms add constraint chat_rooms_kind_check check (kind in ('league', 'draft', 'custom', 'practice'));
create unique index chat_rooms_draft_idx on public.chat_rooms (draft_id) where draft_id is not null;
insert into public.chat_rooms (id, name, kind, sort, draft_id)
select 'practice-' || d.id, left(btrim(d.name), 40), 'practice', 1000, d.id from public.drafts d where d.kind = 'mock';

-- A practice draft that held the league Draft chat's header gives it back
update public.draft_state set status = 'idle', team_id = null, clock_ends_at = null, paused_remaining = null, draft_id = null
 where id and draft_id in (select d.id from public.drafts d where d.kind = 'mock');

-- ---------------------------------------------------------------------------
-- Who may do what
-- ---------------------------------------------------------------------------
create function private.draft_joined(p_draft bigint) returns boolean
language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.draft_participants p where p.draft_id = p_draft and p.user_id = (select auth.uid())) $$;

-- Real draft: the commissioner. Practice draft: the host, or anyone who joined unless the controls are host-only.
create function private.draft_can_control(p_draft bigint) returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((select case when d.is_practice
      then private.is_member() and (d.host = (select auth.uid()) or (not d.host_only and private.draft_joined(p_draft)))
      else private.is_commissioner() end
    from public.drafts d where d.id = p_draft), false)
$$;
create function private.draft_need_control(p_draft bigint) returns void
language plpgsql stable security definer set search_path = ''
as $$
declare d public.drafts;
begin
  select * into d from public.drafts where id = p_draft;
  if d.id is null then raise exception 'No such draft' using errcode = '22023'; end if;
  if private.draft_can_control(p_draft) then return; end if;
  if not d.is_practice then raise exception 'Only the commissioner runs the draft' using errcode = '42501'; end if;
  if private.draft_joined(p_draft) then raise exception 'The host has limited the controls in this practice draft' using errcode = '42501'; end if;
  raise exception 'Join this practice draft first' using errcode = '42501';
end;
$$;

-- "Adam" (practice drafts name who did it) or "The commissioner"
create function private.draft_person(p_user uuid) returns text
language sql stable security definer set search_path = ''
as $$ select coalesce((select nullif(btrim(p.display_name), '') from public.profiles p where p.id = p_user), 'A member') $$;
create function private.draft_who(p_practice boolean) returns text
language sql stable security definer set search_path = ''
as $$ select case when p_practice then private.draft_person((select auth.uid())) else 'The commissioner' end $$;

-- The draft log (practice drafts): who did what. No user = B5 Bot. Also keeps the draft "active".
create function private.draft_log_add(p_draft bigint, p_action text, p_actor uuid) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.draft_log (draft_id, actor, actor_name, action)
  values (p_draft, p_actor, case when p_actor is null then 'B5 Bot' else private.draft_person(p_actor) end, p_action);
  update public.drafts set last_activity_at = now() where id = p_draft and last_activity_at < now() - interval '10 minutes';
end;
$$;

-- Real drafts: the admin audit log, as before. Practice drafts: the draft's own log, in words.
create or replace function private.draft_audit(p_action text, p_details jsonb) returns void
language plpgsql security definer set search_path = ''
as $$
declare practice boolean;
begin
  select d.is_practice into practice from public.drafts d where d.id = (p_details ->> 'draft')::bigint;
  if practice then
    perform private.draft_log_add((p_details ->> 'draft')::bigint, case p_action
      when 'create' then 'Created the practice draft'
      when 'start' then 'Started the draft'
      when 'pause' then 'Paused the draft'
      when 'resume' then 'Resumed the draft'
      when 'extend' then 'Added ' || coalesce(p_details ->> 'seconds', '60') || ' seconds'
      when 'complete' then 'Finished the draft'
      when 'end' then 'Ended the draft'
      when 'reset' then 'Reset the draft'
      when 'undo' then 'Undid ' || jsonb_array_length(p_details -> 'picks') || ' pick' || case when jsonb_array_length(p_details -> 'picks') = 1 then '' else 's' end
      when 'edit_pick' then 'Changed pick #' || (p_details ->> 'overall') || ' to ' || coalesce((select np.name from public.nfl_players np where np.id = p_details ->> 'to'), p_details ->> 'to')
      when 'order_drawn' then 'Drew the round ' || (p_details ->> 'round') || ' order'
      when 'order_set' then 'Set the round ' || (p_details ->> 'round') || ' order'
      when 'order_redone' then 'Redid the round ' || (p_details ->> 'round') || ' order'
      when 'settings' then case
        when p_details -> 'settings' ? 'host_only' then case when (p_details -> 'settings' ->> 'host_only')::boolean then 'Switched to host-only controls' else 'Opened the controls to everyone' end
        when p_details -> 'settings' ? 'bots' and (select count(*) from jsonb_object_keys(p_details -> 'settings')) = 1 then 'Changed the bots'
        else 'Changed the settings' end
      else replace(p_action, '_', ' ') end, (select auth.uid()));
    return;
  end if;
  insert into public.audit_log (actor, action, details) values ((select auth.uid()), 'draft:' || p_action, p_details);
end;
$$;

-- The league Draft chat's header only ever follows a real draft
create or replace function private.draft_owns_header(p_draft bigint) returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((select d.kind = 'real' from public.drafts d where d.id = p_draft), false) and coalesce((
    select s.draft_id is null or s.draft_id = p_draft or h.id is null or h.status not in ('live', 'paused', 'awaiting_order')
    from public.draft_state s left join public.drafts h on h.id = s.draft_id where s.id), true)
$$;

-- Every B5 Bot post about a practice draft goes to that draft's own room, never the league Draft room.
create or replace function private.chat_bot_post(p_room text, p_body text, p_event jsonb) returns bigint
language plpgsql security definer set search_path = ''
as $$
declare room text := p_room; practice boolean; out_id bigint;
begin
  if p_room = 'draft' and p_event ? 'draft' then
    select d.is_practice, r.id into practice, room from public.drafts d left join public.chat_rooms r on r.draft_id = d.id where d.id = (p_event ->> 'draft')::bigint;
    if not coalesce(practice, false) then room := p_room;
    elsif room is null then return null; end if;
  end if;
  insert into public.chat_messages (room_id, is_bot, body, event) values (room, true, p_body, p_event) returning id into out_id;
  return out_id;
end;
$$;

-- Emails about a practice draft reach only the people in it
create or replace function private.draft_notify(p_team text, p_ref text, p_payload jsonb) returns void
language plpgsql security definer set search_path = ''
as $$
declare u uuid; did bigint := (p_payload ->> 'draft_id')::bigint; practice boolean;
begin
  select d.is_practice into practice from public.drafts d where d.id = did;
  for u in select m.user_id from public.team_managers m where m.team_id = p_team
             and (not coalesce(practice, false) or exists (select 1 from public.draft_participants p where p.draft_id = did and p.user_id = m.user_id)) loop
    if private.notify_on(u, 'draft') then
      insert into public.notify_queue (user_id, kind, ref, due_at, payload) values (u, 'draft', p_ref, now(), p_payload) on conflict do nothing;
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Drafts: create, join, delete; the rest of the RPCs through draft_need_control
-- ---------------------------------------------------------------------------
create or replace function public.draft_create(p_season int, p_kind text, p_name text, p_settings jsonb default '{}') returns bigint
language plpgsql security definer set search_path = ''
as $$
declare id bigint; teams text[]; uid uuid := (select auth.uid());
begin
  if p_kind = 'mock' then
    if not private.is_member() then raise exception 'Only league members can create a practice draft' using errcode = '42501'; end if;
    perform pg_advisory_xact_lock(hashtext('b5-practice:' || uid::text));
    if (select count(*) from public.drafts d where d.kind = 'mock' and d.host = uid and d.status <> 'complete') >= 3 then
      raise exception 'You already host 3 active practice drafts. Finish or delete one first.' using errcode = '42501';
    end if;
  else
    perform private.draft_need_commissioner();
  end if;
  select array_agg(t.id order by t.id) into teams from public.teams t;
  if p_settings ? 'bots' and exists (select 1 from jsonb_array_elements_text(p_settings -> 'bots') t where not (t = any (teams))) then
    raise exception 'Unknown team in the bots' using errcode = '22023';
  end if;
  insert into public.drafts (season, kind, name, teams, bots, rounds, timer_seconds, order_mode, expiry, starts_at, host)
  values (p_season, p_kind, p_name, teams,
    coalesce(array(select jsonb_array_elements_text(p_settings -> 'bots')), '{}'),
    coalesce((p_settings ->> 'rounds')::int, 18), coalesce((p_settings ->> 'timer_seconds')::int, 180),
    coalesce(p_settings ->> 'order_mode', 'live'), coalesce(p_settings ->> 'expiry', 'autopick'), (p_settings ->> 'starts_at')::timestamptz,
    case when p_kind = 'mock' then uid end)
  returning drafts.id into id;
  if p_kind = 'real' then
    perform private.ensure_draft_picks(p_season, coalesce((p_settings ->> 'rounds')::int, 18));
  else
    insert into public.draft_participants (draft_id, user_id) values (id, uid);
    insert into public.chat_rooms (id, name, kind, sort, draft_id) values ('practice-' || id, left(btrim(p_name), 40), 'practice', 1000, id);
  end if;
  perform private.draft_audit('create', jsonb_build_object('draft', id, 'kind', p_kind, 'name', p_name, 'settings', p_settings));
  return id;
end;
$$;

-- Join a practice draft: its controls (unless host-only) and its chat room.
create function public.draft_join(p_draft bigint) returns void
language plpgsql security definer set search_path = ''
as $$
declare d public.drafts;
begin
  if not private.is_member() then raise exception 'Only league members can join a practice draft' using errcode = '42501'; end if;
  select * into d from public.drafts where id = p_draft;
  if d.id is null then raise exception 'No such draft' using errcode = '22023'; end if;
  if not d.is_practice then raise exception 'Only practice drafts can be joined' using errcode = '42501'; end if;
  insert into public.draft_participants (draft_id, user_id) values (p_draft, (select auth.uid())) on conflict do nothing;
  if found then perform private.draft_log_add(p_draft, 'Joined the draft', (select auth.uid())); end if;
end;
$$;

create or replace function public.draft_delete(p_draft bigint) returns void
language plpgsql security definer set search_path = ''
as $$
declare d public.drafts;
begin
  select * into d from public.drafts where id = p_draft;
  if d.id is null then raise exception 'No such draft' using errcode = '22023'; end if;
  if d.is_practice then
    if not (private.is_member() and (d.host = (select auth.uid()) or private.is_commissioner())) then
      raise exception 'Only the host or a commissioner can delete a practice draft' using errcode = '42501';
    end if;
  else
    perform private.draft_need_commissioner();
    if d.status not in ('setup') then raise exception 'The real draft can''t be deleted once it has started' using errcode = '42501'; end if;
  end if;
  delete from public.drafts where id = p_draft;
  perform private.draft_audit('delete', jsonb_build_object('draft', p_draft, 'name', d.name, 'kind', d.kind));
end;
$$;

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
    perform private.chat_bot_post('draft', '🏁 ' || d.name || ': the draft is complete.' || case when d.is_practice then '' else ' The commissioner finalizes it to fill the rosters.' end, jsonb_build_object('kind', 'end', 'draft', p_draft));
    update public.draft_state set status = 'done', team_id = null, clock_ends_at = null, paused_remaining = null, updated_at = now(), draft_id = p_draft where id and private.draft_owns_header(p_draft);
    return;
  end if;
  s := private.draft_slot(p_draft, nxt);
  if s.owner is null then
    update public.drafts set status = 'awaiting_order', current_overall = nxt, clock_ends_at = null, paused_remaining = null, updated_at = now() where id = p_draft;
    perform private.chat_bot_post('draft', '🎩 Round ' || s.round || ' starts with a new order: waiting for ' || case when d.is_practice then 'someone' else 'the commissioner' end || ' to draw it.', jsonb_build_object('kind', 'paused', 'draft', p_draft));
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

create or replace function private.draft_record(p_draft bigint, p_overall int, p_team text, p_original text, p_player text, p_by uuid, p_auto boolean) returns void
language plpgsql security definer set search_path = ''
as $$
declare d public.drafts; pos record; who text; a numeric; v text;
begin
  select * into d from public.drafts where id = p_draft;
  a := private.draft_adp(d.season, p_player);
  insert into public.draft_selections (draft_id, overall, round, pick, team_id, original_team, player_id, skipped, auto, picked_by, picked_at, adp)
  values (p_draft, p_overall, (p_overall - 1) / cardinality(d.teams) + 1, (p_overall - 1) % cardinality(d.teams) + 1, p_team, p_original, p_player, false, p_auto, p_by, now(), a)
  on conflict (draft_id, overall) do update set player_id = excluded.player_id, skipped = false, auto = excluded.auto, picked_by = excluded.picked_by, picked_at = now(), adp = excluded.adp;
  delete from public.draft_queue q where q.draft_id = p_draft and q.player_id = p_player;
  if d.kind = 'real' then
    update public.draft_picks dp set used = true where dp.season = d.season and dp.round = (p_overall - 1) / cardinality(d.teams) + 1 and dp.original_team = p_original;
  end if;
  select np.name, np.position, np.nfl_team into pos from public.nfl_players np where np.id = p_player;
  select nullif(p.display_name, '') into who from public.profiles p where p.id = p_by;
  v := private.draft_value(p_overall, a);
  perform private.chat_bot_post('draft', '✅ ' || private.draft_name(p_team) || ' select ' || coalesce(pos.name, p_player) ||
    coalesce(', ' || nullif(btrim(concat_ws(' ', pos.position, pos.nfl_team)), ''), '') ||
    ' (Round ' || ((p_overall - 1) / cardinality(d.teams) + 1) || ', Pick ' || ((p_overall - 1) % cardinality(d.teams) + 1) || ')' ||
    case when p_auto then ' · auto-pick' when who is not null then ' · by ' || who else '' end ||
    case v when 'reach' then ' · 📈 Reach (ADP ' || round(a, 1) || ')' when 'steal' then ' · 💎 Steal (ADP ' || round(a, 1) || ')' else '' end,
    jsonb_build_object('kind', 'pick', 'draft', p_draft, 'overall', p_overall, 'team', p_team, 'player', p_player, 'adp', a, 'value', v));
  if d.is_practice then
    perform private.draft_log_add(p_draft, case when p_auto then 'Auto-picked ' else 'Drafted ' end || coalesce(pos.name, p_player) || ' for ' || private.draft_name(p_team) ||
      ' (' || ((p_overall - 1) / cardinality(d.teams) + 1) || '.' || lpad((((p_overall - 1) % cardinality(d.teams)) + 1)::text, 2, '0') || ')', p_by);
  end if;
end;
$$;

create or replace function public.draft_pick(p_draft bigint, p_player text, p_overall int default null) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  d public.drafts;
  target int;
  s record;
  sk public.draft_selections;
  team text;
  orig text;
begin
  select * into d from public.drafts where id = p_draft for update;
  if d.id is null then raise exception 'No such draft' using errcode = '22023'; end if;
  if not private.is_member() then raise exception 'Only league members draft' using errcode = '42501'; end if;
  target := coalesce(p_overall, d.current_overall);
  select * into sk from public.draft_selections x where x.draft_id = p_draft and x.overall = target;
  if sk.overall is not null and not sk.skipped then
    raise exception 'That pick was already made (Round %, Pick %)', sk.round, sk.pick using errcode = '40001';
  end if;
  if sk.overall is not null then
    team := sk.team_id; orig := sk.original_team;                   -- catching up on a skipped pick: any time
    if d.status not in ('live', 'paused', 'awaiting_order', 'done') then raise exception 'The draft isn''t running' using errcode = '42501'; end if;
  else
    if d.status <> 'live' then raise exception 'The draft isn''t live right now (%)', replace(d.status, '_', ' ') using errcode = '42501'; end if;
    if target is distinct from d.current_overall then raise exception 'That pick was already made' using errcode = '40001'; end if;
    s := private.draft_slot(p_draft, target);
    team := s.owner; orig := s.original;
  end if;
  if d.is_practice then
    -- anyone with the controls picks for any seat; with host-only controls a participant still picks for his own team
    if not (private.draft_can_control(p_draft) or (private.draft_joined(p_draft) and private.manages_team(team))) then
      raise exception '%', case when private.draft_joined(p_draft) then 'The host has limited the controls: you can only pick for your own team' else 'Join this practice draft first' end using errcode = '42501';
    end if;
  elsif not (private.manages_team(team) or private.is_commissioner()) then
    raise exception '% is on the clock, not your team', private.draft_name(team) using errcode = '42501';
  end if;
  if not exists (select 1 from public.nfl_players p where p.id = p_player and p.position in ('QB', 'RB', 'WR', 'TE', 'K', 'DEF')) then
    raise exception 'Unknown player' using errcode = '22023';
  end if;
  if exists (select 1 from public.draft_selections x where x.draft_id = p_draft and x.player_id = p_player) then
    raise exception 'That player is already drafted' using errcode = '23505';
  end if;
  perform private.draft_record(p_draft, target, team, orig, p_player, (select auth.uid()), false);
  if not d.is_practice and private.is_commissioner() and not private.manages_team(team) then
    insert into public.audit_log (actor, action, details) values ((select auth.uid()), 'draft:pick_for_team',
      jsonb_build_object('draft', p_draft, 'overall', target, 'team', team, 'player', p_player));
  end if;
  if sk.overall is null then perform private.draft_advance(p_draft); end if;
  return jsonb_build_object('overall', target, 'team', team, 'player', p_player);
end;
$$;

create or replace function public.draft_settings(p_draft bigint, p_settings jsonb) returns void
language plpgsql security definer set search_path = ''
as $$
declare d public.drafts; s record; nb text[];
begin
  perform private.draft_need_control(p_draft);
  select * into d from public.drafts where id = p_draft for update;
  if p_settings ? 'host_only' then
    if not d.is_practice then raise exception 'Only practice drafts have a host' using errcode = '42501'; end if;
    if d.host is distinct from (select auth.uid()) then raise exception 'Only the host can change who has the controls' using errcode = '42501'; end if;
  end if;
  if p_settings ? 'bots' and exists (select 1 from jsonb_array_elements_text(p_settings -> 'bots') t where not (t = any (d.teams))) then
    raise exception 'Unknown team in the bots' using errcode = '22023';
  end if;
  -- practice drafts can add or remove bots at any time; a real draft has none
  if d.status <> 'setup' and (p_settings ?| case when d.is_practice then array['rounds', 'order_mode'] else array['rounds', 'order_mode', 'bots'] end) then
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
    host_only = coalesce((p_settings ->> 'host_only')::boolean, host_only),
    bots = case when p_settings ? 'bots' then array(select jsonb_array_elements_text(p_settings -> 'bots')) else bots end,
    starts_at = case when p_settings ? 'starts_at' then (p_settings ->> 'starts_at')::timestamptz else starts_at end,
    reminded_at = case when p_settings ? 'starts_at' then null else reminded_at end,
    updated_at = now()
  where id = p_draft;
  if d.kind = 'real' and p_settings ? 'rounds' then perform private.ensure_draft_picks(d.season, (p_settings ->> 'rounds')::int); end if;
  if d.is_practice and d.status = 'live' and p_settings ? 'bots' then   -- the seat on the clock just changed hands
    nb := array(select jsonb_array_elements_text(p_settings -> 'bots'));
    s := private.draft_slot(p_draft, d.current_overall);
    if s.owner = any (nb) and not (s.owner = any (d.bots)) then update public.drafts set clock_ends_at = now() + interval '2 seconds', updated_at = now() where id = p_draft;
    elsif s.owner = any (d.bots) and not (s.owner = any (nb)) then update public.drafts set clock_ends_at = now() + make_interval(secs => d.timer_seconds), updated_at = now() where id = p_draft;
    end if;
  end if;
  perform private.draft_audit('settings', jsonb_build_object('draft', p_draft, 'settings', p_settings));
end;
$$;

create or replace function public.draft_set_order(p_draft bigint, p_round int, p_teams text[] default null) returns text[]
language plpgsql security definer set search_path = ''
as $$
declare d public.drafts; ord text[]; keys text[]; prev public.draft_orders; dup text;
begin
  perform private.draft_need_control(p_draft);
  select * into d from public.drafts where id = p_draft for update;
  if p_round % 2 = 0 or p_round < 1 or p_round > d.rounds then raise exception 'Orders are set for odd rounds 1 to %', d.rounds using errcode = '22023'; end if;
  if exists (select 1 from public.draft_selections x where x.draft_id = p_draft and x.round = p_round) then
    raise exception 'Round % already has picks: its order can''t change', p_round using errcode = '42501';
  end if;
  if p_teams is null then
    select array_agg(t order by k), array_agg(k::text order by k) into ord, keys
      from (select t, gen_random_uuid() as k from unnest(d.teams) t) x;
  else
    if cardinality(p_teams) <> cardinality(d.teams) then raise exception 'The order needs all % teams', cardinality(d.teams) using errcode = '22023'; end if;
    select t into dup from unnest(p_teams) t group by t having count(*) > 1 limit 1;
    if dup is not null then raise exception 'A team is in the order twice: %', private.draft_name(dup) using errcode = '22023'; end if;
    if exists (select 1 from unnest(p_teams) t where not (t = any (d.teams))) then raise exception 'Unknown team in the order' using errcode = '22023'; end if;
    ord := p_teams;
  end if;
  select * into prev from public.draft_orders o where o.draft_id = p_draft and o.round = p_round;
  insert into public.draft_orders (draft_id, round, teams, method, draw_keys, set_by, set_at)
  values (p_draft, p_round, ord, case when p_teams is null then 'auto' else 'manual' end, keys, (select auth.uid()), now())
  on conflict (draft_id, round) do update set teams = excluded.teams, method = excluded.method, draw_keys = excluded.draw_keys, set_by = excluded.set_by, set_at = now();
  perform private.draft_audit(case when prev.round is not null then 'order_redone' when p_teams is null then 'order_drawn' else 'order_set' end,
    jsonb_build_object('draft', p_draft, 'round', p_round, 'order', ord, 'method', case when p_teams is null then 'auto' else 'manual' end,
      'keys', keys, 'previous', prev.teams, 'at', now()));
  perform private.chat_bot_post('draft', '🎩 Round ' || p_round || ' order (' || case when p_teams is null then 'drawn' else 'set by ' || case when d.is_practice then private.draft_who(true) else 'the commissioner' end end || '): ' ||
    (select string_agg(i || '. ' || private.draft_name(t), ', ' order by i) from unnest(ord) with ordinality u(t, i)) ||
    '. Round ' || (p_round + 1) || ' is the reverse.', jsonb_build_object('kind', 'order', 'draft', p_draft, 'round', p_round, 'order', ord));
  if d.status = 'awaiting_order' then perform private.draft_advance(p_draft); end if;
  return ord;
end;
$$;

create or replace function public.draft_control(p_draft bigint, p_action text, p_seconds int default null) returns text
language plpgsql security definer set search_path = ''
as $$
declare d public.drafts; r int; left_s int;
begin
  perform private.draft_need_control(p_draft);
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
    perform private.chat_bot_post('draft', '⏸️ ' || private.draft_who(d.is_practice) || ' paused the draft', jsonb_build_object('kind', 'paused', 'draft', p_draft));
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
  elsif p_action = 'end' then          -- practice only: stop here, whatever is left
    if not d.is_practice then raise exception 'Only practice drafts can be ended early' using errcode = '42501'; end if;
    if d.status = 'complete' then raise exception 'This practice draft is already over' using errcode = '42501'; end if;
    update public.drafts set status = 'complete', completed_at = now(), current_overall = null, clock_ends_at = null, paused_remaining = null, updated_at = now() where id = p_draft;
    perform private.chat_bot_post('draft', '🏁 ' || private.draft_who(d.is_practice) || ' ended ' || d.name, jsonb_build_object('kind', 'end', 'draft', p_draft));
  elsif p_action = 'reset' then        -- practice only: back to the start, no picks and no orders
    if not d.is_practice then raise exception 'Only practice drafts can be reset' using errcode = '42501'; end if;
    delete from public.draft_selections where draft_id = p_draft;
    delete from public.draft_orders where draft_id = p_draft;
    update public.drafts set status = 'setup', completed_at = null, current_overall = null, clock_ends_at = null, paused_remaining = null, warned_overall = null, warned_secs = null, updated_at = now() where id = p_draft;
    perform private.chat_bot_post('draft', '🔄 ' || private.draft_who(d.is_practice) || ' reset ' || d.name, jsonb_build_object('kind', 'reset', 'draft', p_draft));
  else
    raise exception 'Unknown action %', p_action using errcode = '22023';
  end if;
  perform private.draft_audit(p_action, jsonb_build_object('draft', p_draft, 'seconds', p_seconds));
  return p_action;
end;
$$;

create or replace function public.draft_undo(p_draft bigint, p_count int default 1) returns int
language plpgsql security definer set search_path = ''
as $$
declare d public.drafts; gone jsonb; n int;
begin
  perform private.draft_need_control(p_draft);
  select * into d from public.drafts where id = p_draft for update;
  if d.status = 'complete' then raise exception 'The draft is final' using errcode = '42501'; end if;
  with del as (
    delete from public.draft_selections x where x.draft_id = p_draft and x.overall in
      (select y.overall from public.draft_selections y where y.draft_id = p_draft order by y.overall desc limit greatest(p_count, 1))
    returning x.*)
  select jsonb_agg(jsonb_build_object('overall', overall, 'team', team_id, 'player', player_id, 'skipped', skipped) order by overall), count(*) into gone, n from del;
  if coalesce(n, 0) = 0 then return 0; end if;
  if d.kind = 'real' then
    update public.draft_picks dp set used = false where dp.season = d.season and exists (select 1 from jsonb_array_elements(gone) g
      join lateral private.draft_slot(p_draft, (g ->> 'overall')::int) s on true where dp.round = s.round and dp.original_team = s.original);
  end if;
  update public.drafts set status = case when d.status in ('done', 'awaiting_order') then 'live' else d.status end where id = p_draft;
  perform private.draft_audit('undo', jsonb_build_object('draft', p_draft, 'picks', gone));
  perform private.chat_bot_post('draft', '↩️ ' || private.draft_who(d.is_practice) || ' undid ' || n || ' pick' || case when n = 1 then '' else 's' end, jsonb_build_object('kind', 'undo', 'draft', p_draft));
  if d.status = 'paused' then
    update public.drafts set current_overall = (select min((g ->> 'overall')::int) from jsonb_array_elements(gone) g), paused_remaining = d.timer_seconds where id = p_draft;
  else
    perform private.draft_advance(p_draft);
  end if;
  return n;
end;
$$;

create or replace function public.draft_edit_pick(p_draft bigint, p_overall int, p_player text) returns void
language plpgsql security definer set search_path = ''
as $$
declare old public.draft_selections;
begin
  perform private.draft_need_control(p_draft);
  select * into old from public.draft_selections x where x.draft_id = p_draft and x.overall = p_overall for update;
  if old.overall is null or old.skipped then raise exception 'That pick hasn''t been made' using errcode = '22023'; end if;
  if exists (select 1 from public.draft_selections x where x.draft_id = p_draft and x.player_id = p_player and x.overall <> p_overall) then
    raise exception 'That player is already drafted' using errcode = '23505';
  end if;
  update public.draft_selections set player_id = p_player, picked_by = (select auth.uid()), picked_at = now(), auto = false where draft_id = p_draft and overall = p_overall;
  perform private.draft_audit('edit_pick', jsonb_build_object('draft', p_draft, 'overall', p_overall, 'from', old.player_id, 'to', p_player));
  perform private.chat_bot_post('draft', '✏️ ' || private.draft_who((select x.is_practice from public.drafts x where x.id = p_draft)) || ' changed Round ' || old.round || ', Pick ' || old.pick || ' (' || private.draft_name(old.team_id) || ') to ' ||
    coalesce((select np.name from public.nfl_players np where np.id = p_player), p_player), jsonb_build_object('kind', 'edit', 'draft', p_draft));
end;
$$;

revoke execute on function private.draft_joined(bigint), private.draft_can_control(bigint), private.draft_need_control(bigint), private.draft_person(uuid), private.draft_who(boolean),
  private.draft_log_add(bigint, text, uuid) from public, anon;
revoke execute on function public.draft_join(bigint) from public, anon;
grant execute on function public.draft_join(bigint) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The practice chat room: only the people in that draft
-- ---------------------------------------------------------------------------
create function private.chat_room_visible(p_room text) returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.is_member() and coalesce((select r.draft_id is null or exists (select 1 from public.draft_participants p where p.draft_id = r.draft_id and p.user_id = (select auth.uid()))
    from public.chat_rooms r where r.id = p_room), false)
$$;
create function private.chat_message_visible(p_message bigint) returns boolean
language sql stable security definer set search_path = ''
as $$ select coalesce((select private.chat_room_visible(m.room_id) from public.chat_messages m where m.id = p_message), false) $$;
revoke execute on function private.chat_room_visible(text), private.chat_message_visible(bigint) from public, anon;
grant execute on function private.chat_room_visible(text), private.chat_message_visible(bigint) to authenticated, service_role;

drop policy "members read" on public.chat_rooms;
drop policy "commissioner manages rooms" on public.chat_rooms;
create policy "members read" on public.chat_rooms for select to authenticated using (private.chat_room_visible(id));
create policy "commissioner manages rooms" on public.chat_rooms for all to authenticated
  using (private.is_commissioner() and kind <> 'practice') with check (private.is_commissioner() and kind <> 'practice');
drop policy "members read" on public.chat_messages;
drop policy "members post" on public.chat_messages;
drop policy "author edits" on public.chat_messages;
drop policy "author or commissioner deletes" on public.chat_messages;
create policy "members read" on public.chat_messages for select to authenticated using (private.chat_room_visible(room_id));
create policy "members post" on public.chat_messages for insert to authenticated with check (private.chat_room_visible(room_id));
create policy "author edits" on public.chat_messages for update to authenticated
  using (private.chat_room_visible(room_id) and author_id = (select auth.uid())) with check (author_id = (select auth.uid()));
create policy "author or commissioner deletes" on public.chat_messages for delete to authenticated
  using (private.chat_room_visible(room_id) and (author_id = (select auth.uid()) or private.is_commissioner()));
drop policy "members read" on public.chat_reactions;
drop policy "react as yourself" on public.chat_reactions;
create policy "members read" on public.chat_reactions for select to authenticated using (private.chat_message_visible(message_id));
create policy "react as yourself" on public.chat_reactions for insert to authenticated
  with check (private.chat_message_visible(message_id) and user_id = (select auth.uid()));
drop policy "own reads" on public.chat_reads;
create policy "own reads" on public.chat_reads for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()) and private.chat_room_visible(room_id));

create or replace function private.guard_chat_room() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if private.is_privileged() and new.kind = 'practice' then new.created_at := now(); new.pinned_message_id := null; return new; end if;   -- server side only
    new.draft_id := null;
    new.kind := 'custom'; new.created_at := now(); new.pinned_message_id := null;
    return new;
  end if;
  if old.kind <> 'custom' and (new.kind <> old.kind or new.archived) then
    raise exception 'The League and Draft rooms are always open' using errcode = '42501';
  end if;
  if new.id <> old.id then raise exception 'A room keeps its id' using errcode = '42501'; end if;
  if new.draft_id is distinct from old.draft_id then raise exception 'A practice room stays with its draft' using errcode = '42501'; end if;
  if new.pinned_message_id is not null and new.pinned_message_id is distinct from old.pinned_message_id
     and not exists (select 1 from public.chat_messages m where m.id = new.pinned_message_id and m.room_id = new.id) then
    raise exception 'Pin a message from this room' using errcode = '22023';
  end if;
  return new;
end;
$$;

create or replace function public.chat_unread() returns table (room_id text, unread int)
language sql stable set search_path = ''
as $$
  select r.id, count(m.id)::int
  from public.chat_rooms r
  join public.chat_messages m on m.room_id = r.id and m.author_id is distinct from (select auth.uid())
  left join public.chat_reads rd on rd.room_id = r.id and rd.user_id = (select auth.uid())
  where not r.archived and r.draft_id is null and m.created_at > coalesce(rd.read_at, now() - interval '1 day')
  group by r.id
$$;

create or replace function private.notify_on_mention() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare u uuid; r text := case when tg_table_name = 'chat_messages' then 'chat:' else 'board:' end || new.id;
begin
  if new.is_bot or new.author_id is null or position('@' in coalesce(new.body, '')) = 0 then return null; end if;
  if tg_table_name = 'chat_messages' and exists (select 1 from public.chat_rooms cr where cr.id = to_jsonb(new) ->> 'room_id' and cr.draft_id is not null) then return null; end if;   -- practice rooms send no email
  for u in select private.mentioned_users(new.body) loop
    if u <> new.author_id then perform private.notify_enqueue(u, 'mentions', r, now() + interval '1 minute'); end if;
  end loop;
  return null;
end;
$$;

-- Talking in a practice room counts as activity (at most one write per 10 minutes)
create function private.chat_touch_practice() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.is_bot then return null; end if;
  update public.drafts d set last_activity_at = now() from public.chat_rooms r
   where r.id = new.room_id and r.draft_id is not null and d.id = r.draft_id and d.last_activity_at < now() - interval '10 minutes';
  return null;
end;
$$;
revoke execute on function private.chat_touch_practice() from public, anon;
create trigger chat_touch_practice after insert on public.chat_messages for each row execute function private.chat_touch_practice();

-- ---------------------------------------------------------------------------
-- Housekeeping: hourly. 14 days without activity = deleted; the host hears 2 days before.
-- ---------------------------------------------------------------------------
create function private.practice_housekeeping(p_now timestamptz default now()) returns int
language plpgsql security definer set search_path = ''
as $$
declare d public.drafts; n int;
begin
  delete from public.drafts x where x.kind = 'mock' and x.last_activity_at < p_now - interval '14 days';
  get diagnostics n = row_count;
  for d in select * from public.drafts x where x.kind = 'mock' and x.last_activity_at < p_now - interval '12 days'
             and (x.expiry_warned_at is null or x.expiry_warned_at < x.last_activity_at) for update skip locked loop
    if d.host is not null and private.notify_on(d.host, 'draft') then
      insert into public.notify_queue (user_id, kind, ref, due_at, payload)
      values (d.host, 'draft', 'draft:' || d.id || ':expiring:' || to_char(p_now, 'YYYYMMDD'), p_now,
        jsonb_build_object('type', 'expiring', 'draft', d.name, 'draft_id', d.id, 'deletes_at', d.last_activity_at + interval '14 days', 'link', '#draft'))
      on conflict do nothing;
    end if;
    update public.drafts set expiry_warned_at = p_now where id = d.id;
  end loop;
  return n;
end;
$$;
revoke execute on function private.practice_housekeeping(timestamptz) from public, anon, authenticated;
do $do$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') and exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('b5-practice-housekeeping', '23 * * * *', 'select private.practice_housekeeping()');
  end if;
end $do$;
