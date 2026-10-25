-- Roles: ADMINISTRATOR (keeps the site running) and COMMISSIONER (runs the league), per user.
--
-- public.user_roles (user_id, role) is the source of truth; private.is_commissioner() and the new
-- private.is_admin() read it (a disabled account holds no powers). A user can hold both; co-owners
-- don't share roles. profiles.is_commissioner / profiles.is_admin stay as read-only mirrors for the
-- pages; changing them directly (the SQL editor, or an officer's own update) is turned into a grant
-- or revoke with the same rules. Grant/revoke: commissioners manage the commissioner role,
-- administrators the admin role (public.grant_role / revoke_role); never below one active holder
-- of each; every change is audited (roles:grant / roles:revoke) and emailed to the person.
-- Existing commissioners (the league's one account) get BOTH roles; nobody else changes.
--
-- Commissioner keeps every league power that already used private.is_commissioner(): invites and
-- team assignment, trades, drop reversals, waiver runs, score overrides, finalizing, payouts,
-- league settings, lineup emails, announcements, Board/Chat moderation, full contact info, reported
-- DMs. Administrator gets the technical side: system health (keep-alive, cron jobs, the live scorer,
-- the nightly job), re-running the pool import, retrying failed emails, the email log and a test
-- email, accounts (sign-in links, sign out everywhere, disable/enable, remove invites), feature
-- flags and season mode switches, and the audit log. Admins don't change scores, money, rosters or
-- league settings unless they're also commissioners. Neither role reads private DMs.
--
-- Conflict of interest: when a commissioner acts on his OWN team (trade approval, drop reversal,
-- score override) and another commissioner exists who owns neither team, the action waits in
-- public.officer_requests for that commissioner; with no such commissioner it goes ahead, flagged
-- in the audit log (coi:own_team_unreviewed) and on the Board by B5 Bot.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.user_roles (
  user_id uuid not null references public.profiles (id) on delete cascade,
  role text not null check (role in ('admin', 'commissioner')),
  granted_by uuid references public.profiles (id) on delete set null,
  granted_at timestamptz not null default now(),
  primary key (user_id, role)
);
alter table public.profiles add column is_admin boolean not null default false, add column disabled boolean not null default false;

alter table public.user_roles enable row level security;
create policy "signed-in users read" on public.user_roles for select to authenticated using (true);
revoke all on public.user_roles from anon, authenticated;
grant select on public.user_roles to authenticated;
grant all on public.user_roles to service_role;

-- The current commissioner(s) become admin + commissioner.
insert into public.user_roles (user_id, role) select p.id, r from public.profiles p cross join unnest(array['admin', 'commissioner']) r where p.is_commissioner;
select set_config('b5.role_sync', 'on', true);
update public.profiles set is_admin = true where is_commissioner;
select set_config('b5.role_sync', 'off', true);
insert into public.audit_log (actor_label, action, details)
select 'migration', 'roles:migrate', jsonb_build_object('user', p.id, 'roles', array['admin', 'commissioner']) from public.profiles p where p.is_commissioner;

-- ---------------------------------------------------------------------------
-- Role checks (every existing policy keeps calling these)
-- ---------------------------------------------------------------------------
create or replace function private.is_commissioner() returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.user_roles r join public.profiles p on p.id = r.user_id
                 where r.user_id = (select auth.uid()) and r.role = 'commissioner' and not p.disabled)
$$;
create function private.is_admin() returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.user_roles r join public.profiles p on p.id = r.user_id
                 where r.user_id = (select auth.uid()) and r.role = 'admin' and not p.disabled)
$$;
grant execute on function private.is_admin() to anon, authenticated, service_role;
create or replace function private.manages_team(p_team text) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.team_managers tm join public.profiles p on p.id = tm.user_id
                 where tm.team_id = p_team and tm.user_id = (select auth.uid()) and not p.disabled)
$$;
create or replace function private.is_member() returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.is_commissioner()
      or exists (select 1 from public.team_managers tm join public.profiles p on p.id = tm.user_id
                 where tm.user_id = (select auth.uid()) and not p.disabled)
$$;
create or replace function private.member_ids() returns setof uuid
language sql stable security definer set search_path = ''
as $$
  select tm.user_id from public.team_managers tm join public.profiles p on p.id = tm.user_id where not p.disabled
  union select r.user_id from public.user_roles r join public.profiles p on p.id = r.user_id where r.role = 'commissioner' and not p.disabled
$$;

create function private.active_holders(p_role text) returns int
language sql stable security definer set search_path = ''
as $$ select count(*)::int from public.user_roles r join public.profiles p on p.id = r.user_id where r.role = p_role and not p.disabled $$;

-- ---------------------------------------------------------------------------
-- Grant / revoke (the one place roles change)
-- ---------------------------------------------------------------------------
alter table public.notify_queue add column payload jsonb;
alter table public.notify_queue drop constraint notify_queue_kind_check;
alter table public.notify_queue add constraint notify_queue_kind_check check (kind in
  ('dm', 'mentions', 'trades', 'waivers', 'announcements', 'lineup', 'lineup_saved', 'league_lineups', 'league_trades', 'league_waivers', 'league_moves', 'scoring', 'account'));

