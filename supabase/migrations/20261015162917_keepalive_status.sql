-- Keep-alive status for the commissioner's warning banner.
-- heartbeats stays service_role-only; this function exposes just the timestamps,
-- and only to the commissioner. Anyone else gets null; anon can't call it at all.
-- Writers: the Cloudflare Worker cron ('cloudflare-cron', the primary keep-alive)
-- and the nightly GitHub Actions job ('nightly', a backup).

create function public.keepalive_status() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select case when private.is_commissioner() then
    jsonb_build_object(
      'checked_at', now(),
      'heartbeats', coalesce((select jsonb_agg(jsonb_build_object('name', h.name, 'at', h.at) order by h.at desc)
                              from public.heartbeats h), '[]'::jsonb))
  end
$$;

revoke execute on function public.keepalive_status() from public, anon;
grant execute on function public.keepalive_status() to authenticated, service_role;
