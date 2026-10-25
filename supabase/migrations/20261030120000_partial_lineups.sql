-- Partial lineups allowed (decided 2026-10-25): a lineup can be saved with empty starter slots; an
-- empty slot scores 0. League setting "Allow partial lineups" (league_settings.allow_partial_lineups,
-- default ON; the commissioner changes it). season_settings.lineups.allowPartial, when set, overrides
-- it for that season. Kickoff locks are unchanged: an empty slot can only be filled with a player whose
-- game hasn't started; a starter whose game hasn't started can be benched, leaving the slot empty.
-- Lineup confirmation emails list the empty slots ("1 empty slot (DEF) — scores 0 points").

alter table public.league_settings add column allow_partial_lineups boolean not null default true;

create or replace function private.lineup_allow_partial(p_season int) returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((select (s.lineups ->> 'allowPartial')::boolean from public.season_settings s where s.season = p_season),
                  (select l.allow_partial_lineups from public.league_settings l limit 1), true)
$$;

-- The page asks the server which rules apply (never hardcoded).
create function public.lineup_rules(p_season int) returns jsonb
language sql stable security definer set search_path = ''
as $$ select jsonb_build_object('allow_partial', private.lineup_allow_partial(p_season)) $$;
revoke execute on function public.lineup_rules(int) from public;
grant execute on function public.lineup_rules(int) to anon, authenticated, service_role;

-- Changing the setting is audited like other commissioner settings.
create function private.audit_league_settings() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if (select auth.uid()) is not null and new.allow_partial_lineups is distinct from old.allow_partial_lineups then
    insert into public.audit_log (actor, action, details)
    values ((select auth.uid()), 'settings:allow_partial_lineups', jsonb_build_object('from', old.allow_partial_lineups, 'to', new.allow_partial_lineups));
  end if;
  return new;
end;
$$;
create trigger audit_league_settings after update on public.league_settings for each row execute function private.audit_league_settings();

-- Empty starter slots, for the emails.
create function private.empty_slots(p_players text[]) returns jsonb
language sql immutable set search_path = ''
as $$
  select coalesce(jsonb_agg(private.slot_pos(k - 1) order by k), '[]')
  from generate_series(1, 9) k where p_players is null or p_players[k] is null
$$;

create or replace function private.lineup_payload(p_season int, p_week int, p_team text) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('team', private.team_name(p_team), 'week', p_week,
    'starters', (select jsonb_agg(jsonb_build_object('slot', (array['QB','RB','RB','WR','WR','WR','TE','K','DEF'])[s.slot + 1], 'name', np.name, 'nfl', np.nfl_team) order by s.slot)
                 from public.lineup_slots s join public.nfl_players np on np.id = s.player_id
                 where s.season = p_season and s.week = p_week and s.team_id = p_team),
    'empty', private.empty_slots(array(select (select s.player_id from public.lineup_slots s where s.season = p_season and s.week = p_week and s.team_id = p_team and s.slot = k)
                                      from generate_series(0, 8) k)),
    'bench', (select jsonb_agg(jsonb_build_object('pos', np.position, 'name', np.name, 'nfl', np.nfl_team) order by np.position, np.name)
              from public.roster_entries r join public.nfl_players np on np.id = r.player_id
              where r.season = p_season and r.team_id = p_team
                and r.player_id not in (select s.player_id from public.lineup_slots s where s.season = p_season and s.week = p_week and s.team_id = p_team and s.player_id is not null)),
    'warnings', (select jsonb_agg(jsonb_build_object('name', lp.name, 'pos', lp.pos, 'problem', lp.problem)) from private.lineup_problems(p_season, p_week, p_team) lp),
    'saved_by', (select coalesce(nullif(p.display_name, ''), 'an owner') from public.lineup_meta m left join public.profiles p on p.id = m.changed_by
                 where m.season = p_season and m.week = p_week and m.team_id = p_team),
    'saved_at', (select m.changed_at from public.lineup_meta m where m.season = p_season and m.week = p_week and m.team_id = p_team))
$$;

create or replace function private.test_lineup_payload(p_season int, p_week int, p_team text) returns jsonb
language sql stable security definer set search_path = ''
as $$
  with tl as (select * from public.test_lineups where season = p_season and week = p_week and team_id = p_team),
  wk as (select count(*) as games from public.nfl_games g where g.season = p_season and g.week = p_week),
  st as (select k - 1 as slot, tl.players[k] as id from tl cross join generate_series(1, 9) k where tl.players[k] is not null)
  select jsonb_build_object('team', private.team_name(p_team), 'week', p_week, 'test', true,
    'starters', (select jsonb_agg(jsonb_build_object('slot', private.slot_pos(st.slot), 'name', np.name, 'nfl', np.nfl_team) order by st.slot) from st join public.nfl_players np on np.id = st.id),
    'empty', private.empty_slots((select players from tl)),
    'bench', (select jsonb_agg(jsonb_build_object('pos', np.position, 'name', np.name, 'nfl', np.nfl_team) order by np.position, np.name)
              from public.roster_entries r join public.nfl_players np on np.id = r.player_id
              where r.season = p_season and r.team_id = p_team and r.player_id not in (select id from st)),
    'warnings', (select jsonb_agg(jsonb_build_object('name', np.name, 'pos', np.position,
                   'problem', case when private.player_kickoff(p_season, p_week, st.id) is null then 'bye' else lower(i.status) end))
                 from st join public.nfl_players np on np.id = st.id cross join wk
                 left join public.player_injuries i on i.season = p_season and i.week = p_week and i.player_id = st.id
                 where (private.player_kickoff(p_season, p_week, st.id) is null and wk.games > 0) or i.status in ('IR', 'PUP', 'Suspended', 'Reserve', 'Out')),
    'saved_by', (select coalesce(nullif(p.display_name, ''), 'an owner') from tl left join public.profiles p on p.id = tl.saved_by),
    'saved_at', (select saved_at from tl))
$$;

revoke execute on function private.empty_slots(text[]) from public, anon;

-- The email caps count Resend's day and month in UTC, whatever the session time zone.
create or replace function public.notify_usage() returns table (priority int, today int, month int)
language sql stable security definer set search_path = ''
as $$
  select p, (select count(*)::int from public.email_log l where l.status = 'sent' and private.notify_priority(l.kind) = p and l.at >= date_trunc('day', now(), 'UTC')),
            (select count(*)::int from public.email_log l where l.status = 'sent' and private.notify_priority(l.kind) = p and l.at >= date_trunc('month', now(), 'UTC'))
  from generate_series(1, 4) p where private.is_commissioner() or private.is_admin()
$$;

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
  select count(*) filter (where l.at >= date_trunc('day', p_now, 'UTC')), count(*) into day_count, month_count
    from public.email_log l where l.status = 'sent' and l.at >= date_trunc('month', p_now, 'UTC');
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
      d := case when parts[1] = 'tsaved' then private.test_lineup_payload(parts[2]::int, parts[3]::int, parts[4])
                else private.lineup_payload(parts[2]::int, parts[3]::int, parts[4]) end || jsonb_build_object('link', '#myteam');
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
