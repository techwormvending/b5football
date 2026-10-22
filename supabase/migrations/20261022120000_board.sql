-- Message Board (#board). League members only: every table is readable and writable only by
-- members (private.is_member(): manages a team or is the commissioner). anon has no grants at all.
--   board_threads    title, author, pinned/locked, activity (last post, reply count)
--   board_posts      the opener (is_opener) and replies: plain text with light formatting
--                    (rendered and sanitized by board.js; never HTML) plus up to 4 images
--                    (https URLs, or "storage:<uid>/<uuid>.<ext>" in the private board-images bucket)
--   board_reactions  👍 😂 🔥 💀 🗑️, one of each per person per post
--   board_reads      per member, per thread: when he last read it (unread = newer activity)
--   board_visits     a member's first visit (unread baseline: the 7 days before it)
--   board_settings   B5 Bot toggles (weekly recap, payout awards); commissioner edits
--   board_bot_keys   what the bot has already handled (server jobs only)
-- Guards (triggers) do what policies can't: authors and timestamps are set by the database, a
-- locked thread takes no replies (except the commissioner's), 10 posts a minute per member,
-- authors edit only their own text ("edited" stamp), only the commissioner pins, locks or deletes
-- others' posts, and his deletions of others' posts, pins and locks go to audit_log.
-- B5 Bot posts come from server jobs (service_role): is_bot, no author.

create table public.board_threads (
  id bigint generated always as identity primary key,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  author_id uuid references public.profiles (id) on delete set null,
  author_team text references public.teams (id),
  is_bot boolean not null default false,
  source_key text unique,                   -- bot posts / announcement cross-posts: one thread per key
  pinned boolean not null default false,
  locked boolean not null default false,
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  last_activity_at timestamptz not null default now(),
  last_author_id uuid,
  reply_count int not null default 0
);
create index board_threads_activity_idx on public.board_threads (pinned desc, last_activity_at desc);

create table public.board_posts (
  id bigint generated always as identity primary key,
  thread_id bigint not null references public.board_threads (id) on delete cascade,
  author_id uuid references public.profiles (id) on delete set null,
  author_team text references public.teams (id),
  is_bot boolean not null default false,
  is_opener boolean not null default false,
  body text not null default '' check (char_length(body) <= 10000),
  images jsonb not null default '[]' check (jsonb_typeof(images) = 'array' and jsonb_array_length(images) <= 4),
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  check (char_length(btrim(body)) > 0 or jsonb_array_length(images) > 0)
);
create index board_posts_thread_idx on public.board_posts (thread_id, created_at);
create index board_posts_author_idx on public.board_posts (author_id, created_at desc);
create unique index board_posts_one_opener on public.board_posts (thread_id) where is_opener;

create table public.board_reactions (
  post_id bigint not null references public.board_posts (id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  emoji text not null check (emoji in ('👍', '😂', '🔥', '💀', '🗑️')),
  created_at timestamptz not null default now(),
  primary key (post_id, user_id, emoji)
);

create table public.board_reads (
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  thread_id bigint not null references public.board_threads (id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (user_id, thread_id)
);

create table public.board_visits (
  user_id uuid primary key default auth.uid() references public.profiles (id) on delete cascade,
  first_at timestamptz not null default now()
);

create table public.board_settings (
  id boolean primary key default true check (id),
  auto_recap boolean not null default true,        -- weekly results recap when a week is final
  auto_awards boolean not null default true,       -- payout awards as they become final
  updated_at timestamptz not null default now()
);
insert into public.board_settings default values;

create table public.board_bot_keys (                -- server jobs only (RLS on, no policies)
  key text primary key,                             -- e.g. 'recap:2026:7', 'award:123'
  posted boolean not null,                          -- false = seen while off / on the first run
  at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- RLS: members only
-- ---------------------------------------------------------------------------
alter table public.board_threads enable row level security;
alter table public.board_posts enable row level security;
alter table public.board_reactions enable row level security;
alter table public.board_reads enable row level security;
alter table public.board_visits enable row level security;
alter table public.board_settings enable row level security;
alter table public.board_bot_keys enable row level security;

create policy "members read" on public.board_threads for select to authenticated using (private.is_member());
create policy "members start threads" on public.board_threads for insert to authenticated with check (private.is_member());
create policy "author or commissioner updates" on public.board_threads for update to authenticated
  using (private.is_member() and (author_id = (select auth.uid()) or private.is_commissioner()))
  with check (private.is_member());
create policy "author or commissioner deletes" on public.board_threads for delete to authenticated
  using (private.is_member() and (author_id = (select auth.uid()) or private.is_commissioner()));

create policy "members read" on public.board_posts for select to authenticated using (private.is_member());
create policy "members post" on public.board_posts for insert to authenticated with check (private.is_member());
create policy "author edits" on public.board_posts for update to authenticated
  using (private.is_member() and author_id = (select auth.uid())) with check (author_id = (select auth.uid()));
create policy "author or commissioner deletes" on public.board_posts for delete to authenticated
  using (private.is_member() and (author_id = (select auth.uid()) or private.is_commissioner()));

create policy "members read" on public.board_reactions for select to authenticated using (private.is_member());
create policy "react as yourself" on public.board_reactions for insert to authenticated
  with check (private.is_member() and user_id = (select auth.uid()));
create policy "unreact your own" on public.board_reactions for delete to authenticated
  using (user_id = (select auth.uid()));

create policy "own reads" on public.board_reads for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()) and private.is_member());
create policy "own visit" on public.board_visits for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()) and private.is_member());

create policy "members read" on public.board_settings for select to authenticated using (private.is_member());
create policy "commissioner edits" on public.board_settings for update to authenticated
  using (private.is_commissioner()) with check (private.is_commissioner());

revoke all on public.board_threads, public.board_posts, public.board_reactions, public.board_reads,
  public.board_visits, public.board_settings, public.board_bot_keys from anon, authenticated;
grant select, insert, update, delete on public.board_threads, public.board_posts to authenticated;
grant select, insert, delete on public.board_reactions to authenticated;
grant select, insert, update, delete on public.board_reads, public.board_visits to authenticated;
grant select, update on public.board_settings to authenticated;
grant all on public.board_threads, public.board_posts, public.board_reactions, public.board_reads,
  public.board_visits, public.board_settings, public.board_bot_keys to service_role;

-- ---------------------------------------------------------------------------
-- Guards (run as the caller, so is_privileged() tells server jobs apart)
-- ---------------------------------------------------------------------------
create function private.my_team() returns text
language sql stable security definer set search_path = ''
as $$ select tm.team_id from public.team_managers tm where tm.user_id = (select auth.uid()) order by tm.team_id limit 1 $$;

-- Images: up to 4, each an https URL or an upload in the board-images bucket.
create function private.board_images_ok(p jsonb) returns boolean
language sql immutable set search_path = ''
as $$
  select coalesce(bool_and(jsonb_typeof(e) = 'string' and char_length(e #>> '{}') <= 1000 and (
           (e #>> '{}') ~ '^https://[^\s"''<>\\]{4,}$'
           or (e #>> '{}') ~ '^storage:[0-9a-f-]{36}/[0-9a-f-]{36}\.(png|jpg|jpeg|gif|webp)$')), true)
  from jsonb_array_elements(p) e
$$;

create function private.board_rate_limit() returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if (select count(*) from public.board_posts p
      where p.author_id = (select auth.uid()) and p.created_at > now() - interval '1 minute') >= 10 then
    raise exception 'Slow down: 10 posts a minute' using errcode = '54000';
  end if;
end;
$$;

create function private.guard_board_thread() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if private.is_privileged() then return coalesce(new, old); end if;
  if tg_op = 'INSERT' then
    if new.source_key is not null and not private.is_commissioner() then
      raise exception 'Only the commissioner can cross-post' using errcode = '42501';
    end if;
    if (new.pinned or new.locked) and not private.is_commissioner() then
      raise exception 'Only the commissioner can pin or lock threads' using errcode = '42501';
    end if;
    new.author_id := (select auth.uid());
    new.author_team := private.my_team();
    new.is_bot := false;
    new.created_at := now(); new.edited_at := null;
    new.last_activity_at := now(); new.last_author_id := new.author_id; new.reply_count := 0;
    return new;
  elsif tg_op = 'UPDATE' then
    if new.id <> old.id or new.author_id is distinct from old.author_id or new.author_team is distinct from old.author_team
       or new.is_bot <> old.is_bot or new.source_key is distinct from old.source_key or new.created_at <> old.created_at
       or new.last_activity_at <> old.last_activity_at or new.last_author_id is distinct from old.last_author_id
       or new.reply_count <> old.reply_count then
      raise exception 'Those fields are set by the board' using errcode = '42501';
    end if;
    if (new.pinned <> old.pinned or new.locked <> old.locked) and not private.is_commissioner() then
      raise exception 'Only the commissioner can pin or lock threads' using errcode = '42501';
    end if;
    if new.title <> old.title then
      if old.author_id is distinct from (select auth.uid()) then
        raise exception 'You can only edit your own thread' using errcode = '42501';
      end if;
      new.edited_at := now();
    else
      new.edited_at := old.edited_at;
    end if;
    return new;
  else   -- DELETE: an author can delete his own thread while it has no replies; the commissioner, any
    if not private.is_commissioner() and old.reply_count > 0 then
      raise exception 'This thread has replies: edit your post instead' using errcode = '42501';
    end if;
    return old;
  end if;
end;
$$;
create trigger guard_board_thread before insert or update or delete on public.board_threads
  for each row execute function private.guard_board_thread();

create function private.guard_board_post() returns trigger
language plpgsql set search_path = ''
as $$
declare
  t record;
begin
  if tg_op <> 'DELETE' and not private.board_images_ok(new.images) then
    raise exception 'Images must be https links or board uploads (up to 4)' using errcode = '22023';
  end if;
  if private.is_privileged() then return coalesce(new, old); end if;
  if tg_op = 'INSERT' then
    select th.author_id, th.locked into t from public.board_threads th where th.id = new.thread_id;
    if t.locked and not private.is_commissioner() then
      raise exception 'This thread is locked' using errcode = '42501';
    end if;
    if new.is_opener and t.author_id is distinct from (select auth.uid()) then
      raise exception 'Only the thread''s author writes its first post' using errcode = '42501';
    end if;
    perform private.board_rate_limit();
    new.author_id := (select auth.uid());
    new.author_team := private.my_team();
    new.is_bot := false;
    new.created_at := now(); new.edited_at := null;
    return new;
  elsif tg_op = 'UPDATE' then
    if new.id <> old.id or new.thread_id <> old.thread_id or new.author_id is distinct from old.author_id
       or new.author_team is distinct from old.author_team or new.is_bot <> old.is_bot or new.is_opener <> old.is_opener
       or new.created_at <> old.created_at then
      raise exception 'Only the text and images of a post can change' using errcode = '42501';
    end if;
    new.edited_at := case when new.body <> old.body or new.images <> old.images then now() else old.edited_at end;
    return new;
  else
    -- The opener goes with its thread (delete the thread instead).
    if old.is_opener and exists (select 1 from public.board_threads th where th.id = old.thread_id) then
      raise exception 'Delete the thread to remove its first post' using errcode = '42501';
    end if;
    return old;
  end if;
end;
$$;
create trigger guard_board_post before insert or update or delete on public.board_posts
  for each row execute function private.guard_board_post();

-- Thread activity (newest activity first, unread, reply counts). Definer: it updates fields the
-- thread guard reserves for the board.
create function private.board_post_activity() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    update public.board_threads set last_activity_at = new.created_at, last_author_id = new.author_id,
      reply_count = reply_count + case when new.is_opener then 0 else 1 end
    where id = new.thread_id;
  elsif not old.is_opener then
    update public.board_threads set reply_count = greatest(reply_count - 1, 0) where id = old.thread_id;
  end if;
  return null;
end;
$$;
create trigger board_post_activity after insert or delete on public.board_posts
  for each row execute function private.board_post_activity();

-- Audit: the commissioner deleting someone else's thread or post, pinning or locking.
create function private.audit_board() returns trigger
language plpgsql set search_path = ''
as $$
declare
  o jsonb := to_jsonb(old);
begin
  if private.is_privileged() or not private.is_commissioner() then return null; end if;
  if tg_op = 'DELETE' then
    if old.author_id is not distinct from (select auth.uid()) then return null; end if;
    -- Posts removed along with their thread are covered by the thread's entry.
    if tg_table_name = 'board_posts' and not exists (select 1 from public.board_threads th where th.id = (o ->> 'thread_id')::bigint) then
      return null;
    end if;
    insert into public.audit_log (actor, action, details)
    values ((select auth.uid()), 'board:' || tg_table_name || ':delete', jsonb_build_object('old', o));
  elsif new.pinned <> old.pinned or new.locked <> old.locked then
    insert into public.audit_log (actor, action, details)
    values ((select auth.uid()), 'board:threads:' || case when new.pinned <> old.pinned then (case when new.pinned then 'pin' else 'unpin' end)
                                                          else (case when new.locked then 'lock' else 'unlock' end) end,
            jsonb_build_object('thread', old.id, 'title', old.title));
  end if;
  return null;
end;
$$;
create trigger audit_board_threads after update or delete on public.board_threads
  for each row execute function private.audit_board();
create trigger audit_board_posts after delete on public.board_posts
  for each row execute function private.audit_board();

revoke execute on function private.my_team(), private.board_images_ok(jsonb), private.board_rate_limit(),
  private.guard_board_thread(), private.guard_board_post(), private.board_post_activity(), private.audit_board()
  from public, anon;
grant execute on function private.my_team(), private.board_images_ok(jsonb), private.board_rate_limit() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- RPCs (security invoker: RLS and the guards apply as the caller)
-- ---------------------------------------------------------------------------
-- New thread = thread + its first post, in one transaction. p_source_key: the commissioner's
-- announcement cross-posts (one thread per announcement).
create function public.board_new_thread(p_title text, p_body text, p_images jsonb default '[]', p_source_key text default null)
returns bigint
language plpgsql set search_path = ''
as $$
declare
  t bigint;
begin
  insert into public.board_threads (title, source_key) values (btrim(p_title), p_source_key) returning id into t;
  insert into public.board_posts (thread_id, is_opener, body, images) values (t, true, coalesce(p_body, ''), coalesce(p_images, '[]'));
  return t;
end;
$$;

-- Threads with activity newer than your last read (or, for threads you never opened, newer than a
-- week before your first visit), not counting your own posts.
create function public.board_unread() returns int
language sql stable set search_path = ''
as $$
  select count(*)::int
  from public.board_threads t
  left join public.board_reads r on r.thread_id = t.id and r.user_id = (select auth.uid())
  where t.last_author_id is distinct from (select auth.uid())
    and t.last_activity_at > greatest(coalesce(r.read_at, '-infinity'),
          coalesce((select v.first_at from public.board_visits v where v.user_id = (select auth.uid())), now()) - interval '7 days')
$$;
revoke execute on function public.board_new_thread(text, text, jsonb, text), public.board_unread() from public, anon;
grant execute on function public.board_new_thread(text, text, jsonb, text), public.board_unread() to authenticated;

-- ---------------------------------------------------------------------------
-- Image uploads: private bucket board-images (Supabase Storage enforces 5 MB and the image
-- types); members upload into their own folder (<uid>/...), members read (signed URLs), the
-- uploader or the commissioner deletes. Skipped where Storage doesn't exist.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('board-images', 'board-images', false, 5242880, array['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
    on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
    create policy "board images: members read" on storage.objects for select to authenticated
      using (bucket_id = 'board-images' and private.is_member());
    create policy "board images: members upload to their own folder" on storage.objects for insert to authenticated
      with check (bucket_id = 'board-images' and private.is_member()
                  and (storage.foldername(name))[1] = (select auth.uid())::text
                  and lower(storage.extension(name)) in ('png', 'jpg', 'jpeg', 'gif', 'webp'));
    create policy "board images: uploader or commissioner deletes" on storage.objects for delete to authenticated
      using (bucket_id = 'board-images' and ((storage.foldername(name))[1] = (select auth.uid())::text or private.is_commissioner()));
  end if;
end $$;

-- Realtime: new posts, thread activity and reactions reach open pages (RLS applies per subscriber).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.board_threads, public.board_posts, public.board_reactions;
  end if;
end $$;
