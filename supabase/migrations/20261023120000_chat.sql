-- Chat (#chat): live rooms for league members. Separate from the Message Board (threads).
--   chat_rooms      "league" and "draft" always exist; the commissioner adds or archives others
--                   (a setting, not code); one pinned message per room
--   chat_messages   text (light formatting rendered by chat.js from escaped text; never HTML) and up
--                   to 4 images (same rules and bucket as the board); B5 Bot system messages
--   chat_reactions  👍 😂 🔥 💀 🗑️, one of each per person per message
--   chat_reads      per member, per room: last read (unread badge)
--   chat_mutes      the commissioner mutes someone until a time
--   draft_state     the live draft's current pick and clock (the draft board updates it through
--                   public.draft_event, which also posts B5 Bot messages in the Draft room)
-- Members only (private.is_member()); anon has no grants. Authors, teams and times are set by the
-- database; 20 messages per 10 seconds per member; muted members can't post; moderation (deleting
-- others' messages, clearing a room, pinning, muting) goes to audit_log. Presence and typing use a
-- PRIVATE Realtime channel ("b5-chat") that only members can join (policies on realtime.messages).

create table public.chat_rooms (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9-]{1,29}$'),
  name text not null check (char_length(btrim(name)) between 1 and 40),
  kind text not null default 'custom' check (kind in ('league', 'draft', 'custom')),
  sort int not null default 100,
  archived boolean not null default false,
  pinned_message_id bigint,
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
insert into public.chat_rooms (id, name, kind, sort) values ('league', 'League', 'league', 1), ('draft', 'Draft', 'draft', 2);

create table public.chat_messages (
  id bigint generated always as identity primary key,
  room_id text not null references public.chat_rooms (id) on delete cascade,
  author_id uuid references public.profiles (id) on delete set null,
  author_team text references public.teams (id),
  is_bot boolean not null default false,
  body text not null default '' check (char_length(body) <= 2000),
  images jsonb not null default '[]' check (jsonb_typeof(images) = 'array' and jsonb_array_length(images) <= 4),
  event jsonb,                               -- B5 Bot draft events: {kind, team, round, pick, ...}
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  check (char_length(btrim(body)) > 0 or jsonb_array_length(images) > 0)
);
create index chat_messages_room_idx on public.chat_messages (room_id, id desc);
create index chat_messages_author_idx on public.chat_messages (author_id, created_at desc);
alter table public.chat_rooms add constraint chat_rooms_pinned_fk foreign key (pinned_message_id) references public.chat_messages (id) on delete set null;

