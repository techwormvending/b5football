-- The feedback thread didn't exist live after 20261108/20261110 (the welcome announcement's
-- board_thread_id was still empty), so: create it now, as Adam (the administrator who owns Mac
-- Daddies, 0011; else the first administrator, else the first commissioner) with the Admin badge,
-- and link the welcome announcement to it. Idempotent.

create or replace function private.create_feedback_thread() returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  tid bigint;
  who uuid;
  team text;
  role text;
begin
  select id into tid from public.board_threads where source_key = 'site:feedback';
  if tid is not null then return tid; end if;
  select m.user_id into who from public.team_managers m where m.team_id = '0011' and private.holds_role(m.user_id, 'admin') limit 1;
  if who is null then select r.user_id into who from public.user_roles r where r.role = 'admin' order by r.granted_at, r.user_id limit 1; end if;
  if who is null then select r.user_id into who from public.user_roles r where r.role = 'commissioner' order by r.granted_at, r.user_id limit 1; end if;
  if who is null then return null; end if;
  role := case when private.holds_role(who, 'admin') then 'admin' when private.holds_role(who, 'commissioner') then 'commissioner' end;
  select m.team_id into team from public.team_managers m where m.user_id = who order by m.team_id limit 1;
  insert into public.board_threads (title, author_id, author_team, source_key, pinned, last_author_id, posted_as)
  values ('Suggestions & feedback for the new site', who, team, 'site:feedback', true, who, role)
  returning id into tid;
  insert into public.board_posts (thread_id, author_id, author_team, is_opener, body, posted_as)
  values (tid, who, team, true,
    E'This is the new home of the Bridgeville 5. We''re testing it this season, and the hope is that it becomes our official league site for 2027.\n\n'
    || E'**Tell us what you think, right here.** Reply to this thread with your ideas, wishes and anything that doesn''t look right. '
    || E'This is **our** site, built for our league, so if you want it to look or work a certain way, we can make it happen.\n\n'
    || E'Not signed in yet? [Sign in](#account) and get connected to your team.', role);
  return tid;
end;
$$;

do $$
declare fb bigint;
begin
  fb := private.create_feedback_thread();
  if fb is not null then
    update public.announcements set board_thread_id = fb where title = 'Welcome to the new B5 site!' and board_thread_id is null;
  end if;
end $$;
