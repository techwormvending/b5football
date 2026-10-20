/* TEMPORARY (2026 shadow season; delete with the other MFL code after the migration):
   mirror MFL's current rosters into Supabase public.roster_entries, nightly.

   Usage:  node scripts/sync-mfl-rosters.mts [season]        (default 2026)
           --dry-run  map and report, write nothing
   Env:    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (server only), B5_CACHE (default .cache/)

   Also flags, in public.review_queue:
     provider "mfl"      rostered MFL players we can't map to an nflverse ID (never name-matched)
     provider "nflverse" rostered players with no ESPN ID (live scoring can't credit them)
   Entries that no longer apply are marked resolved. */

import fs from "node:fs";
import path from "node:path";
import { parseCsv } from "../src/ingest/csv.ts";
import { mapRosters, mflToGsis, type MflFranchise, type MflPlayerInfo } from "../src/league/mflRosters.ts";
import { upsert } from "../src/league/nflSync.ts";
import { deleteWhere, selectAll, updateWhere, type SbConfig } from "../src/league/supabaseRest.ts";

const LEAGUE = "22689";
const HOST = "https://www45.myfantasyleague.com";
const API = "https://api.myfantasyleague.com";
const IDMAP_URL = "https://github.com/dynastyprocess/data/raw/master/files/db_playerids.csv";
const CACHE = path.resolve(process.env.B5_CACHE || ".cache", "mfl");
const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const season = Number(args.find(a => /^\d{4}$/.test(a))) || 2026;
const url = process.env.SUPABASE_URL, serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) { console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."); process.exit(1); }
const cfg: SbConfig = { url, serviceKey };

async function get(src: string, name: string): Promise<string> {
  const file = path.join(CACHE, name);
  try {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    fs.mkdirSync(CACHE, { recursive: true });
    fs.writeFileSync(file, text);
    return text;
  } catch (err) {
    // Rosters must be current: never fall back to a cached roster file.
    if (name.startsWith("rosters") || !fs.existsSync(file)) throw new Error(`Can't download ${name}: ${(err as Error).message}`);
    log(`${name}: download failed (${(err as Error).message}); using the cached copy.`);
    return fs.readFileSync(file, "utf8");
  }
}

const rosters = JSON.parse(await get(`${HOST}/${season}/export?TYPE=rosters&L=${LEAGUE}&JSON=1`, `rosters-${season}.json`));
const franchises = ([] as MflFranchise[]).concat(rosters?.rosters?.franchise ?? []);
const mflPlayers = JSON.parse(await get(`${API}/${season}/export?TYPE=players&JSON=1`, `players-${season}.json`));
const players = new Map<string, MflPlayerInfo>(([] as MflPlayerInfo[]).concat(mflPlayers?.players?.player ?? []).map(p => [p.id, p]));
const idMap = mflToGsis(parseCsv(await get(IDMAP_URL, "db_playerids.csv")));
const nfl = await selectAll<{ id: string; espn_id: string | null; name: string; nfl_team: string | null }>(cfg, "nfl_players", "select=id,espn_id,name,nfl_team");
const known = new Set(nfl.map(p => p.id));

const { entries, unmatched, mflIds } = mapRosters({ season, franchises, players, idMap, known });
const total = franchises.reduce((n, f) => n + ([] as unknown[]).concat(f.player ?? []).length, 0);
log(`MFL: ${franchises.length} teams, ${total} rostered; mapped ${entries.length}, unmatched ${unmatched.length}`);
for (const u of unmatched) log(`  UNMATCHED ${u.franchise} MFL ${u.mflId} ${u.name} (${u.position} ${u.team}): ${u.reason}`);

// Guard: a broken or partial export must never wipe the rosters.
if (franchises.length !== 12 || entries.length < 12 * 15) {
  console.error(`Refusing to sync: expected 12 teams and at least 180 mapped players, got ${franchises.length} and ${entries.length}.`);
  process.exit(1);
}

const byId = new Map(nfl.map(p => [p.id, p]));
const noEspn = entries.filter(e => !e.player_id.startsWith("DEF:") && !byId.get(e.player_id)?.espn_id);
for (const e of noEspn) log(`  NO ESPN ID ${e.team_id} ${e.player_id} ${byId.get(e.player_id)?.name}`);

if (dry) { log("Dry run: nothing written."); process.exit(0); }

const now = new Date().toISOString();
log(`roster_entries: ${await upsert(cfg, "roster_entries", entries.map(e => ({ ...e, acquired_at: now })), "season,player_id")} upserted`);
// Players no longer on any MFL roster this season (dropped): remove.
const keep = entries.map(e => `"${e.player_id}"`).join(",");
const dropped = await deleteWhere(cfg, "roster_entries", `season=eq.${season}&player_id=not.in.(${encodeURIComponent(keep)})`);
log(`roster_entries: ${dropped} removed (no longer rostered on MFL)`);
// MFL ID -> our ID for rostered players (the live scorer mirrors MFL starters with it).
await upsert(cfg, "mfl_player_map", [...mflIds].map(([mfl_id, player_id]) => ({ mfl_id, player_id, updated_at: now })), "mfl_id");
log(`mfl_player_map: ${mflIds.size} upserted`);

// Review queue: open what's unmatched now, resolve what isn't any more.
const review = [
  ...unmatched.map(u => ({ provider: "mfl", provider_id: u.mflId, name: u.name || `MFL ${u.mflId}`, team: u.team || null, reason: `Rostered by ${u.franchise}: ${u.reason}`, status: "open", last_seen: now })),
  ...noEspn.map(e => ({ provider: "nflverse", provider_id: e.player_id, name: byId.get(e.player_id)?.name ?? e.player_id, team: byId.get(e.player_id)?.nfl_team ?? null,
    reason: `Rostered by ${e.team_id}, but has no ESPN ID: live scoring can't credit him until nflverse adds one (final scores are unaffected)`, status: "open", last_seen: now }))
];
if (review.length) await upsert(cfg, "review_queue", review, "provider,provider_id");
for (const prov of ["mfl", "nflverse"]) {
  const open = review.filter(r => r.provider === prov).map(r => `"${r.provider_id}"`).join(",");
  await updateWhere(cfg, "review_queue", `provider=eq.${prov}&status=eq.open${open ? `&provider_id=not.in.(${encodeURIComponent(open)})` : ""}`, { status: "resolved" });
}
log(`review_queue: ${unmatched.length} unmatched MFL players, ${noEspn.length} rostered players without an ESPN ID`);
