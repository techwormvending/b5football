-- Announcements have an author and the role they were posted as (2026-11-01).
--
-- Every announcement stores its author (user id) and "posted as" (admin | commissioner | treasurer:
-- a role the author holds when posting). The card's tag and badge come from that choice, never
-- hardcoded, and the card always shows the author's name, team and role badge (author_name and
-- author_team are snapshotted by the database at posting time, so signed-out visitors, who can't read
-- profiles, see them too). Any officer may post; the author or a commissioner/admin edits, pins or
-- deletes. Announcements move from league-data.js into public.announcements; pinning is the row's
-- `pinned` column (replaces public.announcement_pins from 20261108120000).
--
-- Board threads and posts get the same optional posted_as (a badge next to the author), limited to
-- roles the author holds. The welcome announcement (2026-11-01) is Adam's (Mac Daddies) as Admin,
-- and so is its feedback thread.

alter table public.announcements
  add column author_id uuid references public.profiles (id),
  add column author_name text,
  add column author_team text references public.teams (id),
  add column posted_as text check (posted_as in ('admin', 'commissioner', 'treasurer')),
  add column pinned boolean not null default false,
  add column board_thread_id bigint references public.board_threads (id) on delete set null,
  add column updated_at timestamptz not null default now();

create function private.holds_role(p_user uuid, p_role text) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.user_roles r join public.profiles p on p.id = r.user_id
    where r.user_id = p_user and r.role = p_role and not coalesce(p.disabled, false))
$$;

-- Who posted, as what: set and checked by the database. The tag follows posted_as.
create function private.guard_announcement() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare me uuid := (select auth.uid());
begin
  if tg_op = 'INSERT' then
    if me is not null then new.author_id := me; new.created_by := me; end if;   -- server jobs / migrations name the author
    if (new.posted_as is not null or me is not null)   -- server jobs (no signed-in user) may post without a role; definer: is_privileged() would always be true here
       and (new.posted_as is null or new.author_id is null or not private.holds_role(new.author_id, new.posted_as)) then
      raise exception 'Post as a role you hold (Admin, Commissioner or Treasurer)' using errcode = '42501';
    end if;
  else
    if new.author_id is distinct from old.author_id and me is not null then
      raise exception 'The author can''t be changed' using errcode = '42501';
    end if;
    if new.posted_as is distinct from old.posted_as and (new.posted_as is null or not private.holds_role(new.author_id, new.posted_as)) then
      raise exception 'Post as a role the author holds' using errcode = '42501';
    end if;
    if me is not null and new.pinned is distinct from old.pinned and not (private.is_commissioner() or private.is_admin()) then
      raise exception 'Only a commissioner or an administrator pins announcements' using errcode = '42501';
    end if;
  end if;
  if new.posted_as is not null then new.tag := case new.posted_as when 'admin' then 'Admin' when 'commissioner' then 'Commish' else 'Treasurer' end; end if;
  select p.display_name into new.author_name from public.profiles p where p.id = new.author_id;
  select m.team_id into new.author_team from public.team_managers m where m.user_id = new.author_id order by m.team_id limit 1;
  new.updated_at := now();
  return new;
end;
$$;
create trigger guard_announcement before insert or update on public.announcements
  for each row execute function private.guard_announcement();

drop policy "commissioner writes" on public.announcements;
create policy "officers post" on public.announcements for insert to authenticated
  with check (private.is_commissioner() or private.is_admin() or private.is_treasurer());
create policy "author or commissioner/admin edits" on public.announcements for update to authenticated
  using (author_id = (select auth.uid()) or private.is_commissioner() or private.is_admin())
  with check (author_id = (select auth.uid()) or private.is_commissioner() or private.is_admin());
create policy "author or commissioner/admin deletes" on public.announcements for delete to authenticated
  using (author_id = (select auth.uid()) or private.is_commissioner() or private.is_admin());
create policy "officers read drafts" on public.announcements for select to authenticated
  using (published_at is null and (author_id = (select auth.uid()) or private.is_commissioner() or private.is_admin()));
grant insert, update, delete on public.announcements to authenticated;

