-- League history (2026-11-02): champion and runner-up for every season since 2000, with a "verified" flag
-- and the source, plus the franchise lineage (old team names -> today's teams). Feeds the History page,
-- team profiles (titles) and the Payouts Empire pot (the defending champion).
--
-- Sources: MFL's public exports for each season's league (the 2026 league export's history list gives each
-- year's league ID): playoff bracket results (TYPE=playoffBracket) 2003-2022, week 17 results for 2023, and
-- the MFL "League Champions" report for 2024-2025 (those seasons' exports are private). 2000-2002 were on
-- intergrow.com, which is gone: unknown until the commissioner enters them.
--
-- Teams are stored as they were named that season, with MFL's franchise ID for that season. A name links to
-- a current team only through public.history_franchises with status 'approved' (MFL ID + name -> team).
-- 'proposed' (a suggested team, awaiting the commissioner) and 'historical' (no current team) show the old
-- name as plain text: nothing is guessed publicly.

create table public.league_history (
  season int primary key check (season between 2000 and 2100),
  champion text check (champion is null or char_length(btrim(champion)) between 1 and 60),
  champion_mfl text check (champion_mfl is null or champion_mfl ~ '^[0-9]{4}$'),
  runner_up text check (runner_up is null or char_length(btrim(runner_up)) between 1 and 60),
  runner_up_mfl text check (runner_up_mfl is null or runner_up_mfl ~ '^[0-9]{4}$'),
  result text check (result is null or char_length(result) <= 120),       -- "107-86, week 16"
  verified boolean not null default false,
  source text check (source is null or char_length(source) <= 120),
  note text check (note is null or char_length(note) <= 600),
  updated_by uuid,
  updated_at timestamptz not null default now()
);

create table public.history_franchises (
  mfl_id text not null check (mfl_id ~ '^[0-9]{4}$'),
  name text not null check (char_length(btrim(name)) between 1 and 60),
  status text not null default 'proposed' check (status in ('approved', 'proposed', 'historical')),
  team_id text references public.teams (id),          -- approved: the current team; proposed: the suggestion
  evidence text check (evidence is null or char_length(evidence) <= 600),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (mfl_id, name),
  check (status <> 'approved' or team_id is not null)
);

alter table public.league_history enable row level security;
alter table public.history_franchises enable row level security;
create policy "public read" on public.league_history for select to anon, authenticated using (true);
create policy "public read" on public.history_franchises for select to anon, authenticated using (true);
create policy "commissioner writes" on public.league_history for all to authenticated using (private.is_commissioner()) with check (private.is_commissioner());
create policy "commissioner writes" on public.history_franchises for all to authenticated using (private.is_commissioner()) with check (private.is_commissioner());
grant select on public.league_history, public.history_franchises to anon, authenticated;
grant insert, update, delete on public.league_history, public.history_franchises to authenticated;
grant all on public.league_history, public.history_franchises to service_role;

-- Who changed it and when (set by the database), and every commissioner change in the audit log.
create function private.history_stamp() returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.updated_by := (select auth.uid());
  new.updated_at := now();
  return new;
end;
$$;
create trigger history_stamp before insert or update on public.league_history for each row execute function private.history_stamp();
create trigger history_stamp before insert or update on public.history_franchises for each row execute function private.history_stamp();

create function private.history_audit() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if (select auth.uid()) is not null then
    insert into public.audit_log (actor, action, details)
    values ((select auth.uid()), 'history:' || tg_table_name || ':' || lower(tg_op),
            jsonb_build_object('old', case when tg_op <> 'INSERT' then to_jsonb(old) end, 'new', case when tg_op <> 'DELETE' then to_jsonb(new) end));
  end if;
  return null;
end;
$$;
create trigger history_audit after insert or update or delete on public.league_history for each row execute function private.history_audit();
create trigger history_audit after insert or update or delete on public.history_franchises for each row execute function private.history_audit();

-- Empire pot: a season's defending champion = the previous season's champion, when its name is mapped to a
-- current team (approved). Seasons whose previous season has no history row are left alone.
create function private.history_sync_empire() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  update public.season_settings s
     set empire_defending_team = (select f.team_id from public.league_history h
                                    join public.history_franchises f on f.mfl_id = h.champion_mfl and f.name = h.champion and f.status = 'approved'
                                   where h.season = s.season - 1),
         updated_at = now()
   where exists (select 1 from public.league_history h where h.season = s.season - 1);
  return null;
end;
$$;
create trigger history_sync_empire after insert or update or delete on public.league_history for each statement execute function private.history_sync_empire();
create trigger history_sync_empire after insert or update or delete on public.history_franchises for each statement execute function private.history_sync_empire();
revoke execute on function private.history_stamp(), private.history_audit(), private.history_sync_empire() from public, anon;

-- Lineage. Approved: the same MFL franchise ID as today's team AND today's name. Everything else waits
-- for the commissioner. Evidence from MFL's franchise names by season (2003-2025).
insert into public.history_franchises (mfl_id, name, status, team_id, evidence)
select v.mfl_id, v.name, v.status, v.team_id, v.evidence from (values
  ('0001', 'NSFW', 'approved', '0001', 'Franchise 0001, NSFW since 2019.'),
  ('0002', 'Stealers', 'approved', '0002', 'Franchise 0002 since 2020.'),
  ('0003', 'H.N.I.C', 'approved', '0003', 'Franchise 0003, H.N.I.C since 2005.'),
  ('0004', 'Narcoleptic Dogs', 'approved', '0004', 'Franchise 0004, Narcoleptic Dogs every season 2003-2025.'),
  ('0005', 'The Mighty Mullets', 'approved', '0005', 'Franchise 0005, The Mighty Mullets every season 2003-2025.'),
  ('0006', 'Vandelay Industries', 'approved', '0006', 'Franchise 0006 since 2020.'),
  ('0007', 'The Sissy Boys', 'approved', '0007', 'Franchise 0007: The Sissy Boys 2003-2012, Cosmic Caterpillar 2013, Sissy Boys since 2014.'),
  ('0007', 'Sissy Boys', 'approved', '0007', 'Franchise 0007, Sissy Boys since 2014.'),
  ('0008', 'The Nutcrackers', 'approved', '0008', 'Franchise 0008, The Nutcrackers since 2011.'),
  ('0011', 'Mac Daddies', 'approved', '0011', 'Franchise 0011, Mac Daddies since 2021.'),
  ('0001', 'The Phantom', 'proposed', '0001', 'Franchise 0001: The Phantom 2003-04, Carnival Ponies 2005-06, Phantom 2007-16, Polar Express 2017-18, NSFW since 2019. Same ID throughout.'),
  ('0001', 'Phantom', 'proposed', '0001', 'Franchise 0001: Phantom 2007-2016, then Polar Express, then NSFW (same ID).'),
  ('0001', 'Polar Express', 'proposed', '0001', 'Franchise 0001: Polar Express 2017-2018, NSFW since 2019 (same ID).'),
  ('0012', 'Stealers', 'proposed', '0002', 'Stealers were franchise 0012 2007-2019; in 2020 (a 10-team season) Stealers moved to franchise 0002.'),
  ('0011', 'Born Again Winners', 'proposed', '0006', 'Franchise 0011: Born Again Winners 2003-2013, Vandelay Industries 2014-2019; in 2020 Vandelay Industries moved to franchise 0006.'),
  ('0008', 'Soggy Bottom Boys', 'proposed', '0008', 'Franchise 0008: The Brothers Grim 2003-05, Soggy Bottom Boys 2006-10, The Nutcrackers since 2011 (same ID). (Franchise 0003 was also called Soggy Bottom Boys in 2003-04.)'),
  ('0009', 'Stugots', 'proposed', '0009', 'Franchise 0009: Stugots 2003-07, Stugots II 2008-10, Blanco 2011-12, Stugots 2013-15, Uncle June 2016-20, Curse of the Monkey 2021, Balls on Toast since 2022 (same ID).'),
  ('0010', 'the Greene Machine', 'proposed', '0010', 'Franchise 0010: The Greene Machine 2003-2019, Aces & Spaces 2020-2025, Puka''s Brain Worm in 2026 (same ID).'),
  ('0002', 'Insane Monkeys', 'historical', null, 'Franchise 0002 2003-2019 (Arli$$''s Reservoir Dogs, Insane Monkeys, Steroid Gorillas, Monkey names, Party Monkeys, The Last O.G.); it left when the league had 10 teams in 2020, and Stealers took ID 0002.'),
  ('0002', 'Party Monkeys', 'historical', null, 'Franchise 0002 2003-2019; left in 2020 (see Insane Monkeys).'),
  ('0002', 'The Last O.G.', 'historical', null, 'Franchise 0002 2003-2019; left in 2020 (see Insane Monkeys).'),
  ('0006', 'BFPM', 'historical', null, 'Franchise 0006 2003-2019 (Lambert''s Lunatics, Adam Bomb, The Funksters, Bret Farve names, Peyton''s Comeback, BFPM); it left in 2020, and Vandelay Industries took ID 0006.'),
  ('0006', 'Bret Farve''s Replacement', 'historical', null, 'Franchise 0006 2003-2019; left in 2020 (see BFPM).'),
  ('0006', 'Peyton''s Comeback', 'historical', null, 'Franchise 0006 2003-2019; left in 2020 (see BFPM).')
) as v (mfl_id, name, status, team_id, evidence)
where v.team_id is null or exists (select 1 from public.teams t where t.id = v.team_id);   -- (a fresh test database has no teams yet)

insert into public.league_history (season, champion, champion_mfl, runner_up, runner_up_mfl, result, verified, source, note) values
  (2000, null, null, null, null, null, false, null, 'Unknown: the old intergrow.com archive is gone (no Internet Archive copy). The commissioner can enter it.'),
  (2001, null, null, null, null, null, false, null, 'Unknown: the old intergrow.com archive is gone (no Internet Archive copy). The commissioner can enter it.'),
  (2002, null, null, null, null, null, false, null, 'Unknown: the old intergrow.com archive is gone (no Internet Archive copy). The commissioner can enter it.'),
  (2003, 'The Phantom', '0001', null, null, 'Black bracket final, week 15: 157-97 over The Sissy Boys', false, 'MFL 2003 playoff brackets',
   'MFL has two division brackets and no title game: The Phantom won Black (157-97 over The Sissy Boys), Arli$$''s Reservoir Dogs won Gold (81-77 over Narcoleptic Dogs). MFL''s champions report lists The Phantom.'),
  (2004, 'Born Again Winners', '0011', 'Insane Monkeys', '0002', '119-98, week 16', true, 'MFL 2004 playoff bracket', null),
  (2005, 'Insane Monkeys', '0002', 'The Mighty Mullets', '0005', '96-69, week 16', true, 'MFL 2005 playoff bracket', null),
  (2006, 'Stugots', '0009', 'Soggy Bottom Boys', '0008', '108-72, week 16', true, 'MFL 2006 playoff bracket', null),
  (2007, 'Stealers', '0012', 'H.N.I.C', '0003', '103-70, week 16', true, 'MFL 2007 playoff bracket', null),
  (2008, 'H.N.I.C', '0003', 'Stealers', '0012', '107-86, week 16', true, 'MFL 2008 playoff bracket',
   'MFL''s League Champions report (garbled for this year) was read as The Sissy Boys; the 2008 bracket has H.N.I.C beating The Sissy Boys 107-96 in round 1, Phantom 99-73 in the semifinal and Stealers 107-86 in the final.'),
  (2009, 'The Sissy Boys', '0007', 'Soggy Bottom Boys', '0008', '92-70, week 16', true, 'MFL 2009 playoff bracket', null),
  (2010, 'H.N.I.C', '0003', 'Soggy Bottom Boys', '0008', '112-97, week 16', true, 'MFL 2010 playoff bracket', null),
  (2011, 'Born Again Winners', '0011', 'Bret Farve''s Replacement', '0006', '98-95, week 16', true, 'MFL 2011 playoff bracket', null),
  (2012, 'Phantom', '0001', 'Peyton''s Comeback', '0006', '126-102, week 16', true, 'MFL 2012 playoff bracket', null),
  (2013, 'the Greene Machine', '0010', 'Stugots', '0009', '113-81, week 16', true, 'MFL 2013 playoff bracket', null),
  (2014, 'Narcoleptic Dogs', '0004', 'The Mighty Mullets', '0005', '92-81, week 16', true, 'MFL 2014 playoff bracket', null),
  (2015, 'Party Monkeys', '0002', 'The Mighty Mullets', '0005', '93.5-90.5, week 16', true, 'MFL 2015 playoff bracket', null),
  (2016, 'Phantom', '0001', 'BFPM', '0006', '94-83, week 16', true, 'MFL 2016 playoff bracket', null),
  (2017, 'the Greene Machine', '0010', 'Polar Express', '0001', '107-83, week 16', true, 'MFL 2017 playoff bracket', null),
  (2018, 'The Last O.G.', '0002', 'The Mighty Mullets', '0005', '99-86, week 16', true, 'MFL 2018 playoff bracket', null),
  (2019, 'BFPM', '0006', 'H.N.I.C', '0003', '136-97, week 16', true, 'MFL 2019 playoff bracket', null),
  (2020, 'Stealers', '0002', 'NSFW', '0001', '138-136, week 16', true, 'MFL 2020 playoff bracket', null),
  (2021, 'Stealers', '0002', 'Sissy Boys', '0007', '176-94.9, week 17', true, 'MFL 2021 playoff bracket', null),
  (2022, 'H.N.I.C', '0003', 'Sissy Boys', '0007', '66.2-66.2, week 17 (tie)', true, 'MFL 2022 playoff bracket and League Champions report',
   'The final was a 66.2-66.2 tie; MFL''s champions report gives the title to H.N.I.C (tiebreaker).'),
  (2023, 'Mac Daddies', '0011', 'H.N.I.C', '0003', '77.9-57.5, week 17', true, 'MFL 2023 week 17 results', null),
  (2024, 'The Nutcrackers', '0008', 'Vandelay Industries', '0006', null, true, 'MFL League Champions report', 'MFL''s 2024 bracket export is private; from the champions report.'),
  (2025, 'Sissy Boys', '0007', 'H.N.I.C', '0003', null, true, 'MFL League Champions report', 'MFL''s 2025 bracket export is private; from the champions report.');
