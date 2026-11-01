-- Admins can assign the commissioner and treasurer roles (2026-11-01).
-- Who may ASSIGN roles changed; what each role may DO did not (an administrator still can't touch
-- scores, trades, money or settings unless he also holds the commissioner role).
--   admin role        <- administrators
--   commissioner role <- commissioners or administrators
--   treasurer role    <- commissioners or administrators
-- Still: always at least one administrator and one commissioner (private.apply_role refuses the
-- whole call), one audit entry per change, an email to the person.
-- New flag: a person granting the commissioner role to THEMSELVES (only possible through the admin
-- power) is allowed, but audited as roles:self_grant_commissioner and every other current
-- commissioner gets an email (account notice "self_grant").

create function private.can_assign(p_role text) returns boolean
language sql stable security definer set search_path = ''
as $$ select case p_role when 'admin' then private.is_admin() else private.is_commissioner() or private.is_admin() end $$;

create function private.flag_self_commissioner(p_user uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare who text; u uuid;
begin
  select coalesce(nullif(display_name, ''), 'An administrator') into who from public.profiles where id = p_user;
  insert into public.audit_log (actor, action, details)
  values (p_user, 'roles:self_grant_commissioner', jsonb_build_object('user', p_user, 'note', 'An administrator gave themselves the commissioner role'));
  for u in select r.user_id from public.user_roles r join public.profiles p on p.id = r.user_id
           where r.role = 'commissioner' and not p.disabled and r.user_id <> p_user loop
    insert into public.notify_queue (user_id, kind, ref, due_at, payload)
    values (u, 'account', 'selfgrant:' || p_user || ':' || extract(epoch from clock_timestamp())::bigint, now(), jsonb_build_object('type', 'self_grant', 'who', who))
    on conflict do nothing;
  end loop;
end;
$$;

create or replace function public.grant_role(p_user uuid, p_role text) returns text
language plpgsql security definer set search_path = ''
as $$
declare me uuid := (select auth.uid()); ok boolean;
begin
  if p_role not in ('admin', 'commissioner', 'treasurer') then raise exception 'Unknown role' using errcode = '22023'; end if;
  if not private.can_assign(p_role) then
    raise exception '%', case p_role when 'admin' then 'Only an administrator can grant the administrator role'
      else 'Only a commissioner or an administrator can grant the ' || p_role || ' role' end using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_user) then raise exception 'No such account' using errcode = '22023'; end if;
  ok := private.apply_role(p_user, p_role, true, me, 'officers');
  if ok and p_role = 'commissioner' and p_user = me then perform private.flag_self_commissioner(me); end if;
  return case when ok then 'Granted' else 'Already held' end;
end;
$$;
create or replace function public.revoke_role(p_user uuid, p_role text) returns text
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.can_assign(p_role) then
    raise exception '%', case p_role when 'admin' then 'Only an administrator can revoke the administrator role'
      else 'Only a commissioner or an administrator can revoke the ' || p_role || ' role' end using errcode = '42501';
  end if;
  return case when private.apply_role(p_user, p_role, false, (select auth.uid()), 'officers') then 'Revoked' else 'Not held' end;
end;
$$;

create or replace function public.set_roles(p_user uuid, p_roles text[]) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  all_roles constant text[] := array['admin', 'commissioner', 'treasurer'];
  want text[] := array(select distinct x from unnest(coalesce(p_roles, '{}')) x where x is not null);
  cur text[];
  added text[] := '{}';
  removed text[] := '{}';
  r text;
  by_name text;
begin
  if exists (select 1 from unnest(want) x where x <> all (all_roles)) then raise exception 'Unknown role' using errcode = '22023'; end if;
  if not exists (select 1 from public.profiles where id = p_user) then raise exception 'No such account' using errcode = '22023'; end if;
  perform 1 from public.profiles where id = p_user for update;
  cur := array(select role from public.user_roles where user_id = p_user);
  foreach r in array all_roles loop
    if (r = any (want)) is distinct from (r = any (cur)) then
      if r = any (want) then added := added || r; else removed := removed || r; end if;
    end if;
  end loop;
  -- Every change checked against the caller's roles BEFORE anything changes.
  foreach r in array added || removed loop
    if not private.can_assign(r) then
      raise exception '%', case r when 'admin' then 'Only an administrator can change the administrator role'
        else 'Only a commissioner or an administrator can change the ' || r || ' role' end using errcode = '42501';
    end if;
  end loop;
  if cardinality(added) + cardinality(removed) = 0 then return jsonb_build_object('added', '[]'::jsonb, 'removed', '[]'::jsonb, 'roles', to_jsonb(cur)); end if;
  perform set_config('b5.role_quiet', 'on', true);
  foreach r in array added loop perform private.apply_role(p_user, r, true, me, 'officers'); end loop;
  foreach r in array removed loop perform private.apply_role(p_user, r, false, me, 'officers'); end loop;
  perform set_config('b5.role_quiet', 'off', true);
  if p_user = me and 'commissioner' = any (added) then perform private.flag_self_commissioner(me); end if;
  select coalesce(nullif(display_name, ''), 'an officer') into by_name from public.profiles where id = me;
  insert into public.notify_queue (user_id, kind, ref, due_at, payload)
  values (p_user, 'account', 'roles:' || (extract(epoch from clock_timestamp()) * 1000000)::bigint, now(),   -- microseconds: two saves in one second are two emails
          jsonb_build_object('type', 'roles', 'added', to_jsonb(added), 'removed', to_jsonb(removed), 'by', coalesce(by_name, 'the league'),
            'roles', to_jsonb(array(select role from public.user_roles where user_id = p_user order by array_position(all_roles, role)))))
  on conflict do nothing;
  return jsonb_build_object('added', to_jsonb(added), 'removed', to_jsonb(removed),
    'roles', to_jsonb(array(select role from public.user_roles where user_id = p_user order by array_position(all_roles, role))));
end;
$$;

revoke execute on function private.can_assign(text), private.flag_self_commissioner(uuid) from public, anon, authenticated;
