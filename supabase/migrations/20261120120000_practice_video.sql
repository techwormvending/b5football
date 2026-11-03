-- Draft Room video guide (2026-11-02): "How to create a practice draft", a Scribe embed shown on the
-- Draft Room's list page to commissioners and administrators. The URL is a league setting, so an
-- administrator (or commissioner) can swap in an updated guide without a code change. Only Scribe
-- embed links are accepted (https://scribehow.com/embed/...), so the page never frames anything else.

alter table public.league_settings add column if not exists practice_video_url text
  default 'https://scribehow.com/embed/How_to_Create_a_New_Practice_Draft_on_B5_Football__iD_l2TKMREOYcfUsx13N8w?as=video'
  check (practice_video_url is null or practice_video_url ~ '^https://scribehow\.com/embed/[A-Za-z0-9_.%-]+(\?[A-Za-z0-9_.%=&-]*)?$');
update public.league_settings set practice_video_url = 'https://scribehow.com/embed/How_to_Create_a_New_Practice_Draft_on_B5_Football__iD_l2TKMREOYcfUsx13N8w?as=video'
 where practice_video_url is null;

-- Administrators or commissioners change it (null = hide the guide); audited.
create function public.set_practice_video(p_url text) returns void
language plpgsql security definer set search_path = ''
as $$
declare old text; u text := nullif(btrim(coalesce(p_url, '')), '');
begin
  if not (private.is_admin() or private.is_commissioner()) then raise exception 'Only an administrator or commissioner changes the video guide' using errcode = '42501'; end if;
  if u is not null and u !~ '^https://scribehow\.com/embed/[A-Za-z0-9_.%-]+(\?[A-Za-z0-9_.%=&-]*)?$' then
    raise exception 'Use a Scribe embed link (https://scribehow.com/embed/...)' using errcode = '22023';
  end if;
  select practice_video_url into old from public.league_settings limit 1;
  update public.league_settings set practice_video_url = u where true;
  insert into public.audit_log (actor, action, details) values ((select auth.uid()), 'settings:practice_video', jsonb_build_object('old', old, 'new', u));
end;
$$;
revoke execute on function public.set_practice_video(text) from public, anon;
grant execute on function public.set_practice_video(text) to authenticated, service_role;
