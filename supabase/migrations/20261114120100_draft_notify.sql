-- Draft emails (kind 'draft', the "Draft alerts" setting, on by default): on the clock, 2 picks away,
-- the start reminder and the results. Priority 1 (time-sensitive). On-the-clock and 2-away emails are
-- skipped while the person is on the site (they're in the room). notify_claim is the 20261030 version
-- plus the draft branch.

create or replace function private.notify_on(p_user uuid, p_kind text) returns boolean
language sql stable security definer set search_path = ''
as $$
  select case when p_kind = 'account' then true
              when s.user_id is null then p_kind in ('dm', 'trades', 'announcements', 'lineup_saved', 'waivers', 'draft')
              when s.paused then false
              when p_kind = 'league_lineups' then s.league_lineups <> 'off'
              else coalesce((to_jsonb(s) ->> p_kind)::boolean, false) end
  from (select 1) one left join public.notify_settings s on s.user_id = p_user
$$;
create or replace function private.notify_priority(p_kind text) returns int
language sql immutable set search_path = ''
as $$ select case when p_kind in ('dm', 'mentions', 'trades', 'announcements', 'account', 'draft') then 1
                  when p_kind in ('waivers', 'league_trades', 'league_waivers', 'league_moves') then 2
                  when p_kind in ('lineup_saved', 'league_lineups', 'lineup') then 3
                  else 4 end $$;

create or replace function private.notify_template_keys() returns text[]
language sql immutable set search_path = ''
as $$ select array['dm', 'mentions', 'trades', 'league_trades', 'waivers', 'league_waivers', 'league_moves', 'lineup_saved', 'lineup',
                   'league_lineups', 'league_lineups_opponent', 'scoring', 'announcements', 'draft'] $$;
create or replace function private.builtin_notify_defaults() returns jsonb
language sql immutable set search_path = ''
as $$ select '{"dm": true, "mentions": false, "trades": true, "league_trades": false, "waivers": true, "league_waivers": false, "league_moves": false,
               "lineup_saved": true, "lineup": false, "league_lineups": "off", "league_lineups_opponent": false, "scoring": false, "announcements": true, "draft": true}'::jsonb $$;

create or replace function public.notify_unsubscribe(p_token text) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  m text[] := regexp_match(coalesce(p_token, ''), '^([0-9a-f-]{36})\.([a-z_]+)\.([0-9a-f]{32})$');
  u uuid;
begin
  if m is null or m[2] not in ('dm', 'mentions', 'trades', 'waivers', 'announcements', 'lineup', 'lineup_saved', 'league_lineups', 'league_trades', 'league_waivers', 'league_moves', 'scoring', 'draft') then
    raise exception 'That link isn''t valid' using errcode = '22023';
  end if;
  u := m[1]::uuid;
  if m[3] <> private.notify_sig(u, m[2]) or not exists (select 1 from public.profiles where id = u) then
    raise exception 'That link isn''t valid' using errcode = '22023';
  end if;
  insert into public.notify_settings (user_id) values (u) on conflict (user_id) do nothing;
  execute format('update public.notify_settings set %I = %L where user_id = %L', m[2], case when m[2] = 'league_lineups' then 'off' else 'false' end, u);
  update public.notify_queue set status = 'skipped', reason = 'unsubscribed', updated_at = now() where user_id = u and kind = m[2] and status = 'pending';
  return m[2];
end;
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
    elsif q.kind = 'draft' then
      -- Draft alerts carry their payload; "on the clock" / "2 picks away" skip people already on the site
      d := coalesce(q.payload, '{}'::jsonb);
      if d ->> 'type' in ('clock', 'soon') and exists (select 1 from public.user_presence pr where pr.user_id = q.user_id and pr.seen_at > p_now - interval '2 minutes') then
        perform private.notify_skip(q, 'active on the site'); continue;
      end if;
    end if;

    update public.notify_queue nq set status = 'sending', attempts = nq.attempts + 1, updated_at = p_now where nq.id = q.id;
    claimed := claimed + 1;
    id := q.id; user_id := q.user_id; kind := q.kind; email := addr; token := private.notify_token(q.user_id, q.kind); data := d;
    return next;
  end loop;
end;
$$;
