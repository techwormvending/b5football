-- Draft Room ADP (2026-11-02). Average draft position from two free public sources, both stored:
-- 'mfl' (primary: MFL's site-wide 12-team PPR redraft ADP) and 'ffc' (fallback / comparison: Fantasy
-- Football Calculator, half-PPR, 12 teams), mapped to our players by scripts/sync-adp.mts (rules in
-- src/league/adp.ts) and written only through public.replace_adp (server jobs).
--
-- A draft uses the ADP of its season, else the most recent season before it (2026 ADP for practice
-- drafts and for the 2027 draft until 2027 ADP exists). ADP per player = MFL's, else FFC's.
-- The commissioner's CSV rankings still work: uploading them switches the season's open drafts to
-- "Custom ranks" (drafts.ranks = 'custom'), which the commissioner can switch back (draft_settings).
--
-- Auto-pick (timer expiry and bots): the top available player of the team's queue, else the best
-- available by the draft's ranking (custom ranks if on, then ADP, then name), with one sanity rule: no
-- 2nd K or DEF for a team before round 14 unless nothing else is left.
-- Each pick stores the player's ADP at that moment (draft_selections.adp) for the value tag:
-- "Reach" = taken 12+ picks before his ADP, "Steal" = 12+ picks after (board, pick list, B5 Bot).

create table public.player_adp (
  season int not null,
  source text not null check (source in ('mfl', 'ffc')),
  player_id text not null references public.nfl_players (id) on delete cascade,
  adp numeric not null,
  pos_rank text,                                  -- "RB7" within this source
  pulled_at timestamptz not null default now(),
  primary key (season, source, player_id)
);
create table public.adp_pulls (
  season int not null,
  source text not null check (source in ('mfl', 'ffc')),
  period text,                                    -- MFL: RECENT or ALL; FFC: its format
  drafts int,
  players int not null,
  pulled_at timestamptz not null default now(),
  primary key (season, source)
);
alter table public.player_adp enable row level security;
alter table public.adp_pulls enable row level security;
create policy "members read" on public.player_adp for select to authenticated using (private.is_member());
create policy "members read" on public.adp_pulls for select to authenticated using (private.is_member());
grant select on public.player_adp, public.adp_pulls to authenticated;
grant all on public.player_adp, public.adp_pulls to service_role;

alter table public.drafts add column ranks text not null default 'adp' check (ranks in ('adp', 'custom'));
alter table public.draft_selections add column adp numeric;

-- Replace one source's list for a season (server jobs only; one transaction).
create function public.replace_adp(p_season int, p_source text, p_period text, p_drafts int, p_rows jsonb) returns int
language plpgsql security definer set search_path = ''
as $$
declare n int;
begin
  if p_source not in ('mfl', 'ffc') then raise exception 'Unknown ADP source %', p_source using errcode = '22023'; end if;
  delete from public.player_adp where season = p_season and source = p_source;
  insert into public.player_adp (season, source, player_id, adp, pos_rank)
  select p_season, p_source, x.player_id, x.adp, x.pos_rank from jsonb_to_recordset(p_rows) as x(player_id text, adp numeric, pos_rank text)
   where x.adp is not null and exists (select 1 from public.nfl_players p where p.id = x.player_id)
  on conflict do nothing;
  get diagnostics n = row_count;
  insert into public.adp_pulls (season, source, period, drafts, players, pulled_at) values (p_season, p_source, p_period, p_drafts, n, now())
  on conflict (season, source) do update set period = excluded.period, drafts = excluded.drafts, players = excluded.players, pulled_at = now();
  return n;
end;
$$;
revoke execute on function public.replace_adp(int, text, text, int, jsonb) from public, anon, authenticated;
grant execute on function public.replace_adp(int, text, text, int, jsonb) to service_role;

-- The ADP season a draft uses: its own, else the latest before it, else the latest there is.
create function private.draft_adp_season(p_season int) returns int
language sql stable security definer set search_path = ''
as $$
  select coalesce((select max(a.season) from public.player_adp a where a.season <= p_season), (select max(a.season) from public.player_adp a))
