-- Password sign-in (2026-11-02): the pages ask whether the signed-in person has set a password
-- (accounts made by an emailed code have none), to offer "Set a password" and the one-time banner.
-- Reads auth.users server-side; returns nothing about anyone else.
create function public.my_auth() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('has_password', coalesce(u.encrypted_password, '') <> '')
  from auth.users u where u.id = (select auth.uid())
$$;
revoke execute on function public.my_auth() from public, anon;
grant execute on function public.my_auth() to authenticated, service_role;
