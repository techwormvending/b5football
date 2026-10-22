/* TEMPORARY (2026): import MFL's add/drops, waiver claims and trades into public.transactions (via 'mfl'),
   so the site's transactions log and 24-hour drop lock follow MFL. Rosters are mirrored separately
   (scripts/sync-mfl-rosters.mts). Run nightly by the finalize workflow, after the roster sync.
   Usage:  node scripts/import-mfl-transactions.mts [season]     default 2026
   Env:    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (Actions secret), MFL_LEAGUE (default 22689). No MFL login. */

import { txnRows, type MflTxn } from "../src/league/mflTransactions.ts";
import { selectAll, type SbConfig } from "../src/league/supabaseRest.ts";

const url = process.env.SUPABASE_URL, serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) { console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."); process.exit(1); }
const sb: SbConfig = { url, serviceKey };
const season = Number(process.argv[2]) || 2026, league = process.env.MFL_LEAGUE || "22689";

const res = await fetch(`https://www45.myfantasyleague.com/${season}/export?TYPE=transactions&L=${league}&COUNT=1000&JSON=1`,
  { headers: { "User-Agent": "b5-fantasy-site/0.1 (private league)" } });
if (!res.ok) throw new Error(`MFL transactions: HTTP ${res.status}`);
const j = await res.json() as { transactions?: { transaction?: MflTxn | MflTxn[] } };
const list = ([] as MflTxn[]).concat(j.transactions?.transaction ?? []);
const map = new Map((await selectAll<{ mfl_id: string; player_id: string }>(sb, "mfl_player_map", "select=mfl_id,player_id")).map(r => [r.mfl_id, r.player_id]));
const { rows, unmapped } = txnRows(season, list, map);
// on_conflict mfl_key: already-imported transactions are left alone.
const base = url.replace(/\/+$/, "").replace(/\/rest\/v1$/, "");
const headers: Record<string, string> = { apikey: serviceKey, "Content-Type": "application/json", Prefer: "resolution=ignore-duplicates,return=representation" };
if (serviceKey.startsWith("eyJ")) headers.Authorization = `Bearer ${serviceKey}`;
let added = 0;
for (let i = 0; i < rows.length; i += 200) {
  const r = await fetch(`${base}/rest/v1/transactions?on_conflict=mfl_key`, { method: "POST", headers, body: JSON.stringify(rows.slice(i, i + 200)) });
  if (!r.ok) throw new Error(`transactions: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
  added += ((await r.json()) as unknown[]).length;
}
console.log(`MFL transactions ${season}: ${list.length} in the export, ${rows.length} roster moves, ${added} new${unmapped.length ? `; unmapped MFL players kept as mfl:<id>: ${unmapped.join(", ")}` : ""}`);