create function private.audit_announcement() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if (select auth.uid()) is null then return null; end if;
  insert into public.audit_log (actor, action, details)
  values ((select auth.uid()), 'announcements:' || lower(tg_op) ||
      case when tg_op = 'UPDATE' and new.pinned is distinct from old.pinned then case when new.pinned then ':pin' else ':unpin' end else '' end,
    jsonb_build_object('id', coalesce(new.id, old.id), 'title', coalesce(new.title, old.title), 'posted_as', coalesce(new.posted_as, old.posted_as)));
  return null;
end;
$$;
create trigger audit_announcement after insert or update or delete on public.announcements
  for each row execute function private.audit_announcement();

-- Board: an optional role badge on threads and posts, only for a role the author holds.
alter table public.board_threads add column posted_as text check (posted_as in ('admin', 'commissioner', 'treasurer'));
alter table public.board_posts add column posted_as text check (posted_as in ('admin', 'commissioner', 'treasurer'));
create function private.guard_posted_as() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if private.is_privileged() then return new; end if;
  if new.posted_as is not null and (tg_op = 'INSERT' or new.posted_as is distinct from old.posted_as)
     and not private.holds_role((select auth.uid()), new.posted_as) then
    raise exception 'Post as a role you hold' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger guard_posted_as before insert or update of posted_as on public.board_threads for each row execute function private.guard_posted_as();
create trigger guard_posted_as before insert or update of posted_as on public.board_posts for each row execute function private.guard_posted_as();

-- Pins now live on the announcement row.
drop table public.announcement_pins;
drop function private.guard_announcement_pin();
drop function private.audit_announcement_pin();

-- ---- Data (live): the two announcements move here from league-data.js, without emailing everyone ----
do $$
declare adam uuid; com uuid; fb bigint;
begin
  -- Adam: the administrator who owns Mac Daddies (0011); else the first administrator.
  select m.user_id into adam from public.team_managers m where m.team_id = '0011' and private.holds_role(m.user_id, 'admin') limit 1;
  if adam is null then select r.user_id into adam from public.user_roles r where r.role = 'admin' order by r.granted_at limit 1; end if;
  select r.user_id into com from public.user_roles r where r.role = 'commissioner' order by r.granted_at limit 1;
  if adam is null or com is null then return; end if;   -- a fresh test database

  -- The feedback thread and its opener: Adam's, as Admin
  select id into fb from public.board_threads where source_key = 'site:feedback';
  if fb is not null then
    update public.board_threads set author_id = adam, last_author_id = coalesce(last_author_id, adam), is_bot = false, posted_as = 'admin',
      author_team = (select m.team_id from public.team_managers m where m.user_id = adam limit 1) where id = fb;
    update public.board_posts set author_id = adam, is_bot = false, posted_as = 'admin',
      author_team = (select m.team_id from public.team_managers m where m.user_id = adam limit 1) where thread_id = fb and is_opener;
  end if;

  alter table public.announcements disable trigger notify_on_announcement;
  insert into public.announcements (title, body_html, author_id, posted_as, pinned, published_at, created_at)
  values ('Welcome to the B5 Fantasy Site',
    '<p>This is our home base now. Sign in to see your team on the <a href="#myteam">My Team</a> page. Lineups move here for the 2027 season.' ||
    ' Everything else (trash talk, history, rules) lives here too.</p><p>And yes, GIFs finally work.</p>',
    com, 'commissioner', false, '2026-10-14T12:00:00-04:00', '2026-10-14T12:00:00-04:00');
  insert into public.announcements (title, body_html, author_id, posted_as, pinned, board_thread_id, published_at, created_at)
  values ('Welcome to the new B5 site!',
    '<p>This is the new home of the Bridgeville 5. We''re testing it this season, and the hope is that it becomes our official league site for 2027.</p>' ||
    '<p><b>First step:</b> if you haven''t already, <a href="#account">sign in</a> and get connected to your team.</p>' ||
    '<p>Then tell us what you think. Post your ideas, wishes and anything that doesn''t look right on the <a href="#messages/board/key/site:feedback">Message Board</a>.' ||
    ' This is <b>our</b> site, built for our league, so if you want it to look or work a certain way, we can make it happen.</p>',
    adam, 'admin', true, fb, '2026-11-01T12:00:00-04:00', '2026-11-01T12:00:00-04:00');
  alter table public.announcements enable trigger notify_on_announcement;
end $$;
