/* TEMPORARY (2026 shadow season; delete with the other MFL code after the migration).
   Shadow mode: score each week with OUR engine and check it against MFL, then publish
   the week to Supabase so the site computes matchups and standings itself.

   Usage:  node scripts/shadow.mts [season] [weeks...]     default: 2026, every week nflverse has
           --dry-run   compare and report only, write nothing
   Env:    B5_DATA (league data folder, as the finalizer writes it), B5_CACHE (default .cache/),
           SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (server only; not needed with --dry-run)

   For each week whose final (nflverse) numbers exist and that MFL has results for:
     - player_scores: every scored player and defense (overrides applied), source "final"
     - score_weeks:   the week's status (pending_review / final)
     - lineup_slots:  MFL's starters, mirrored (2026 lineups are set on MFL)
     - matchups:      our team totals (MFL's starters x our scores)
     - shadow_results: our total vs MFL's, with every differing player's rule lines and plays
   Also: the full schedule (matchups without scores) from MFL, and standings computed from
   matchups. The report prints every difference. */

import path from "node:path";
import { parseCsv } from "../src/ingest/csv.ts";
import { loadCrosswalk } from "../src/ingest/crosswalk.ts";
import { nflverseProvider } from "../src/ingest/nflverse.ts";
import { jsonFileStore } from "../src/league/store.ts";
import { weekScores } from "../src/league/finalizer.ts";
import { mflToGsis, type MflPlayerInfo } from "../src/league/mflRosters.ts";
import { compareWeek, standingsFrom, type WeekComparison, type WeekScores } from "../src/league/shadow.ts";
import { upsert } from "../src/league/nflSync.ts";
import { deleteWhere, selectAll, type SbConfig } from "../src/league/supabaseRest.ts";

const LEAGUE = "22689", HOST = "https://www45.myfantasyleague.com", API = "https://api.myfantasyleague.com";
const IDMAP_URL = "https://github.com/dynastyprocess/data/raw/master/files/db_playerids.csv";
const DATA = path.resolve(process.env.B5_DATA || "data/league");
const CACHE = path.resolve(process.env.B5_CACHE || ".cache");
const REGULAR_WEEKS = 14;
const log = (m: string) => console.log(m);

const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const nums = args.filter(a => /^\d+$/.test(a)).map(Number);
const season = nums.find(n => n > 1000) ?? 2026;
const onlyWeeks = nums.filter(n => n < 100);
const url = process.env.SUPABASE_URL, serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!dry && (!url || !serviceKey)) { console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or use --dry-run)."); process.exit(1); }
const cfg: SbConfig = { url: url ?? "", serviceKey: serviceKey ?? "" };

async function json(u: string) {
  const res = await fetch(u);
  if (!res.ok) throw new Error(`${u}: HTTP ${res.status}`);
  return res.json();
}
const list = <T>(x: T | T[] | undefined): T[] => (x == null ? [] : Array.isArray(x) ? x : [x]);

const store = jsonFileStore(DATA);
const cw = await loadCrosswalk({ cacheDir: path.join(CACHE, "nflverse") });
const nflverse = nflverseProvider({ cacheDir: path.join(CACHE, "nflverse") });
const mflPlayers = new Map<string, MflPlayerInfo>(list<MflPlayerInfo>((await json(`${API}/${season}/export?TYPE=players&JSON=1`))?.players?.player).map(p => [p.id, p]));
const idMapRes = await fetch(IDMAP_URL);
if (!idMapRes.ok) throw new Error(`ID map: HTTP ${idMapRes.status}`);
const idMap = mflToGsis(parseCsv(await idMapRes.text()));
const known = dry ? null : new Set((await selectAll<{ id: string }>(cfg, "nfl_players", "select=id")).map(p => p.id));

const weeks = onlyWeeks.length ? onlyWeeks
  : (await store.listWeeks(season)).filter(r => r.final).map(r => r.week).sort((a, b) => a - b);
log(`Shadow ${season}: weeks ${weeks.join(", ") || "(none)"}${dry ? " (dry run)" : ""}`);