$$;
-- A player's ADP for a draft season: MFL's, else FFC's.
create function private.draft_adp(p_season int, p_player text) returns numeric
language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (select a.adp from public.player_adp a where a.season = private.draft_adp_season(p_season) and a.source = 'mfl' and a.player_id = p_player),
    (select a.adp from public.player_adp a where a.season = private.draft_adp_season(p_season) and a.source = 'ffc' and a.player_id = p_player))
$$;
-- 'reach' (taken 12+ picks before his ADP), 'steal' (12+ picks after) or null.
create function private.draft_value(p_overall int, p_adp numeric) returns text
language sql immutable set search_path = ''
as $$
  select case when p_adp is null then null when p_adp - p_overall >= 12 then 'reach' when p_overall - p_adp >= 12 then 'steal' end
$$;

-- The auto-pick: the team's queue, else best available by the draft's ranking, with the K/DEF rule.
create or replace function private.draft_autopick_player(p_draft bigint, p_team text) returns text
language plpgsql stable security definer set search_path = ''
as $$
declare d public.drafts; rnd int; aseason int; custom boolean; pl text;
begin
  select * into d from public.drafts where id = p_draft;
  select q.player_id into pl from public.draft_queue q where q.draft_id = p_draft and q.team_id = p_team
     and not exists (select 1 from public.draft_selections x where x.draft_id = p_draft and x.player_id = q.player_id)
   order by q.rank, q.player_id limit 1;
  if pl is not null then return pl; end if;
  rnd := (coalesce(d.current_overall, 1) - 1) / cardinality(d.teams) + 1;
  aseason := private.draft_adp_season(d.season);
  custom := d.ranks = 'custom' and exists (select 1 from public.draft_rankings r where r.season = d.season);
  select p.id into pl from public.nfl_players p
    left join public.draft_rankings r on custom and r.season = d.season and r.player_id = p.id
    left join public.player_adp m on m.season = aseason and m.source = 'mfl' and m.player_id = p.id
    left join public.player_adp f on f.season = aseason and f.source = 'ffc' and f.player_id = p.id
   where p.position in ('QB', 'RB', 'WR', 'TE', 'K', 'DEF')
     and not exists (select 1 from public.draft_selections x where x.draft_id = p_draft and x.player_id = p.id)
   order by
     -- a 2nd K or DEF before round 14 goes last (taken only when nothing else is left)
     (p.position in ('K', 'DEF') and rnd < 14 and exists (select 1 from public.draft_selections x join public.nfl_players xp on xp.id = x.player_id
        where x.draft_id = p_draft and x.team_id = p_team and xp.position = p.position)),
     r.rank nulls last, coalesce(m.adp, f.adp) nulls last, p.name, p.id
   limit 1;
  return pl;
end;
$$;

