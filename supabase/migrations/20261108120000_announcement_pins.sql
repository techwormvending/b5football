-- Pinned home-page announcements + the "Suggestions & feedback for the new site" board thread (2026-11-01).
--
-- Announcements live in league-data.js (commissioner-authored HTML). One can be marked `pinned: true`
-- there: it stays first on the Home page, above newer ones. public.announcement_pins lets a
-- commissioner or an administrator unpin it (or pin another) from the Home page without a code
-- change; a row overrides the file's flag. Public read; every change is audited.
--
-- The welcome announcement's feedback thread is created once by private.create_feedback_thread():
-- pinned, posted under the league's commissioner account (the first commissioner by grant time, with
-- his team), source key 'site:feedback'. That key deliberately doesn't start with 'announcement:', so
-- creating it doesn't email every member (an announcement cross-post would). The page links to it by
-- key: #messages/board/key/site:feedback.

create table public.announcement_pins (
  key text primary key check (key ~ '^announcement:[0-9]{4}-[0-9]{2}-[0-9]{2}:[a-z0-9-]{1,60}$'),
  pinned boolean not null,
  updated_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);
alter table public.announcement_pins enable row level security;
create policy "public read" on public.announcement_pins for select to anon, authenticated using (true);
create policy "officers pin" on public.announcement_pins for all to authenticated
  using (private.is_commissioner() or private.is_admin())
  with check (private.is_commissioner() or private.is_admin());
grant select on public.announcement_pins to anon, authenticated;
grant insert, update, delete on public.announcement_pins to authenticated;
grant all on public.announcement_pins to service_role;

-- Who and when are set by the database; every change is in the audit log.
create function private.guard_announcement_pin() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if tg_op <> 'DELETE' then
    new.updated_by := (select auth.uid());
    new.updated_at := now();
  end if;
  return coalesce(new, old);
end;
$$;
create trigger guard_announcement_pin before insert or update or delete on public.announcement_pins
  for each row execute function private.guard_announcement_pin();

create function private.audit_announcement_pin() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if (select auth.uid()) is null then return null; end if;   -- server jobs / SQL editor
  insert into public.audit_log (actor, action, details)
  values ((select auth.uid()),
    case when tg_op = 'DELETE' then 'announcements:pin_reset' when new.pinned then 'announcements:pin' else 'announcements:unpin' end,
    jsonb_build_object('key', coalesce(new.key, old.key)));
  return null;
end;
$$;
create trigger audit_announcement_pin after insert or update or delete on public.announcement_pins
  for each row execute function private.audit_announcement_pin();

-- The feedback thread (idempotent: returns the existing thread if it's already there).
create function private.create_feedback_thread() returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  tid bigint;
  who uuid;
  team text;
begin
  select id into tid from public.board_threads where source_key = 'site:feedback';
  if tid is not null then return tid; end if;
  select r.user_id into who from public.user_roles r join public.profiles p on p.id = r.user_id
    where r.role = 'commissioner' and not coalesce(p.disabled, false) order by r.granted_at, r.user_id limit 1;
  if who is null then return null; end if;
  select m.team_id into team from public.team_managers m where m.user_id = who limit 1;
  insert into public.board_threads (title, author_id, author_team, source_key, pinned, last_author_id)
  values ('Suggestions & feedback for the new site', who, team, 'site:feedback', true, who)
  returning id into tid;
  insert into public.board_posts (thread_id, author_id, author_team, is_opener, body)
  values (tid, who, team, true,
    E'This is the new home of the Bridgeville 5. We''re testing it this season, and the hope is that it becomes our official league site for 2027.\n\n'
    || E'**Tell us what you think, right here.** Reply to this thread with your ideas, wishes and anything that doesn''t look right. '
    || E'This is **our** site, built for our league, so if you want it to look or work a certain way, we can make it happen.\n\n'
    || E'Not signed in yet? [Sign in](#account) and get connected to your team.');
  return tid;
end;
$$;
revoke all on function private.create_feedback_thread() from public;
grant execute on function private.create_feedback_thread() to service_role;

-- Live: create it now (a no-op until the league has a commissioner, e.g. a fresh test database).
select private.create_feedback_thread();
