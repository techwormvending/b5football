-- Email notifications (sent by the Edge Function "notify" through Resend, from noreply@b5football.win).
--
-- notify_settings  per user, editable only by that user (RLS): pause-all + one toggle per type:
--                  dm (default on), mentions (off), trades (on), waivers (off), announcements (on),
--                  lineup (off). No row = the defaults.
-- user_presence    "last seen on the site" (the page calls public.notify_seen() every minute while
--                  it's visible). Active = seen in the last 2 minutes: DM and mention emails skip you.
-- notify_queue     events waiting to be emailed (server jobs only). Database triggers enqueue them:
--                  a direct message (each other participant; due in 5 minutes), an @mention in Chat
--                  or on the Board, a trade proposal or status change, waiver results (one per run),
--                  a commissioner announcement (a board cross-post or a published announcement),
--                  and lineup reminders (cron: starters on bye or out, ~3 hours before the deadline).
--                  One pending row per user + type + subject, so bursts collapse into one email.
-- email_log        one row per email decision: sent / failed / skipped (+ why), type, recipient user,
--                  time. Never the contents. Commissioner read.
--
-- public.notify_claim() (service_role, called by the function) applies every rule at send time:
-- the user's toggles and pause, a sign-in email on file, league membership, the free-tier cap
-- (95 a day, 2,900 a month: Resend's free plan is 100/day, 3,000/month), DMs only while still
-- unread, DMs and mentions not while the user is active, and at most one DM email per conversation
-- per 30 minutes (later ones wait and summarize everything unread). public.notify_done() records
-- the result; a failure is retried once (2 minutes later), then given up quietly.
-- Unsubscribe: a signed token per user + type (key in private.notify_key, never leaves the database);
-- public.notify_unsubscribe(token) turns that type off without signing in (links in the email
-- footer and the List-Unsubscribe header).

create table public.notify_settings (
  user_id uuid primary key default auth.uid() references public.profiles (id) on delete cascade,
  paused boolean not null default false,
  dm boolean not null default true,
  mentions boolean not null default false,
  trades boolean not null default true,
  waivers boolean not null default false,
  announcements boolean not null default true,
  lineup boolean not null default false,
  updated_at timestamptz not null default now()
);
create table public.user_presence (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  seen_at timestamptz not null default now()
);
create table public.notify_queue (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('dm', 'mentions', 'trades', 'waivers', 'announcements', 'lineup')),
  ref text not null,                       -- what it's about: conv:7, trade:5:accepted, run:3, chat:812, board:44, lineup:2027:3:0011:<epoch>
  due_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'skipped', 'failed')),
  reason text,
  attempts int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index notify_queue_one_open on public.notify_queue (user_id, kind, ref) where status in ('pending', 'sending');
create index notify_queue_due on public.notify_queue (due_at) where status = 'pending';
create table public.email_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  user_id uuid references public.profiles (id) on delete set null,
  kind text not null,
  ref text,
  status text not null check (status in ('sent', 'failed', 'skipped')),
  reason text,
  attempt int not null default 1,
  provider_id text
);
create index email_log_at on public.email_log (at desc);
create table private.notify_key (id boolean primary key default true check (id), key text not null);
insert into private.notify_key (key) values (replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''));

alter table public.notify_settings enable row level security;
alter table public.user_presence enable row level security;
alter table public.notify_queue enable row level security;     -- server jobs only: no policies
alter table public.email_log enable row level security;
create policy "own settings" on public.notify_settings for select to authenticated using (user_id = (select auth.uid()));
create policy "insert own settings" on public.notify_settings for insert to authenticated with check (user_id = (select auth.uid()));
create policy "update own settings" on public.notify_settings for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own presence" on public.user_presence for select to authenticated using (user_id = (select auth.uid()));
create policy "commissioner reads" on public.email_log for select to authenticated using (private.is_commissioner());
revoke all on public.notify_settings, public.user_presence, public.notify_queue, public.email_log from anon, authenticated;
revoke all on private.notify_key from public, anon, authenticated;
grant select, insert, update on public.notify_settings to authenticated;
grant select on public.user_presence, public.email_log to authenticated;
grant all on public.notify_settings, public.user_presence, public.notify_queue, public.email_log to service_role;