create function private.apply_role(p_user uuid, p_role text, p_grant boolean, p_actor uuid, p_via text) returns boolean
language plpgsql security definer set search_path = ''
as $$
declare by_name text;
begin
  if p_grant then
    insert into public.user_roles (user_id, role, granted_by) values (p_user, p_role, p_actor) on conflict do nothing;
    if not found then return false; end if;
  else
    if exists (select 1 from public.user_roles r join public.profiles p on p.id = r.user_id where r.user_id = p_user and r.role = p_role and not p.disabled)
       and private.active_holders(p_role) <= 1 then
      raise exception 'There must always be at least one %', case p_role when 'admin' then 'administrator' else 'commissioner' end using errcode = '42501';
    end if;
    delete from public.user_roles where user_id = p_user and role = p_role;
    if not found then return false; end if;
  end if;
  perform set_config('b5.role_sync', 'on', true);
  update public.profiles set
    is_commissioner = exists (select 1 from public.user_roles r where r.user_id = p_user and r.role = 'commissioner'),
    is_admin = exists (select 1 from public.user_roles r where r.user_id = p_user and r.role = 'admin')
  where id = p_user;
  perform set_config('b5.role_sync', 'off', true);
  insert into public.audit_log (actor, actor_label, action, details)
  values (p_actor, case when p_actor is null then p_via end, 'roles:' || case when p_grant then 'grant' else 'revoke' end,
          jsonb_build_object('user', p_user, 'role', p_role, 'via', p_via));
  select coalesce(nullif(display_name, ''), 'an officer') into by_name from public.profiles where id = p_actor;
  insert into public.notify_queue (user_id, kind, ref, due_at, payload)
  values (p_user, 'account', 'role:' || p_role || ':' || case when p_grant then 'grant' else 'revoke' end || ':' || extract(epoch from clock_timestamp())::bigint, now(),
          jsonb_build_object('type', 'role', 'role', p_role, 'action', case when p_grant then 'grant' else 'revoke' end, 'by', coalesce(by_name, 'the league')))
  on conflict do nothing;
  return true;
end;
$$;

create function public.grant_role(p_user uuid, p_role text) returns text
language plpgsql security definer set search_path = ''
as $$
begin
  if p_role = 'commissioner' and not private.is_commissioner() then raise exception 'Only a commissioner can grant the commissioner role' using errcode = '42501'; end if;
  if p_role = 'admin' and not private.is_admin() then raise exception 'Only an administrator can grant the administrator role' using errcode = '42501'; end if;
  if p_role not in ('admin', 'commissioner') then raise exception 'Unknown role' using errcode = '22023'; end if;
  if not exists (select 1 from public.profiles where id = p_user) then raise exception 'No such account' using errcode = '22023'; end if;
  return case when private.apply_role(p_user, p_role, true, (select auth.uid()), 'officers') then 'Granted' else 'Already held' end;
end;
$$;
create function public.revoke_role(p_user uuid, p_role text) returns text
language plpgsql security definer set search_path = ''
as $$
begin
  if p_role = 'commissioner' and not private.is_commissioner() then raise exception 'Only a commissioner can revoke the commissioner role' using errcode = '42501'; end if;
  if p_role = 'admin' and not private.is_admin() then raise exception 'Only an administrator can revoke the administrator role' using errcode = '42501'; end if;
  return case when private.apply_role(p_user, p_role, false, (select auth.uid()), 'officers') then 'Revoked' else 'Not held' end;
end;
$$;

-- profiles.is_commissioner / is_admin are mirrors: direct changes become grants/revokes.
create or replace function private.guard_profile() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.id is distinct from old.id then raise exception 'Profile id cannot change' using errcode = '42501'; end if;
  if coalesce(current_setting('b5.role_sync', true), 'off') = 'on' then return new; end if;
  if new.is_commissioner is distinct from old.is_commissioner and not (private.is_commissioner() or private.is_privileged()) then
    raise exception 'Only the commissioner can change commissioner rights' using errcode = '42501';
  end if;
  if new.is_admin is distinct from old.is_admin and not (private.is_admin() or private.is_privileged()) then
    raise exception 'Only an administrator can change administrator rights' using errcode = '42501';
  end if;
  if new.disabled is distinct from old.disabled and not private.is_privileged() then
    raise exception 'Accounts are disabled from the Admin page' using errcode = '42501';
  end if;
  return new;
end;
$$;
create function private.profile_roles_changed() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if coalesce(current_setting('b5.role_sync', true), 'off') = 'on' then return null; end if;
  if new.is_commissioner is distinct from old.is_commissioner then
    perform private.apply_role(new.id, 'commissioner', new.is_commissioner, (select auth.uid()), 'profile');
  end if;
  if new.is_admin is distinct from old.is_admin then
    perform private.apply_role(new.id, 'admin', new.is_admin, (select auth.uid()), 'profile');
  end if;
  return null;
end;
$$;
create trigger profile_roles_changed after update of is_commissioner, is_admin on public.profiles
  for each row execute function private.profile_roles_changed();

-- Sign-up: an invite marked commissioner grants the role (audited, like any grant).
create or replace function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  inv public.invites%rowtype;
begin
  select * into inv from public.invites i where i.email = lower(btrim(new.email));
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1), ''));
  if coalesce(inv.is_commissioner, false) then
    perform private.apply_role(new.id, 'commissioner', true, inv.invited_by, 'invite');
  end if;
  if inv.email is not null then
    if inv.team_id is not null then
      begin
        insert into public.team_managers (team_id, user_id) values (inv.team_id, new.id) on conflict do nothing;
      exception when check_violation or unique_violation then
        null;   -- the team filled up (or the account owns another): the commissioner sees it unassigned
      end;
    end if;
    update public.invites set user_id = new.id, accepted_at = new.last_sign_in_at where email = inv.email;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Who reads what: technical data moves to administrators
-- ---------------------------------------------------------------------------
drop policy "commissioner reads" on public.audit_log;
create policy "administrator reads" on public.audit_log for select to authenticated using (private.is_admin());
drop policy "commissioner appends" on public.audit_log;
create policy "officers append" on public.audit_log for insert to authenticated with check (private.is_commissioner() or private.is_admin());
drop policy "commissioner reads" on public.email_log;
create policy "administrator reads" on public.email_log for select to authenticated using (private.is_admin());
drop policy "commissioner reads" on public.pool_imports;
create policy "officers read" on public.pool_imports for select to authenticated using (private.is_admin() or private.is_commissioner());
drop policy "commissioner reads" on public.shadow_results;
create policy "officers read" on public.shadow_results for select to authenticated using (private.is_admin() or private.is_commissioner());
drop policy "commissioner reads" on public.live_compare;
create policy "officers read" on public.live_compare for select to authenticated using (private.is_admin() or private.is_commissioner());
drop policy "commissioner only" on public.review_queue;
create policy "officers read" on public.review_queue for select to authenticated using (private.is_admin() or private.is_commissioner());
create policy "commissioner writes" on public.review_queue for all to authenticated using (private.is_commissioner()) with check (private.is_commissioner());
-- Invites: the commissioner invites; an administrator can also see and remove them.
create policy "administrator reads" on public.invites for select to authenticated using (private.is_admin());
create policy "administrator removes" on public.invites for delete to authenticated using (private.is_admin());

