/* TEMPORARY (2026): import MFL's add/drops, waiver claims and trades into public.transactions (via 'mfl'),
   so the site's transactions log and 24-hour drop lock follow MFL. Rosters are mirrored separately
   (scripts/sync-mfl-rosters.mts). Run nightly by the finalize workflow, after the roster sync.
   Players are mapped like the roster sync (mapMflId: defenses by MFL team code, players through
   dynastyprocess's ID map, never by name), so dropped players and defenses get names too; anything
   unmappable stays "mfl:<id>". Rows are upserted on mfl_key, so a later, better mapping fixes old rows.
   Usage:  node scripts/import-mfl-transactions.mts [season]     default 2026
   Env:    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (Actions secret), MFL_LEAGUE (default 22689). No MFL login. */

import { parseCsv } from "../src/ingest/csv.ts";
import { mapMflId, mflToGsis, type MflPlayerInfo } from "../src/league/mflRosters.ts";
import { txnRows, type MflTxn } from "../src/league/mflTransactions.ts";
import { selectAll, type SbConfig } from "../src/league/supabaseRest.ts";

const url = process.env.SUPABASE_URL, serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) { console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."); process.exit(1); }
const sb: SbConfig = { url, serviceKey };
const season = Number(process.argv[2]) || 2026, league = process.env.MFL_LEAGUE || "22689";
const UA = { headers: { "User-Agent": "b5-fantasy-site/0.1 (private league)" } };
const getJson = async (u: string) => { const r = await fetch(u, UA); if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`); return r.json(); };

const j = await getJson(`https://www45.myfantasyleague.com/${season}/export?TYPE=transactions&L=${league}&COUNT=1000&JSON=1`) as { transactions?: { transaction?: MflTxn | MflTxn[] } };
const list = ([] as MflTxn[]).concat(j.transactions?.transaction ?? []);

// MFL ID -> our ID: the roster sync's map first, then every other player through the same rules.
const map = new Map((await selectAll<{ mfl_id: string; player_id: string }>(sb, "mfl_player_map", "select=mfl_id,player_id")).map(r => [r.mfl_id, r.player_id]));
try {
  const mp = await getJson(`https://api.myfantasyleague.com/${season}/export?TYPE=players&JSON=1`) as { players?: { player?: MflPlayerInfo[] } };
  const players = new Map(([] as MflPlayerInfo[]).concat(mp.players?.player ?? []).map(p => [p.id, p]));
  const idsRes = await fetch("https://github.com/dynastyprocess/data/raw/master/files/db_playerids.csv");
  if (!idsRes.ok) throw new Error(`db_playerids.csv: HTTP ${idsRes.status}`);
  const idMap = mflToGsis(parseCsv(await idsRes.text()));
  const known = new Set((await selectAll<{ id: string }>(sb, "nfl_players", "select=id")).map(p => p.id));
  for (const id of players.keys()) if (!map.has(id)) { const m = mapMflId(id, players, idMap, known); if ("id" in m) map.set(id, m.id); }
} catch (e) {
  console.log(`Extra player mapping skipped (${(e as Error).message}); using the roster map only.`);
}

const { rows, unmapped } = txnRows(season, list, map);
const base = url.replace(/\/+$/, "").replace(/\/rest\/v1$/, "");
const headers: Record<string, string> = { apikey: serviceKey, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" };
if (serviceKey.startsWith("eyJ")) headers.Authorization = `Bearer ${serviceKey}`;
for (let i = 0; i < rows.length; i += 200) {
  const r = await fetch(`${base}/rest/v1/transactions?on_conflict=mfl_key`, { method: "POST", headers, body: JSON.stringify(rows.slice(i, i + 200)) });
  if (!r.ok) throw new Error(`transactions: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
}
console.log(`MFL transactions ${season}: ${list.length} in the export, ${rows.length} roster moves upserted${unmapped.length ? `; unmapped MFL players kept as mfl:<id>: ${unmapped.join(", ")}` : ""}`);
