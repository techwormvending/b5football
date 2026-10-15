-- Invite-only accounts.
--   * public.invites: emails the commissioner has invited (optionally to a team,
--     optionally as commissioner). Commissioner-only.
--   * public.hook_before_user_created: Supabase Auth "Before User Created" hook.
--     Rejects sign-ups from emails that aren't invited. Enable it in the dashboard:
--     Authentication > Hooks > Before User Created > Postgres > public.hook_before_user_created.
--   * On first sign-in the invite is applied: team assignment and commissioner flag.
--   * Second layer, independent of the hook: league-member data (profiles, team
--     managers, decided transactions, kicked-off lineup slots) is readable only by
--     members (manages a team, or is the commissioner). An account that slipped past
--     the hook sees no more than a logged-out visitor.

create table public.invites (
  email text primary key check (email = lower(btrim(email)) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  team_id text references public.teams (id) on delete set null,
  is_commissioner boolean not null default false,
  invited_by uuid default auth.uid() references public.profiles (id) on delete set null,
  invited_at timestamptz not null default now(),
  user_id uuid references public.profiles (id) on delete set null,     -- set on first sign-in
  accepted_at timestamptz
);

alter table public.invites enable row level security;
create policy "commissioner only" on public.invites for all to authenticated
  using (private.is_commissioner()) with check (private.is_commissioner());
grant select, insert, update, delete on public.invites to authenticated;
grant all on public.invites to service_role;

-- ---------------------------------------------------------------------
-- Before User Created hook
-- ---------------------------------------------------------------------
create function public.hook_before_user_created(event jsonb) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  em text := lower(btrim(coalesce(event -> 'user' ->> 'email', '')));
begin
  if em <> '' and exists (select 1 from public.invites i where i.email = em) then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('error', jsonb_build_object(
    'http_code', 403,
    'message', 'The B5 league is invite-only. Ask the commissioner for an invite.'));
end;
$$;
revoke execute on function public.hook_before_user_created(jsonb) from public, anon, authenticated;
grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;

-- ---------------------------------------------------------------------
-- Apply the invite when the account is created (replaces the profile trigger function)
-- ---------------------------------------------------------------------
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
    update public.invites set user_id = new.id, accepted_at = now() where email = inv.email;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- Members-only reads (defense in depth)
-- ---------------------------------------------------------------------
create function private.is_member() returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.is_commissioner()
      or exists (select 1 from public.team_managers tm where tm.user_id = (select auth.uid()))
$$;
grant execute on function private.is_member() to anon, authenticated, service_role;

drop policy "members read" on public.profiles;
create policy "members read" on public.profiles for select to authenticated
  using (private.is_member() or id = (select auth.uid()));       -- everyone can see their own profile

drop policy "members read" on public.team_managers;
create policy "members read" on public.team_managers for select to authenticated
  using (private.is_member());

drop policy "members read" on public.transactions;
create policy "members read" on public.transactions for select to authenticated
  using ((private.is_member() and status in ('approved', 'processed', 'reversed'))
         or private.manages_team(team_id)
         or (partner_team_id is not null and private.manages_team(partner_team_id))
         or private.is_commissioner());

drop policy "read own or locked" on public.lineup_slots;
create policy "read own or locked" on public.lineup_slots for select to authenticated
  using (private.manages_team(team_id)
         or private.is_commissioner()
         or (private.is_member() and coalesce(private.player_kickoff(season, week, player_id) <= now(), false)));