create or replace function public.keepalive_status() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select case when private.is_admin() then
    jsonb_build_object('checked_at', now(),
      'heartbeats', coalesce((select jsonb_agg(jsonb_build_object('name', h.name, 'at', h.at) order by h.at desc) from public.heartbeats h), '[]'::jsonb))
  end
$$;
create or replace function public.run_pool_import(p_week int default null) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  w record;
begin
  if not private.is_admin() then
    raise exception 'Only an administrator can re-run the pool import' using errcode = '42501';
  end if;
  select * into w from private.last_finished_week();
  if w.season is null then raise exception 'No finished NFL week yet' using errcode = '22023'; end if;
  perform private.request_pool_import(w.season, coalesce(p_week, w.week), 'admin');
  return 'Import requested for ' || w.season || ' week ' || coalesce(p_week, w.week);
end;
$$;
create or replace function public.notify_usage() returns table (priority int, today int, month int)
language sql stable security definer set search_path = ''
as $$
  select p, (select count(*)::int from public.email_log l where l.status = 'sent' and private.notify_priority(l.kind) = p and l.at >= date_trunc('day', now())),
            (select count(*)::int from public.email_log l where l.status = 'sent' and private.notify_priority(l.kind) = p and l.at >= date_trunc('month', now()))
  from generate_series(1, 4) p where private.is_commissioner() or private.is_admin()
$$;

-- ---------------------------------------------------------------------------
-- Feature flags and season modes (administrators)
-- ---------------------------------------------------------------------------
create table public.feature_flags (
  key text primary key check (key ~ '^[a-z_]{2,40}$'),
  enabled boolean not null default true,
  description text not null default '',
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now()
);
insert into public.feature_flags (key, enabled, description) values
  ('email_notifications', true, 'Send email notifications (off = nothing is sent; the queue waits)'),
  ('live_scoring', true, 'Run the live ESPN scorer during games');
alter table public.feature_flags enable row level security;
create policy "signed-in users read" on public.feature_flags for select to authenticated using (true);
create policy "administrator updates" on public.feature_flags for update to authenticated using (private.is_admin()) with check (private.is_admin());
revoke all on public.feature_flags from anon, authenticated;
grant select, update on public.feature_flags to authenticated;
grant all on public.feature_flags to service_role;
create function private.flag(p_key text) returns boolean
language sql stable security definer set search_path = ''
as $$ select coalesce((select f.enabled from public.feature_flags f where f.key = p_key), true) $$;
create function private.audit_flag() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  new.updated_by := (select auth.uid()); new.updated_at := now();
  insert into public.audit_log (actor, action, details) values ((select auth.uid()), 'admin:flag', jsonb_build_object('key', new.key, 'enabled', new.enabled));
  return new;
end;
$$;
create trigger audit_flag before update on public.feature_flags for each row execute function private.audit_flag();

-- Season modes: 2026 test mode -> 2027 live. Only these switches, only administrators.
create function private.season_modes(s public.season_settings) returns jsonb
language sql immutable set search_path = ''
as $$ select jsonb_build_object('pools.mode', s.pools -> 'mode', 'waivers.live', s.waivers -> 'live', 'trades.live', s.trades -> 'live', 'notify.lineupReminders', s.notify -> 'lineupReminders') $$;
create function private.guard_season_modes() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if not private.is_privileged() and not private.is_admin() and private.season_modes(new) is distinct from private.season_modes(old) then
    raise exception 'Season modes (test/live switches) are changed by an administrator' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger guard_season_modes before update on public.season_settings for each row execute function private.guard_season_modes();

create function public.admin_set_mode(p_season int, p_key text, p_value jsonb) returns text
language plpgsql security definer set search_path = ''
as $$
declare col text := split_part(p_key, '.', 1); k text := split_part(p_key, '.', 2);
begin
  if not private.is_admin() then raise exception 'Only an administrator switches season modes' using errcode = '42501'; end if;
  if p_key not in ('pools.mode', 'waivers.live', 'trades.live', 'notify.lineupReminders') then raise exception 'Unknown mode %', p_key using errcode = '22023'; end if;
  if (p_key = 'pools.mode' and p_value not in ('"test"', '"official"', '"closed"')) or (p_key <> 'pools.mode' and jsonb_typeof(p_value) <> 'boolean') then
    raise exception 'Invalid value for %', p_key using errcode = '22023';
  end if;
  if not exists (select 1 from public.season_settings where season = p_season) then raise exception 'No settings for %', p_season using errcode = '22023'; end if;
  execute format('update public.season_settings set %I = jsonb_set(coalesce(%I, ''{}''), %L, %L::jsonb) where season = %s', col, col, '{' || k || '}', p_value::text, p_season);
  insert into public.audit_log (actor, action, season, details) values ((select auth.uid()), 'admin:mode', p_season, jsonb_build_object('mode', p_key, 'value', p_value));
  return p_key || ' = ' || p_value::text;
end;
$$;

-- Kill switches honored by the schedulers.
create or replace function private.notify_tick() returns text
language plpgsql security definer set search_path = ''
as $$
declare n uuid;
begin
  if not private.flag('email_notifications') then return 'off'; end if;
  if not exists (select 1 from public.notify_queue q where q.status = 'pending' and q.due_at <= now()) then return 'idle'; end if;
  delete from public.live_nonces where created_at < now() - interval '10 minutes';
  insert into public.live_nonces default values returning nonce into n;
  perform net.http_post(
    url := 'https://kngwdttpbpezlvjrkrrg.supabase.co/functions/v1/notify',
    body := jsonb_build_object('nonce', n),
    headers := jsonb_build_object('Content-Type', 'application/json'),
    timeout_milliseconds := 60000);
  return 'called';
