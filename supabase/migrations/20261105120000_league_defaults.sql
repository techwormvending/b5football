-- League default settings (2026-10-29), taken from an administrator's own settings.
-- public.league_defaults (one row): `notify` = the email-notification preferences to start people
-- with, `display` = display preferences (today: the Live page's "Show official MFL lineups").
-- What's copied is a whitelist of notification choices: dm, mentions, trades, league_trades,
-- waivers, league_waivers, league_moves, lineup_saved, lineup (bye/out reminders), league_lineups
-- (off/digest/instant), league_lineups_opponent, scoring, announcements. NEVER copied: "Pause all
-- email", contact info, display name, payment preferences, team, roles, and role notices (account
-- notices for officers and treasurers aren't settings at all: they follow the role).
-- notify_settings.customized: true once the person (or their unsubscribe link) changed anything;
-- only changes made by the defaults machinery (session setting b5.defaults = on) leave it false.
-- New accounts get the defaults when the account is created; "apply to users who haven't
-- customized" never touches a customized row; "Reset to league defaults" on the Account page
-- un-customizes. Pause is always kept as it is.

create table public.league_defaults (
  id boolean primary key default true check (id),
  notify jsonb not null default '{}',
  display jsonb not null default '{}',
  set_by uuid references public.profiles (id) on delete set null,
  set_at timestamptz not null default now()
);
alter table public.league_defaults enable row level security;
create policy "everyone reads" on public.league_defaults for select to anon, authenticated using (true);
revoke all on public.league_defaults from anon, authenticated;
grant select on public.league_defaults to anon, authenticated;
grant all on public.league_defaults to service_role;

alter table public.notify_settings add column customized boolean not null default true;   -- existing rows were saved by their owners
alter table public.notify_settings alter column customized set default false;

-- Changes not made by the defaults machinery mark the row customized.
create or replace function private.guard_notify_settings() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if not private.is_privileged() then new.user_id := (select auth.uid()); end if;
  new.updated_at := now();
  new.customized := coalesce(current_setting('b5.defaults', true), 'off') <> 'on';
  return new;
end;
$$;

-- The notification keys a template may carry, and the built-in defaults (the column defaults).
create function private.notify_template_keys() returns text[]
language sql immutable set search_path = ''
as $$ select array['dm', 'mentions', 'trades', 'league_trades', 'waivers', 'league_waivers', 'league_moves', 'lineup_saved', 'lineup',
                   'league_lineups', 'league_lineups_opponent', 'scoring', 'announcements'] $$;
create function private.builtin_notify_defaults() returns jsonb
language sql immutable set search_path = ''
as $$ select '{"dm": true, "mentions": false, "trades": true, "league_trades": false, "waivers": true, "league_waivers": false, "league_moves": false,
               "lineup_saved": true, "lineup": false, "league_lineups": "off", "league_lineups_opponent": false, "scoring": false, "announcements": true}'::jsonb $$;
