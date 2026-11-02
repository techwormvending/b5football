-- Draft Room (2026-11-02): the 2027 draft, plus practice (mock) drafts usable now.
--
-- Format, B5 "redraw serpentine": teams x rounds (setting, 18); ODD rounds get a NEW order (drawn
-- at random, cryptographically fair, or entered by the commissioner); EVEN rounds are the exact
-- reverse of the round before. Odd-round orders are set either all before the draft or live at the
-- start of each odd round (default: the draft waits in 'awaiting_order' until the commissioner draws
-- or enters it). A draw can be redone until a pick of that round is made. A pick is owned as "Round N,
-- originally Team X" (public.draft_picks, tradable since 20261025): its slot is that round's order
-- position of the original team, so traded picks work before orders are drawn. Mock drafts use the
-- real teams, no traded picks, optional bot seats, and never touch rosters.
--
-- The SERVER keeps the clock: drafts.clock_ends_at; private.draft_tick() (pg_cron every 5 seconds,
-- and any member's page when its countdown hits zero) acts on expired clocks: auto-pick (top of the
-- team's queue, else best available by rank, else first by name) or skip (the team picks late,
-- catch-up allowed any time), per the draft's setting. Bot seats pick about 2 seconds after they
-- come on the clock. Every pick is checked here: the right team (or the commissioner), the expected
-- pick number (two co-owners racing: the first wins, the second gets "already made"), the player
-- available. Commissioner actions are audited; B5 Bot posts picks, on-the-clock and draw results in
-- the Draft chat room; draft_state (the Draft room header) follows the live draft.

create table public.drafts (
  id bigint generated always as identity primary key,
  season int not null,
  kind text not null check (kind in ('real', 'mock')),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  teams text[] not null,                         -- the seats (team ids)
  bots text[] not null default '{}',             -- mock: seats drafted by bots
  rounds int not null default 18 check (rounds between 1 and 40),
  timer_seconds int not null default 180 check (timer_seconds between 10 and 3600),
  order_mode text not null default 'live' check (order_mode in ('before', 'live')),
  expiry text not null default 'autopick' check (expiry in ('autopick', 'skip')),
  status text not null default 'setup' check (status in ('setup', 'live', 'paused', 'awaiting_order', 'done', 'complete')),
  current_overall int,
  clock_ends_at timestamptz,
  paused_remaining int,
  starts_at timestamptz,
  reminded_at timestamptz,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);
create unique index drafts_one_real on public.drafts (season) where kind = 'real';

create table public.draft_orders (
  draft_id bigint not null references public.drafts (id) on delete cascade,
  round int not null check (round % 2 = 1),
  teams text[] not null,
  method text not null check (method in ('auto', 'manual')),
  draw_keys text[],                              -- auto: each team's random key (uuid), the order sorts them
  set_by uuid,
  set_at timestamptz not null default now(),
  primary key (draft_id, round)
);