end;
$$;
create or replace function private.live_tick() returns text
language plpgsql security definer set search_path = ''
as $$
declare
  n uuid;
begin
  if not private.flag('live_scoring') then return 'off'; end if;
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

-- ---------------------------------------------------------------------------
-- Administrator tools
-- ---------------------------------------------------------------------------
create function public.admin_health() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare jobs jsonb := '[]';
begin
  if not private.is_admin() then raise exception 'Administrators only' using errcode = '42501'; end if;
  if to_regclass('cron.job') is not null then
    execute $q$select coalesce(jsonb_agg(jsonb_build_object('job', j.jobname, 'schedule', j.schedule, 'active', j.active,
                 'last_status', d.status, 'last_run', d.end_time, 'message', left(d.return_message, 200)) order by j.jobname), '[]')
               from cron.job j left join lateral (select r.status, r.end_time, r.return_message from cron.job_run_details r
                 where r.jobid = j.jobid order by r.start_time desc limit 1) d on true$q$ into jobs;
  end if;
  return jsonb_build_object(
    'heartbeats', coalesce((select jsonb_agg(jsonb_build_object('name', h.name, 'at', h.at) order by h.at desc) from public.heartbeats h), '[]'),
    'jobs', jobs,
    'live_scorer', (select jsonb_build_object('season', sw.season, 'week', sw.week, 'status', sw.status, 'updated_at', sw.updated_at, 'delayed', sw.live_delayed)
                    from public.score_weeks sw order by sw.updated_at desc nulls last limit 1),
    'pool_import', (select jsonb_build_object('week', pi.week, 'status', pi.status, 'at', coalesce(pi.succeeded_at, pi.attempted_at), 'message', pi.message)
                    from public.pool_imports pi order by pi.attempted_at desc limit 1),
    'email', jsonb_build_object(
      'pending', (select count(*) from public.notify_queue q where q.status = 'pending'),
      'failed_24h', (select count(*) from public.notify_queue q where q.status = 'failed' and q.updated_at > now() - interval '1 day'),
      'last_sent', (select max(l.at) from public.email_log l where l.status = 'sent')),
    'flags', (select jsonb_object_agg(f.key, f.enabled) from public.feature_flags f));
end;
$$;

create function public.admin_accounts()
returns table (user_id uuid, display_name text, email text, teams text[], roles text[], disabled boolean, last_sign_in_at timestamptz)
language sql stable security definer set search_path = ''
as $$
  select p.id, p.display_name, u.email,
         array(select tm.team_id from public.team_managers tm where tm.user_id = p.id order by 1),
         array(select r.role from public.user_roles r where r.user_id = p.id order by 1),
         p.disabled, u.last_sign_in_at
  from public.profiles p left join auth.users u on u.id = p.id
  where private.is_admin()
  order by p.display_name nulls last
$$;

-- Sign a user out of every session (refresh tokens; an access token already issued lasts up to an hour).
create function public.admin_sign_out(p_user uuid) returns text
language plpgsql security definer set search_path = ''
as $$
declare n int := 0; m int := 0;
begin
  if not private.is_admin() then raise exception 'Administrators only' using errcode = '42501'; end if;
  begin
    if to_regclass('auth.refresh_tokens') is not null then execute 'delete from auth.refresh_tokens where user_id = $1' using p_user::text; get diagnostics n = row_count; end if;
    if to_regclass('auth.sessions') is not null then execute 'delete from auth.sessions where user_id = $1' using p_user; get diagnostics m = row_count; end if;
  exception when insufficient_privilege then
    insert into public.audit_log (actor, action, details) values ((select auth.uid()), 'admin:sign_out', jsonb_build_object('user', p_user, 'error', 'no permission on auth sessions'));
    return 'Couldn''t end sessions (no permission on Supabase Auth''s tables); disable the account instead';
  end;
  insert into public.audit_log (actor, action, details) values ((select auth.uid()), 'admin:sign_out', jsonb_build_object('user', p_user, 'sessions', m, 'refresh_tokens', n));
  return 'Signed out of ' || m || ' session(s)';
end;
$$;

-- Disable / enable: a disabled account keeps its data but has no team rights, no officer powers and
-- sees only public data; its sessions are ended. The last active admin or commissioner can't be disabled.
create function public.admin_set_disabled(p_user uuid, p_disabled boolean) returns text
language plpgsql security definer set search_path = ''
as $$
declare r text;
begin
  if not private.is_admin() then raise exception 'Administrators only' using errcode = '42501'; end if;
  if p_disabled then
    for r in select ur.role from public.user_roles ur where ur.user_id = p_user loop
      if private.active_holders(r) <= 1 then
        raise exception 'That''s the last active %: grant the role to someone else first', case r when 'admin' then 'administrator' else 'commissioner' end using errcode = '42501';
      end if;
    end loop;
  end if;
  update public.profiles set disabled = p_disabled where id = p_user;
  if not found then raise exception 'No such account' using errcode = '22023'; end if;
  insert into public.audit_log (actor, action, details) values ((select auth.uid()), 'admin:' || case when p_disabled then 'disable' else 'enable' end, jsonb_build_object('user', p_user));
  if p_disabled then perform public.admin_sign_out(p_user); end if;
  return case when p_disabled then 'Disabled' else 'Enabled' end;
end;
$$;

-- Email system: a test email to yourself; retry failed emails (last 7 days) once more.
create function public.admin_test_email() returns text
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.is_admin() then raise exception 'Administrators only' using errcode = '42501'; end if;
  insert into public.notify_queue (user_id, kind, ref, due_at, payload)
  values ((select auth.uid()), 'account', 'test:' || extract(epoch from clock_timestamp())::bigint, now(), jsonb_build_object('type', 'test'));
  insert into public.audit_log (actor, action, details) values ((select auth.uid()), 'admin:test_email', '{}');
  return 'Test email queued: it goes out within a minute';