-- Only whitelisted keys, with the right types (anything else is dropped).
create function private.clean_notify_template(p jsonb) returns jsonb
language sql immutable set search_path = ''
as $$
  select coalesce(jsonb_object_agg(k, v), '{}') from jsonb_each(coalesce(p, '{}')) e(k, v)
  where k = any (private.notify_template_keys())
    and ((k = 'league_lineups' and v #>> '{}' in ('off', 'digest', 'instant')) or (k <> 'league_lineups' and jsonb_typeof(v) = 'boolean'))
$$;
create function private.current_notify_template() returns jsonb
language sql stable security definer set search_path = ''
as $$ select private.builtin_notify_defaults() || coalesce((select private.clean_notify_template(d.notify) from public.league_defaults d), '{}') $$;

-- Write the template into one person's row (keeps their pause). force = also over a customized row.
create function private.apply_notify_template(p_user uuid, p_force boolean) returns boolean
language plpgsql security definer set search_path = ''
as $$
declare t jsonb := private.current_notify_template();
begin
  if not p_force and exists (select 1 from public.notify_settings where user_id = p_user and customized) then return false; end if;
  perform set_config('b5.defaults', 'on', true);
  insert into public.notify_settings (user_id, dm, mentions, trades, league_trades, waivers, league_waivers, league_moves, lineup_saved, lineup,
                                      league_lineups, league_lineups_opponent, scoring, announcements)
  values (p_user, (t->>'dm')::boolean, (t->>'mentions')::boolean, (t->>'trades')::boolean, (t->>'league_trades')::boolean, (t->>'waivers')::boolean,
          (t->>'league_waivers')::boolean, (t->>'league_moves')::boolean, (t->>'lineup_saved')::boolean, (t->>'lineup')::boolean,
          t->>'league_lineups', (t->>'league_lineups_opponent')::boolean, (t->>'scoring')::boolean, (t->>'announcements')::boolean)
  on conflict (user_id) do update set dm = excluded.dm, mentions = excluded.mentions, trades = excluded.trades, league_trades = excluded.league_trades,
    waivers = excluded.waivers, league_waivers = excluded.league_waivers, league_moves = excluded.league_moves, lineup_saved = excluded.lineup_saved,
    lineup = excluded.lineup, league_lineups = excluded.league_lineups, league_lineups_opponent = excluded.league_lineups_opponent,
    scoring = excluded.scoring, announcements = excluded.announcements;   -- paused untouched
  perform set_config('b5.defaults', 'off', true);
  return true;
end;
$$;

-- Admin: "Use my settings as league defaults" (whoever clicks it).
create function public.admin_save_defaults(p_display jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare me uuid := (select auth.uid()); mine jsonb; t jsonb; disp jsonb;
begin
  if not private.is_admin() then raise exception 'Only an administrator can set the league defaults' using errcode = '42501'; end if;
  select to_jsonb(s) into mine from public.notify_settings s where s.user_id = me;
  t := private.builtin_notify_defaults() || private.clean_notify_template(mine);
  disp := case when jsonb_typeof(p_display -> 'liveShowOfficial') = 'boolean' then jsonb_build_object('liveShowOfficial', p_display -> 'liveShowOfficial') else '{}' end;
  insert into public.league_defaults (id, notify, display, set_by, set_at) values (true, t, disp, me, now())
  on conflict (id) do update set notify = excluded.notify, display = excluded.display, set_by = excluded.set_by, set_at = excluded.set_at;
  insert into public.audit_log (actor, action, details) values (me, 'defaults:save', jsonb_build_object('notify', t, 'display', disp));
  return jsonb_build_object('notify', t, 'display', disp);
end;
$$;

-- Admin: "Apply defaults to users who haven't customized" (preview = only count them).
create function public.admin_apply_defaults(p_preview boolean default true) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare me uuid := (select auth.uid()); n int := 0; u uuid;
begin
  if not private.is_admin() then raise exception 'Only an administrator can apply the league defaults' using errcode = '42501'; end if;
  if not exists (select 1 from public.league_defaults) then raise exception 'Save league defaults first' using errcode = '22023'; end if;
  for u in select p.id from public.profiles p left join public.notify_settings s on s.user_id = p.id
           where not p.disabled and not coalesce(s.customized, false) order by p.id loop
    n := n + 1;
    if not p_preview then perform private.apply_notify_template(u, false); end if;
  end loop;
  if not p_preview then
    insert into public.audit_log (actor, action, details) values (me, 'defaults:apply', jsonb_build_object('users', n, 'notify', private.current_notify_template()));
  end if;
  return jsonb_build_object('users', n, 'applied', not p_preview);
end;
$$;

-- Account page: "Reset to league defaults" (your own row; your pause stays).
create function public.reset_my_notify_settings() returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if (select auth.uid()) is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  perform private.apply_notify_template((select auth.uid()), true);
end;
$$;

-- New accounts start with the league defaults (when some were saved).
create function private.new_user_defaults() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if exists (select 1 from public.league_defaults) then perform private.apply_notify_template(new.id, false); end if;
  return null;
end;
$$;
create trigger new_user_defaults after insert on public.profiles for each row execute function private.new_user_defaults();

revoke execute on function public.admin_save_defaults(jsonb), public.admin_apply_defaults(boolean), public.reset_my_notify_settings() from public, anon;
grant execute on function public.admin_save_defaults(jsonb), public.admin_apply_defaults(boolean), public.reset_my_notify_settings() to authenticated, service_role;
revoke execute on function private.apply_notify_template(uuid, boolean), private.new_user_defaults(), private.current_notify_template() from public, anon, authenticated;
