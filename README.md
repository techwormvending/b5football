# Bridgeville 5 Fantasy Site

A static site (GitHub Pages) with Supabase for accounts and lineups. No build step.

- **Local preview:** `node scripts/serve.js`, then open http://localhost:8737.
- Sign-in, My Team and the commissioner screen talk to Supabase directly from the browser.

| File | Purpose |
|---|---|
| `league-data.js` | **All content.** Edit this; nothing else needs touching for routine updates. |
| `app.js` | Renders pages from the data. Hash routing (`#home`, `#myteam`, `#schedule`, `#teams`, `#history`, `#rules`, `#traditions`, `#account`, `#commish`). |
| `auth.js`, `account.js` | Magic-link sign-in, the account page and the commissioner screen. |
| `myteam.js` | My Team: team, record, roster and (from 2027) the weekly lineup. |
| `style.css` | Theme. Colors are CSS variables at the top of the file. |
| `index.html` | Shell + nav. |
| `scripts/refresh-mfl.js` | Re-pulls standings, rosters and schedule/scores from MFL into `league-data.js`. |

## Lineups
Managers sign in and land on **My Team**. Lineups open there for the **2027 season** (`lineupsFrom` in `league-data.js`); until then the page shows the team, record and roster.

- Lineups are saved in Supabase (`lineup_slots`) through `save_lineup()`. The database enforces the rules: own team only, player on the roster, right position, and each player locks at his game's kickoff. The commissioner can edit any team.
- No lineup saved yet: last week's is shown as a draft to confirm.
- Kickoff times and NFL players come from nflverse, loaded nightly by `scripts/sync-nfl.mts` (part of the nightly workflow).

## Scoring engine
`src/scoring/` holds the B5 scoring engine (TypeScript). Run its tests with `npm test` and type-check with `npm run typecheck` (first run `npm install`). It matches MFL's official scores exactly for 2026 weeks 1–5.

## Stats ingest
`src/ingest/` turns NFL stats feeds into scoring-engine input. Live scores will come from ESPN's public (unofficial) feed; final scores come from nflverse, the system of record. The nflverse adapter matches MFL's official scores on all 10,030 player and defense games checked (2025 and 2026 so far).

```
node scripts/bakeoff.mts nflverse 2026 1 2 3 4 5 --fetch-mfl
node scripts/spike-espn-vs-nflverse.mts 2026 5
node scripts/verify-espn.mts 2026 1 2 3 4 5
```
`bakeoff.mts` compares a source's scores with MFL's official scores (`--fetch-mfl` downloads them into `.bakeoff/`). The spike compares ESPN's and nflverse's touchdowns, with yardage, for one game. `verify-espn.mts` scores every player and defense from ESPN (live adapter) and nflverse and lists any difference.

## Database (Supabase)
Schema changes are migrations in `supabase/migrations/`; never edit tables in the dashboard. `npm test` includes RLS tests that run the migrations in an in-process Postgres (no Docker needed) and check that managers can only change their own team. The service_role key lives only in the GitHub Actions secret `SUPABASE_SERVICE_ROLE_KEY`, and the project URL in the Actions variable `SUPABASE_URL`.

## Live scoring and weekly finalization
- **Live poller** (keep it running in season, e.g. as a service): `node scripts/live-poller.mts`. It polls ESPN only while games are on (every 30–60 s) and otherwise sleeps until shortly before the next kickoff. `--once` does a single poll.
- **Nightly finalization** (schedule daily, e.g. 4 AM ET): `node scripts/finalize.mts`. It pulls nflverse (the official record), overwrites live scores, logs every live-vs-final difference and stat correction, and auto-locks each week Tuesday 11 PM ET (`AUTO_FINALIZE=off` to require the commissioner).
- **Commissioner:** `node scripts/commish.mts status 2026`, `diffs 2026 6`, `confirm 2026 6`, `reopen 2026 6 "reason"`, `review` (players with no ID match), `audit`.
- **Overrides** (survive nightly re-runs; every change is audited):
  - `node scripts/commish.mts override 2026 6 "Jameson Williams" stats '{"recTdLengths":[52]}' "League office ruling"` corrects stats; points are recomputed.
  - `node scripts/commish.mts override 2026 6 DEF:PHI points 10 "Forfeit"` pins a score.
  - `overrides 2026 6` lists them, `unoverride 2026 6 <id> "reason"` removes one, and `scores 2026 6 [name|position]` shows effective scores (overrides marked `*`).
- Data lives in `data/league/` (set `B5_DATA` to move it). Back it up.

## Routine updates
- **Refresh from MFL (standings, rosters, schedule & scores):** run `node scripts/refresh-mfl.js`. It only rewrites the blocks between the `@mfl-begin` / `@mfl-end` markers in `league-data.js`, and bumps the `?v=` on `league-data.js` in `index.html` so browsers pick up the new data. Run it after each week's games are final (Tuesday morning) and after waivers.
- **Post an announcement:** add an object to the top of `announcements`. `body` is raw HTML — `<img src="...gif">`, embeds, links all work. `image` is an optional full-width image URL.
- **Countdown:** change `nextEvent` (label + ISO datetime with offset, e.g. `-05:00` EST / `-04:00` EDT).
- **End of season:** add a row to the top of `champions`; bump the winner's `titles` in `teams`. The Title Count table builds itself.

## TODOs in the data file
Manager names, past champions, traditions text, bylaws details, trade deadline date. Teams, logos, divisions and scoring are already filled in from MFL; standings, rosters and the schedule come from the refresh script.

## Notes
- Announcement bodies are rendered as HTML by design (commissioner-authored). Every other field is escaped.
- Cache: after editing, browsers may hold the old `league-data.js`. The refresh script bumps its `?v=`; do the same by hand after manual edits.