end;
$$;
create function public.admin_retry_failed_emails() returns int
language plpgsql security definer set search_path = ''
as $$
declare n int;
begin
  if not private.is_admin() then raise exception 'Administrators only' using errcode = '42501'; end if;
  update public.notify_queue set status = 'pending', attempts = 0, due_at = now(), reason = null, updated_at = now()
   where status = 'failed' and updated_at > now() - interval '7 days';
  get diagnostics n = row_count;
  insert into public.audit_log (actor, action, details) values ((select auth.uid()), 'admin:retry_emails', jsonb_build_object('count', n));
  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- Email: account notices (role changes, test emails) always go out
-- ---------------------------------------------------------------------------
create or replace function private.notify_on(p_user uuid, p_kind text) returns boolean
language sql stable security definer set search_path = ''
as $$
  select case when p_kind = 'account' then true
              when s.user_id is null then p_kind in ('dm', 'trades', 'announcements', 'lineup_saved', 'waivers')
              when s.paused then false
              when p_kind = 'league_lineups' then s.league_lineups <> 'off'
              else coalesce((to_jsonb(s) ->> p_kind)::boolean, false) end
  from (select 1) one left join public.notify_settings s on s.user_id = p_user
$$;
create or replace function private.notify_priority(p_kind text) returns int
language sql immutable set search_path = ''
as $$ select case when p_kind in ('dm', 'mentions', 'trades', 'announcements', 'account') then 1
                  when p_kind in ('waivers', 'league_trades', 'league_waivers', 'league_moves') then 2
                  when p_kind in ('lineup_saved', 'league_lineups', 'lineup') then 3
                  else 4 end $$;

-- notify_claim: account notices skip the membership check and carry their payload.
create or replace function public.notify_claim(p_limit int default 25, p_now timestamptz default now())
returns table (id bigint, user_id uuid, kind text, email text, token text, data jsonb)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  q public.notify_queue;
  addr text;
  d jsonb;
  unread int;
  last_sent timestamptz;
  ref_id bigint;
  t public.trades;
  parts text[];
  day_count int;
  month_count int;
  pri int;
  claimed int := 0;
  mode text;