const done: WeekComparison[] = [];
for (const week of weeks) {
  const ws = await weekScores(store, season, week, cw);
  if (!ws.snapshot || ws.snapshot.source !== "final") { log(`Week ${week}: no final (nflverse) numbers yet; skipped.`); continue; }
  const results = (await json(`${HOST}/${season}/export?TYPE=weeklyResults&L=${LEAGUE}&W=${week}&JSON=1`))?.weeklyResults;
  if (!results || !list(results.matchup).length) { log(`Week ${week}: MFL has no results yet; skipped.`); continue; }
  const games = await nflverse.week(season, week);
  const c = compareWeek({ season, week, results, mflPlayers, idMap, scores: ws.snapshot as unknown as WeekScores, games });
  done.push(c);

  const matched = c.teams.filter(t => t.matched).length;
  const posted = c.teams.filter(t => t.mflScore != null).length;
  log(posted ? `\nWeek ${week} (${ws.status}): ${matched}/${posted} team totals match MFL exactly.`
    : `\nWeek ${week} (${ws.status}): MFL hasn't posted scores yet; our totals are published, the comparison waits.`);
  for (const t of c.teams) {
    if (t.mflScore != null && (!t.matched || t.diffs.length)) log(`  ${t.teamId}: ours ${t.ourScore} vs MFL ${t.mflScore} (${(t.ourScore - t.mflScore).toFixed(2)})`);
    for (const d of t.diffs) {
      log(`    ${d.name} (${d.position ?? "?"}): ours ${d.ours} vs MFL ${d.mfl}${d.note ? ` — ${d.note}` : ""}`);
      if (d.lines.length) log(`      rules: ${d.lines.map(l => `${l.stat}=${l.value}→${l.points}`).join(", ")}`);
      for (const p of d.plays) log(`      play: ${p}`);
    }
  }
  if (dry) continue;

  // player_scores (only players in nfl_players: the FK; anything else is logged)
  const now = new Date().toISOString();
  const rows: object[] = [];
  const skipped: string[] = [];
  for (const p of Object.values(ws.snapshot.players)) {
    const id = p.key.replace(/^nflverse:/, "");
    if (!known!.has(id)) { skipped.push(`${p.name} (${id})`); continue; }
    rows.push({ season, week, player_id: id, game_key: p.gameKey, points: p.points, stats: p.stats, source: "final", overridden: !!(p as { override?: unknown }).override, updated_at: now });
  }
  for (const d of Object.values(ws.snapshot.defenses)) {
    rows.push({ season, week, player_id: `DEF:${d.team}`, game_key: d.gameKey, points: d.points, stats: d.stats, source: "final", overridden: !!(d as { override?: unknown }).override, updated_at: now });
  }
  await upsert(cfg, "player_scores", rows, "season,week,player_id");
  if (skipped.length) log(`  player_scores: ${skipped.length} scored players not in nfl_players (not on any fantasy roster list): ${skipped.slice(0, 8).join(", ")}${skipped.length > 8 ? "…" : ""}`);
  await upsert(cfg, "score_weeks", [{ season, week, status: ws.status, live_delayed: false, updated_at: now }], "season,week");

  // lineup_slots: mirror MFL's starters
  const teams = c.teams.map(t => `"${t.teamId}"`).join(",");
  await deleteWhere(cfg, "lineup_slots", `season=eq.${season}&week=eq.${week}&team_id=in.(${encodeURIComponent(teams)})`);
  const slots = c.teams.flatMap(t => t.slots.map((pid, slot) => (pid && known!.has(pid) ? { season, week, team_id: t.teamId, slot, player_id: pid } : null)).filter(Boolean)) as object[];
  if (slots.length) await upsert(cfg, "lineup_slots", slots, "season,week,team_id,slot");

  // matchups with our totals
  const score = new Map(c.teams.map(t => [t.teamId, t.ourScore]));
  await upsert(cfg, "matchups", c.matchups.map(m => ({ season, week, home_team: m.home, away_team: m.away,
    home_score: score.get(m.home) ?? null, away_score: score.get(m.away) ?? null, is_playoff: week > REGULAR_WEEKS })), "season,week,home_team");

  const compared = c.teams.filter(t => t.mflScore != null);
  if (compared.length) await upsert(cfg, "shadow_results", compared.map(t => ({ season, week, team_id: t.teamId, mfl_score: t.mflScore, our_score: t.ourScore, matched: t.matched,
    details: { diffs: t.diffs, unmapped: t.unmapped }, checked_at: now })), "season,week,team_id");
}

if (!dry) {
  // Full schedule (no scores) so future weeks exist; scored weeks were written above.
  const sched = list<{ week: string; matchup?: unknown }>((await json(`${HOST}/${season}/export?TYPE=schedule&L=${LEAGUE}&JSON=1`))?.schedule?.weeklySchedule);
  const fixtures: object[] = [];
  for (const w of sched) for (const m of list(w.matchup as { franchise: { id: string; isHome: string }[] }[])) {
    const h = m.franchise.find(f => f.isHome === "1"), a = m.franchise.find(f => f.isHome !== "1");
    if (h && a) fixtures.push({ season, week: Number(w.week), home_team: h.id, away_team: a.id, is_playoff: Number(w.week) > REGULAR_WEEKS });
  }
  if (fixtures.length) await upsert(cfg, "matchups", fixtures, "season,week,home_team");
  const ms = await selectAll<{ week: number; home_team: string; away_team: string; home_score: number | null; away_score: number | null }>(
    cfg, "matchups", `season=eq.${season}&select=week,home_team,away_team,home_score,away_score`);
  const st = standingsFrom(ms.map(m => ({ ...m, home_score: m.home_score == null ? null : Number(m.home_score), away_score: m.away_score == null ? null : Number(m.away_score) })), REGULAR_WEEKS);
  if (st.length) await upsert(cfg, "standings", st.map(r => ({ season, ...r })), "season,team_id");
  log(`\nSchedule: ${fixtures.length} matchups; standings: ${st.length} teams.`);
}

const all = done.flatMap(c => c.teams).filter(t => t.mflScore != null);
log(`\nSummary: ${all.filter(t => t.matched).length}/${all.length} team-weeks match MFL exactly; ${all.reduce((n, t) => n + t.diffs.length, 0)} player differences.`);