create function private.guard_notify_settings() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if not private.is_privileged() then new.user_id := (select auth.uid()); end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger guard_notify_settings before insert or update on public.notify_settings
  for each row execute function private.guard_notify_settings();

-- Is this type on for this user (defaults when there's no row; pause turns everything off)?
create function private.notify_on(p_user uuid, p_kind text) returns boolean
language sql stable security definer set search_path = ''
as $$
  select case when s.user_id is null then p_kind in ('dm', 'trades', 'announcements')
              when s.paused then false
              else (to_jsonb(s) ->> p_kind)::boolean end
  from (select 1) one left join public.notify_settings s on s.user_id = p_user
$$;

-- Presence heartbeat from the page.
create function public.notify_seen() returns void
language sql security definer set search_path = ''
as $$
  insert into public.user_presence (user_id, seen_at) select (select auth.uid()), now() where (select auth.uid()) is not null
  on conflict (user_id) do update set seen_at = excluded.seen_at
$$;

-- ---------------------------------------------------------------------------
-- Unsubscribe tokens: "<user>.<kind>.<sig>", sig = sha256(k || sha256(k || ":" || user || ":" || kind))
-- (the nested form isn't open to length extension), first 32 hex characters.
-- ---------------------------------------------------------------------------
create function private.notify_sig(p_user uuid, p_kind text) returns text
language sql stable security definer set search_path = ''
as $$
  select left(encode(sha256(convert_to(k.key || encode(sha256(convert_to(k.key || ':' || p_user::text || ':' || p_kind, 'UTF8')), 'hex'), 'UTF8')), 'hex'), 32)
  from private.notify_key k
$$;
create function private.notify_token(p_user uuid, p_kind text) returns text
language sql stable security definer set search_path = ''
as $$ select p_user::text || '.' || p_kind || '.' || private.notify_sig(p_user, p_kind) $$;

-- Turn one type off from an email link (no sign-in). Returns the type.
create function public.notify_unsubscribe(p_token text) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  m text[] := regexp_match(coalesce(p_token, ''), '^([0-9a-f-]{36})\.(dm|mentions|trades|waivers|announcements|lineup)\.([0-9a-f]{32})$');
  u uuid;
begin
  if m is null then raise exception 'That link isn''t valid' using errcode = '22023'; end if;
  u := m[1]::uuid;
  if m[3] <> private.notify_sig(u, m[2]) or not exists (select 1 from public.profiles where id = u) then
    raise exception 'That link isn''t valid' using errcode = '22023';
  end if;
  insert into public.notify_settings (user_id) values (u) on conflict (user_id) do nothing;
  update public.notify_settings set
    dm = case when m[2] = 'dm' then false else dm end,
    mentions = case when m[2] = 'mentions' then false else mentions end,
    trades = case when m[2] = 'trades' then false else trades end,
    waivers = case when m[2] = 'waivers' then false else waivers end,
    announcements = case when m[2] = 'announcements' then false else announcements end,
    lineup = case when m[2] = 'lineup' then false else lineup end
  where user_id = u;
  update public.notify_queue set status = 'skipped', reason = 'unsubscribed', updated_at = now() where user_id = u and kind = m[2] and status = 'pending';
  return m[2];
end;
$$;

-- ---------------------------------------------------------------------------
-- Enqueueing (definer helpers called by triggers that run as the caller)
-- ---------------------------------------------------------------------------
create function private.notify_enqueue(p_user uuid, p_kind text, p_ref text, p_due timestamptz) returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  if p_user is null or not private.notify_on(p_user, p_kind) then return false; end if;
  insert into public.notify_queue (user_id, kind, ref, due_at) values (p_user, p_kind, p_ref, p_due)
  on conflict (user_id, kind, ref) where status in ('pending', 'sending') do nothing;
  return found;
end;
$$;
create function private.member_ids() returns setof uuid
language sql stable security definer set search_path = ''
as $$ select tm.user_id from public.team_managers tm union select p.id from public.profiles p where p.is_commissioner $$;
create function private.team_owner_ids(p_teams text[]) returns setof uuid
language sql stable security definer set search_path = ''
as $$ select tm.user_id from public.team_managers tm where tm.team_id = any (p_teams) $$;

-- Who an @mention in this text reaches: a team name -> its owners; a display name -> that person.
create function private.mentioned_users(p_body text) returns setof uuid
language sql stable security definer set search_path = ''
as $$
  select tm.user_id from public.teams t join public.team_managers tm on tm.team_id = t.id
   where position(lower('@' || t.name) in lower(coalesce(p_body, ''))) > 0
  union
  select p.id from public.profiles p
   where char_length(btrim(coalesce(p.display_name, ''))) >= 2 and p.id in (select private.member_ids())
     and position(lower('@' || p.display_name) in lower(coalesce(p_body, ''))) > 0
$$;

create function private.notify_on_dm() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare u uuid; c public.dm_conversations;
begin
  if new.is_bot then return null; end if;
  select * into c from public.dm_conversations where id = new.conversation_id;
  for u in select m.user_id from public.dm_members m where m.conversation_id = c.id
           union select private.team_owner_ids(c.teams) loop
    if u is distinct from new.author_id then perform private.notify_enqueue(u, 'dm', 'conv:' || c.id, now() + interval '5 minutes'); end if;
  end loop;
  return null;
end;
$$;
create trigger notify_on_dm after insert on public.dm_messages for each row execute function private.notify_on_dm();

create function private.notify_on_mention() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare u uuid; r text := case when tg_table_name = 'chat_messages' then 'chat:' else 'board:' end || new.id;
begin
  if new.is_bot or new.author_id is null or position('@' in coalesce(new.body, '')) = 0 then return null; end if;
  for u in select private.mentioned_users(new.body) loop
    if u <> new.author_id then perform private.notify_enqueue(u, 'mentions', r, now() + interval '1 minute'); end if;
  end loop;
  return null;
end;
$$;
create trigger notify_on_mention after insert on public.chat_messages for each row execute function private.notify_on_mention();
create trigger notify_on_mention after insert on public.board_posts for each row execute function private.notify_on_mention();

create function private.notify_on_trade() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare u uuid; who uuid[];
begin
  if tg_op = 'UPDATE' and new.status = old.status then return null; end if;
  who := case new.status
    when 'proposed' then array(select private.team_owner_ids(array[new.to_team]))
    when 'accepted' then array(select private.team_owner_ids(array[new.from_team])
                               union select p.id from public.profiles p where p.is_commissioner)
    else array(select private.team_owner_ids(array[new.from_team, new.to_team])) end;
  foreach u in array who loop
    if u is distinct from (select auth.uid()) then
      perform private.notify_enqueue(u, 'trades', 'trade:' || new.id || ':' || new.status, now() + interval '1 minute');
    end if;
  end loop;
  return null;
end;
$$;
create trigger notify_on_trade after insert or update of status on public.trades for each row execute function private.notify_on_trade();

create function private.notify_on_waiver() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare u uuid;
begin
  if old.status <> 'pending' or new.status not in ('won', 'lost', 'skipped') or new.run_id is null then return null; end if;
  for u in select private.team_owner_ids(array[new.team_id]) loop
    perform private.notify_enqueue(u, 'waivers', 'run:' || new.run_id || ':' || new.team_id, now() + interval '2 minutes');
  end loop;
  return null;
end;
$$;
create trigger notify_on_waiver after update of status on public.waiver_claims for each row execute function private.notify_on_waiver();

-- Announcements: the commissioner's board cross-posts, and published rows of public.announcements.
create function private.notify_on_announcement() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare u uuid; r text;
begin
  if tg_table_name = 'board_threads' then
    if new.source_key is null or new.source_key not like 'announcement:%' then return null; end if;
    r := 'board:' || new.id;
  else
    if new.published_at is null or (tg_op = 'UPDATE' and old.published_at is not null) then return null; end if;
    r := 'ann:' || new.id;
  end if;
  for u in select private.member_ids() loop
    if u is distinct from (select auth.uid()) then perform private.notify_enqueue(u, 'announcements', r, now() + interval '1 minute'); end if;
  end loop;
  return null;
end;
$$;
create trigger notify_on_announcement after insert on public.board_threads for each row execute function private.notify_on_announcement();
create trigger notify_on_announcement after insert or update of published_at on public.announcements for each row execute function private.notify_on_announcement();

-- Lineup reminders (cron every 15 minutes): starters who are OUT (IR, PUP, Suspended, Reserve, Out)
-- before their game's kickoff, and starters ON BYE before the week's first Sunday kickoff, from 3 hours
-- ahead. One reminder per team, week and deadline. Season setting season_settings.notify.lineupReminders
-- (default true; false for 2026, when lineups mirror MFL's).
alter table public.season_settings add column notify jsonb not null default '{}';
update public.season_settings set notify = '{"lineupReminders": false}' where season = 2026;

create function private.lineup_problems(p_season int, p_week int, p_team text)
returns table (player_id text, name text, pos text, problem text, deadline timestamptz)
language sql stable security definer set search_path = ''
as $$
  with games as (select * from public.nfl_games g where g.season = p_season and g.week = p_week),
  sunday as (select coalesce(min(g.kickoff) filter (where extract(isodow from g.kickoff at time zone 'America/New_York') = 7), max(g.kickoff)) as kick from games g),
  starters as (
    select s.player_id, np.name, np.position as pos, coalesce(np.nfl_team, substr(s.player_id, 5)) as nfl
    from public.lineup_slots s join public.nfl_players np on np.id = s.player_id
    where s.season = p_season and s.week = p_week and s.team_id = p_team and s.player_id is not null)
  select st.player_id, st.name, st.pos,
         case when g.kickoff is null then 'bye' else lower(i.status) end,
         case when g.kickoff is null then (select kick from sunday) else g.kickoff end
  from starters st
  left join games g on st.nfl in (g.home, g.away)
  left join public.player_injuries i on i.season = p_season and i.week = p_week and i.player_id = st.player_id
  where (g.kickoff is null and exists (select 1 from games))
     or (g.kickoff > now() and i.status in ('IR', 'PUP', 'Suspended', 'Reserve', 'Out'))
$$;

create function private.enqueue_lineup_reminders(p_now timestamptz default now()) returns int
language plpgsql security definer set search_path = ''
as $$
declare r record; u uuid; n int := 0;
begin
  for r in
    select distinct s.season, s.week, s.team_id, p.deadline
    from (select distinct season, week, team_id from public.lineup_slots
          where (season, week) in (select g.season, g.week from public.nfl_games g where g.kickoff between p_now and p_now + interval '7 days')) s
    cross join lateral private.lineup_problems(s.season, s.week, s.team_id) p
    where coalesce((select (ss.notify ->> 'lineupReminders')::boolean from public.season_settings ss where ss.season = s.season), true)
      and p.deadline > p_now and p.deadline <= p_now + interval '3 hours'
  loop
    for u in select private.team_owner_ids(array[r.team_id]) loop
      if not exists (select 1 from public.notify_queue q where q.user_id = u and q.kind = 'lineup'
                     and q.ref = 'lineup:' || r.season || ':' || r.week || ':' || r.team_id || ':' || extract(epoch from r.deadline)::bigint) then
        if private.notify_enqueue(u, 'lineup', 'lineup:' || r.season || ':' || r.week || ':' || r.team_id || ':' || extract(epoch from r.deadline)::bigint, p_now) then
          n := n + 1;
        end if;
      end if;
    end loop;
  end loop;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- Sending: claim due items with everything the email needs, then record the result.
-- ---------------------------------------------------------------------------
create function private.person(p_user uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('name', coalesce(nullif(p.display_name, ''), 'A league member'),
    'team', (select t.name from public.team_managers tm join public.teams t on t.id = tm.team_id where tm.user_id = p.id limit 1))
  from public.profiles p where p.id = p_user
$$;
create function private.preview(p_body text) returns text
language sql immutable set search_path = ''
as $$ select case when char_length(btrim(coalesce(p_body, ''))) = 0 then '📷 Image'
             else left(regexp_replace(btrim(p_body), '\s+', ' ', 'g'), 160) || case when char_length(btrim(p_body)) > 160 then '…' else '' end end $$;

create function private.notify_skip(q public.notify_queue, p_reason text) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.notify_queue set status = 'skipped', reason = p_reason, updated_at = now() where id = q.id;
  insert into public.email_log (user_id, kind, ref, status, reason, attempt) values (q.user_id, q.kind, q.ref, 'skipped', p_reason, q.attempts);
end;
$$;

create function public.notify_claim(p_limit int default 25, p_now timestamptz default now())
returns table (id bigint, user_id uuid, kind text, email text, token text, data jsonb)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  q public.notify_queue;
  addr text;
  d jsonb;
  unread int;
  last_sent timestamptz;
  ref_id bigint;
  t public.trades;
  parts text[];
  day_count int;
  month_count int;
begin
  -- Items stuck in "sending" (the function died): back to pending.
  update public.notify_queue nq set status = 'pending', updated_at = p_now where nq.status = 'sending' and nq.updated_at < p_now - interval '10 minutes';
  for q in select * from public.notify_queue nq where nq.status = 'pending' and nq.due_at <= p_now order by nq.due_at limit p_limit for update skip locked loop
    select u.email into addr from auth.users u where u.id = q.user_id;
    if addr is null then perform private.notify_skip(q, 'no email'); continue; end if;
    if q.user_id not in (select private.member_ids()) then perform private.notify_skip(q, 'not a member'); continue; end if;
    if not private.notify_on(q.user_id, q.kind) then perform private.notify_skip(q, 'turned off'); continue; end if;
    select count(*) filter (where l.at >= date_trunc('day', p_now)), count(*) into day_count, month_count
      from public.email_log l where l.status = 'sent' and l.at >= date_trunc('month', p_now);
    if day_count >= 95 or month_count >= 2900 then perform private.notify_skip(q, 'free-tier limit'); continue; end if;
    d := null;
    parts := string_to_array(q.ref, ':');
    ref_id := case when parts[2] ~ '^\d+$' then parts[2]::bigint end;

    if q.kind in ('dm', 'mentions') and exists (select 1 from public.user_presence pr where pr.user_id = q.user_id and pr.seen_at > p_now - interval '2 minutes') then
      perform private.notify_skip(q, 'active on the site'); continue;
    end if;

    if q.kind = 'dm' then
      select count(*) into unread from public.dm_messages m
       where m.conversation_id = ref_id and not m.is_bot and m.author_id is distinct from q.user_id
         and m.created_at > coalesce((select r.read_at from public.dm_reads r where r.conversation_id = ref_id and r.user_id = q.user_id), '-infinity');
      if unread = 0 then perform private.notify_skip(q, 'already read'); continue; end if;
      select max(l.at) into last_sent from public.email_log l where l.user_id = q.user_id and l.kind = 'dm' and l.ref = q.ref and l.status = 'sent';
      if last_sent is not null and last_sent > p_now - interval '30 minutes' then
        update public.notify_queue nq set due_at = last_sent + interval '30 minutes', updated_at = p_now where nq.id = q.id;   -- wait, then summarize
        continue;
      end if;
      d := jsonb_build_object('count', unread, 'link', '#dm/' || ref_id,
        'senders', (select jsonb_agg(distinct private.person(m.author_id)) from public.dm_messages m
                    where m.conversation_id = ref_id and not m.is_bot and m.author_id is distinct from q.user_id
                      and m.created_at > coalesce((select r.read_at from public.dm_reads r where r.conversation_id = ref_id and r.user_id = q.user_id), '-infinity')),
        'preview', (select private.preview(m.body) from public.dm_messages m where m.conversation_id = ref_id and not m.is_bot and m.author_id is distinct from q.user_id order by m.id desc limit 1));
    elsif q.kind = 'mentions' then
      if parts[1] = 'chat' then
        select jsonb_build_object('where', 'Chat', 'from', private.person(m.author_id), 'preview', private.preview(m.body), 'link', '#chat/' || m.room_id)
          into d from public.chat_messages m where m.id = ref_id;
      else
        select jsonb_build_object('where', 'the Message Board', 'from', private.person(p.author_id), 'preview', private.preview(p.body), 'link', '#board/' || p.thread_id,
          'title', (select th.title from public.board_threads th where th.id = p.thread_id))
          into d from public.board_posts p where p.id = ref_id;
      end if;
      if d is null then perform private.notify_skip(q, 'deleted'); continue; end if;
    elsif q.kind = 'trades' then
      select * into t from public.trades tr where tr.id = ref_id;
      if t.id is null then perform private.notify_skip(q, 'deleted'); continue; end if;
      d := jsonb_build_object('status', parts[3], 'test', t.test, 'summary', private.trade_summary(t), 'note', t.note, 'decision_note', t.decision_note,
        'from_team', private.team_name(t.from_team), 'to_team', private.team_name(t.to_team), 'expires_at', t.expires_at,
        'commissioner_party', t.commissioner_party, 'link', case when t.conversation_id is not null and parts[3] in ('proposed') then '#trades' else '#trades' end);
    elsif q.kind = 'waivers' then
      d := jsonb_build_object('link', '#players/results', 'claims', (select jsonb_agg(jsonb_build_object('player', coalesce(np.name, c.add_player), 'drop', dp.name,
               'status', c.status, 'result', c.result) order by c.rank)
             from public.waiver_claims c left join public.nfl_players np on np.id = c.add_player left join public.nfl_players dp on dp.id = c.drop_player
             where c.run_id = ref_id and c.team_id = parts[3]));
      if d ->> 'claims' is null then perform private.notify_skip(q, 'undone'); continue; end if;
    elsif q.kind = 'announcements' then
      if parts[1] = 'board' then
        select jsonb_build_object('title', th.title, 'preview', private.preview((select p.body from public.board_posts p where p.thread_id = th.id and p.is_opener limit 1)), 'link', '#board/' || th.id)
          into d from public.board_threads th where th.id = ref_id;
      else
        select jsonb_build_object('title', a.title, 'preview', private.preview(regexp_replace(a.body_html, '<[^>]*>', ' ', 'g')), 'link', '#home')
          into d from public.announcements a where a.id = ref_id and a.published_at is not null;
      end if;
      if d is null then perform private.notify_skip(q, 'deleted'); continue; end if;
    elsif q.kind = 'lineup' then
      d := jsonb_build_object('week', parts[3]::int, 'team', private.team_name(parts[4]), 'link', '#myteam',
        'players', (select jsonb_agg(jsonb_build_object('name', lp.name, 'pos', lp.pos, 'problem', lp.problem, 'deadline', lp.deadline))
                    from private.lineup_problems(parts[2]::int, parts[3]::int, parts[4]) lp));
      if d ->> 'players' is null then perform private.notify_skip(q, 'lineup fixed'); continue; end if;
    end if;

    update public.notify_queue nq set status = 'sending', attempts = nq.attempts + 1, updated_at = p_now where nq.id = q.id;
    id := q.id; user_id := q.user_id; kind := q.kind; email := addr; token := private.notify_token(q.user_id, q.kind); data := d;
    return next;
  end loop;
end;
$$;

create function public.notify_done(p_id bigint, p_ok boolean, p_provider_id text default null, p_error text default null) returns void
language plpgsql security definer set search_path = ''
as $$
declare q public.notify_queue;
begin
  select * into q from public.notify_queue where id = p_id and status = 'sending';
  if q.id is null then return; end if;
  if p_ok then
    update public.notify_queue set status = 'sent', reason = null, updated_at = now() where id = q.id;
    insert into public.email_log (user_id, kind, ref, status, attempt, provider_id) values (q.user_id, q.kind, q.ref, 'sent', q.attempts, left(p_provider_id, 100));
  else
    insert into public.email_log (user_id, kind, ref, status, reason, attempt) values (q.user_id, q.kind, q.ref, 'failed', left(p_error, 200), q.attempts);
    if q.attempts < 2 then   -- retry once, then give up quietly
      update public.notify_queue set status = 'pending', due_at = now() + interval '2 minutes', reason = left(p_error, 200), updated_at = now() where id = q.id;
    else
      update public.notify_queue set status = 'failed', reason = left(p_error, 200), updated_at = now() where id = q.id;
    end if;
  end if;
end;
$$;

-- Every minute: call the function only when something is due (zero invocations otherwise).
create function private.notify_tick() returns text
language plpgsql security definer set search_path = ''
as $$
declare n uuid;
begin
  if not exists (select 1 from public.notify_queue q where q.status = 'pending' and q.due_at <= now()) then return 'idle'; end if;
  delete from public.live_nonces where created_at < now() - interval '10 minutes';
  insert into public.live_nonces default values returning nonce into n;
  perform net.http_post(
    url := 'https://kngwdttpbpezlvjrkrrg.supabase.co/functions/v1/notify',
    body := jsonb_build_object('nonce', n),
    headers := jsonb_build_object('Content-Type', 'application/json'),
    timeout_milliseconds := 60000);
  return 'called';
end;
$$;

revoke execute on function private.notify_on(uuid, text), private.notify_sig(uuid, text), private.notify_token(uuid, text), private.notify_enqueue(uuid, text, text, timestamptz),
  private.member_ids(), private.team_owner_ids(text[]), private.mentioned_users(text), private.notify_on_dm(), private.notify_on_mention(), private.notify_on_trade(),
  private.notify_on_waiver(), private.notify_on_announcement(), private.lineup_problems(int, int, text), private.enqueue_lineup_reminders(timestamptz),
  private.person(uuid), private.notify_skip(public.notify_queue, text), private.notify_tick(), private.guard_notify_settings() from public, anon, authenticated;
grant execute on function private.guard_notify_settings() to authenticated;
revoke execute on function public.notify_seen(), public.notify_unsubscribe(text), public.notify_claim(int, timestamptz), public.notify_done(bigint, boolean, text, text) from public, anon, authenticated;
grant execute on function public.notify_seen() to authenticated;
grant execute on function public.notify_unsubscribe(text) to anon, authenticated, service_role;
grant execute on function public.notify_claim(int, timestamptz), public.notify_done(bigint, boolean, text, text) to service_role;
grant execute on function private.enqueue_lineup_reminders(timestamptz), private.notify_tick() to service_role;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    perform cron.schedule('b5-notify', '* * * * *', 'select private.notify_tick()');
    perform cron.schedule('b5-lineup-reminders', '*/15 * * * *', 'select private.enqueue_lineup_reminders()');
  end if;
end $$;