begin
  update public.notify_queue nq set status = 'pending', updated_at = p_now where nq.status = 'sending' and nq.updated_at < p_now - interval '10 minutes';
  select count(*) filter (where l.at >= date_trunc('day', p_now)), count(*) into day_count, month_count
    from public.email_log l where l.status = 'sent' and l.at >= date_trunc('month', p_now);
  for q in select * from public.notify_queue nq where nq.status = 'pending' and nq.due_at <= p_now
           order by private.notify_priority(nq.kind), nq.due_at limit p_limit for update skip locked loop
    select u.email into addr from auth.users u where u.id = q.user_id;
    if addr is null then perform private.notify_skip(q, 'no email'); continue; end if;
    if q.kind <> 'account' and q.user_id not in (select private.member_ids()) then perform private.notify_skip(q, 'not a member'); continue; end if;
    if not private.notify_on(q.user_id, q.kind) then perform private.notify_skip(q, 'turned off'); continue; end if;
    pri := private.notify_priority(q.kind);
    if day_count + claimed >= private.notify_cap(pri, false) or month_count + claimed >= private.notify_cap(pri, true) then
      perform private.notify_skip(q, 'free-tier limit'); continue;
    end if;
    d := null;
    parts := string_to_array(q.ref, ':');
    ref_id := case when parts[2] ~ '^\d+$' then parts[2]::bigint end;

    if q.kind in ('dm', 'mentions') and exists (select 1 from public.user_presence pr where pr.user_id = q.user_id and pr.seen_at > p_now - interval '2 minutes') then
      perform private.notify_skip(q, 'active on the site'); continue;
    end if;

    if q.kind = 'dm' then
      select count(*) into unread from public.dm_messages m
       where m.conversation_id = ref_id and not m.is_bot and m.author_id is distinct from q.user_id
         and m.created_at > coalesce((select r.read_at from public.dm_reads r where r.conversation_id = ref_id and r.user_id = q.user_id), '-infinity');
      if unread = 0 then perform private.notify_skip(q, 'already read'); continue; end if;
      select max(l.at) into last_sent from public.email_log l where l.user_id = q.user_id and l.kind = 'dm' and l.ref = q.ref and l.status = 'sent';
      if last_sent is not null and last_sent > p_now - interval '30 minutes' then
        update public.notify_queue nq set due_at = last_sent + interval '30 minutes', updated_at = p_now where nq.id = q.id;
        continue;
      end if;
      d := jsonb_build_object('count', unread, 'link', '#dm/' || ref_id,
        'senders', (select jsonb_agg(distinct private.person(m.author_id)) from public.dm_messages m
                    where m.conversation_id = ref_id and not m.is_bot and m.author_id is distinct from q.user_id
                      and m.created_at > coalesce((select r.read_at from public.dm_reads r where r.conversation_id = ref_id and r.user_id = q.user_id), '-infinity')),
        'preview', (select private.preview(m.body) from public.dm_messages m where m.conversation_id = ref_id and not m.is_bot and m.author_id is distinct from q.user_id order by m.id desc limit 1));
    elsif q.kind = 'mentions' then
      if parts[1] = 'chat' then
        select jsonb_build_object('where', 'Chat', 'from', private.person(m.author_id), 'preview', private.preview(m.body), 'link', '#chat/' || m.room_id)
          into d from public.chat_messages m where m.id = ref_id;
      else
        select jsonb_build_object('where', 'the Message Board', 'from', private.person(p.author_id), 'preview', private.preview(p.body), 'link', '#board/' || p.thread_id,
          'title', (select th.title from public.board_threads th where th.id = p.thread_id))
          into d from public.board_posts p where p.id = ref_id;
      end if;
      if d is null then perform private.notify_skip(q, 'deleted'); continue; end if;
    elsif q.kind in ('trades', 'league_trades') then
      select * into t from public.trades tr where tr.id = ref_id;
      if t.id is null then perform private.notify_skip(q, 'deleted'); continue; end if;
      d := jsonb_build_object('status', parts[3], 'test', t.test, 'summary', private.trade_summary(t), 'note', t.note, 'decision_note', t.decision_note,
        'from_team', private.team_name(t.from_team), 'to_team', private.team_name(t.to_team), 'expires_at', t.expires_at,
        'commissioner_party', t.commissioner_party, 'link', '#trades');
    elsif q.kind = 'waivers' then
      d := jsonb_build_object('link', '#players/results', 'claims', (select jsonb_agg(jsonb_build_object('player', coalesce(np.name, c.add_player), 'drop', dp.name,
               'status', c.status, 'result', c.result) order by c.rank)
             from public.waiver_claims c left join public.nfl_players np on np.id = c.add_player left join public.nfl_players dp on dp.id = c.drop_player
             where c.run_id = ref_id and c.team_id = parts[3]));
      if d ->> 'claims' is null then perform private.notify_skip(q, 'undone'); continue; end if;
    elsif q.kind = 'league_waivers' then
      d := jsonb_build_object('link', '#players/results', 'won', (select jsonb_agg(jsonb_build_object('team', private.team_name(c.team_id), 'player', coalesce(np.name, c.add_player), 'drop', dp.name) order by c.team_id)
             from public.waiver_claims c left join public.nfl_players np on np.id = c.add_player left join public.nfl_players dp on dp.id = c.drop_player
             join public.waiver_runs wr on wr.id = c.run_id and wr.status = 'done'
             where c.run_id = ref_id and c.status = 'won'),
           'claims', (select count(*) from public.waiver_claims c where c.run_id = ref_id));
      if d ->> 'won' is null then perform private.notify_skip(q, 'no claims won'); continue; end if;
    elsif q.kind = 'league_moves' then
      d := jsonb_build_object('link', '#players/log', 'moves', (select jsonb_agg(jsonb_build_object('team', private.team_name(x.team_id),
               'added', (select string_agg(coalesce(np.name, a), ', ') from unnest(x.players_in) a left join public.nfl_players np on np.id = a),
               'dropped', (select string_agg(coalesce(np.name, b), ', ') from unnest(x.players_out) b left join public.nfl_players np on np.id = b)) order by x.created_at)
             from public.transactions x where x.status = 'processed' and x.via in ('free_agent', 'commissioner') and x.type <> 'trade'
               and x.created_at >= to_timestamp(ref_id) and x.created_at < to_timestamp(ref_id) + interval '1 hour'));
      if d ->> 'moves' is null then perform private.notify_skip(q, 'no moves'); continue; end if;
    elsif q.kind = 'lineup_saved' then
      d := private.lineup_payload(parts[2]::int, parts[3]::int, parts[4]) || jsonb_build_object('link', '#myteam');
      if d ->> 'starters' is null then perform private.notify_skip(q, 'empty lineup'); continue; end if;
    elsif q.kind = 'league_lineups' then
      select ns.league_lineups into mode from public.notify_settings ns where ns.user_id = q.user_id;
      if (parts[1] = 'ldig' and mode <> 'digest') or (parts[1] = 'linst' and mode <> 'instant') then perform private.notify_skip(q, 'mode changed'); continue; end if;
      if parts[1] = 'ldig' then
        select max(l.at) into last_sent from public.email_log l where l.user_id = q.user_id and l.kind = 'league_lineups' and l.status = 'sent';
        d := jsonb_build_object('mode', 'digest', 'link', '#teams', 'teams', private.lineup_changes(q.user_id, coalesce(last_sent, p_now - interval '7 days'), p_now));
      else
        d := jsonb_build_object('mode', 'instant', 'link', '#team/' || parts[4],
          'teams', private.lineup_changes(q.user_id, p_now - interval '1 day', p_now, parts[4]));
      end if;
      if jsonb_array_length(d -> 'teams') = 0 then perform private.notify_skip(q, 'no changes'); continue; end if;
    elsif q.kind = 'scoring' then
      d := private.scoring_payload(q.user_id, parts[2]::date);
      if d is null then perform private.notify_skip(q, 'no scoring run'); continue; end if;
    elsif q.kind = 'announcements' then
      if parts[1] = 'board' then
        select jsonb_build_object('title', th.title, 'preview', private.preview((select p.body from public.board_posts p where p.thread_id = th.id and p.is_opener limit 1)), 'link', '#board/' || th.id)
          into d from public.board_threads th where th.id = ref_id;
      elsif parts[1] = 'clineup' then
        d := private.lineup_payload(parts[2]::int, parts[3]::int, parts[4]) || jsonb_build_object('commissioner', 'lineup', 'link', '#myteam');
      elsif parts[1] = 'cremind' then
        d := jsonb_build_object('commissioner', 'reminder', 'team', private.team_name(parts[4]), 'week', parts[3]::int, 'link', '#myteam',
          'first_kickoff', (select min(g.kickoff) from public.nfl_games g where g.season = parts[2]::int and g.week = parts[3]::int and g.kickoff > p_now));
        if exists (select 1 from public.lineup_meta m where m.season = parts[2]::int and m.week = parts[3]::int and m.team_id = parts[4]) then
          perform private.notify_skip(q, 'submitted since'); continue;
        end if;
      else
        select jsonb_build_object('title', a.title, 'preview', private.preview(regexp_replace(a.body_html, '<[^>]*>', ' ', 'g')), 'link', '#home')
          into d from public.announcements a where a.id = ref_id and a.published_at is not null;
      end if;
      if d is null then perform private.notify_skip(q, 'deleted'); continue; end if;
    elsif q.kind = 'account' then
      d := coalesce(q.payload, '{}'::jsonb) || jsonb_build_object('link', '#account');
    elsif q.kind = 'lineup' then
      d := jsonb_build_object('week', parts[3]::int, 'team', private.team_name(parts[4]), 'link', '#myteam',
        'players', (select jsonb_agg(jsonb_build_object('name', lp.name, 'pos', lp.pos, 'problem', lp.problem, 'deadline', lp.deadline))
                    from private.lineup_problems(parts[2]::int, parts[3]::int, parts[4]) lp));
      if d ->> 'players' is null then perform private.notify_skip(q, 'lineup fixed'); continue; end if;
    end if;

    update public.notify_queue nq set status = 'sending', attempts = nq.attempts + 1, updated_at = p_now where nq.id = q.id;
    claimed := claimed + 1;
    id := q.id; user_id := q.user_id; kind := q.kind; email := addr; token := private.notify_token(q.user_id, q.kind); data := d;
    return next;
  end loop;