create table public.draft_selections (
  draft_id bigint not null references public.drafts (id) on delete cascade,
  overall int not null,
  round int not null,
  pick int not null,
  team_id text not null references public.teams (id),         -- who picks (the pick's owner)
  original_team text not null references public.teams (id),   -- "originally Team X"
  player_id text references public.nfl_players (id),          -- null while skipped
  skipped boolean not null default false,
  auto boolean not null default false,
  picked_by uuid,
  picked_at timestamptz,
  primary key (draft_id, overall),
  check (skipped or player_id is not null)
);
create unique index draft_selections_player on public.draft_selections (draft_id, player_id) where player_id is not null;

create table public.draft_queue (
  draft_id bigint not null references public.drafts (id) on delete cascade,
  team_id text not null references public.teams (id),
  player_id text not null references public.nfl_players (id),
  rank int not null,
  updated_by uuid default auth.uid(),
  primary key (draft_id, team_id, player_id)
);

create table public.draft_rankings (
  season int not null,
  player_id text not null references public.nfl_players (id),
  rank numeric not null,
  source text not null,
  uploaded_at timestamptz not null default now(),
  primary key (season, player_id)
);

alter table public.drafts enable row level security;
alter table public.draft_orders enable row level security;
alter table public.draft_selections enable row level security;
alter table public.draft_queue enable row level security;
alter table public.draft_rankings enable row level security;
create policy "members read" on public.drafts for select to authenticated using (private.is_member());
create policy "members read" on public.draft_orders for select to authenticated using (private.is_member());
create policy "members read" on public.draft_selections for select to authenticated using (private.is_member());
create policy "members read" on public.draft_rankings for select to authenticated using (private.is_member());
create policy "own team" on public.draft_queue for all to authenticated
  using (private.manages_team(team_id) or private.is_commissioner()) with check (private.manages_team(team_id));
grant select on public.drafts, public.draft_orders, public.draft_selections, public.draft_rankings to authenticated;
grant select, insert, update, delete on public.draft_queue to authenticated;
grant all on public.drafts, public.draft_orders, public.draft_selections, public.draft_queue, public.draft_rankings to service_role;

-- Realtime: the room follows these (RLS applies per subscriber)
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.drafts, public.draft_orders, public.draft_selections;
  end if;
end $$;

-- The server's clock, so every browser counts down the same timer (offset from the local clock).
create function public.server_now() returns timestamptz language sql stable set search_path = '' as $$ select now() $$;
grant execute on function public.server_now() to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Order and slots (the same rules as draftlogic.js)
-- ---------------------------------------------------------------------------
create function private.draft_round_order(p_draft bigint, p_round int) returns text[]
language sql stable security definer set search_path = ''
as $$
  select case when p_round % 2 = 1 then (select o.teams from public.draft_orders o where o.draft_id = p_draft and o.round = p_round)
              else (select array(select t from unnest(o.teams) with ordinality u(t, i) order by i desc) from public.draft_orders o where o.draft_id = p_draft and o.round = p_round - 1) end
$$;

-- The slot for an overall pick: round, pick in round, original team, owner (traded picks, real drafts only).
create function private.draft_slot(p_draft bigint, p_overall int, out round int, out pick int, out original text, out owner text)
language plpgsql stable security definer set search_path = ''
as $$
declare d public.drafts; n int; ord text[];
begin
  select * into d from public.drafts where id = p_draft;
  n := cardinality(d.teams);
  round := (p_overall - 1) / n + 1; pick := (p_overall - 1) % n + 1;
  ord := private.draft_round_order(p_draft, round);
  if ord is null then original := null; owner := null; return; end if;
  original := ord[pick];
  owner := original;
  if d.kind = 'real' then
    select dp.owner_team into owner from public.draft_picks dp where dp.season = d.season and dp.round = draft_slot.round and dp.original_team = original;
    owner := coalesce(owner, original);
  end if;
end;
$$;

create function private.draft_name(p_team text) returns text
language sql stable security definer set search_path = ''
as $$ select coalesce((select t.name from public.teams t where t.id = p_team), p_team) $$;

-- Draft emails (kind 'draft', the user's "Draft alerts" setting): on the clock, 2 picks away, start reminder, results.
create function private.draft_notify(p_team text, p_ref text, p_payload jsonb) returns void
language plpgsql security definer set search_path = ''
as $$
declare u uuid;
begin
  for u in select m.user_id from public.team_managers m where m.team_id = p_team loop
    if private.notify_on(u, 'draft') then
      insert into public.notify_queue (user_id, kind, ref, due_at, payload) values (u, 'draft', p_ref, now(), p_payload) on conflict do nothing;
    end if;
  end loop;
end;
$$;

-- Move the draft to its next open pick: live with a fresh clock, 'awaiting_order' when that odd
-- round's order isn't set, or 'done' after the last pick. Posts "on the clock", emails the team (and
-- the one 2 picks away), and mirrors the live draft into draft_state for the chat header.
create function private.draft_advance(p_draft bigint) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  d public.drafts;
  nxt int;
  total int;
  s record;
  soon record;
  secs int;
begin
  select * into d from public.drafts where id = p_draft for update;
  total := cardinality(d.teams) * d.rounds;
  select min(o) into nxt from generate_series(1, total) o
   where not exists (select 1 from public.draft_selections x where x.draft_id = p_draft and x.overall = o);
  if nxt is null then
    update public.drafts set status = 'done', current_overall = null, clock_ends_at = null, paused_remaining = null, updated_at = now() where id = p_draft;
    perform private.chat_bot_post('draft', '🏁 ' || d.name || ': the draft is complete. The commissioner finalizes it to fill the rosters.', jsonb_build_object('kind', 'end', 'draft', p_draft));
    update public.draft_state set status = 'done', team_id = null, clock_ends_at = null, paused_remaining = null, updated_at = now();
    return;
  end if;
  s := private.draft_slot(p_draft, nxt);
  if s.owner is null then
    update public.drafts set status = 'awaiting_order', current_overall = nxt, clock_ends_at = null, paused_remaining = null, updated_at = now() where id = p_draft;
    perform private.chat_bot_post('draft', '🎩 Round ' || s.round || ' starts with a new order: waiting for the commissioner to draw it.', jsonb_build_object('kind', 'paused', 'draft', p_draft));
    update public.draft_state set status = 'paused', round = s.round, pick = s.pick, overall = nxt, team_id = null, clock_ends_at = null, updated_at = now();
    return;
  end if;
  secs := case when s.owner = any (d.bots) then 2 else d.timer_seconds end;
  update public.drafts set status = 'live', current_overall = nxt, clock_ends_at = now() + make_interval(secs => secs), paused_remaining = null, updated_at = now() where id = p_draft;
  update public.draft_state set status = 'live', season = d.season, round = s.round, pick = s.pick, overall = nxt, team_id = s.owner,
    clock_ends_at = now() + make_interval(secs => secs), paused_remaining = null, updated_at = now();
  if not (s.owner = any (d.bots)) then
    perform private.chat_bot_post('draft', '⏰ On the clock: ' || private.draft_name(s.owner) || ' (Round ' || s.round || ', Pick ' || s.pick ||
      case when s.owner <> s.original then ', from ' || private.draft_name(s.original) else '' end || ')',
      jsonb_build_object('kind', 'on_clock', 'draft', p_draft, 'overall', nxt, 'team', s.owner));
    perform private.draft_notify(s.owner, 'draft:' || p_draft || ':clock:' || nxt,
      jsonb_build_object('type', 'clock', 'draft', d.name, 'draft_id', p_draft, 'team', private.draft_name(s.owner), 'round', s.round, 'pick', s.pick, 'seconds', d.timer_seconds, 'link', '#draft/' || p_draft));
    if nxt + 2 <= total then
      soon := private.draft_slot(p_draft, nxt + 2);
      if soon.owner is not null and soon.owner <> s.owner and not (soon.owner = any (d.bots))
         and soon.owner <> (private.draft_slot(p_draft, nxt + 1)).owner then
        perform private.draft_notify(soon.owner, 'draft:' || p_draft || ':soon:' || (nxt + 2),
          jsonb_build_object('type', 'soon', 'draft', d.name, 'draft_id', p_draft, 'team', private.draft_name(soon.owner), 'round', soon.round, 'pick', soon.pick, 'link', '#draft/' || p_draft));
      end if;
    end if;
  end if;
end;
$$;

-- Record a pick (validated by the caller): insert or fill a skipped slot, mark a real pick used, post it.
create function private.draft_record(p_draft bigint, p_overall int, p_team text, p_original text, p_player text, p_by uuid, p_auto boolean) returns void
language plpgsql security definer set search_path = ''
as $$
declare d public.drafts; pos record; who text;
begin
  select * into d from public.drafts where id = p_draft;
  insert into public.draft_selections (draft_id, overall, round, pick, team_id, original_team, player_id, skipped, auto, picked_by, picked_at)
  values (p_draft, p_overall, (p_overall - 1) / cardinality(d.teams) + 1, (p_overall - 1) % cardinality(d.teams) + 1, p_team, p_original, p_player, false, p_auto, p_by, now())
  on conflict (draft_id, overall) do update set player_id = excluded.player_id, skipped = false, auto = excluded.auto, picked_by = excluded.picked_by, picked_at = now();
  delete from public.draft_queue q where q.draft_id = p_draft and q.player_id = p_player;
  if d.kind = 'real' then
    update public.draft_picks dp set used = true where dp.season = d.season and dp.round = (p_overall - 1) / cardinality(d.teams) + 1 and dp.original_team = p_original;
  end if;
  select np.name, np.position, np.nfl_team into pos from public.nfl_players np where np.id = p_player;
  select nullif(p.display_name, '') into who from public.profiles p where p.id = p_by;
  perform private.chat_bot_post('draft', '✅ ' || private.draft_name(p_team) || ' select ' || coalesce(pos.name, p_player) ||
    coalesce(', ' || nullif(btrim(concat_ws(' ', pos.position, pos.nfl_team)), ''), '') ||
    ' (Round ' || ((p_overall - 1) / cardinality(d.teams) + 1) || ', Pick ' || ((p_overall - 1) % cardinality(d.teams) + 1) || ')' ||
    case when p_auto then ' · auto-pick' when who is not null then ' · by ' || who else '' end,
    jsonb_build_object('kind', 'pick', 'draft', p_draft, 'overall', p_overall, 'team', p_team, 'player', p_player));
end;
$$;

-- The auto-pick: top available player of the team's queue, else best available by rank, else first by name.
create function private.draft_autopick_player(p_draft bigint, p_team text) returns text
language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (select q.player_id from public.draft_queue q where q.draft_id = p_draft and q.team_id = p_team
       and not exists (select 1 from public.draft_selections x where x.draft_id = p_draft and x.player_id = q.player_id) order by q.rank, q.player_id limit 1),
    (select r.player_id from public.draft_rankings r join public.drafts d on d.id = p_draft and r.season = d.season
       where not exists (select 1 from public.draft_selections x where x.draft_id = p_draft and x.player_id = r.player_id) order by r.rank, r.player_id limit 1),
    (select p.id from public.nfl_players p where p.position in ('QB', 'RB', 'WR', 'TE', 'K', 'DEF')
       and not exists (select 1 from public.draft_selections x where x.draft_id = p_draft and x.player_id = p.id) order by p.name, p.id limit 1))
$$;

-- ---------------------------------------------------------------------------
-- Picks
-- ---------------------------------------------------------------------------
-- p_overall: the pick you're making (the one on the clock, or one of your skipped picks to catch up).
create function public.draft_pick(p_draft bigint, p_player text, p_overall int default null) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  d public.drafts;
  target int;
  s record;
  sk public.draft_selections;
  team text;
  orig text;
begin
  select * into d from public.drafts where id = p_draft for update;
  if d.id is null then raise exception 'No such draft' using errcode = '22023'; end if;
  if not private.is_member() then raise exception 'Only league members draft' using errcode = '42501'; end if;
  target := coalesce(p_overall, d.current_overall);
  select * into sk from public.draft_selections x where x.draft_id = p_draft and x.overall = target;
  if sk.overall is not null and not sk.skipped then
    raise exception 'That pick was already made (Round %, Pick %)', sk.round, sk.pick using errcode = '40001';
  end if;
  if sk.overall is not null then
    team := sk.team_id; orig := sk.original_team;                   -- catching up on a skipped pick: any time
    if d.status not in ('live', 'paused', 'awaiting_order', 'done') then raise exception 'The draft isn''t running' using errcode = '42501'; end if;
  else
    if d.status <> 'live' then raise exception 'The draft isn''t live right now (%)', replace(d.status, '_', ' ') using errcode = '42501'; end if;
    if target is distinct from d.current_overall then raise exception 'That pick was already made' using errcode = '40001'; end if;
    s := private.draft_slot(p_draft, target);
    team := s.owner; orig := s.original;
  end if;
  if not (private.manages_team(team) or private.is_commissioner()) then
    raise exception '% is on the clock, not your team', private.draft_name(team) using errcode = '42501';
  end if;
  if not exists (select 1 from public.nfl_players p where p.id = p_player and p.position in ('QB', 'RB', 'WR', 'TE', 'K', 'DEF')) then
    raise exception 'Unknown player' using errcode = '22023';
  end if;
  if exists (select 1 from public.draft_selections x where x.draft_id = p_draft and x.player_id = p_player) then
    raise exception 'That player is already drafted' using errcode = '23505';
  end if;
  perform private.draft_record(p_draft, target, team, orig, p_player, (select auth.uid()), false);
  if private.is_commissioner() and not private.manages_team(team) then
    insert into public.audit_log (actor, action, details) values ((select auth.uid()), 'draft:pick_for_team',
      jsonb_build_object('draft', p_draft, 'overall', target, 'team', team, 'player', p_player));
  end if;
  if sk.overall is null then perform private.draft_advance(p_draft); end if;
  return jsonb_build_object('overall', target, 'team', team, 'player', p_player);
end;
$$;

-- Expired clocks (and bot seats): auto-pick or skip. Runs from pg_cron every 5 seconds and from any
-- member's page when its countdown reaches zero; does nothing unless a clock has actually run out.
create function private.draft_tick_one(p_draft bigint) returns boolean
language plpgsql security definer set search_path = ''
as $$
declare d public.drafts; s record; pl text;
begin
  select * into d from public.drafts where id = p_draft for update skip locked;
  if d.id is null or d.status <> 'live' or d.clock_ends_at is null or d.clock_ends_at > now() then return false; end if;
  s := private.draft_slot(p_draft, d.current_overall);
  if s.owner = any (d.bots) or d.expiry = 'autopick' then
    pl := private.draft_autopick_player(p_draft, s.owner);
    if pl is null then return false; end if;
    perform private.draft_record(p_draft, d.current_overall, s.owner, s.original, pl, null, true);
  else
    insert into public.draft_selections (draft_id, overall, round, pick, team_id, original_team, skipped)
    values (p_draft, d.current_overall, s.round, s.pick, s.owner, s.original, true);
    perform private.chat_bot_post('draft', '⏭️ Time ran out: ' || private.draft_name(s.owner) || ' (Round ' || s.round || ', Pick ' || s.pick || ') picks later', jsonb_build_object('kind', 'skip', 'draft', p_draft));
  end if;
  perform private.draft_advance(p_draft);
  return true;
end;
$$;
create function public.draft_tick(p_draft bigint default null) returns int
language plpgsql security definer set search_path = ''
as $$
declare r record; n int := 0; d public.drafts;
begin
  if (select auth.uid()) is not null and not private.is_member() then return 0; end if;
  for r in select id from public.drafts where status = 'live' and clock_ends_at <= now() and (p_draft is null or id = p_draft) loop
    if private.draft_tick_one(r.id) then n := n + 1; end if;
  end loop;
  -- Start reminders: once, an hour before a scheduled start
  if p_draft is null then
    for d in select * from public.drafts where status = 'setup' and starts_at is not null and reminded_at is null
               and starts_at between now() and now() + interval '1 hour' for update skip locked loop
      update public.drafts set reminded_at = now() where id = d.id;
      perform private.draft_notify(t, 'draft:' || d.id || ':start', jsonb_build_object('type', 'start', 'draft', d.name, 'draft_id', d.id, 'starts_at', d.starts_at, 'link', '#draft/' || d.id))
        from unnest(d.teams) t where not (t = any (d.bots));
    end loop;
  end if;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- Commissioner: create, settings, orders, start/pause/resume/extend, undo, edit, complete, delete
-- ---------------------------------------------------------------------------
create function private.draft_need_commissioner() returns void
language plpgsql stable security definer set search_path = ''
as $$ begin
  if not private.is_commissioner() then raise exception 'Only the commissioner runs the draft' using errcode = '42501'; end if;
end; $$;

create function private.draft_audit(p_action text, p_details jsonb) returns void
language sql security definer set search_path = ''
as $$ insert into public.audit_log (actor, action, details) values ((select auth.uid()), 'draft:' || p_action, p_details) $$;

create function public.draft_create(p_season int, p_kind text, p_name text, p_settings jsonb default '{}') returns bigint
language plpgsql security definer set search_path = ''
as $$
declare id bigint; teams text[];
begin
  perform private.draft_need_commissioner();
  select array_agg(t.id order by t.id) into teams from public.teams t;
  insert into public.drafts (season, kind, name, teams, bots, rounds, timer_seconds, order_mode, expiry, starts_at)
  values (p_season, p_kind, p_name, teams,
    coalesce(array(select jsonb_array_elements_text(p_settings -> 'bots')), '{}'),
    coalesce((p_settings ->> 'rounds')::int, 18), coalesce((p_settings ->> 'timer_seconds')::int, 180),
    coalesce(p_settings ->> 'order_mode', 'live'), coalesce(p_settings ->> 'expiry', 'autopick'), (p_settings ->> 'starts_at')::timestamptz)
  returning drafts.id into id;
  if p_kind = 'real' then perform private.ensure_draft_picks(p_season, coalesce((p_settings ->> 'rounds')::int, 18)); end if;
  perform private.draft_audit('create', jsonb_build_object('draft', id, 'kind', p_kind, 'name', p_name, 'settings', p_settings));
  return id;
end;
$$;

create function public.draft_settings(p_draft bigint, p_settings jsonb) returns void
language plpgsql security definer set search_path = ''
as $$
declare d public.drafts;
begin
  perform private.draft_need_commissioner();
  select * into d from public.drafts where id = p_draft for update;
  if d.status <> 'setup' and (p_settings ?| array['rounds', 'order_mode', 'bots']) then
    raise exception 'Rounds, order timing and bots can only change before the draft starts' using errcode = '42501';
  end if;
  update public.drafts set
    name = coalesce(p_settings ->> 'name', name),
    rounds = coalesce((p_settings ->> 'rounds')::int, rounds),
    timer_seconds = coalesce((p_settings ->> 'timer_seconds')::int, timer_seconds),
    order_mode = coalesce(p_settings ->> 'order_mode', order_mode),
    expiry = coalesce(p_settings ->> 'expiry', expiry),
    bots = case when p_settings ? 'bots' then array(select jsonb_array_elements_text(p_settings -> 'bots')) else bots end,
    starts_at = case when p_settings ? 'starts_at' then (p_settings ->> 'starts_at')::timestamptz else starts_at end,
    reminded_at = case when p_settings ? 'starts_at' then null else reminded_at end,
    updated_at = now()
  where id = p_draft;
  if d.kind = 'real' and p_settings ? 'rounds' then perform private.ensure_draft_picks(d.season, (p_settings ->> 'rounds')::int); end if;
  perform private.draft_audit('settings', jsonb_build_object('draft', p_draft, 'settings', p_settings));
end;
$$;

-- An odd round's order: p_teams = the commissioner's order (names from a hat), or null = a fair random
-- draw (each team gets a random uuid key from the database's strong random source; the order sorts the keys).
create function public.draft_set_order(p_draft bigint, p_round int, p_teams text[] default null) returns text[]
language plpgsql security definer set search_path = ''
as $$
declare d public.drafts; ord text[]; keys text[]; prev public.draft_orders; dup text;
begin
  perform private.draft_need_commissioner();
  select * into d from public.drafts where id = p_draft for update;
  if p_round % 2 = 0 or p_round < 1 or p_round > d.rounds then raise exception 'Orders are set for odd rounds 1 to %', d.rounds using errcode = '22023'; end if;
  if exists (select 1 from public.draft_selections x where x.draft_id = p_draft and x.round = p_round) then
    raise exception 'Round % already has picks: its order can''t change', p_round using errcode = '42501';
  end if;
  if p_teams is null then
    select array_agg(t order by k), array_agg(k::text order by k) into ord, keys
      from (select t, gen_random_uuid() as k from unnest(d.teams) t) x;
  else
    if cardinality(p_teams) <> cardinality(d.teams) then raise exception 'The order needs all % teams', cardinality(d.teams) using errcode = '22023'; end if;
    select t into dup from unnest(p_teams) t group by t having count(*) > 1 limit 1;
    if dup is not null then raise exception 'A team is in the order twice: %', private.draft_name(dup) using errcode = '22023'; end if;
    if exists (select 1 from unnest(p_teams) t where not (t = any (d.teams))) then raise exception 'Unknown team in the order' using errcode = '22023'; end if;
    ord := p_teams;
  end if;
  select * into prev from public.draft_orders o where o.draft_id = p_draft and o.round = p_round;
  insert into public.draft_orders (draft_id, round, teams, method, draw_keys, set_by, set_at)
  values (p_draft, p_round, ord, case when p_teams is null then 'auto' else 'manual' end, keys, (select auth.uid()), now())
  on conflict (draft_id, round) do update set teams = excluded.teams, method = excluded.method, draw_keys = excluded.draw_keys, set_by = excluded.set_by, set_at = now();
  perform private.draft_audit(case when prev.round is not null then 'order_redone' when p_teams is null then 'order_drawn' else 'order_set' end,
    jsonb_build_object('draft', p_draft, 'round', p_round, 'order', ord, 'method', case when p_teams is null then 'auto' else 'manual' end,
      'keys', keys, 'previous', prev.teams, 'at', now()));
  perform private.chat_bot_post('draft', '🎩 Round ' || p_round || ' order (' || case when p_teams is null then 'drawn' else 'set by the commissioner' end || '): ' ||
    (select string_agg(i || '. ' || private.draft_name(t), ', ' order by i) from unnest(ord) with ordinality u(t, i)) ||
    '. Round ' || (p_round + 1) || ' is the reverse.', jsonb_build_object('kind', 'order', 'draft', p_draft, 'round', p_round, 'order', ord));
  if d.status = 'awaiting_order' then perform private.draft_advance(p_draft); end if;
  return ord;
end;
$$;

create function public.draft_control(p_draft bigint, p_action text, p_seconds int default null) returns text
language plpgsql security definer set search_path = ''
as $$
declare d public.drafts; r int; left_s int;
begin
  perform private.draft_need_commissioner();
  select * into d from public.drafts where id = p_draft for update;
  if p_action = 'start' then
    if d.status <> 'setup' then raise exception 'The draft has already started' using errcode = '42501'; end if;
    if d.order_mode = 'before' then
      for r in select g from generate_series(1, d.rounds, 2) g loop
        if not exists (select 1 from public.draft_orders o where o.draft_id = p_draft and o.round = r) then
          raise exception 'Set every odd round''s order first (round % is missing)', r using errcode = '42501';
        end if;
      end loop;
    end if;
    perform private.chat_bot_post('draft', '🏈 ' || d.name || ' is live!', jsonb_build_object('kind', 'start', 'draft', p_draft));
    perform private.draft_advance(p_draft);
  elsif p_action = 'pause' then
    if d.status <> 'live' then raise exception 'The draft isn''t live' using errcode = '42501'; end if;
    left_s := greatest(0, ceil(extract(epoch from d.clock_ends_at - now()))::int);
    update public.drafts set status = 'paused', paused_remaining = left_s, clock_ends_at = null, updated_at = now() where id = p_draft;
    update public.draft_state set status = 'paused', paused_remaining = left_s, clock_ends_at = null, updated_at = now();
    perform private.chat_bot_post('draft', '⏸️ The commissioner paused the draft', jsonb_build_object('kind', 'paused', 'draft', p_draft));
  elsif p_action = 'resume' then
    if d.status <> 'paused' then raise exception 'The draft isn''t paused' using errcode = '42501'; end if;
    update public.drafts set status = 'live', clock_ends_at = now() + make_interval(secs => greatest(coalesce(d.paused_remaining, d.timer_seconds), 10)), paused_remaining = null, updated_at = now() where id = p_draft;
    update public.draft_state set status = 'live', clock_ends_at = now() + make_interval(secs => greatest(coalesce(d.paused_remaining, d.timer_seconds), 10)), paused_remaining = null, updated_at = now();
    perform private.chat_bot_post('draft', '▶️ The draft resumed', jsonb_build_object('kind', 'resumed', 'draft', p_draft));
  elsif p_action = 'extend' then
    if d.status = 'live' then
      update public.drafts set clock_ends_at = clock_ends_at + make_interval(secs => coalesce(p_seconds, 60)), updated_at = now() where id = p_draft;
      update public.draft_state set clock_ends_at = clock_ends_at + make_interval(secs => coalesce(p_seconds, 60)), updated_at = now();
    elsif d.status = 'paused' then
      update public.drafts set paused_remaining = paused_remaining + coalesce(p_seconds, 60), updated_at = now() where id = p_draft;
    else raise exception 'The draft isn''t running' using errcode = '42501'; end if;
  elsif p_action = 'complete' then
    if d.status <> 'done' then raise exception 'Finish every pick first' using errcode = '42501'; end if;
    if exists (select 1 from public.draft_selections x where x.draft_id = p_draft and x.skipped) then
      raise exception 'Some skipped picks haven''t been made yet' using errcode = '42501';
    end if;
    if d.kind = 'real' then
      insert into public.roster_entries (season, team_id, player_id, acquired)
      select d.season, x.team_id, x.player_id, x.round || '.' || lpad(x.pick::text, 2, '0') from public.draft_selections x where x.draft_id = p_draft
      on conflict (season, player_id) do update set team_id = excluded.team_id, acquired = excluded.acquired, acquired_at = now();
    end if;
    update public.drafts set status = 'complete', completed_at = now(), updated_at = now() where id = p_draft;
    update public.draft_state set status = 'done', team_id = null, clock_ends_at = null, updated_at = now();
    -- Results email: every owner
    perform private.draft_notify(t, 'draft:' || p_draft || ':results', jsonb_build_object('type', 'results', 'draft', d.name, 'draft_id', p_draft, 'team', private.draft_name(t),
      'mock', d.kind = 'mock', 'link', '#draft/' || p_draft,
      'picks', (select jsonb_agg(jsonb_build_object('round', x.round, 'pick', x.pick, 'player', np.name, 'pos', np.position, 'nfl', np.nfl_team) order by x.overall)
                from public.draft_selections x join public.nfl_players np on np.id = x.player_id where x.draft_id = p_draft and x.team_id = t)))
      from unnest(d.teams) t where not (t = any (d.bots));
    perform private.chat_bot_post('draft', '🏆 ' || d.name || ' is final.' || case when d.kind = 'real' then ' Rosters are set.' else ' (practice: rosters untouched)' end, jsonb_build_object('kind', 'end', 'draft', p_draft));
  else
    raise exception 'Unknown action %', p_action using errcode = '22023';
  end if;
  perform private.draft_audit(p_action, jsonb_build_object('draft', p_draft, 'seconds', p_seconds));
  return p_action;
end;
$$;

-- Undo the last p_count picks (made or skipped): back on the clock at the earliest one.
create function public.draft_undo(p_draft bigint, p_count int default 1) returns int
language plpgsql security definer set search_path = ''
as $$
declare d public.drafts; gone jsonb; n int;
begin
  perform private.draft_need_commissioner();
  select * into d from public.drafts where id = p_draft for update;
  if d.status = 'complete' then raise exception 'The draft is final' using errcode = '42501'; end if;
  with del as (
    delete from public.draft_selections x where x.draft_id = p_draft and x.overall in
      (select y.overall from public.draft_selections y where y.draft_id = p_draft order by y.overall desc limit greatest(p_count, 1))
    returning x.*)
  select jsonb_agg(jsonb_build_object('overall', overall, 'team', team_id, 'player', player_id, 'skipped', skipped) order by overall), count(*) into gone, n from del;
  if coalesce(n, 0) = 0 then return 0; end if;
  if d.kind = 'real' then
    update public.draft_picks dp set used = false where dp.season = d.season and exists (select 1 from jsonb_array_elements(gone) g
      join lateral private.draft_slot(p_draft, (g ->> 'overall')::int) s on true where dp.round = s.round and dp.original_team = s.original);
  end if;
  update public.drafts set status = case when d.status in ('done', 'awaiting_order') then 'live' else d.status end where id = p_draft;
  perform private.draft_audit('undo', jsonb_build_object('draft', p_draft, 'picks', gone));
  perform private.chat_bot_post('draft', '↩️ The commissioner undid ' || n || ' pick' || case when n = 1 then '' else 's' end, jsonb_build_object('kind', 'undo', 'draft', p_draft));
  if d.status = 'paused' then
    update public.drafts set current_overall = (select min((g ->> 'overall')::int) from jsonb_array_elements(gone) g), paused_remaining = d.timer_seconds where id = p_draft;
  else
    perform private.draft_advance(p_draft);
  end if;
  return n;
end;
$$;

create function public.draft_edit_pick(p_draft bigint, p_overall int, p_player text) returns void
language plpgsql security definer set search_path = ''
as $$
declare old public.draft_selections;
begin
  perform private.draft_need_commissioner();
  select * into old from public.draft_selections x where x.draft_id = p_draft and x.overall = p_overall for update;
  if old.overall is null or old.skipped then raise exception 'That pick hasn''t been made' using errcode = '22023'; end if;
  if exists (select 1 from public.draft_selections x where x.draft_id = p_draft and x.player_id = p_player and x.overall <> p_overall) then
    raise exception 'That player is already drafted' using errcode = '23505';
  end if;
  update public.draft_selections set player_id = p_player, picked_by = (select auth.uid()), picked_at = now(), auto = false where draft_id = p_draft and overall = p_overall;
  perform private.draft_audit('edit_pick', jsonb_build_object('draft', p_draft, 'overall', p_overall, 'from', old.player_id, 'to', p_player));
  perform private.chat_bot_post('draft', '✏️ The commissioner changed Round ' || old.round || ', Pick ' || old.pick || ' (' || private.draft_name(old.team_id) || ') to ' ||
    coalesce((select np.name from public.nfl_players np where np.id = p_player), p_player), jsonb_build_object('kind', 'edit', 'draft', p_draft));
end;
$$;

create function public.draft_delete(p_draft bigint) returns void
language plpgsql security definer set search_path = ''
as $$
declare d public.drafts;
begin
  perform private.draft_need_commissioner();
  select * into d from public.drafts where id = p_draft;
  if d.kind = 'real' and d.status not in ('setup') then raise exception 'The real draft can''t be deleted once it has started' using errcode = '42501'; end if;
  delete from public.drafts where id = p_draft;
  perform private.draft_audit('delete', jsonb_build_object('draft', p_draft, 'name', d.name, 'kind', d.kind));
end;
$$;

-- Rankings (CSV upload, matched to players on the page): replaces the season's list.
create function public.draft_rankings_upload(p_season int, p_rows jsonb, p_source text) returns int
language plpgsql security definer set search_path = ''
as $$
declare n int;
begin
  perform private.draft_need_commissioner();
  delete from public.draft_rankings where season = p_season;
  insert into public.draft_rankings (season, player_id, rank, source)
  select p_season, x.player_id, x.rank, p_source from jsonb_to_recordset(p_rows) as x(player_id text, rank numeric)
   where exists (select 1 from public.nfl_players p where p.id = x.player_id)
  on conflict do nothing;
  get diagnostics n = row_count;
  perform private.draft_audit('rankings', jsonb_build_object('season', p_season, 'source', p_source, 'players', n));
  return n;
end;
$$;

revoke execute on function public.draft_pick(bigint, text, int), public.draft_tick(bigint), public.draft_create(int, text, text, jsonb),
  public.draft_settings(bigint, jsonb), public.draft_set_order(bigint, int, text[]), public.draft_control(bigint, text, int),
  public.draft_undo(bigint, int), public.draft_edit_pick(bigint, int, text), public.draft_delete(bigint), public.draft_rankings_upload(int, jsonb, text) from public, anon;
grant execute on function public.draft_pick(bigint, text, int), public.draft_tick(bigint), public.draft_create(int, text, text, jsonb),
  public.draft_settings(bigint, jsonb), public.draft_set_order(bigint, int, text[]), public.draft_control(bigint, text, int),
  public.draft_undo(bigint, int), public.draft_edit_pick(bigint, int, text), public.draft_delete(bigint), public.draft_rankings_upload(int, jsonb, text) to authenticated, service_role;
revoke execute on function private.draft_round_order(bigint, int), private.draft_slot(bigint, int), private.draft_name(text), private.draft_notify(text, text, jsonb),
  private.draft_advance(bigint), private.draft_record(bigint, int, text, text, text, uuid, boolean), private.draft_autopick_player(bigint, text),
  private.draft_tick_one(bigint), private.draft_need_commissioner(), private.draft_audit(text, jsonb) from public, anon;
grant execute on function private.draft_need_commissioner() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Draft emails: the "Draft alerts" setting (on by default), kind 'draft'
-- ---------------------------------------------------------------------------
alter table public.notify_settings add column draft boolean not null default true;
alter table public.notify_queue drop constraint notify_queue_kind_check;
alter table public.notify_queue add constraint notify_queue_kind_check check (kind in
  ('dm', 'mentions', 'trades', 'waivers', 'announcements', 'lineup', 'lineup_saved', 'league_lineups', 'league_trades', 'league_waivers', 'league_moves', 'scoring', 'account', 'draft'));

-- ---------------------------------------------------------------------------
-- The clock: every 5 seconds (pg_cron), only acts on expired clocks
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') and exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('b5-draft-tick', '5 seconds', 'select public.draft_tick()');
  end if;
end $$;
