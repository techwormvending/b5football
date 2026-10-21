/* Load NFL players and the schedule (kickoff times) into Supabase. Lineups lock
   at each player's kickoff from public.nfl_games, so this runs nightly (the
   finalize workflow) and can be run by hand after a schedule change (flexed game).

   Usage:  node scripts/sync-nfl.mts [season]      default: this NFL season (March onward = this year)
   Env:    SUPABASE_URL (with or without /rest/v1/), SUPABASE_SERVICE_ROLE_KEY (server only, never in the repo),
           B5_CACHE (default .cache/)
   Games are synced for <season> and <season + 1> (the next schedule appears in May).
   Injury statuses (Live page warnings): nflverse injuries_<season>.csv (weekly report) + players.csv
   roster status (current week), merged by src/league/injuries.ts, written with public.replace_injuries
   (weeks from the current one are replaced in one transaction). */

import fs from "node:fs";
import path from "node:path";
import { parseCsv } from "../src/ingest/csv.ts";
import { gamesFromRows, playersFromRows, upsert } from "../src/league/nflSync.ts";
import { currentWeek, injuryRows } from "../src/league/injuries.ts";

const PLAYERS_URL = "https://github.com/nflverse/nflverse-data/releases/download/players/players.csv";
const INJURIES_URL = (s: number) => `https://github.com/nflverse/nflverse-data/releases/download/injuries/injuries_${s}.csv`;
const GAMES_URL = "https://github.com/nflverse/nfldata/raw/master/data/games.csv";
const CACHE = path.resolve(process.env.B5_CACHE || ".cache", "nflverse");
const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

const url = process.env.SUPABASE_URL, serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) { console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."); process.exit(1); }

const now = new Date();
const season = Number(process.argv[2]) || (now.getUTCMonth() >= 2 ? now.getUTCFullYear() : now.getUTCFullYear() - 1);

/** Always try a fresh download; fall back to the cached copy if nflverse is unreachable. */
async function csv(name: string, src: string): Promise<Record<string, string>[]> {
  const file = path.join(CACHE, name);
  try {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    fs.mkdirSync(CACHE, { recursive: true });
    fs.writeFileSync(file + ".tmp", await res.text());
    fs.renameSync(file + ".tmp", file);
  } catch (err) {
    if (!fs.existsSync(file)) throw new Error(`Can't download ${name}: ${(err as Error).message}`);
    log(`${name}: download failed (${(err as Error).message}); using the cached copy.`);
  }
  return parseCsv(fs.readFileSync(file, "utf8"));
}

const cfg = { url, serviceKey };
const playerRows = await csv("players.csv", PLAYERS_URL);
const players = playersFromRows(playerRows, season);
log(`nfl_players: ${await upsert(cfg, "nfl_players", players.map(p => ({ ...p, updated_at: now.toISOString() })), "id")} upserted`);

const gameRows = await csv("games.csv", GAMES_URL);
for (const s of [season, season + 1]) {
  const games = gamesFromRows(gameRows, s);
  if (!games.length) { log(`nfl_games ${s}: no schedule yet`); continue; }
  const noKick = games.filter(g => !g.kickoff).length;
  log(`nfl_games ${s}: ${await upsert(cfg, "nfl_games", games, "season,week,game_key")} upserted${noKick ? `, ${noKick} without a kickoff time` : ""}`);
  // A game the NFL moved to another week must not linger in its old week (it would lock those players at the old time).
  let removed = 0;
  for (const w of [...new Set(games.map(g => g.week))]) {
    const keys = games.filter(g => g.week === w).map(g => `"${g.game_key}"`).join(",");
    removed += await removeStale(s, w, keys);
  }
  if (removed) log(`nfl_games ${s}: removed ${removed} game(s) no longer on the schedule`);
}

// Injury statuses. A missing report file (before the season) isn't an error: roster statuses still apply.
{
  const wk = currentWeek(gamesFromRows(gameRows, season), now.getTime());
  let report: Record<string, string>[] = [];
  try { report = await csv(`injuries_${season}.csv`, INJURIES_URL(season)); }
  catch (err) { log(`injuries ${season}: ${(err as Error).message} (weekly report skipped)`); }
  const rows = injuryRows({ season, currentWeek: wk, known: new Set(players.map(p => p.id)), report, players: playerRows });
  const base = url.replace(/\/+$/, "").replace(/\/rest\/v1$/, "");
  const headers: Record<string, string> = { apikey: serviceKey, "Content-Type": "application/json" };
  if (serviceKey.startsWith("eyJ")) headers.Authorization = `Bearer ${serviceKey}`;
  const res = await fetch(`${base}/rest/v1/rpc/replace_injuries`, { method: "POST", headers,
    body: JSON.stringify({ p_season: season, p_from_week: wk ?? 19, p_rows: rows }) });
  if (!res.ok) throw new Error(`replace_injuries: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  const by: Record<string, number> = {};
  for (const r of rows) if (r.week === wk) by[r.status] = (by[r.status] ?? 0) + 1;
  log(`player_injuries ${season}: ${rows.length} rows (current week ${wk ?? "none"}: ${JSON.stringify(by)})`);
}

async function removeStale(s: number, w: number, keys: string): Promise<number> {
  const base = url!.replace(/\/+$/, "").replace(/\/rest\/v1$/, "");
  const headers: Record<string, string> = { apikey: serviceKey!, Prefer: "return=representation" };
  if (serviceKey!.startsWith("eyJ")) headers.Authorization = `Bearer ${serviceKey}`;
  const res = await fetch(`${base}/rest/v1/nfl_games?season=eq.${s}&week=eq.${w}&game_key=not.in.(${encodeURIComponent(keys)})`, { method: "DELETE", headers });
  if (!res.ok) throw new Error(`nfl_games cleanup: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  return (await res.json() as unknown[]).length;
}