end;
$$;


-- ---------------------------------------------------------------------------
-- Conflict of interest: another commissioner approves actions on your own team
-- ---------------------------------------------------------------------------
create table public.officer_requests (
  id bigint generated always as identity primary key,
  action text not null check (action in ('trade_decide', 'reverse_drop', 'score_override')),
  payload jsonb not null,
  teams text[] not null,
  summary text not null,
  requested_by uuid references public.profiles (id) on delete set null,
  requested_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by uuid references public.profiles (id) on delete set null,
  decided_at timestamptz,
  note text check (char_length(note) <= 500)
);
alter table public.officer_requests enable row level security;
create policy "commissioners read" on public.officer_requests for select to authenticated using (private.is_commissioner());
revoke all on public.officer_requests from anon, authenticated;
grant select on public.officer_requests to authenticated;
grant all on public.officer_requests to service_role;

-- Is there a commissioner other than me who owns none of these teams?
create function private.coi_others(p_teams text[]) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.user_roles r join public.profiles p on p.id = r.user_id
                 where r.role = 'commissioner' and not p.disabled and r.user_id <> (select auth.uid())
                   and not exists (select 1 from public.team_managers tm where tm.user_id = r.user_id and tm.team_id = any (p_teams)))
$$;
create function private.coi_request(p_action text, p_payload jsonb, p_teams text[], p_summary text) returns bigint
language plpgsql security definer set search_path = ''
as $$
declare i bigint;
begin
  insert into public.officer_requests (action, payload, teams, summary, requested_by) values (p_action, p_payload, p_teams, p_summary, (select auth.uid())) returning id into i;
  insert into public.audit_log (actor, action, details) values ((select auth.uid()), 'coi:request', jsonb_build_object('request', i, 'action', p_action, 'teams', p_teams, 'summary', p_summary));
  return i;
end;
$$;
-- No other commissioner to ask: it goes ahead, flagged in the audit log and on the Board.
create function private.coi_flag(p_action text, p_teams text[], p_summary text) returns void
language plpgsql security definer set search_path = ''
as $$
declare a bigint; th bigint; who text;
begin
  select coalesce(nullif(display_name, ''), 'The commissioner') into who from public.profiles where id = (select auth.uid());
  insert into public.audit_log (actor, action, details) values ((select auth.uid()), 'coi:own_team_unreviewed',
    jsonb_build_object('action', p_action, 'teams', p_teams, 'summary', p_summary, 'flag', 'No other commissioner to approve: done by the commissioner on his own team')) returning id into a;
  insert into public.board_threads (title, is_bot, source_key) values (left('⚠ Commissioner action on his own team: ' || p_action, 120), true, 'coi:' || a) returning id into th;
  insert into public.board_posts (thread_id, is_bot, is_opener, body) values (th, true, true,
    '⚠ **' || coalesce(who, 'The commissioner') || '** acted on his own team (' || array_to_string(array(select private.team_name(x) from unnest(p_teams) x), ', ') || '): ' || p_summary ||
    E'.\n\nThe league has no other commissioner to approve it, so it went ahead and is flagged in the audit log.');
end;
$$;

-- Trades
alter function public.trade_decide(bigint, boolean, text) rename to trade_decide_exec;
alter function public.trade_decide_exec(bigint, boolean, text) set schema private;
revoke execute on function private.trade_decide_exec(bigint, boolean, text) from public, anon, authenticated;
create function public.trade_decide(p_trade bigint, p_approve boolean, p_note text default null) returns text
language plpgsql security definer set search_path = ''
as $$
declare t public.trades; s text;
begin
  if not private.is_commissioner() then raise exception 'Only the commissioner approves trades' using errcode = '42501'; end if;
  select * into t from public.trades where id = p_trade;
  if t.id is null or t.status <> 'accepted' then raise exception 'Only accepted trades wait for approval' using errcode = '22023'; end if;
  s := case when p_approve then 'approve' else 'reject' end || ' trade #' || t.id || ': ' || private.trade_summary(t);
  if private.manages_team(t.from_team) or private.manages_team(t.to_team) then
    if private.coi_others(array[t.from_team, t.to_team]) then
      return 'This trade involves your team: sent to another commissioner for approval (request #' ||
        private.coi_request('trade_decide', jsonb_build_object('trade', p_trade, 'approve', p_approve, 'note', p_note), array[t.from_team, t.to_team], s) || ')';
    end if;
    perform private.trade_decide_exec(p_trade, p_approve, p_note);
    perform private.coi_flag('trade ' || case when p_approve then 'approval' else 'rejection' end, array[t.from_team, t.to_team], s);
    return case when p_approve then 'Approved' else 'Rejected' end || ' (your own team, with no other commissioner to ask: flagged in the audit log and on the Board)';
  end if;
  perform private.trade_decide_exec(p_trade, p_approve, p_note);
  return case when p_approve then 'Approved' else 'Rejected' end;
end;
$$;