create table public.chat_reactions (
  message_id bigint not null references public.chat_messages (id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  emoji text not null check (emoji in ('👍', '😂', '🔥', '💀', '🗑️')),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);
create table public.chat_reads (
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  room_id text not null references public.chat_rooms (id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (user_id, room_id)
);
create table public.chat_mutes (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  until timestamptz not null,
  reason text,
  muted_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create table public.draft_state (
  id boolean primary key default true check (id),
  season int,
  status text not null default 'idle' check (status in ('idle', 'live', 'paused', 'done')),
  round int, pick int, overall int,
  team_id text references public.teams (id),
  clock_ends_at timestamptz,                 -- while live
  paused_remaining int,                      -- seconds left when paused
  updated_at timestamptz not null default now()
);
insert into public.draft_state default values;

-- ---------------------------------------------------------------------------
-- RLS: members only
-- ---------------------------------------------------------------------------
alter table public.chat_rooms enable row level security;
alter table public.chat_messages enable row level security;
alter table public.chat_reactions enable row level security;
alter table public.chat_reads enable row level security;
alter table public.chat_mutes enable row level security;
alter table public.draft_state enable row level security;

create policy "members read" on public.chat_rooms for select to authenticated using (private.is_member());
create policy "commissioner manages rooms" on public.chat_rooms for all to authenticated
  using (private.is_commissioner()) with check (private.is_commissioner());
create policy "members read" on public.chat_messages for select to authenticated using (private.is_member());
create policy "members post" on public.chat_messages for insert to authenticated with check (private.is_member());
create policy "author edits" on public.chat_messages for update to authenticated
  using (private.is_member() and author_id = (select auth.uid())) with check (author_id = (select auth.uid()));
create policy "author or commissioner deletes" on public.chat_messages for delete to authenticated
  using (private.is_member() and (author_id = (select auth.uid()) or private.is_commissioner()));
create policy "members read" on public.chat_reactions for select to authenticated using (private.is_member());
create policy "react as yourself" on public.chat_reactions for insert to authenticated
  with check (private.is_member() and user_id = (select auth.uid()));
create policy "unreact your own" on public.chat_reactions for delete to authenticated using (user_id = (select auth.uid()));
create policy "own reads" on public.chat_reads for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()) and private.is_member());
create policy "you see your own mute; the commissioner sees all" on public.chat_mutes for select to authenticated
  using (user_id = (select auth.uid()) or private.is_commissioner());
create policy "commissioner mutes" on public.chat_mutes for all to authenticated
  using (private.is_commissioner()) with check (private.is_commissioner());
create policy "members read" on public.draft_state for select to authenticated using (private.is_member());

revoke all on public.chat_rooms, public.chat_messages, public.chat_reactions, public.chat_reads, public.chat_mutes, public.draft_state from anon, authenticated;
grant select, insert, update on public.chat_rooms to authenticated;
grant select, insert, update, delete on public.chat_messages to authenticated;
grant select, insert, delete on public.chat_reactions to authenticated;
grant select, insert, update, delete on public.chat_reads to authenticated;
grant select, insert, update, delete on public.chat_mutes to authenticated;
grant select on public.draft_state to authenticated;
grant all on public.chat_rooms, public.chat_messages, public.chat_reactions, public.chat_reads, public.chat_mutes, public.draft_state to service_role;

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------
create function private.chat_rate_limit() returns void
language plpgsql security definer set search_path = ''
as $$
declare
  m timestamptz;
begin
  select cm.until into m from public.chat_mutes cm where cm.user_id = (select auth.uid()) and cm.until > now();
  if m is not null then
    raise exception 'You''re muted until %', to_char(m at time zone 'America/New_York', 'FMHH12:MI AM') using errcode = '42501';
  end if;
  if (select count(*) from public.chat_messages c
      where c.author_id = (select auth.uid()) and c.created_at > now() - interval '10 seconds') >= 20 then
    raise exception 'Slow down: 20 messages per 10 seconds' using errcode = '54000';
  end if;
end;
$$;

create function private.guard_chat_message() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if tg_op <> 'DELETE' and not private.board_images_ok(new.images) then
    raise exception 'Images must be https links or uploads (up to 4)' using errcode = '22023';
  end if;
  if private.is_privileged() then return coalesce(new, old); end if;
  if tg_op = 'INSERT' then
    if (select r.archived from public.chat_rooms r where r.id = new.room_id) then
      raise exception 'This room is closed' using errcode = '42501';
    end if;
    perform private.chat_rate_limit();
    new.author_id := (select auth.uid());
    new.author_team := private.my_team();
    new.is_bot := false; new.event := null;
    new.created_at := now(); new.edited_at := null;
    return new;
  elsif tg_op = 'UPDATE' then
    if new.id <> old.id or new.room_id <> old.room_id or new.author_id is distinct from old.author_id or new.author_team is distinct from old.author_team
       or new.is_bot <> old.is_bot or new.event is distinct from old.event or new.created_at <> old.created_at then
      raise exception 'Only the text and images of a message can change' using errcode = '42501';
    end if;
    new.edited_at := case when new.body <> old.body or new.images <> old.images then now() else old.edited_at end;
    return new;
  end if;
  return old;
end;
$$;
create trigger guard_chat_message before insert or update or delete on public.chat_messages
  for each row execute function private.guard_chat_message();

-- The "league" and "draft" rooms can't be removed or renamed into something else.
create function private.guard_chat_room() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.kind := 'custom'; new.created_at := now(); new.pinned_message_id := null;
    return new;
  end if;
  if old.kind <> 'custom' and (new.kind <> old.kind or new.archived) then
    raise exception 'The League and Draft rooms are always open' using errcode = '42501';
  end if;
  if new.id <> old.id then raise exception 'A room keeps its id' using errcode = '42501'; end if;
  if new.pinned_message_id is not null and new.pinned_message_id is distinct from old.pinned_message_id
     and not exists (select 1 from public.chat_messages m where m.id = new.pinned_message_id and m.room_id = new.id) then
    raise exception 'Pin a message from this room' using errcode = '22023';
  end if;
  return new;
end;
$$;
create trigger guard_chat_room before insert or update on public.chat_rooms
  for each row execute function private.guard_chat_room();

-- Moderation audit (runs as the caller; see private.audit_payouts): the commissioner deleting
-- someone else's message, pinning/unpinning, creating/archiving rooms, muting/unmuting.
create function private.audit_chat() returns trigger
language plpgsql set search_path = ''
as $$
declare
  o jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  n jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  act text;
  d jsonb;
begin
  if private.is_privileged() or not private.is_commissioner() then return null; end if;
  if tg_table_name = 'chat_messages' then
    if (o ->> 'author_id') is not distinct from (select auth.uid())::text or current_setting('b5.chat_clearing', true) = 'on' then return null; end if;
    act := 'chat:message:delete'; d := jsonb_build_object('old', o);
  elsif tg_table_name = 'chat_mutes' then
    act := 'chat:mute:' || lower(tg_op);
    d := jsonb_build_object('user_id', coalesce(n, o) ->> 'user_id', 'until', n ->> 'until', 'reason', n ->> 'reason');
  elsif tg_op = 'INSERT' then
    act := 'chat:room:create'; d := jsonb_build_object('room', n ->> 'id', 'name', n ->> 'name');
  elsif (n ->> 'pinned_message_id') is distinct from (o ->> 'pinned_message_id') then
    act := case when n ->> 'pinned_message_id' is null then 'chat:room:unpin' else 'chat:room:pin' end;
    d := jsonb_build_object('room', n ->> 'id', 'message', coalesce(n ->> 'pinned_message_id', o ->> 'pinned_message_id'));
  elsif (n ->> 'archived') <> (o ->> 'archived') or (n ->> 'name') <> (o ->> 'name') then
    act := 'chat:room:update'; d := jsonb_build_object('room', n ->> 'id', 'name', n ->> 'name', 'archived', n -> 'archived');
  else
    return null;
  end if;
  insert into public.audit_log (actor, action, details) values ((select auth.uid()), act, d);
  return null;
end;
$$;
create trigger audit_chat after delete on public.chat_messages for each row execute function private.audit_chat();
create trigger audit_chat after insert or update on public.chat_rooms for each row execute function private.audit_chat();
create trigger audit_chat after insert or update or delete on public.chat_mutes for each row execute function private.audit_chat();

-- Clear a room (commissioner): one audit entry with how many messages went.
create function public.chat_clear_room(p_room text) returns int
language plpgsql set search_path = ''
as $$
declare
  n int;
begin
  if not private.is_commissioner() then raise exception 'Only the commissioner can clear a room' using errcode = '42501'; end if;
  perform set_config('b5.chat_clearing', 'on', true);
  delete from public.chat_messages where room_id = p_room;
  get diagnostics n = row_count;
  perform set_config('b5.chat_clearing', 'off', true);
  insert into public.audit_log (actor, action, details) values ((select auth.uid()), 'chat:room:clear', jsonb_build_object('room', p_room, 'messages', n));
  return n;
end;
$$;

-- Unread messages (others', newer than your last read; rooms you never opened: the last day).
create function public.chat_unread() returns table (room_id text, unread int)
language sql stable set search_path = ''
as $$
  select r.id, count(m.id)::int
  from public.chat_rooms r
  join public.chat_messages m on m.room_id = r.id and m.author_id is distinct from (select auth.uid())
  left join public.chat_reads rd on rd.room_id = r.id and rd.user_id = (select auth.uid())
  where not r.archived and m.created_at > coalesce(rd.read_at, now() - interval '1 day')
  group by r.id
$$;

revoke execute on function private.chat_rate_limit(), private.guard_chat_message(), private.guard_chat_room(), private.audit_chat() from public, anon;
grant execute on function private.chat_rate_limit() to authenticated, service_role;
revoke execute on function public.chat_clear_room(text), public.chat_unread() from public, anon;
grant execute on function public.chat_clear_room(text), public.chat_unread() to authenticated;

-- ---------------------------------------------------------------------------
-- Draft hook: the draft board (when built) reports events here; the Draft room gets a pinned
-- header (draft_state) and B5 Bot messages. Commissioner or server jobs only.
--   'start'     {round, pick, overall, team, seconds}  draft is live, team on the clock
--   'on_clock'  {round, pick, overall, team, seconds}  "On the clock: Mac Daddies (Round 3, Pick 7)"
--   'pick'      {team, player, pos, nfl}                "Mac Daddies select Joe Burrow, QB CIN"
--   'timer'     {team, seconds}                         "30 seconds left for Mac Daddies"
--   'paused' / 'resumed' {}                             clock stops / restarts where it was
--   'end'       {}                                      "The draft is complete"
-- ---------------------------------------------------------------------------
create function private.chat_bot_post(p_room text, p_body text, p_event jsonb) returns bigint
language sql security definer set search_path = ''
as $$
  insert into public.chat_messages (room_id, is_bot, body, event) values (p_room, true, p_body, p_event) returning id
$$;
revoke execute on function private.chat_bot_post(text, text, jsonb) from public, anon, authenticated;

-- The checked entry point runs as the caller (so it can tell the commissioner and server jobs
-- apart); the writes happen in a definer helper the Data API doesn't expose (schema private).
create function public.draft_event(p_kind text, p_payload jsonb default '{}') returns bigint
language plpgsql set search_path = ''
as $$
begin
  if not (private.is_commissioner() or private.is_privileged()) then
    raise exception 'Only the commissioner (the draft board) reports draft events' using errcode = '42501';
  end if;
  return private.draft_event_apply(p_kind, p_payload);
end;
$$;

create function private.draft_event_apply(p_kind text, p_payload jsonb) returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  s public.draft_state%rowtype;
  team text := p_payload ->> 'team';
  tname text;
  body text;
  left_s int;
begin
  select * into s from public.draft_state for update;
  tname := coalesce((select t.name from public.teams t where t.id = coalesce(team, s.team_id)), team, s.team_id, 'Next team');
  if p_kind in ('start', 'on_clock') then
    update public.draft_state set status = 'live', season = coalesce((p_payload ->> 'season')::int, season),
      round = (p_payload ->> 'round')::int, pick = (p_payload ->> 'pick')::int, overall = (p_payload ->> 'overall')::int,
      team_id = team, clock_ends_at = now() + make_interval(secs => coalesce((p_payload ->> 'seconds')::int, 120)),
      paused_remaining = null, updated_at = now();
    body := case when p_kind = 'start' then '🏈 The draft is live! ' else '' end ||
            '⏰ On the clock: ' || tname || ' (Round ' || (p_payload ->> 'round') || ', Pick ' || (p_payload ->> 'pick') || ')';
  elsif p_kind = 'pick' then
    body := '✅ ' || tname || ' select ' || coalesce(p_payload ->> 'player', '?') ||
            coalesce(', ' || nullif(btrim(concat_ws(' ', p_payload ->> 'pos', p_payload ->> 'nfl')), ''), '');
  elsif p_kind = 'timer' then
    body := '⏳ ' || coalesce(p_payload ->> 'seconds', '?') || ' seconds left for ' || tname;
  elsif p_kind = 'paused' then
    left_s := greatest(0, ceil(extract(epoch from s.clock_ends_at - now()))::int);
    update public.draft_state set status = 'paused', paused_remaining = left_s, clock_ends_at = null, updated_at = now();
    body := '⏸️ The commissioner paused the draft';
  elsif p_kind = 'resumed' then
    update public.draft_state set status = 'live', clock_ends_at = now() + make_interval(secs => coalesce(s.paused_remaining, 0)),
      paused_remaining = null, updated_at = now();
    body := '▶️ The draft resumed: ' || tname || ' is on the clock';
  elsif p_kind = 'end' then
    update public.draft_state set status = 'done', team_id = null, clock_ends_at = null, paused_remaining = null, updated_at = now();
    body := '🏁 The draft is complete';
  else
    raise exception 'Unknown draft event %', p_kind using errcode = '22023';
  end if;
  return private.chat_bot_post('draft', body, p_payload || jsonb_build_object('kind', p_kind));
end;
$$;
revoke execute on function public.draft_event(text, jsonb), private.draft_event_apply(text, jsonb) from public, anon;
grant execute on function public.draft_event(text, jsonb), private.draft_event_apply(text, jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Realtime: messages, reactions, rooms and the draft clock reach open pages (RLS per subscriber).
-- Presence ("who's online") and typing use the private channel "b5-chat": only members may join
-- it, listen or send (Realtime Authorization = policies on realtime.messages).
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.chat_messages, public.chat_reactions, public.chat_rooms, public.draft_state;
  end if;
  if to_regclass('realtime.messages') is not null then
    execute $p$create policy "b5 chat: members receive presence and typing" on realtime.messages for select to authenticated
      using (realtime.topic() = 'b5-chat' and private.is_member())$p$;
    execute $p$create policy "b5 chat: members send presence and typing" on realtime.messages for insert to authenticated
      with check (realtime.topic() = 'b5-chat' and private.is_member())$p$;
  end if;
end $$;
