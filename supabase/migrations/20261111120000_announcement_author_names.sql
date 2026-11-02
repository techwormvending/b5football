-- Announcement bylines follow the author's display name (2026-11-01).
-- author_name/author_team are snapshots (signed-out visitors can't read profiles); when a person
-- changes his display name or team, his announcements' bylines follow. Also removes the old
-- 2026-10-14 welcome announcement.

create function private.refresh_bylines_for(p_user uuid) returns void
language sql security definer set search_path = ''
as $$
  -- the guard recomputes author_name and author_team from the profile and team on every update
  update public.announcements set updated_at = now() where author_id = p_user
$$;
create function private.bylines_on_profile() returns trigger
language plpgsql security definer set search_path = ''
as $$ begin perform private.refresh_bylines_for(new.id); return null; end; $$;
create function private.bylines_on_team() returns trigger
language plpgsql security definer set search_path = ''
as $$ begin perform private.refresh_bylines_for(case when tg_op = 'DELETE' then old.user_id else new.user_id end); return null; end; $$;
create trigger refresh_announcement_bylines after update of display_name on public.profiles
  for each row execute function private.bylines_on_profile();
create trigger refresh_announcement_bylines after insert or delete on public.team_managers
  for each row execute function private.bylines_on_team();

-- The old 2026-10-14 welcome is removed (the commissioner asked for it to go).
delete from public.announcements where title = 'Welcome to the B5 Fantasy Site' and published_at::date = '2026-10-14';