-- Drop reversals
alter function public.reverse_drop(bigint, timestamptz) rename to reverse_drop_exec;
alter function public.reverse_drop_exec(bigint, timestamptz) set schema private;
revoke execute on function private.reverse_drop_exec(bigint, timestamptz) from public, anon, authenticated;
create function public.reverse_drop(p_transaction bigint, p_reported_at timestamptz default now()) returns text
language plpgsql security definer set search_path = ''
as $$
declare x public.transactions; s text;
begin
  if not private.is_commissioner() then raise exception 'Only the commissioner can reverse a drop' using errcode = '42501'; end if;
  select * into x from public.transactions where id = p_transaction;
  if x.id is null then raise exception 'That isn''t a drop' using errcode = '22023'; end if;
  s := 'reverse ' || private.team_name(x.team_id) || '''s drop of ' || private.trade_items(x.players_out, '{}');
  if private.manages_team(x.team_id) then
    if private.coi_others(array[x.team_id]) then
      return 'This is your team: sent to another commissioner for approval (request #' ||
        private.coi_request('reverse_drop', jsonb_build_object('transaction', p_transaction, 'reported_at', p_reported_at), array[x.team_id], s) || ')';
    end if;
    perform private.reverse_drop_exec(p_transaction, p_reported_at);
    perform private.coi_flag('drop reversal', array[x.team_id], s);
    return 'Drop reversed (your own team, with no other commissioner to ask: flagged in the audit log and on the Board)';
  end if;
  perform private.reverse_drop_exec(p_transaction, p_reported_at);
  return 'Drop reversed';
end;
$$;

-- Score overrides (written to the table directly): on your own player, the row waits for another commissioner.
create function private.coi_score_override() returns trigger
language plpgsql set search_path = ''
as $$
declare owner text; s text;
begin
  if private.is_privileged() or not private.is_commissioner() then return new; end if;
  select re.team_id into owner from public.roster_entries re where re.season = new.season and re.player_id = regexp_replace(new.target_key, '^nflverse:', '');
  if owner is null or not private.manages_team(owner) then return new; end if;
  s := lower(tg_op) || ' a ' || new.type || ' override on ' || new.target_key || ' (week ' || new.week || '): ' || new.reason;
  if private.coi_others(array[owner]) then
    perform private.coi_request('score_override', jsonb_build_object('op', lower(tg_op), 'row', to_jsonb(new)), array[owner], s);
    return null;   -- not written: it waits for another commissioner (see officer_requests)
  end if;
  perform private.coi_flag('score override', array[owner], s);
  return new;
end;
$$;
create trigger coi_score_override before insert or update on public.score_overrides for each row execute function private.coi_score_override();

create function public.decide_officer_request(p_id bigint, p_approve boolean, p_note text default null) returns text
language plpgsql security definer set search_path = ''
as $$
declare r public.officer_requests; ov public.score_overrides;
begin
  if not private.is_commissioner() then raise exception 'Only a commissioner decides these' using errcode = '42501'; end if;
  select * into r from public.officer_requests where id = p_id for update;
  if r.id is null or r.status <> 'pending' then raise exception 'That request isn''t pending' using errcode = '22023'; end if;
  if r.requested_by = (select auth.uid()) then raise exception 'Another commissioner has to decide your request' using errcode = '42501'; end if;
  if exists (select 1 from public.team_managers tm where tm.user_id = (select auth.uid()) and tm.team_id = any (r.teams)) then
    raise exception 'You own one of these teams too' using errcode = '42501';
  end if;
  if p_approve then
    if r.action = 'trade_decide' then
      perform private.trade_decide_exec((r.payload ->> 'trade')::bigint, (r.payload ->> 'approve')::boolean, r.payload ->> 'note');
    elsif r.action = 'reverse_drop' then
      perform private.reverse_drop_exec((r.payload ->> 'transaction')::bigint, (r.payload ->> 'reported_at')::timestamptz);
    else
      ov := jsonb_populate_record(null::public.score_overrides, r.payload -> 'row');
      if r.payload ->> 'op' = 'insert' then
        insert into public.score_overrides select ov.*;
      else
        update public.score_overrides s set active = ov.active, stats = ov.stats, points = ov.points, reason = ov.reason,
          removed_by = ov.removed_by, removed_at = ov.removed_at, removed_reason = ov.removed_reason where s.id = ov.id;
      end if;
    end if;
  end if;
  update public.officer_requests set status = case when p_approve then 'approved' else 'rejected' end, decided_by = (select auth.uid()), decided_at = now(),
    note = nullif(btrim(coalesce(p_note, '')), '') where id = p_id;
  insert into public.audit_log (actor, action, details) values ((select auth.uid()), 'coi:' || case when p_approve then 'approved' else 'rejected' end,
    jsonb_build_object('request', p_id, 'action', r.action, 'requested_by', r.requested_by, 'summary', r.summary, 'note', p_note));
  return case when p_approve then 'Approved and done' else 'Rejected' end;
end;
$$;
create function public.cancel_officer_request(p_id bigint) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.officer_requests set status = 'cancelled', decided_by = (select auth.uid()), decided_at = now()
   where id = p_id and status = 'pending' and requested_by = (select auth.uid());
  if not found then raise exception 'Only your own pending request can be cancelled' using errcode = '42501'; end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke execute on function private.active_holders(text), private.apply_role(uuid, text, boolean, uuid, text), private.flag(text), private.audit_flag(),
  private.season_modes(public.season_settings), private.coi_others(text[]), private.coi_request(text, jsonb, text[], text), private.coi_flag(text, text[], text),
  private.profile_roles_changed(), private.guard_season_modes(), private.coi_score_override() from public, anon;
grant execute on function private.apply_role(uuid, text, boolean, uuid, text), private.season_modes(public.season_settings), private.coi_others(text[]),
  private.coi_request(text, jsonb, text[], text), private.coi_flag(text, text[], text) to authenticated;
revoke execute on function public.grant_role(uuid, text), public.revoke_role(uuid, text), public.admin_set_mode(int, text, jsonb), public.admin_health(),
  public.admin_accounts(), public.admin_sign_out(uuid), public.admin_set_disabled(uuid, boolean), public.admin_test_email(), public.admin_retry_failed_emails(),
  public.trade_decide(bigint, boolean, text), public.reverse_drop(bigint, timestamptz), public.decide_officer_request(bigint, boolean, text),
  public.cancel_officer_request(bigint) from public, anon;
grant execute on function public.grant_role(uuid, text), public.revoke_role(uuid, text), public.admin_set_mode(int, text, jsonb), public.admin_health(),
  public.admin_accounts(), public.admin_sign_out(uuid), public.admin_set_disabled(uuid, boolean), public.admin_test_email(), public.admin_retry_failed_emails(),
  public.trade_decide(bigint, boolean, text), public.reverse_drop(bigint, timestamptz), public.decide_officer_request(bigint, boolean, text),
  public.cancel_officer_request(bigint) to authenticated, service_role;
