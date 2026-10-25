-- Live game situation (2026-10-25): from the ESPN scoreboard the live scorer already reads, each
-- in-progress game's team with the ball, whether it's a red-zone drive, and down & distance with ball
-- position ("2nd & 6 at KC 14"). Written with the score and clock on every live pass (so the Live page
-- gets it with its usual Realtime refresh); null when nobody has the ball (halftime, end of a quarter,
-- between a score and the kickoff) and once the game is final. Public read like the rest of nfl_games.
alter table public.nfl_games
  add column possession text,
  add column red_zone boolean not null default false,
  add column down_distance text;
