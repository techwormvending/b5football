-- Live scoring (decided 2026-10-20: free tier, no Workers Paid): the Supabase Edge
-- Function "b5-live" (supabase/functions/b5-live -> src/live/liveRun.ts), called every
-- minute by pg_cron + pg_net, but ONLY near NFL games:
--   private.live_tick() runs every minute. If no game in public.nfl_games kicks off within
--   5 minutes or started in the last 4.5 hours, it does nothing (no HTTP call, no Edge
--   Function invocation). Otherwise it writes a one-time nonce and POSTs it to the function.
--   The function exits after one ESPN request unless a game is in progress (or just ended
--   and not yet captured).
-- Authentication without a stored secret: live_nonces is service_role-only; the function
-- accepts a call only if it can consume a fresh nonce (src/live/edgeHandler.ts).

-- Service-only tables (RLS on, no policies, no grants to anon/authenticated).
create table public.live_nonces (
  nonce uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);
create table public.live_games (           -- finished games whose final live numbers were written
  event_id text primary key,               -- ESPN event ID
  season int not null,
  week int not null,
  captured_at timestamptz not null default now()
);
alter table public.live_nonces enable row level security;
alter table public.live_games enable row level security;
revoke all on public.live_nonces, public.live_games from anon, authenticated;
grant all on public.live_nonces, public.live_games to service_role;

-- Is an NFL game near? (kickoff within 5 minutes, or started less than 4.5 hours ago)
create function private.nfl_game_window(p_now timestamptz default now()) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.nfl_games g
                 where g.kickoff <= p_now + interval '5 minutes'
                   and g.kickoff >= p_now - interval '4 hours 30 minutes')
$$;

create function private.live_tick() returns text
language plpgsql security definer set search_path = ''
as $$
declare
  n uuid;
begin
  if not private.nfl_game_window() then
    return 'idle';
  end if;
  delete from public.live_nonces where created_at < now() - interval '10 minutes';
  insert into public.live_nonces default values returning nonce into n;
  perform net.http_post(
    url := 'https://kngwdttpbpezlvjrkrrg.supabase.co/functions/v1/b5-live',
    body := jsonb_build_object('nonce', n),
    headers := jsonb_build_object('Content-Type', 'application/json'),
    timeout_milliseconds := 120000
  );
  return 'called';
end;
$$;
revoke execute on function private.nfl_game_window(timestamptz), private.live_tick() from public, anon, authenticated;

-- pg_cron and pg_net exist on Supabase; the local test database (PGlite) has neither, so
-- install and schedule only where they're available.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net with schema extensions;
  end if;
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('b5-live', '* * * * *', 'select private.live_tick()');
    -- Every-minute jobs add ~1,440 run records a day: keep three days.
    perform cron.schedule('b5-cron-cleanup', '17 4 * * *', $c$delete from cron.job_run_details where end_time < now() - interval '3 days'$c$);
  end if;
end $$;
