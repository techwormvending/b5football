-- Franchise lineage approved by the commissioner (2026-11-03): every name proposed by the history import
-- now counts for today's team (titles, runner-up appearances, links, Empire back-to-backs).
--   The Phantom / Phantom / Polar Express (MFL 0001)  -> NSFW
--   Stealers (MFL 0012, 2007-2019)                    -> Stealers
--   Born Again Winners (MFL 0011, 2003-2013)          -> Vandelay Industries
--   Soggy Bottom Boys (MFL 0008, 2006-2010)           -> The Nutcrackers
--   Stugots (MFL 0009)                                -> Balls on Toast
--   the Greene Machine (MFL 0010)                     -> Puka's Brain Worm
-- Former teams (Insane Monkeys, Party Monkeys, The Last O.G., BFPM, Bret Farve's Replacement,
-- Peyton's Comeback) stay historical. Only these exact rows change.

update public.history_franchises f
   set status = 'approved'
  from (values ('0001', 'The Phantom', '0001'), ('0001', 'Phantom', '0001'), ('0001', 'Polar Express', '0001'),
               ('0012', 'Stealers', '0002'), ('0011', 'Born Again Winners', '0006'), ('0008', 'Soggy Bottom Boys', '0008'),
               ('0009', 'Stugots', '0009'), ('0010', 'the Greene Machine', '0010')) as v (mfl_id, name, team_id)
 where f.mfl_id = v.mfl_id and f.name = v.name and f.status = 'proposed' and f.team_id = v.team_id;
