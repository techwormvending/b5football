-- Invites show "Joined" once the invited email has actually signed in.
--
-- Before: accepted_at was set when the auth account was created. But a magic-link
-- request creates the account before the link is clicked, and an account that
-- existed before its invite (e.g. the commissioner's, bootstrapped by SQL) was
-- never marked at all.
--
-- Now invites.accepted_at = the account's first sign-in (auth.users.last_sign_in_at),
-- kept in sync three ways: when the account is created, when it signs in, and when
-- an invite is added for an account that already exists. Existing rows are backfilled.

-- 1. Account created: apply the invite (profile, commissioner flag, team) as before,
--    but only link it; "joined" waits for the first sign-in.
create or replace function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  inv public.invites%rowtype;
begin
  select * into inv from public.invites i where i.email = lower(btrim(new.email));
  insert into public.profiles (id, display_name, is_commissioner)
  values (new.id,
          coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1), ''),
          coalesce(inv.is_commissioner, false));
  if inv.email is not null then
    if inv.team_id is not null then
      insert into public.team_managers (team_id, user_id) values (inv.team_id, new.id) on conflict do nothing;
    end if;
    update public.invites set user_id = new.id, accepted_at = new.last_sign_in_at where email = inv.email;
  end if;
  return new;
end;
$$;

-- 2. Account signs in: mark its invite joined (first sign-in only).
create function private.handle_user_sign_in() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.last_sign_in_at is not null then
    update public.invites
    set user_id = new.id, accepted_at = coalesce(accepted_at, new.last_sign_in_at)
    where email = lower(btrim(new.email)) and (accepted_at is null or user_id is distinct from new.id);
  end if;
  return new;
end;
$$;
create trigger on_auth_user_sign_in after update of last_sign_in_at on auth.users
  for each row execute function private.handle_user_sign_in();

-- 3. Invite added for an account that already exists: link it, mark joined if it has
--    signed in, and apply the invite's team (the commissioner flag is not applied here;
--    that stays a deliberate profile change).
create function private.link_existing_user() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  u record;
begin
  select au.id, au.last_sign_in_at into u from auth.users au where lower(btrim(au.email)) = new.email;
  if u.id is not null then
    new.user_id := u.id;
    new.accepted_at := coalesce(new.accepted_at, u.last_sign_in_at);
    if new.team_id is not null then
      insert into public.team_managers (team_id, user_id) values (new.team_id, u.id) on conflict do nothing;
    end if;
  end if;
  return new;
end;
$$;
create trigger link_existing_user before insert on public.invites
  for each row execute function private.link_existing_user();

-- 4. Backfill: every invite whose account exists gets its link and first sign-in time.
update public.invites i
set user_id = u.id, accepted_at = u.last_sign_in_at
from auth.users u
where lower(btrim(u.email)) = i.email;