-- Record a pick (validated by the caller): insert or fill a skipped slot, mark a real pick used, post it
-- (now with the player's ADP and the Reach / Steal tag).
create or replace function private.draft_record(p_draft bigint, p_overall int, p_team text, p_original text, p_player text, p_by uuid, p_auto boolean) returns void
language plpgsql security definer set search_path = ''
as $$
declare d public.drafts; pos record; who text; a numeric; v text;
begin
  select * into d from public.drafts where id = p_draft;
  a := private.draft_adp(d.season, p_player);
  insert into public.draft_selections (draft_id, overall, round, pick, team_id, original_team, player_id, skipped, auto, picked_by, picked_at, adp)
  values (p_draft, p_overall, (p_overall - 1) / cardinality(d.teams) + 1, (p_overall - 1) % cardinality(d.teams) + 1, p_team, p_original, p_player, false, p_auto, p_by, now(), a)
  on conflict (draft_id, overall) do update set player_id = excluded.player_id, skipped = false, auto = excluded.auto, picked_by = excluded.picked_by, picked_at = now(), adp = excluded.adp;
  delete from public.draft_queue q where q.draft_id = p_draft and q.player_id = p_player;
  if d.kind = 'real' then
    update public.draft_picks dp set used = true where dp.season = d.season and dp.round = (p_overall - 1) / cardinality(d.teams) + 1 and dp.original_team = p_original;
  end if;
  select np.name, np.position, np.nfl_team into pos from public.nfl_players np where np.id = p_player;
  select nullif(p.display_name, '') into who from public.profiles p where p.id = p_by;
  v := private.draft_value(p_overall, a);
  perform private.chat_bot_post('draft', '✅ ' || private.draft_name(p_team) || ' select ' || coalesce(pos.name, p_player) ||
    coalesce(', ' || nullif(btrim(concat_ws(' ', pos.position, pos.nfl_team)), ''), '') ||
    ' (Round ' || ((p_overall - 1) / cardinality(d.teams) + 1) || ', Pick ' || ((p_overall - 1) % cardinality(d.teams) + 1) || ')' ||
    case when p_auto then ' · auto-pick' when who is not null then ' · by ' || who else '' end ||
    case v when 'reach' then ' · 📈 Reach (ADP ' || round(a, 1) || ')' when 'steal' then ' · 💎 Steal (ADP ' || round(a, 1) || ')' else '' end,
    jsonb_build_object('kind', 'pick', 'draft', p_draft, 'overall', p_overall, 'team', p_team, 'player', p_player, 'adp', a, 'value', v));
end;
$$;

-- Settings: + ranks ('adp' or 'custom'), changeable any time.
create or replace function public.draft_settings(p_draft bigint, p_settings jsonb) returns void
language plpgsql security definer set search_path = ''
as $$
declare d public.drafts;
begin
  perform private.draft_need_commissioner();
  select * into d from public.drafts where id = p_draft for update;
  if d.status <> 'setup' and (p_settings ?| array['rounds', 'order_mode', 'bots']) then
    raise exception 'Rounds, order timing and bots can only change before the draft starts' using errcode = '42501';
  end if;
  if p_settings ? 'ranks' and p_settings ->> 'ranks' not in ('adp', 'custom') then raise exception 'Ranks are adp or custom' using errcode = '22023'; end if;
  update public.drafts set
    name = coalesce(p_settings ->> 'name', name),
    rounds = coalesce((p_settings ->> 'rounds')::int, rounds),
    timer_seconds = coalesce((p_settings ->> 'timer_seconds')::int, timer_seconds),
    order_mode = coalesce(p_settings ->> 'order_mode', order_mode),
    expiry = coalesce(p_settings ->> 'expiry', expiry),
    ranks = coalesce(p_settings ->> 'ranks', ranks),
    bots = case when p_settings ? 'bots' then array(select jsonb_array_elements_text(p_settings -> 'bots')) else bots end,
    starts_at = case when p_settings ? 'starts_at' then (p_settings ->> 'starts_at')::timestamptz else starts_at end,
    reminded_at = case when p_settings ? 'starts_at' then null else reminded_at end,
    updated_at = now()
  where id = p_draft;
  if d.kind = 'real' and p_settings ? 'rounds' then perform private.ensure_draft_picks(d.season, (p_settings ->> 'rounds')::int); end if;
  perform private.draft_audit('settings', jsonb_build_object('draft', p_draft, 'settings', p_settings));
end;
$$;

-- Rankings upload: as before, and the season's open drafts switch to Custom ranks (none uploaded = ADP).
create or replace function public.draft_rankings_upload(p_season int, p_rows jsonb, p_source text) returns int
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
  update public.drafts set ranks = case when n > 0 then 'custom' else 'adp' end, updated_at = now()
   where season = p_season and status not in ('done', 'complete');
  perform private.draft_audit('rankings', jsonb_build_object('season', p_season, 'source', p_source, 'players', n));
  return n;
end;
$$;

-- A new draft starts on Custom ranks when the commissioner has uploaded rankings for its season.
create function private.draft_default_ranks() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if exists (select 1 from public.draft_rankings r where r.season = new.season) then new.ranks := 'custom'; end if;
  return new;
end;
$$;
create trigger draft_default_ranks before insert on public.drafts for each row execute function private.draft_default_ranks();

revoke execute on function private.draft_adp_season(int), private.draft_adp(int, text), private.draft_value(int, numeric), private.draft_default_ranks() from public, anon;
grant execute on function private.draft_adp_season(int), private.draft_adp(int, text), private.draft_value(int, numeric) to service_role;
