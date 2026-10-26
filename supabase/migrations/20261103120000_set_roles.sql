-- Several roles per person, set in one go (2026-10-25).
-- Roles were already one row per user + role (user_roles primary key (user_id, role)) and every
-- permission check asks about one role (is_admin / is_commissioner / is_treasurer), so a person's
-- rights are the union of his roles. public.set_roles(user, roles[]) sets a person's whole role set
-- at once: each change needs the right to grant that role (administrators: admin; commissioners:
-- commissioner and treasurer), checked for ALL changes before ANY is applied; the "at least one
-- administrator and one commissioner" rule still holds (the whole call is refused); one audit entry
-- per role added or removed (roles:grant / roles:revoke), and ONE email summarizing the changes.

-- apply_role sends its own email unless a caller asks for quiet (set_roles sends one summary).
create or replace function private.apply_role(p_user uuid, p_role text, p_grant boolean, p_actor uuid, p_via text) returns boolean
language plpgsql security definer set search_path = ''
as $$
declare by_name text;
begin
  if p_grant then
    insert into public.user_roles (user_id, role, granted_by) values (p_user, p_role, p_actor) on conflict do nothing;
    if not found then return false; end if;
  else
    -- Always at least one administrator and one commissioner; treasurers are optional.
    if p_role in ('admin', 'commissioner')
       and exists (select 1 from public.user_roles r join public.profiles p on p.id = r.user_id where r.user_id = p_user and r.role = p_role and not p.disabled)
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
  if coalesce(current_setting('b5.role_quiet', true), 'off') <> 'on' then
    select coalesce(nullif(display_name, ''), 'an officer') into by_name from public.profiles where id = p_actor;
    insert into public.notify_queue (user_id, kind, ref, due_at, payload)
    values (p_user, 'account', 'role:' || p_role || ':' || case when p_grant then 'grant' else 'revoke' end || ':' || extract(epoch from clock_timestamp())::bigint, now(),
            jsonb_build_object('type', 'role', 'role', p_role, 'action', case when p_grant then 'grant' else 'revoke' end, 'by', coalesce(by_name, 'the league')))
    on conflict do nothing;
  end if;
  return true;
end;
$$;

create function public.set_roles(p_user uuid, p_roles text[]) returns jsonb
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
  perform 1 from public.profiles where id = p_user for update;   -- two officers saving the same person: one waits
  cur := array(select role from public.user_roles where user_id = p_user);
  foreach r in array all_roles loop
    if (r = any (want)) is distinct from (r = any (cur)) then
      if r = any (want) then added := added || r; else removed := removed || r; end if;
    end if;
  end loop;
  -- Every change checked against the caller's roles BEFORE anything changes.
  foreach r in array added || removed loop
    if r = 'admin' and not private.is_admin() then
      raise exception 'Only an administrator can change the administrator role' using errcode = '42501';
    end if;
    if r in ('commissioner', 'treasurer') and not private.is_commissioner() then
      raise exception 'Only a commissioner can change the % role', r using errcode = '42501';
    end if;
  end loop;
  if cardinality(added) + cardinality(removed) = 0 then return jsonb_build_object('added', '[]'::jsonb, 'removed', '[]'::jsonb, 'roles', to_jsonb(cur)); end if;
  perform set_config('b5.role_quiet', 'on', true);
  foreach r in array added loop perform private.apply_role(p_user, r, true, me, 'officers'); end loop;
  foreach r in array removed loop perform private.apply_role(p_user, r, false, me, 'officers'); end loop;   -- last-holder rule refuses the whole call
  perform set_config('b5.role_quiet', 'off', true);
  select coalesce(nullif(display_name, ''), 'an officer') into by_name from public.profiles where id = me;
  insert into public.notify_queue (user_id, kind, ref, due_at, payload)
  values (p_user, 'account', 'roles:' || extract(epoch from clock_timestamp())::bigint, now(),
          jsonb_build_object('type', 'roles', 'added', to_jsonb(added), 'removed', to_jsonb(removed), 'by', coalesce(by_name, 'the league'),
            'roles', to_jsonb(array(select role from public.user_roles where user_id = p_user order by array_position(all_roles, role)))))
  on conflict do nothing;
  return jsonb_build_object('added', to_jsonb(added), 'removed', to_jsonb(removed),
    'roles', to_jsonb(array(select role from public.user_roles where user_id = p_user order by array_position(all_roles, role))));
end;
$$;
revoke execute on function public.set_roles(uuid, text[]) from public, anon;
grant execute on function public.set_roles(uuid, text[]) to authenticated, service_role;
