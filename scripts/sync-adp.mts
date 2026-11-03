/* Draft Room ADP: pull MFL's site-wide ADP (primary) and Fantasy Football Calculator's (fallback /
   comparison), map them to our players and store them in public.player_adp (src/league/adp.ts has the
   rules). Run by the nightly workflow: it acts nightly in the preseason (July 1 to the real draft),
   weekly (Mondays) otherwise; --force runs anyway. A source that fails or returns nothing keeps its
   last good list. Unmatched players go to review_queue (adp-mfl / adp-ffc), shown on the Admin page.
   Usage:  node scripts/sync-adp.mts [year] [--force] [--dry-run]     year default: this calendar year
   Env:    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (Actions secret). No logins anywhere. */

import { parseCsv } from "../src/ingest/csv.ts";
import { adpDue, ffcAdpUrl, mapFfcAdp, mapMflAdp, mflAdpUrl, parseFfcAdp, parseMflAdp, usePeriod, type AdpRow, type AdpUnmatched, type OurPlayer } from "../src/league/adp.ts";
import { mflToGsis, type MflPlayerInfo } from "../src/league/mflRosters.ts";
import { upsert } from "../src/league/nflSync.ts";
import { sbBase, sbHeaders, selectAll, updateWhere, type SbConfig } from "../src/league/supabaseRest.ts";

const url = process.env.SUPABASE_URL, serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) { console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."); process.exit(1); }
const cfg: SbConfig = { url, serviceKey };
const args = process.argv.slice(2), force = args.includes("--force"), dry = args.includes("--dry-run");
const year = Number(args.find(a => /^\d{4}$/.test(a))) || new Date().getUTCFullYear();
const UA = { headers: { "User-Agent": "b5-fantasy-site/0.1 (private league)" } };
const getJson = async (u: string) => { const r = await fetch(u, UA); if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`); return r.json(); };
const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

const done = (await selectAll<{ status: string }>(cfg, "drafts", `season=eq.${year}&kind=eq.real&select=status`)).some(d => d.status === "complete" || d.status === "done");
if (!force && !adpDue(new Date(), done)) { log(`ADP ${year}: not due today (weekly outside the preseason); --force to run anyway`); process.exit(0); }

const ours = await selectAll<OurPlayer>(cfg, "nfl_players", "select=id,name,position,nfl_team&position=in.(QB,RB,WR,TE,K,DEF)");
const now = new Date().toISOString();
const results: { source: "mfl" | "ffc"; period: string; drafts: number; rows: AdpRow[]; unmatched: AdpUnmatched[] }[] = [];

try {
  let j = parseMflAdp(await getJson(mflAdpUrl(year, "RECENT"))), period = "RECENT";
  if (usePeriod(j.drafts) === "ALL") { j = parseMflAdp(await getJson(mflAdpUrl(year, "ALL"))); period = "ALL"; }
  const mp = await getJson(`https://api.myfantasyleague.com/${year}/export?TYPE=players&JSON=1`) as { players?: { player?: MflPlayerInfo[] } };
  const players = new Map(([] as MflPlayerInfo[]).concat(mp.players?.player ?? []).map(p => [p.id, p]));
  const idsRes = await fetch("https://github.com/dynastyprocess/data/raw/master/files/db_playerids.csv");
  if (!idsRes.ok) throw new Error(`db_playerids.csv: HTTP ${idsRes.status}`);
  const m = mapMflAdp(j.players, players, mflToGsis(parseCsv(await idsRes.text())), ours);
  results.push({ source: "mfl", period, drafts: j.drafts, ...m });
} catch (e) { log(`::warning::MFL ADP failed (${(e as Error).message}); keeping the last good list`); }

try {
  const j = parseFfcAdp(await getJson(ffcAdpUrl(year)));
  results.push({ source: "ffc", period: "half-PPR 12", drafts: j.drafts, ...mapFfcAdp(j.players, ours) });
} catch (e) { log(`::warning::FFC ADP failed (${(e as Error).message}); keeping the last good list`); }

for (const r of results) {
  log(`ADP ${year} ${r.source} (${r.period}, ${r.drafts} drafts): ${r.rows.length} players mapped, ${r.unmatched.length} unmatched` +
    (r.rows.length ? `; top: ${r.rows.slice(0, 3).map(x => `${x.player_id} ${x.adp} ${x.pos_rank}`).join(", ")}` : ""));
  if (dry) continue;
  if (!r.rows.length) { log(`${r.source}: nothing in the list (out of season?), last good list kept`); continue; }
  const res = await fetch(`${sbBase(cfg)}rpc/replace_adp`, { method: "POST", headers: sbHeaders(cfg),
    body: JSON.stringify({ p_season: year, p_source: r.source, p_period: r.period, p_drafts: r.drafts, p_rows: r.rows }) });
  if (!res.ok) throw new Error(`replace_adp ${r.source}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  // Review queue: open the unmatched, resolve what matches now
  const prov = `adp-${r.source}`, review = r.unmatched.map(u => ({ provider: prov, provider_id: u.provider_id, name: u.name, team: u.team, reason: `ADP ${year}: ${u.reason}`, status: "open", last_seen: now }));
  if (review.length) await upsert(cfg, "review_queue", review, "provider,provider_id");
  const open = review.map(x => `"${x.provider_id}"`).join(",");
  await updateWhere(cfg, "review_queue", `provider=eq.${prov}&status=eq.open${open ? `&provider_id=not.in.(${encodeURIComponent(open)})` : ""}`, { status: "resolved" });
}
