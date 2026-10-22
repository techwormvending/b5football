-- Team profiles (owner contact info), direct messages, draft picks and trade proposals.
--
-- Owner contact info (owner_contacts): email, US cell phone, personal website, each with a
--   visibility flag ("League members" = true, the default, or "Hidden"). PRIVATE TABLE: an owner
--   reads/writes only his own row, the commissioner reads every row; nobody else selects it.
--   League members get the visible fields through public.team_contacts(team) (members only; hidden
--   fields come back null, except to the commissioner and the owner himself). anon: no grants.
--
-- Direct messages (dm_*): 1-to-1 (two people) or 1-to-team (you + that team's owners, current
--   owners at any time), plus one conversation per trade (both teams' owners, B5 Bot notices).
--   Only participants read (RLS). The commissioner can NOT read a conversation he's not in, unless
--   a participant reports it (dm_report), until he resolves the report (dm_resolve); both audited.
--   Same text/image rules as chat (escaped text rendered by chat.js, images = https links or uploads
--   to the private dm-images bucket, readable only by the conversation's participants).
--
-- Trades (season_settings.trades, settings not code): propose players and future draft picks;
--   either co-owner proposes / accepts / declines; proposals expire after expireDays (7); the
--   proposer withdraws; accepted trades wait for the commissioner, who approves or rejects with a
--   note (a trade involving his own team is flagged and audited as such); no trades from the
--   kickoff of week deadlineWeek's first game (12); a player whose game has started can't be traded
--   until his NFL week ends (the add/drop lock); rosters over the max after the trade need drops.
--   A trade isn't a roster move (transactions.via = 'trade'). Each step posts a B5 Bot notice in the
--   trade's conversation; approved (live) trades are posted to the Board.
--   "live": false (2026, MFL is official) = test trades: allowed and labelled TEST, approval changes
--   nothing. Live from 2027.

-- ---------------------------------------------------------------------------
-- Owner contact info
-- ---------------------------------------------------------------------------
create table public.owner_contacts (
  user_id uuid primary key default auth.uid() references public.profiles (id) on delete cascade,
  email text check (email is null or (char_length(email) <= 254 and email ~* '^[^@[:space:]<>"'']+@[^@[:space:]<>"'']+\.[a-z]{2,}$')),
  email_visible boolean not null default true,
  phone text check (phone is null or phone ~ '^[2-9][0-9]{2}[2-9][0-9]{6}$'),     -- US, 10 digits
  phone_visible boolean not null default true,
  website text check (website is null or (char_length(website) <= 300 and website ~ '^https://[^[:space:]<>"''`]+$')),
  website_visible boolean not null default true,
  updated_at timestamptz not null default now()
);

-- Phone: "(412) 555-0123", "412.555.0123", "+1 412 555 0123" -> "4125550123"; empty -> null.
create function private.guard_owner_contact() returns trigger
language plpgsql set search_path = ''
as $$
declare d text;
begin
  new.email := nullif(btrim(coalesce(new.email, '')), '');
  new.website := nullif(btrim(coalesce(new.website, '')), '');
  d := regexp_replace(coalesce(new.phone, ''), '[^0-9]', '', 'g');
  if d = '' then new.phone := null;
  else
    if char_length(d) = 11 and left(d, 1) = '1' then d := substr(d, 2); end if;
    if d !~ '^[2-9][0-9]{2}[2-9][0-9]{6}$' then
      raise exception 'Enter a 10-digit US phone number, e.g. (412) 555-0123' using errcode = '22023';
    end if;
    new.phone := d;
  end if;
  if new.website is not null and new.website !~ '^https://[^[:space:]<>"''`]+\.[^[:space:]<>"''`]+$' then
    raise exception 'Website must be an https:// link' using errcode = '22023';
  end if;
  if new.email is not null and new.email !~* '^[^@[:space:]<>"'']+@[^@[:space:]<>"'']+\.[a-z]{2,}$' then
    raise exception 'That email address doesn''t look right' using errcode = '22023';
  end if;
  if not private.is_privileged() then new.user_id := (select auth.uid()); end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger guard_owner_contact before insert or update on public.owner_contacts
  for each row execute function private.guard_owner_contact();

alter table public.owner_contacts enable row level security;
create policy "own row, or the commissioner" on public.owner_contacts for select to authenticated
  using (user_id = (select auth.uid()) or private.is_commissioner());
create policy "insert own row" on public.owner_contacts for insert to authenticated
  with check (user_id = (select auth.uid()) and private.is_member());
create policy "update own row" on public.owner_contacts for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "delete own row" on public.owner_contacts for delete to authenticated using (user_id = (select auth.uid()));
revoke all on public.owner_contacts from anon, authenticated;
grant select, insert, update, delete on public.owner_contacts to authenticated;
grant all on public.owner_contacts to service_role;

-- A team's owners with their visible contact fields. Members only (others get no rows).
create function public.team_contacts(p_team text)
returns table (user_id uuid, display_name text, email text, phone text, website text, hidden text[])
language sql stable security definer set search_path = ''
as $$
  select tm.user_id, p.display_name,
         case when c.email_visible or full_view then c.email end,
         case when c.phone_visible or full_view then c.phone end,
         case when c.website_visible or full_view then c.website end,
         case when full_view then array_remove(array[case when not c.email_visible then 'email' end,
           case when not c.phone_visible then 'phone' end, case when not c.website_visible then 'website' end], null) else '{}'::text[] end
  from public.team_managers tm
  join public.profiles p on p.id = tm.user_id
  left join public.owner_contacts c on c.user_id = tm.user_id
  cross join lateral (select private.is_commissioner() or tm.user_id = (select auth.uid()) as full_view) v
  where tm.team_id = p_team and private.is_member()
  order by p.display_name nulls last, tm.user_id
$$;
revoke execute on function public.team_contacts(text) from public, anon;
grant execute on function public.team_contacts(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Direct messages
-- ---------------------------------------------------------------------------
create table public.dm_conversations (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('user', 'team', 'trade')),
  teams text[] not null default '{}',          -- the current owners of these teams take part
  pair_key text not null unique,               -- one conversation per pair / person+team / trade
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  reported_at timestamptz,
  reported_by uuid references public.profiles (id) on delete set null,
  report_reason text check (char_length(report_reason) <= 500)
);
create table public.dm_members (
  conversation_id bigint not null references public.dm_conversations (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  primary key (conversation_id, user_id)
);
create index dm_members_user_idx on public.dm_members (user_id);
create table public.dm_messages (
  id bigint generated always as identity primary key,
  conversation_id bigint not null references public.dm_conversations (id) on delete cascade,
  author_id uuid references public.profiles (id) on delete set null,
  author_team text references public.teams (id),
  is_bot boolean not null default false,
  body text not null default '' check (char_length(body) <= 2000),
  images jsonb not null default '[]' check (jsonb_typeof(images) = 'array' and jsonb_array_length(images) <= 4),
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  check (char_length(btrim(body)) > 0 or jsonb_array_length(images) > 0)
);
create index dm_messages_conv_idx on public.dm_messages (conversation_id, id desc);
create table public.dm_reads (
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  conversation_id bigint not null references public.dm_conversations (id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (user_id, conversation_id)
);

-- Am I in this conversation? (named member, or a current owner of one of its teams)
create function private.dm_participant(p_conv bigint) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.dm_members m where m.conversation_id = p_conv and m.user_id = (select auth.uid()))
      or exists (select 1 from public.dm_conversations c join public.team_managers tm on tm.team_id = any (c.teams)
                 where c.id = p_conv and tm.user_id = (select auth.uid()))
$$;
-- ...or the commissioner, while it's reported.
create function private.dm_can_read(p_conv bigint) returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.dm_participant(p_conv)
      or (private.is_commissioner() and exists (select 1 from public.dm_conversations c where c.id = p_conv and c.reported_at is not null))
$$;

alter table public.dm_conversations enable row level security;
alter table public.dm_members enable row level security;
alter table public.dm_messages enable row level security;
alter table public.dm_reads enable row level security;
create policy "participants (commissioner: reported only)" on public.dm_conversations for select to authenticated using (private.dm_can_read(id));
create policy "participants read members" on public.dm_members for select to authenticated using (private.dm_can_read(conversation_id));
create policy "participants read messages" on public.dm_messages for select to authenticated using (private.dm_can_read(conversation_id));
create policy "participants post" on public.dm_messages for insert to authenticated
  with check (private.is_member() and private.dm_participant(conversation_id));
create policy "author edits" on public.dm_messages for update to authenticated
  using (author_id = (select auth.uid())) with check (author_id = (select auth.uid()));
create policy "author deletes; commissioner on reported" on public.dm_messages for delete to authenticated
  using (author_id = (select auth.uid()) or (private.is_commissioner() and private.dm_can_read(conversation_id)));
create policy "own reads" on public.dm_reads for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()) and private.dm_participant(conversation_id));
revoke all on public.dm_conversations, public.dm_members, public.dm_messages, public.dm_reads from anon, authenticated;
grant select on public.dm_conversations, public.dm_members to authenticated;
grant select, insert, update, delete on public.dm_messages to authenticated;
grant select, insert, update, delete on public.dm_reads to authenticated;
grant all on public.dm_conversations, public.dm_members, public.dm_messages, public.dm_reads to service_role;

create function private.dm_rate_limit() returns void
language plpgsql security definer set search_path = ''
as $$
declare m timestamptz;
begin
  select cm.until into m from public.chat_mutes cm where cm.user_id = (select auth.uid()) and cm.until > now();
  if m is not null then
    raise exception 'You''re muted until %', to_char(m at time zone 'America/New_York', 'FMHH12:MI AM') using errcode = '42501';
  end if;
  if (select count(*) from public.dm_messages d where d.author_id = (select auth.uid()) and d.created_at > now() - interval '10 seconds') >= 20 then
    raise exception 'Slow down: 20 messages per 10 seconds' using errcode = '54000';
  end if;
end;
$$;

create function private.guard_dm_message() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if tg_op <> 'DELETE' and not private.board_images_ok(new.images) then
    raise exception 'Images must be https links or uploads (up to 4)' using errcode = '22023';
  end if;
  if private.is_privileged() then return coalesce(new, old); end if;
  if tg_op = 'INSERT' then
    perform private.dm_rate_limit();
    new.author_id := (select auth.uid());
    new.author_team := private.my_team();
    new.is_bot := false;
    new.created_at := now(); new.edited_at := null;
    return new;
  elsif tg_op = 'UPDATE' then
    if new.id <> old.id or new.conversation_id <> old.conversation_id or new.author_id is distinct from old.author_id
       or new.author_team is distinct from old.author_team or new.is_bot <> old.is_bot or new.created_at <> old.created_at then
      raise exception 'Only the text and images of a message can change' using errcode = '42501';
    end if;
    new.edited_at := case when new.body <> old.body or new.images <> old.images then now() else old.edited_at end;
    return new;
  end if;
  return old;
end;
$$;
create trigger guard_dm_message before insert or update or delete on public.dm_messages
  for each row execute function private.guard_dm_message();

create function private.dm_touch() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  update public.dm_conversations c set last_message_at = new.created_at where c.id = new.conversation_id;
  return null;
end;
$$;
create trigger dm_touch after insert on public.dm_messages for each row execute function private.dm_touch();

-- Open (find or create) a conversation: with a person (p_user) or with a team's owners (p_team).
create function public.dm_open(p_user uuid default null, p_team text default null) returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  k text;
  c bigint;
begin
  if me is null or not private.is_member() then raise exception 'Direct messages are for league members' using errcode = '42501'; end if;
  if (p_user is null) = (p_team is null) then raise exception 'Message a person or a team' using errcode = '22023'; end if;
  if p_user is not null then
    if p_user = me then raise exception 'That''s you' using errcode = '22023'; end if;
    if not exists (select 1 from public.team_managers tm where tm.user_id = p_user)
       and not exists (select 1 from public.profiles p where p.id = p_user and p.is_commissioner) then
      raise exception 'That person isn''t in the league' using errcode = '22023';
    end if;
    k := 'u:' || least(me::text, p_user::text) || ':' || greatest(me::text, p_user::text);
  else
    if not exists (select 1 from public.team_managers tm where tm.team_id = p_team) then raise exception 'That team has no owners yet' using errcode = '22023'; end if;
    if private.manages_team(p_team) then raise exception 'That''s your own team' using errcode = '22023'; end if;
    k := 't:' || me::text || ':' || p_team;
  end if;
  select id into c from public.dm_conversations where pair_key = k;
  if c is not null then return c; end if;
  insert into public.dm_conversations (kind, teams, pair_key, created_by)
  values (case when p_user is null then 'team' else 'user' end, case when p_team is null then '{}' else array[p_team] end, k, me)
  on conflict (pair_key) do nothing returning id into c;
  if c is null then select id into c from public.dm_conversations where pair_key = k; return c; end if;
  insert into public.dm_members (conversation_id, user_id) values (c, me);
  if p_user is not null then insert into public.dm_members (conversation_id, user_id) values (c, p_user); end if;
  return c;
end;
$$;

-- B5 Bot notice in a conversation.
create function private.dm_bot_post(p_conv bigint, p_body text) returns bigint
language plpgsql security definer set search_path = ''
as $$
declare i bigint;
begin
  insert into public.dm_messages (conversation_id, is_bot, body) values (p_conv, true, left(p_body, 2000)) returning id into i;
  return i;
end;
$$;

-- Report: shares the conversation with the commissioner (until he resolves it). Audited.
create function public.dm_report(p_conv bigint, p_reason text default null) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.dm_participant(p_conv) then raise exception 'You''re not in that conversation' using errcode = '42501'; end if;
  update public.dm_conversations set reported_at = now(), reported_by = (select auth.uid()), report_reason = nullif(btrim(coalesce(p_reason, '')), '')
   where id = p_conv;
  perform private.dm_bot_post(p_conv, '🚩 This conversation was reported to the commissioner, who can now read it.');
  insert into public.audit_log (actor, action, details) values ((select auth.uid()), 'dm:report', jsonb_build_object('conversation', p_conv, 'reason', p_reason));
end;
$$;
create function public.dm_resolve(p_conv bigint) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.is_commissioner() then raise exception 'Only the commissioner resolves reports' using errcode = '42501'; end if;
  update public.dm_conversations set reported_at = null, reported_by = null, report_reason = null where id = p_conv and reported_at is not null;
  if not found then raise exception 'That conversation isn''t reported' using errcode = '22023'; end if;
  perform private.dm_bot_post(p_conv, '✅ The commissioner closed the report; the conversation is private again.');
  insert into public.audit_log (actor, action, details) values ((select auth.uid()), 'dm:resolve', jsonb_build_object('conversation', p_conv));
end;
$$;

-- Unread per conversation: others' messages newer than my last read.
create function public.dm_unread() returns table (conversation_id bigint, unread int)
language sql stable security definer set search_path = ''
as $$
  select c.id, (select count(*)::int from public.dm_messages m
                where m.conversation_id = c.id and m.author_id is distinct from (select auth.uid())
                  and m.created_at > coalesce((select r.read_at from public.dm_reads r where r.conversation_id = c.id and r.user_id = (select auth.uid())), '-infinity'))
  from public.dm_conversations c
  where private.dm_participant(c.id)
$$;

-- Images: private bucket dm-images; uploads into your own folder; readable by the uploader and by
-- whoever can read a message that uses it.
create function private.dm_image_visible(p_name text) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.dm_messages m where m.images ? ('storage:' || p_name) and private.dm_can_read(m.conversation_id))
$$;
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('dm-images', 'dm-images', false, 5242880, array['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
    on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
    create policy "dm images: uploader or conversation" on storage.objects for select to authenticated
      using (bucket_id = 'dm-images' and ((storage.foldername(name))[1] = (select auth.uid())::text or private.dm_image_visible(name)));
    create policy "dm images: members upload to their own folder" on storage.objects for insert to authenticated
      with check (bucket_id = 'dm-images' and private.is_member()
                  and (storage.foldername(name))[1] = (select auth.uid())::text
                  and lower(storage.extension(name)) in ('png', 'jpg', 'jpeg', 'gif', 'webp'));
    create policy "dm images: uploader deletes" on storage.objects for delete to authenticated
      using (bucket_id = 'dm-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
  end if;
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.dm_messages, public.dm_conversations;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Draft picks (future picks are tradable)
-- ---------------------------------------------------------------------------
create table public.draft_picks (
  id bigint generated always as identity primary key,
  season int not null,
  round int not null check (round between 1 and 40),
  original_team text not null references public.teams (id),
  owner_team text not null references public.teams (id),
  used boolean not null default false,
  unique (season, round, original_team)
);
alter table public.draft_picks enable row level security;
create policy "anyone reads" on public.draft_picks for select to anon, authenticated using (true);
revoke all on public.draft_picks from anon, authenticated;
grant select on public.draft_picks to anon, authenticated;
grant all on public.draft_picks to service_role;

-- ---------------------------------------------------------------------------
-- Trades
-- ---------------------------------------------------------------------------
alter table public.season_settings add column trades jsonb not null default '{}';
update public.season_settings set trades = '{"live": false}' where season = 2026;

create function private.trade_settings(p_season int) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select '{"live": false, "deadlineWeek": 12, "expireDays": 7, "pickSeasons": 1, "draftRounds": 18}'::jsonb
         || coalesce((select s.trades from public.season_settings s where s.season = p_season), '{}'::jsonb)
$$;

-- Picks for a draft season, one per round per team (idempotent).
create function private.ensure_draft_picks(p_season int, p_rounds int default 18) returns int
language plpgsql security definer set search_path = ''
as $$
declare n int;
begin
  insert into public.draft_picks (season, round, original_team, owner_team)
  select p_season, r, t.id, t.id from public.teams t cross join generate_series(1, p_rounds) r
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end;
$$;
select private.ensure_draft_picks(2027);

alter table public.transactions drop constraint transactions_via_check;
alter table public.transactions add constraint transactions_via_check check (via in ('free_agent', 'waiver', 'commissioner', 'mfl', 'trade'));
alter table public.transactions add column trade_id bigint;

create table public.trades (
  id bigint generated always as identity primary key,
  season int not null,
  from_team text not null references public.teams (id),
  to_team text not null references public.teams (id),
  give_players text[] not null default '{}',     -- from_team -> to_team
  get_players text[] not null default '{}',      -- to_team -> from_team
  give_picks bigint[] not null default '{}',
  get_picks bigint[] not null default '{}',
  from_drops text[] not null default '{}',
  to_drops text[] not null default '{}',
  note text check (char_length(note) <= 500),
  status text not null default 'proposed' check (status in ('proposed', 'accepted', 'approved', 'rejected', 'declined', 'withdrawn', 'expired')),
  test boolean not null,
  commissioner_party boolean not null default false,
  conversation_id bigint references public.dm_conversations (id),
  proposed_by uuid references public.profiles (id) on delete set null,
  proposed_at timestamptz not null default now(),
  expires_at timestamptz not null,
  responded_by uuid references public.profiles (id) on delete set null,
  responded_at timestamptz,
  decided_by uuid references public.profiles (id) on delete set null,
  decided_at timestamptz,
  decision_note text check (char_length(decision_note) <= 500),
  check (from_team <> to_team),
  check (cardinality(give_players) + cardinality(give_picks) + cardinality(get_players) + cardinality(get_picks) > 0)
);
create index trades_teams_idx on public.trades (season, from_team, to_team, status);
alter table public.transactions add constraint transactions_trade_fk foreign key (trade_id) references public.trades (id);
alter table public.trades enable row level security;
-- Both teams' owners and the commissioner; approved trades are the league's.
create policy "parties, commissioner, or approved" on public.trades for select to authenticated
  using (private.manages_team(from_team) or private.manages_team(to_team) or private.is_commissioner() or (status = 'approved' and private.is_member()));
revoke all on public.trades from anon, authenticated;
grant select on public.trades to authenticated;
grant all on public.trades to service_role;

create function private.team_name(p_team text) returns text
language sql stable security definer set search_path = ''
as $$ select coalesce((select t.name from public.teams t where t.id = p_team), p_team) $$;

create function private.trade_items(p_players text[], p_picks bigint[]) returns text
language sql stable security definer set search_path = ''
as $$
  select coalesce(nullif(array_to_string(
    array(select coalesce(np.name, x) || coalesce(' (' || np.position || ')', '') from unnest(p_players) with ordinality u(x, o) left join public.nfl_players np on np.id = u.x order by o)
    || array(select dp.season || ' round ' || dp.round || ' pick' || case when dp.original_team <> dp.owner_team then ' (from ' || private.team_name(dp.original_team) || ')' else '' end
             from unnest(p_picks) with ordinality u(x, o) join public.draft_picks dp on dp.id = u.x order by o), ', '), ''), 'nothing')
$$;

create function private.trade_summary(t public.trades) returns text
language sql stable security definer set search_path = ''
as $$
  select private.team_name(t.from_team) || ' get ' || private.trade_items(t.get_players, t.get_picks) || '; '
      || private.team_name(t.to_team) || ' get ' || private.trade_items(t.give_players, t.give_picks)
      || case when cardinality(t.from_drops) > 0 then '. ' || private.team_name(t.from_team) || ' drop ' || private.trade_items(t.from_drops, '{}') else '' end
      || case when cardinality(t.to_drops) > 0 then '. ' || private.team_name(t.to_team) || ' drop ' || private.trade_items(t.to_drops, '{}') else '' end
$$;

-- The deadline: kickoff of the deadline week's first game (null = no games scheduled yet).
create function private.trade_deadline(p_season int) returns timestamptz
language sql stable security definer set search_path = ''
as $$
  select min(g.kickoff) from public.nfl_games g
  where g.season = p_season and g.week = (private.trade_settings(p_season) ->> 'deadlineWeek')::int
$$;

-- Every rule a trade must pass now. p_need_to: check the receiving team's roster size too (from
-- acceptance on). Raises with a readable reason.
create function private.trade_check(t public.trades, p_need_to boolean) returns void
language plpgsql stable security definer set search_path = ''
as $$
declare
  ws jsonb := private.waiver_settings(t.season);
  maxr int := (ws ->> 'rosterMax')::int;
  dl timestamptz := private.trade_deadline(t.season);
  p text;
  pk record;
  side text;
  n int;
begin
  if dl is not null and now() >= dl then
    raise exception 'The trade deadline has passed (week % kickoff, %)', private.trade_settings(t.season) ->> 'deadlineWeek',
      to_char(dl at time zone 'America/New_York', 'Mon FMDD FMHH12:MI AM') using errcode = '42501';
  end if;
  if ws ->> 'closeAt' is not null and now() >= (ws ->> 'closeAt')::timestamptz then
    raise exception 'The season''s transaction period is over' using errcode = '42501';
  end if;
  foreach p in array t.give_players || t.from_drops loop
    if private.owner_of(t.season, p) is distinct from t.from_team then
      raise exception '% isn''t on % anymore', coalesce((select name from public.nfl_players where id = p), p), private.team_name(t.from_team) using errcode = '22023';
    end if;
  end loop;
  foreach p in array t.get_players || t.to_drops loop
    if private.owner_of(t.season, p) is distinct from t.to_team then
      raise exception '% isn''t on % anymore', coalesce((select name from public.nfl_players where id = p), p), private.team_name(t.to_team) using errcode = '22023';
    end if;
  end loop;
  if t.from_drops && t.give_players or t.to_drops && t.get_players then
    raise exception 'A player can''t be both traded and dropped' using errcode = '22023';
  end if;
  foreach p in array t.give_players || t.get_players || t.from_drops || t.to_drops loop
    if private.player_kickoff_in_week(t.season, p, now()) is not null then
      raise exception '% is locked: his game has started. He can be traded after the week''s last game.', coalesce((select name from public.nfl_players where id = p), p) using errcode = '42501';
    end if;
  end loop;
  for pk in select dp.*, (dp.id = any (t.give_picks)) as giving from public.draft_picks dp where dp.id = any (t.give_picks || t.get_picks) loop
    if pk.used then raise exception 'The % round % pick has been used', pk.season, pk.round using errcode = '22023'; end if;
    side := case when pk.giving then t.from_team else t.to_team end;
    if pk.owner_team <> side then
      raise exception 'The % round % pick (%) isn''t owned by %', pk.season, pk.round, private.team_name(pk.original_team),
        private.team_name(side) using errcode = '22023';
    end if;
  end loop;
  if (select count(*) from public.draft_picks dp where dp.id = any (t.give_picks || t.get_picks)) <> cardinality(t.give_picks || t.get_picks) then
    raise exception 'Unknown draft pick' using errcode = '22023';
  end if;
  n := private.roster_size(t.season, t.from_team) - cardinality(t.give_players) + cardinality(t.get_players) - cardinality(t.from_drops);
  if n > maxr then
    raise exception '% would have % players (max %): add % drop%', private.team_name(t.from_team), n, maxr, n - maxr, case when n - maxr > 1 then 's' else '' end using errcode = '23514';
  end if;
  if p_need_to then
    n := private.roster_size(t.season, t.to_team) - cardinality(t.get_players) + cardinality(t.give_players) - cardinality(t.to_drops);
    if n > maxr then
      raise exception '% would have % players (max %): add % drop%', private.team_name(t.to_team), n, maxr, n - maxr, case when n - maxr > 1 then 's' else '' end using errcode = '23514';
    end if;
  end if;
end;
$$;

create function private.trade_label(t public.trades) returns text
language sql immutable set search_path = ''
as $$ select case when t.test then '[TEST trade: MFL is official for ' || t.season || '] ' else '' end $$;

create function private.trade_commish_party(p_from text, p_to text) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.team_managers tm join public.profiles p on p.id = tm.user_id
                 where tm.team_id in (p_from, p_to) and p.is_commissioner)
$$;

create function public.trade_propose(p_season int, p_from text, p_to text, p_give text[] default '{}', p_get text[] default '{}',
  p_give_picks bigint[] default '{}', p_get_picks bigint[] default '{}', p_drops text[] default '{}', p_note text default null) returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  s jsonb := private.trade_settings(p_season);
  t public.trades;
  c bigint;
begin
  if not private.manages_team(p_from) then raise exception 'You can only propose trades for your own team' using errcode = '42501'; end if;
  if not exists (select 1 from public.teams where id = p_to) or p_to = p_from then raise exception 'Pick another team' using errcode = '22023'; end if;
  t.season := p_season; t.from_team := p_from; t.to_team := p_to;
  t.give_players := coalesce(p_give, '{}'); t.get_players := coalesce(p_get, '{}');
  t.give_picks := coalesce(p_give_picks, '{}'); t.get_picks := coalesce(p_get_picks, '{}');
  t.from_drops := coalesce(p_drops, '{}'); t.to_drops := '{}';
  if cardinality(t.give_players) + cardinality(t.give_picks) + cardinality(t.get_players) + cardinality(t.get_picks) = 0 then
    raise exception 'Add at least one player or pick' using errcode = '22023';
  end if;
  perform private.trade_check(t, false);
  insert into public.trades (season, from_team, to_team, give_players, get_players, give_picks, get_picks, from_drops, note, test,
                             commissioner_party, proposed_by, expires_at)
  values (p_season, p_from, p_to, t.give_players, t.get_players, t.give_picks, t.get_picks, t.from_drops, nullif(btrim(coalesce(p_note, '')), ''),
          not coalesce((s ->> 'live')::boolean, false), private.trade_commish_party(p_from, p_to), (select auth.uid()),
          now() + make_interval(days => (s ->> 'expireDays')::int))
  returning * into t;
  insert into public.dm_conversations (kind, teams, pair_key, created_by) values ('trade', array[p_from, p_to], 'trade:' || t.id, (select auth.uid()))
  returning id into c;
  update public.trades set conversation_id = c where id = t.id;
  perform private.dm_bot_post(c, private.trade_label(t) || '🔁 Trade proposed by ' || coalesce((select display_name from public.profiles where id = (select auth.uid())), private.team_name(p_from))
    || ' (' || private.team_name(p_from) || '): ' || private.trade_summary(t) || '.' || coalesce(' Note: ' || t.note, '')
    || ' Expires ' || to_char(t.expires_at at time zone 'America/New_York', 'Dy Mon FMDD FMHH12:MI AM') || ' ET.');
  return t.id;
end;
$$;

-- Lazy expiry (also run by the hourly job).
create function private.expire_trades() returns int
language plpgsql security definer set search_path = ''
as $$
declare t public.trades; n int := 0;
begin
  for t in update public.trades set status = 'expired' where status = 'proposed' and expires_at <= now() returning * loop
    perform private.dm_bot_post(t.conversation_id, private.trade_label(t) || '⌛ The trade expired without an answer.');
    n := n + 1;
  end loop;
  return n;
end;
$$;

create function public.trade_respond(p_trade bigint, p_accept boolean, p_drops text[] default '{}') returns void
language plpgsql security definer set search_path = ''
as $$
declare t public.trades;
begin
  perform private.expire_trades();
  select * into t from public.trades where id = p_trade for update;
  if t.id is null or not private.manages_team(t.to_team) then raise exception 'Only the other team''s owners can answer this trade' using errcode = '42501'; end if;
  if t.status <> 'proposed' then raise exception 'This trade is %', t.status using errcode = '22023'; end if;
  if p_accept then
    t.to_drops := coalesce(p_drops, '{}');
    perform private.trade_check(t, true);
    update public.trades set status = 'accepted', to_drops = t.to_drops, responded_by = (select auth.uid()), responded_at = now(),
      commissioner_party = private.trade_commish_party(t.from_team, t.to_team) where id = t.id returning * into t;
    perform private.dm_bot_post(t.conversation_id, private.trade_label(t) || '🤝 ' || private.team_name(t.to_team) || ' accepted: ' || private.trade_summary(t)
      || '. Waiting for the commissioner''s approval' || case when t.commissioner_party then ' (the commissioner is a party: flagged and audited)' else '' end || '.');
  else
    update public.trades set status = 'declined', responded_by = (select auth.uid()), responded_at = now() where id = t.id;
    perform private.dm_bot_post(t.conversation_id, private.trade_label(t) || '❌ ' || private.team_name(t.to_team) || ' declined the trade.');
  end if;
end;
$$;

create function public.trade_withdraw(p_trade bigint) returns void
language plpgsql security definer set search_path = ''
as $$
declare t public.trades;
begin
  select * into t from public.trades where id = p_trade for update;
  if t.id is null or not private.manages_team(t.from_team) then raise exception 'Only the proposing team''s owners can withdraw it' using errcode = '42501'; end if;
  if t.status not in ('proposed', 'accepted') then raise exception 'This trade is %', t.status using errcode = '22023'; end if;
  update public.trades set status = 'withdrawn', responded_by = coalesce(responded_by, (select auth.uid())), responded_at = coalesce(responded_at, now()) where id = t.id;
  perform private.dm_bot_post(t.conversation_id, private.trade_label(t) || '↩️ ' || private.team_name(t.from_team) || ' withdrew the trade.');
end;
$$;

create function public.trade_decide(p_trade bigint, p_approve boolean, p_note text default null) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  t public.trades;
  own boolean;
  p text;
  thread bigint;
  msg text;
begin
  if not private.is_commissioner() then raise exception 'Only the commissioner approves trades' using errcode = '42501'; end if;
  select * into t from public.trades where id = p_trade for update;
  if t.id is null or t.status <> 'accepted' then raise exception 'Only accepted trades wait for approval' using errcode = '22023'; end if;
  own := private.manages_team(t.from_team) or private.manages_team(t.to_team);
  if p_approve then
    perform private.trade_check(t, true);
    if not t.test then
      perform 1 from public.teams where id in (t.from_team, t.to_team) for update;
      delete from public.roster_entries r where r.season = t.season and r.player_id = any (t.from_drops || t.to_drops);
      update public.roster_entries r set team_id = t.to_team, acquired = 'Trade' where r.season = t.season and r.player_id = any (t.give_players);
      update public.roster_entries r set team_id = t.from_team, acquired = 'Trade' where r.season = t.season and r.player_id = any (t.get_players);
      update public.draft_picks dp set owner_team = t.to_team where dp.id = any (t.give_picks);
      update public.draft_picks dp set owner_team = t.from_team where dp.id = any (t.get_picks);
      insert into public.transactions (season, team_id, type, status, players_in, players_out, partner_team_id, via, trade_id, created_by, decided_by, decided_at, note)
      values (t.season, t.from_team, 'trade', 'processed', t.get_players, t.give_players, t.to_team, 'trade', t.id, t.proposed_by, (select auth.uid()), now(),
              nullif(concat_ws('; ', case when cardinality(t.get_picks) > 0 then 'picks in: ' || private.trade_items('{}', t.get_picks) end,
                                     case when cardinality(t.give_picks) > 0 then 'picks out: ' || private.trade_items('{}', t.give_picks) end), ''));
      if cardinality(t.from_drops) > 0 then
        insert into public.transactions (season, team_id, type, status, players_out, via, trade_id, created_by, decided_at)
        values (t.season, t.from_team, 'drop', 'processed', t.from_drops, 'trade', t.id, t.proposed_by, now());
      end if;
      if cardinality(t.to_drops) > 0 then
        insert into public.transactions (season, team_id, type, status, players_out, via, trade_id, created_by, decided_at)
        values (t.season, t.to_team, 'drop', 'processed', t.to_drops, 'trade', t.id, t.responded_by, now());
      end if;
    end if;
    update public.trades set status = 'approved', decided_by = (select auth.uid()), decided_at = now(), decision_note = nullif(btrim(coalesce(p_note, '')), '') where id = t.id returning * into t;
    perform private.dm_bot_post(t.conversation_id, private.trade_label(t) || '✅ Approved by the commissioner: ' || private.trade_summary(t) || '.'
      || coalesce(' Note: ' || t.decision_note, '') || case when t.test then ' (Test: rosters unchanged.)' else ' Rosters are updated.' end);
    if not t.test then
      msg := '🔁 **Trade completed.** ' || private.trade_summary(t) || '.' || coalesce(E'\n\nCommissioner''s note: ' || t.decision_note, '');
      insert into public.board_threads (title, is_bot, source_key) values (left('Trade: ' || private.team_name(t.from_team) || ' and ' || private.team_name(t.to_team), 120), true, 'trade:' || t.id)
      returning id into thread;
      insert into public.board_posts (thread_id, is_bot, is_opener, body) values (thread, true, true, left(msg, 10000));
    end if;
  else
    update public.trades set status = 'rejected', decided_by = (select auth.uid()), decided_at = now(), decision_note = nullif(btrim(coalesce(p_note, '')), '') where id = t.id returning * into t;
    perform private.dm_bot_post(t.conversation_id, private.trade_label(t) || '🚫 Rejected by the commissioner.' || coalesce(' Note: ' || t.decision_note, ''));
  end if;
  insert into public.audit_log (actor, action, season, details)
  values ((select auth.uid()), case when own then 'own_team:' else '' end || 'trades:' || case when p_approve then 'approve' else 'reject' end, t.season,
          jsonb_build_object('trade', t.id, 'from', t.from_team, 'to', t.to_team, 'test', t.test, 'commissioner_party', t.commissioner_party or own,
                             'note', t.decision_note, 'summary', private.trade_summary(t)));
end;
$$;

-- What can be traded (for the trade builder): a team's players with lock status, and its picks.
create function public.trade_assets(p_season int, p_team text)
returns table (kind text, id text, name text, pos text, nfl_team text, locked_until timestamptz, label text)
language sql stable security definer set search_path = ''
as $$
  select 'player', r.player_id, np.name, np.position, np.nfl_team,
         case when private.player_kickoff_in_week(p_season, r.player_id, now()) is not null then
           (select max(g.kickoff) + make_interval(hours => (private.waiver_settings(p_season) ->> 'lockAfterLastKickoffHours')::int)
              from public.nfl_games g where g.season = p_season
               and g.week = (select g2.week from public.nfl_games g2 where g2.season = p_season and coalesce(np.nfl_team, substr(r.player_id, 5)) in (g2.home, g2.away) and g2.kickoff <= now() order by g2.kickoff desc limit 1)) end,
         null
  from public.roster_entries r left join public.nfl_players np on np.id = r.player_id
  where r.season = p_season and r.team_id = p_team and private.is_member()
  union all
  select 'pick', dp.id::text, null, null, null, null,
         dp.season || ' round ' || dp.round || case when dp.original_team <> dp.owner_team then ' (from ' || private.team_name(dp.original_team) || ')' else '' end
  from public.draft_picks dp
  where dp.owner_team = p_team and not dp.used and private.is_member()
    and dp.season > p_season and dp.season <= p_season + (private.trade_settings(p_season) ->> 'pickSeasons')::int
  order by 1 desc, 4, 3, 7
$$;

-- Function grants: the checked entry points to members; private helpers to nobody else.
revoke execute on function public.dm_open(uuid, text), public.dm_report(bigint, text), public.dm_resolve(bigint), public.dm_unread(),
  public.trade_propose(int, text, text, text[], text[], bigint[], bigint[], text[], text), public.trade_respond(bigint, boolean, text[]),
  public.trade_withdraw(bigint), public.trade_decide(bigint, boolean, text), public.trade_assets(int, text) from public, anon;
grant execute on function public.dm_open(uuid, text), public.dm_report(bigint, text), public.dm_resolve(bigint), public.dm_unread(),
  public.trade_propose(int, text, text, text[], text[], bigint[], bigint[], text[], text), public.trade_respond(bigint, boolean, text[]),
  public.trade_withdraw(bigint), public.trade_decide(bigint, boolean, text), public.trade_assets(int, text) to authenticated, service_role;
revoke execute on function private.guard_owner_contact(), private.dm_participant(bigint), private.dm_can_read(bigint), private.dm_rate_limit(),
  private.guard_dm_message(), private.dm_touch(), private.dm_bot_post(bigint, text), private.dm_image_visible(text),
  private.trade_settings(int), private.ensure_draft_picks(int, int), private.team_name(text), private.trade_items(text[], bigint[]),
  private.trade_summary(public.trades), private.trade_deadline(int), private.trade_check(public.trades, boolean), private.trade_label(public.trades),
  private.trade_commish_party(text, text), private.expire_trades() from public, anon;
grant execute on function private.dm_participant(bigint), private.dm_can_read(bigint), private.dm_image_visible(text), private.guard_owner_contact(),
  private.guard_dm_message(), private.dm_rate_limit() to authenticated;
grant execute on function private.ensure_draft_picks(int, int), private.expire_trades() to service_role;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    perform cron.schedule('b5-trades-expire', '7 * * * *', 'select private.expire_trades()');
  end if;
end $$;
