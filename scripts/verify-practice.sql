-- Live check: practice drafts for every member (run by .github/workflows/verify-practice.yml).
--
-- Runs as throwaway TEST accounts created through the invite flow (invites row + account), never real members'
-- accounts. EVERYTHING here is one DO block that ends by raising an error carrying the results, so Postgres
-- rolls back every change: the test accounts, their team links, drafts, chat, log, emails queued (never sent),
-- audit rows. Nothing is kept, nothing reaches standings, Realtime (only committed rows are broadcast) or email.
do $verify$
declare
  res text[] := '{}';
  t1 uuid := gen_random_uuid();  -- TEST Manager A, team X
  t2 uuid := gen_random_uuid();  -- TEST Manager B, co-owner of team X
  t3 uuid := gen_random_uuid();  -- TEST Manager C, team Y
  t4 uuid := gen_random_uuid();  -- TEST Manager D, team Z
  t5 uuid := gen_random_uuid();  -- TEST Commissioner (to create the real draft if there isn't one)
  tx text; ty text; tz text;
  all_teams text[];
  pl text[];
  pi int := 0;
  d1 bigint; d3 bigint; d6 bigint; d8 bigint; dr bigint;
  dz bigint[] := '{}';
  r text; r2 text; n int; n2 int; st text; owner text;
  ord text[];
  snap_before text; snap_after text;
  hdr_before text; hdr_after text;
  league_msgs int;
  mine bigint[];
begin
  -- helpers (temporary, gone with the rollback)
  execute $f$create function pg_temp.b5_as(p_uid uuid, p_sql text) returns text language plpgsql as $b$
    declare r text;
    begin
      begin
        perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
        perform set_config('request.jwt.claim.sub', p_uid::text, true);
        perform set_config('request.jwt.claim.role', 'authenticated', true);
        execute 'set local role authenticated';
        execute p_sql into r;
        execute 'reset role';
        return 'ok:' || coalesce(r, '');
      exception when others then
        return 'err:' || sqlerrm;
      end;
    end $b$$f$;
  execute $f$create function pg_temp.b5_chk(p_ok boolean, p_item text, p_what text, p_detail text) returns text language sql as $b$
    select case when coalesce(p_ok, false) then 'PASS' else 'FAIL' end || ' [' || p_item || '] ' || p_what || coalesce(' (' || p_detail || ')', '') $b$$f$;
  -- rows a practice draft must never change
  execute $f$create function pg_temp.b5_snap() returns text language plpgsql as $b$
    declare out text := ''; t text; h text;
    begin
      foreach t in array array['roster_entries', 'draft_picks', 'transactions', 'awards', 'team_scores', 'matchups', 'standings',
                               'lineup_slots', 'team_fees', 'payout_payments', 'waiver_claims', 'trades'] loop
        if to_regclass('public.' || t) is not null then
          execute format('select coalesce(md5(string_agg(x::text, %L order by x::text)), %L) from public.%I x', '|', 'empty', t) into h;
          out := out || t || '=' || h || ' ';
        end if;
      end loop;
      select coalesce(md5(string_agg(x::text, '|' order by x::text)), 'empty') into h from public.drafts x where x.kind = 'real';
      out := out || 'real_drafts=' || h || ' ';
      select coalesce(md5(string_agg(x::text, '|' order by x::text)), 'empty') into h
        from public.draft_selections x join public.drafts d on d.id = x.draft_id where d.kind = 'real';
      out := out || 'real_selections=' || h;
      return out;
    end $b$$f$;

  begin
    -- ------------------------------------------------------------------ setup: test accounts via the invite flow
    select array_agg(t.id order by t.id) into all_teams from public.teams t;
    -- the three teams with the fewest owners + pending invites. Every team may already be spoken for (invites sent),
    -- so the owner limit is raised for this run only (rolled back with everything else).
    update public.league_settings set max_owners_per_team = 4 where true;
    select t.id into tx from public.teams t order by (select count(*) from public.team_managers m where m.team_id = t.id) + (select count(*) from public.invites i where i.team_id = t.id and i.user_id is null), t.id limit 1;
    select t.id into ty from public.teams t where t.id <> tx order by (select count(*) from public.team_managers m where m.team_id = t.id) + (select count(*) from public.invites i where i.team_id = t.id and i.user_id is null), t.id limit 1;
    select t.id into tz from public.teams t where t.id not in (tx, ty) order by (select count(*) from public.team_managers m where m.team_id = t.id) + (select count(*) from public.invites i where i.team_id = t.id and i.user_id is null), t.id limit 1;
    if tx is null or ty is null or tz is null then raise exception 'setup: not enough free team places for the test accounts'; end if;

    insert into public.invites (email, team_id, is_commissioner) values
      ('b5-test-a@example.invalid', tx, false), ('b5-test-b@example.invalid', tx, false),
      ('b5-test-c@example.invalid', ty, false), ('b5-test-d@example.invalid', tz, false),
      ('b5-test-e@example.invalid', null, true);
    insert into auth.users (id, email, aud, role, raw_user_meta_data, created_at, updated_at) values
      (t1, 'b5-test-a@example.invalid', 'authenticated', 'authenticated', '{"display_name": "TEST Manager A"}', now(), now()),
      (t2, 'b5-test-b@example.invalid', 'authenticated', 'authenticated', '{"display_name": "TEST Manager B"}', now(), now()),
      (t3, 'b5-test-c@example.invalid', 'authenticated', 'authenticated', '{"display_name": "TEST Manager C"}', now(), now()),
      (t4, 'b5-test-d@example.invalid', 'authenticated', 'authenticated', '{"display_name": "TEST Manager D"}', now(), now()),
      (t5, 'b5-test-e@example.invalid', 'authenticated', 'authenticated', '{"display_name": "TEST Commissioner"}', now(), now());
    -- test accounts never get email (and the transaction is rolled back anyway)
    if to_regclass('public.notify_settings') is not null then
      insert into public.notify_settings (user_id, paused) select u, true from unnest(array[t1, t2, t3, t4, t5]) u on conflict (user_id) do update set paused = true;
    end if;
    res := res || pg_temp.b5_chk(
      (select count(*) from public.team_managers m where m.user_id in (t1, t2) and m.team_id = tx) = 2
      and exists (select 1 from public.team_managers m where m.user_id = t3 and m.team_id = ty)
      and exists (select 1 from public.team_managers m where m.user_id = t4 and m.team_id = tz)
      and not exists (select 1 from public.user_roles x where x.user_id in (t1, t2, t3, t4)),
      'setup', 'test managers created by invite, on their teams, with no roles', tx || ', ' || tx || ' (co-owner), ' || ty || ', ' || tz);

    select array_agg(p.id order by p.id) into pl from (select id from public.nfl_players where position in ('QB', 'RB', 'WR', 'TE') order by id limit 80) p;

    -- the real draft (the season's own if it exists; otherwise the test commissioner makes one)
    select id into dr from public.drafts where kind = 'real' order by season desc limit 1;
    if dr is null then
      r := pg_temp.b5_as(t5, $q$select public.draft_create(2027, 'real', 'TEST real draft', '{"rounds": 18}'::jsonb)$q$);
      if r not like 'ok:%' then raise exception 'setup: could not create a real draft: %', r; end if;
      dr := substr(r, 4)::bigint;
    end if;
    select count(*) into league_msgs from public.chat_messages where room_id = 'draft';
    select coalesce((select x::text from public.draft_state x where x.id), 'none') into hdr_before;
    snap_before := pg_temp.b5_snap();

    -- ------------------------------------------------------------------ 1. a regular manager: create + video
    r := pg_temp.b5_as(t1, $q$select coalesce(practice_video_url, '') from public.league_settings limit 1$q$);
    res := res || pg_temp.b5_chk(r like 'ok:https://scribehow.com/embed/%', '1', 'regular manager reads the how-to video setting', left(r, 60));
    r := pg_temp.b5_as(t1, $q$select count(*)::text from public.drafts$q$);
    res := res || pg_temp.b5_chk(r like 'ok:%', '1', 'regular manager can list the drafts', r);

    -- ------------------------------------------------------------------ 2. create and run as host
    r := pg_temp.b5_as(t1, $q$select public.draft_create(2027, 'mock', 'TEST practice A', '{"rounds": 4, "timer_seconds": 60}'::jsonb)$q$);
    res := res || pg_temp.b5_chk(r ~ '^ok:\d+$', '2', 'regular manager creates a practice draft', r);
    d1 := substr(r, 4)::bigint;
    res := res || pg_temp.b5_chk((select host = t1 and is_practice from public.drafts where id = d1)
      and exists (select 1 from public.draft_participants where draft_id = d1 and user_id = t1), '2', 'creator is the host and a participant', null);
    r := pg_temp.b5_as(t1, format('select public.draft_control(%s, %L)', d1, 'start'));
    select status into st from public.drafts where id = d1;
    res := res || pg_temp.b5_chk(r like 'ok:%' and st = 'awaiting_order', '2', 'start', r || ' -> ' || st);
    r := pg_temp.b5_as(t1, format('select array_to_string(public.draft_set_order(%s, 1, null), %L)', d1, ','));
    select status into st from public.drafts where id = d1;
    res := res || pg_temp.b5_chk(r like 'ok:%' and st = 'live', '2', 'draw the round 1 order', st);
    select array_agg(t order by random()) into ord from unnest(all_teams) t;
    r := pg_temp.b5_as(t1, format('select array_to_string(public.draft_set_order(%s, 3, %L::text[]), %L)', d1, ord, ','));
    res := res || pg_temp.b5_chk(r like 'ok:%' and (select method from public.draft_orders where draft_id = d1 and round = 3) = 'manual', '2', 'set the round 3 order by hand', left(r, 40));
    pi := pi + 1; r := pg_temp.b5_as(t1, format('select public.draft_pick(%s, %L)::text', d1, pl[pi]));
    pi := pi + 1; r2 := pg_temp.b5_as(t1, format('select public.draft_pick(%s, %L)::text', d1, pl[pi]));
    res := res || pg_temp.b5_chk(r like 'ok:%' and r2 like 'ok:%' and (select count(*) from public.draft_selections where draft_id = d1) = 2,
      '2', 'make picks (any seat)', left(r, 60));
    r := pg_temp.b5_as(t1, format('select public.draft_control(%s, %L)', d1, 'pause'));
    select status into st from public.drafts where id = d1;
    res := res || pg_temp.b5_chk(r like 'ok:%' and st = 'paused', '2', 'pause', r);
    r := pg_temp.b5_as(t1, format('select public.draft_control(%s, %L)', d1, 'resume'));
    select status into st from public.drafts where id = d1;
    res := res || pg_temp.b5_chk(r like 'ok:%' and st = 'live', '2', 'resume', r);
    r := pg_temp.b5_as(t1, format('select public.draft_control(%s, %L, 30)', d1, 'extend'));
    res := res || pg_temp.b5_chk(r like 'ok:%', '2', 'add time', r);
    r := pg_temp.b5_as(t1, format('select public.draft_undo(%s, 1)::text', d1));
    res := res || pg_temp.b5_chk(r like 'ok:%' and (select count(*) from public.draft_selections where draft_id = d1) = 1, '2', 'undo', r);
    r := pg_temp.b5_as(t1, format('select public.draft_settings(%s, %L::jsonb)', d1,
      jsonb_build_object('bots', (select jsonb_agg(t) from unnest(all_teams) t where t not in (tx, ty)))::text));
    res := res || pg_temp.b5_chk(r like 'ok:%' and (select cardinality(bots) from public.drafts where id = d1) = cardinality(all_teams) - 2, '2', 'add bots mid-draft', r);
    res := res || pg_temp.b5_chk((select count(*) from public.draft_log where draft_id = d1 and actor = t1 and actor_name = 'TEST Manager A') >= 8,
      '2', 'every action is in the draft log with who did it',
      (select string_agg(actor_name || ': ' || action, '; ' order by id) from (select * from public.draft_log where draft_id = d1 order by id limit 4) l));

    -- ------------------------------------------------------------------ 3. a second manager's own draft, at the same time
    r := pg_temp.b5_as(t3, $q$select public.draft_create(2027, 'mock', 'TEST practice C', '{"rounds": 2, "timer_seconds": 60}'::jsonb)$q$);
    d3 := substr(r, 4)::bigint;
    r := pg_temp.b5_as(t3, format('select public.draft_control(%s, %L)', d3, 'start'));
    r := pg_temp.b5_as(t3, format('select array_to_string(public.draft_set_order(%s, 1, null), %L)', d3, ','));
    pi := pi + 1; r := pg_temp.b5_as(t3, format('select public.draft_pick(%s, %L)::text', d3, pl[pi]));
    res := res || pg_temp.b5_chk(r like 'ok:%' and (select host from public.drafts where id = d3) = t3
      and (select status from public.drafts where id = d3) = 'live' and (select status from public.drafts where id = d1) = 'live',
      '3', 'two managers run their own practice drafts at the same time', 'A: live, C: live');
    res := res || pg_temp.b5_chk((select count(*) from public.draft_selections where draft_id = d1) = 1
      and (select count(*) from public.draft_selections where draft_id = d3) = 1
      and not exists (select 1 from public.draft_selections a join public.draft_selections b on a.player_id = b.player_id where a.draft_id = d1 and b.draft_id = d3),
      '3', 'picks stay in their own draft', null);
    r := pg_temp.b5_as(t3, format('select public.draft_control(%s, %L)', d1, 'pause'));
    res := res || pg_temp.b5_chk(r like 'err:%Join this practice draft first%' and (select status from public.drafts where id = d1) = 'live',
      '3', 'C can''t control A''s draft without joining', r);
    pi := pi + 1; r := pg_temp.b5_as(t3, format('select public.draft_pick(%s, %L)::text', d1, pl[pi]));
    res := res || pg_temp.b5_chk(r like 'err:%', '3', 'C can''t pick in A''s draft without joining', r);

    -- ------------------------------------------------------------------ 4. join someone else's; host-only controls
    r := pg_temp.b5_as(t3, format('select public.draft_join(%s)', d1));
    res := res || pg_temp.b5_chk(r like 'ok:%', '4', 'C joins A''s practice draft', r);
    r := pg_temp.b5_as(t3, format('select public.draft_control(%s, %L)', d1, 'pause'));
    r2 := pg_temp.b5_as(t3, format('select public.draft_control(%s, %L)', d1, 'resume'));
    res := res || pg_temp.b5_chk(r like 'ok:%' and r2 like 'ok:%', '4', 'joined member uses the controls (default settings)', r || ', ' || r2);
    select (private.draft_slot(d1, current_overall)).owner into owner from public.drafts where id = d1;
    pi := pi + 1; r := pg_temp.b5_as(t3, format('select public.draft_pick(%s, %L)::text', d1, pl[pi]));
    res := res || pg_temp.b5_chk(r like 'ok:%', '4', 'joined member picks for any seat (default settings)', owner || ': ' || left(r, 40));
    r := pg_temp.b5_as(t3, format('select public.draft_settings(%s, %L::jsonb)', d1, '{"host_only": true}'));
    res := res || pg_temp.b5_chk(r like 'err:%Only the host%', '4', 'only the host switches host-only controls', r);
    r := pg_temp.b5_as(t1, format('select public.draft_settings(%s, %L::jsonb)', d1, '{"host_only": true}'));
    res := res || pg_temp.b5_chk(r like 'ok:%' and (select host_only from public.drafts where id = d1), '4', 'host turns on host-only controls', r);
    r := pg_temp.b5_as(t3, format('select public.draft_control(%s, %L)', d1, 'pause'));
    res := res || pg_temp.b5_chk(r like 'err:%host has limited%' and (select status from public.drafts where id = d1) = 'live', '4', 'host-only: joined member can''t pause', r);
    r := pg_temp.b5_as(t3, format('select public.draft_undo(%s, 1)::text', d1));
    r2 := pg_temp.b5_as(t3, format('select array_to_string(public.draft_set_order(%s, 3, null), %L)', d1, ','));
    res := res || pg_temp.b5_chk(r like 'err:%host has limited%' and r2 like 'err:%host has limited%', '4', 'host-only: joined member can''t undo or set orders', null);
    select (private.draft_slot(d1, current_overall)).owner into owner from public.drafts where id = d1;
    if owner is distinct from ty then
      pi := pi + 1; r := pg_temp.b5_as(t3, format('select public.draft_pick(%s, %L)::text', d1, pl[pi]));
      res := res || pg_temp.b5_chk(r like 'err:%only pick for your own team%', '4', 'host-only: joined member can''t pick for another seat', r);
    end if;
    r := pg_temp.b5_as(t1, format('select public.draft_control(%s, %L)', d1, 'pause'));
    res := res || pg_temp.b5_chk(r like 'ok:%', '4', 'host-only: the host still has the controls', r);
    r := pg_temp.b5_as(t1, format('select public.draft_settings(%s, %L::jsonb)', d1, '{"host_only": false}'));
    r2 := pg_temp.b5_as(t3, format('select public.draft_control(%s, %L)', d1, 'resume'));
    res := res || pg_temp.b5_chk(r like 'ok:%' and r2 like 'ok:%', '4', 'host opens the controls again; joined member resumes', r2);

    -- ------------------------------------------------------------------ 7. each practice draft's chat is its own
    r := pg_temp.b5_as(t1, format($q$insert into public.chat_messages (room_id, body) values (%L, 'TEST hello practice room') returning id::text$q$, 'practice-' || d1));
    res := res || pg_temp.b5_chk(r ~ '^ok:\d+$', '7', 'participant posts in the practice room', r);
    r := pg_temp.b5_as(t3, format('select count(*)::text from public.chat_messages where room_id = %L and body = %L', 'practice-' || d1, 'TEST hello practice room'));
    res := res || pg_temp.b5_chk(r = 'ok:1', '7', 'another participant reads it', r);
    r := pg_temp.b5_as(t4, format('select count(*)::text from public.chat_messages where room_id = %L', 'practice-' || d1));
    r2 := pg_temp.b5_as(t4, format($q$insert into public.chat_messages (room_id, body) values (%L, 'TEST intruder') returning id::text$q$, 'practice-' || d1));
    res := res || pg_temp.b5_chk(r = 'ok:0' and r2 like 'err:%', '7', 'a member who didn''t join can''t read or post there', r || ' / ' || left(r2, 60));
    r := pg_temp.b5_as(t3, format('select count(*)::text from public.chat_messages where room_id = %L', 'practice-' || d3));
    r2 := pg_temp.b5_as(t1, format('select count(*)::text from public.chat_messages where room_id = %L', 'practice-' || d3));
    res := res || pg_temp.b5_chk(r <> 'ok:0' and r2 = 'ok:0', '7', 'C''s draft has its own room that A (not joined) can''t see', r || ' / ' || r2);
    res := res || pg_temp.b5_chk((select count(*) from public.chat_messages where room_id = 'practice-' || d1 and is_bot) >= 5
      and (select count(*) from public.chat_messages where room_id = 'draft') = league_msgs
      and not exists (select 1 from public.chat_messages m where m.room_id not like 'practice-%' and (m.event ->> 'draft') ~ '^\d+$' and (m.event ->> 'draft')::bigint in (d1, d3)),
      '7', 'B5 Bot posts go to the practice room; the league Draft chat got none',
      (select count(*) from public.chat_messages where room_id = 'practice-' || d1 and is_bot) || ' bot posts in the practice room');
    select coalesce((select x::text from public.draft_state x where x.id), 'none') into hdr_after;
    res := res || pg_temp.b5_chk(hdr_after = hdr_before, '7', 'league Draft chat header untouched', null);

    -- ------------------------------------------------------------------ 8. co-owners
    r := pg_temp.b5_as(t2, $q$select public.draft_create(2027, 'mock', 'TEST practice B', '{"rounds": 2, "timer_seconds": 60, "order_mode": "before"}'::jsonb)$q$);
    res := res || pg_temp.b5_chk(r ~ '^ok:\d+$', '8', 'co-owner B creates his own practice draft', r);
    d8 := substr(r, 4)::bigint;
    select array[tx] || array_agg(t order by t) into ord from unnest(all_teams) t where t <> tx;
    r := pg_temp.b5_as(t2, format('select array_to_string(public.draft_set_order(%s, 1, %L::text[]), %L)', d8, ord, ','));
    r2 := pg_temp.b5_as(t2, format('select public.draft_control(%s, %L)', d8, 'start'));
    res := res || pg_temp.b5_chk(r like 'ok:%' and r2 like 'ok:%' and (select status from public.drafts where id = d8) = 'live', '8', 'co-owner B sets the order and starts it', r2);
    r := pg_temp.b5_as(t2, format('select public.draft_settings(%s, %L::jsonb)', d8, '{"host_only": true}'));
    r := pg_temp.b5_as(t1, format('select public.draft_join(%s)', d8));
    r2 := pg_temp.b5_as(t1, format('select public.draft_control(%s, %L)', d8, 'pause'));
    res := res || pg_temp.b5_chk(r like 'ok:%' and r2 like 'err:%host has limited%', '8', 'host-only: co-owner A joined, can''t pause B''s draft', r2);
    pi := pi + 1; r := pg_temp.b5_as(t1, format('select public.draft_pick(%s, %L)::text', d8, pl[pi]));
    res := res || pg_temp.b5_chk(r like 'ok:%' and (select team_id from public.draft_selections where draft_id = d8 and overall = 1) = tx,
      '8', 'host-only: co-owner A still picks for their team', left(r, 60));
    pi := pi + 1; r := pg_temp.b5_as(t1, format('select public.draft_pick(%s, %L)::text', d8, pl[pi]));
    res := res || pg_temp.b5_chk(r like 'err:%own team%', '8', 'host-only: but not for another team', r);
    r := pg_temp.b5_as(t2, format('select public.draft_join(%s)', d1));
    r2 := pg_temp.b5_as(t2, format('select public.draft_control(%s, %L)', d1, 'pause'));
    res := res || pg_temp.b5_chk(r like 'ok:%' and r2 like 'ok:%', '8', 'co-owner B joins A''s draft and runs it', r2);

    -- ------------------------------------------------------------------ 2. (end) host ends it
    r := pg_temp.b5_as(t1, format('select public.draft_control(%s, %L)', d1, 'end'));
    res := res || pg_temp.b5_chk(r like 'ok:%' and (select status from public.drafts where id = d1) = 'complete', '2', 'end the draft', r);

    -- ------------------------------------------------------------------ 5. three active practice drafts per host
    for n in 1..3 loop
      r := pg_temp.b5_as(t4, format($q$select public.draft_create(2027, 'mock', %L, '{"rounds": 1}'::jsonb)$q$, 'TEST limit ' || n));
      if r ~ '^ok:\d+$' then dz := dz || substr(r, 4)::bigint; end if;
    end loop;
    r := pg_temp.b5_as(t4, $q$select public.draft_create(2027, 'mock', 'TEST limit 4', '{"rounds": 1}'::jsonb)$q$);
    res := res || pg_temp.b5_chk(cardinality(dz) = 3 and r like 'err:You already host 3 active practice drafts%', '5', 'a 4th active practice draft is refused', r);
    r := pg_temp.b5_as(t4, format('select public.draft_control(%s, %L)', dz[1], 'end'));
    r := pg_temp.b5_as(t4, $q$select public.draft_create(2027, 'mock', 'TEST limit 4', '{"rounds": 1}'::jsonb)$q$);
    res := res || pg_temp.b5_chk(r ~ '^ok:\d+$', '5', 'after ending one, a new one can be created', r);
    r := pg_temp.b5_as(t3, $q$select public.draft_create(2027, 'mock', 'TEST other host', '{"rounds": 1}'::jsonb)$q$);
    res := res || pg_temp.b5_chk(r ~ '^ok:\d+$', '5', 'the limit is per host', r);

    -- ------------------------------------------------------------------ 6. the real draft is off limits; practice changes nothing real
    foreach r2 in array array[
      format('select public.draft_control(%s, %L)', dr, 'start'),
      format('select public.draft_control(%s, %L)', dr, 'pause'),
      format('select array_to_string(public.draft_set_order(%s, 1, null), %L)', dr, ','),
      format('select public.draft_undo(%s, 1)::text', dr),
      format('select public.draft_settings(%s, %L::jsonb)', dr, '{"timer_seconds": 5}'),
      format('select public.draft_join(%s)', dr),
      format('select public.draft_delete(%s)', dr),
      format('select public.draft_pick(%s, %L)::text', dr, pl[80])] loop
      r := pg_temp.b5_as(t1, r2);
      res := res || pg_temp.b5_chk(r like 'err:%', '6', 'regular manager refused on the real draft: ' || split_part(split_part(r2, 'public.', 2), '(', 1), r);
    end loop;
    -- a whole practice draft to the end, "complete" included
    r := pg_temp.b5_as(t1, $q$select public.draft_create(2027, 'mock', 'TEST practice full', '{"rounds": 1, "timer_seconds": 60}'::jsonb)$q$);
    d6 := substr(r, 4)::bigint;
    r := pg_temp.b5_as(t1, format('select public.draft_control(%s, %L)', d6, 'start'));
    r := pg_temp.b5_as(t1, format('select array_to_string(public.draft_set_order(%s, 1, null), %L)', d6, ','));
    for n in 1..cardinality(all_teams) loop
      pi := pi + 1; r := pg_temp.b5_as(t1, format('select public.draft_pick(%s, %L)::text', d6, pl[pi]));
    end loop;
    r := pg_temp.b5_as(t1, format('select public.draft_control(%s, %L)', d6, 'complete'));
    res := res || pg_temp.b5_chk(r like 'ok:%' and (select status from public.drafts where id = d6) = 'complete', '6', 'a practice draft run to the end and finalized', r);
    snap_after := pg_temp.b5_snap();
    res := res || pg_temp.b5_chk(snap_after = snap_before, '6', 'rosters, draft picks, transactions, awards, scores, lineups, ledger and the real draft unchanged', null);
    select array_agg(id) into mine from public.drafts where host in (t1, t2, t3, t4);
    res := res || pg_temp.b5_chk(not exists (select 1 from public.audit_log a where (a.details ->> 'draft') ~ '^\d+$' and (a.details ->> 'draft')::bigint = any (mine)),
      '6', 'practice actions write no admin audit entries', null);
    res := res || pg_temp.b5_chk(not exists (select 1 from public.notify_queue q where (q.payload ->> 'draft_id') ~ '^\d+$' and (q.payload ->> 'draft_id')::bigint = any (mine)
                                              and q.user_id not in (t1, t2, t3, t4)),
      '6', 'no draft emails queued for anyone outside the practice drafts', null);
    select count(*) into n from public.drafts where host in (t1, t2, t3, t4);
    res := res || pg_temp.b5_chk(n >= 8, 'info', 'practice drafts created during the check (all rolled back)', n::text);
  exception when others then
    res := res || ('FAIL [error] ' || sqlerrm);
  end;

  -- Undo everything: the error rolls back the whole block.
  raise exception 'B5VERIFY%', E'\n' || array_to_string(res, E'\n') || E'\nB5VERIFY-END';
end
$verify$;
