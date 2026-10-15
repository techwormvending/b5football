/* Spike: do ESPN (live source) and nflverse (final source) agree on every
   touchdown and its yardage? For one completed game (or a whole week), pulls
   ESPN's game summary and nflverse play-by-play, extracts every TD from each,
   pairs them up and prints them side by side.

   Usage:
     node scripts/spike-espn-vs-nflverse.mts <season> <week> [game]
       game = ESPN event id, AWAY@HOME (e.g. DET@ARI), or "all". Default: first final game.
   Env: B5_CACHE (default .cache/), MAX_AGE_HOURS for the nflverse download (default 6).

   ESPN's site API is unofficial and undocumented. Every field read here is
   checked, and anything unexpected is reported instead of crashing. */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createHttp } from "../src/ingest/http.ts";
import { parseCsv } from "../src/ingest/csv.ts";
import { team } from "../src/ingest/teams.ts";

const [seasonArg, weekArg, gameArg] = process.argv.slice(2);
const season = Number(seasonArg), week = Number(weekArg);
if (!season || !week) {
  console.error("Usage: node scripts/spike-espn-vs-nflverse.mts <season> <week> [espnEventId|AWAY@HOME|all]");
  process.exit(1);
}
const CACHE = path.resolve(process.env.B5_CACHE || ".cache");
const ESPN = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";
const http = createHttp({ headers: { "User-Agent": "b5-fantasy-site/0.1 (private league)" }, minIntervalMs: 1000, cacheDir: path.join(CACHE, "espn") });

interface Td { qtr: number; clockSec: number; clock: string; team: string; kind: string; yards: number; yards2?: number; scorer: string; text: string }

const clockSec = (c: string) => { const [m, s] = c.split(":").map(Number); return (m ?? 0) * 60 + (s ?? 0); };
const lastName = (n: string) => n.replace(/^\d+-/, "").replace(/\b(Jr|Sr|II|III|IV)\.?$/i, "").trim().split(/[ .]/).filter(Boolean).pop()?.toLowerCase() ?? "";

/** Scorer from an NFL-style play description. */
function scorerFromDescription(d: string): string | undefined {
  const s = d.replace(/^(\([^)]*\)\s*)+/, "");               // drop "(No Huddle) (Shotgun)"
  const pass = s.match(/pass .*?\bto (?:\d+-)?([A-Z][A-Za-z]?\.[A-Za-z' -]+?) for -?\d+ yards?, TOUCHDOWN/);
  if (pass) return pass[1];
  const ret = s.match(/(?:\d+-)?([A-Z][A-Za-z]?\.[A-Za-z'-]+) (?:to \S+ )?for -?\d+ yards?, TOUCHDOWN/);
  if (ret && !/ pass /.test(s)) {
    // For runs the runner is the first name; for returns it's the name just before "for N yards".
    const first = s.match(/^(?:\d+-)?([A-Z][A-Za-z]?\.[A-Za-z'-]+)/)?.[1];
    return /(punts|kicks|INTERCEPTED|FUMBLES|BLOCKED|RECOVERED)/.test(s) ? ret[1] : first ?? ret[1];
  }
  return s.match(/^(?:\d+-)?([A-Z][A-Za-z]?\.[A-Za-z'-]+)/)?.[1];
}

// ---- ESPN ---------------------------------------------------------------------
interface EspnEvent { id: string; shortName: string; competitions: { status: { type: { name: string; completed?: boolean } }; competitors: { homeAway: string; team: { abbreviation: string } }[] }[] }
interface EspnPlay {
  id: string; scoringPlay?: boolean; text?: string; statYardage?: number;
  type?: { text?: string }; scoringType?: { name?: string };
  period?: { number?: number }; clock?: { displayValue?: string };
  start?: { yardsToEndzone?: number }; end?: { yardsToEndzone?: number };
}
interface EspnScoringPlay { id: string; text?: string; type?: { text?: string }; team?: { abbreviation?: string }; period?: { number?: number }; clock?: { displayValue?: string } }

async function espnTds(eventId: string, warn: (m: string) => void): Promise<Td[]> {
  const sum = await http.get<{ drives?: { previous?: { plays?: EspnPlay[] }[] }; scoringPlays?: EspnScoringPlay[] }>(`${ESPN}/summary?event=${eventId}`, { cache: true });
  const scoring = new Map((sum.scoringPlays ?? []).map(s => [s.id, s]));
  const plays = (sum.drives?.previous ?? []).flatMap(d => d.plays ?? []);
  if (!plays.length) warn("ESPN summary has no drives/plays");
  const tds: Td[] = [];
  const seen = new Set<string>();
  for (const p of plays) {
    if (!p.scoringPlay || p.scoringType?.name !== "touchdown") continue;
    seen.add(p.id);
    const sp = scoring.get(p.id);
    if (!sp) warn(`TD play ${p.id} has no matching scoringPlays entry`);
    const summary = sp?.text ?? "";
    // Usually "Name 38 Yd pass from Name (Kicker Kick)"; sometimes ESPN gives the raw
    // play description instead ("J.Gibbs up the middle for 1 yard, TOUCHDOWN.").
    const scorer =
      summary.match(/lateral to (.+?) for -?\d+ yards/i)?.[1] ??       // "A complete pass to B for 2 yards, lateral to C for 80 yards"
      summary.match(/^(.+?) \d+ Yd /)?.[1] ??
      summary.match(/^(.+?) Fumble Recovery in End Zone/i)?.[1] ??
      scorerFromDescription(summary || p.text || "") ?? "?";
    const abbr = sp?.team?.abbreviation;
    tds.push({
      qtr: p.period?.number ?? 0, clock: p.clock?.displayValue ?? "?", clockSec: clockSec(p.clock?.displayValue ?? "0:00"),
      team: abbr ? team(abbr) : "?", kind: p.type?.text ?? "?",
      yards: p.statYardage ?? NaN,
      ...(p.start?.yardsToEndzone !== undefined ? { yards2: p.start.yardsToEndzone } : {}),
      scorer, text: summary || p.text || ""
    });
  }
  // TDs listed in scoringPlays but missing from the drive feed
  for (const s of sum.scoringPlays ?? []) {
    if (!seen.has(s.id) && /touchdown/i.test(s.type?.text ?? "")) warn(`scoringPlays TD not found in drives: ${s.text}`);
  }
  return tds;
}

// ---- nflverse -----------------------------------------------------------------
async function nflverseRows(): Promise<Record<string, string>[]> {
  const file = path.join(CACHE, "nflverse", `pbp_${season}.csv.gz`);
  const maxAge = Number(process.env.MAX_AGE_HOURS || 6) * 3600 * 1000;
  if (!fs.existsSync(file) || Date.now() - fs.statSync(file).mtimeMs > maxAge) {
    const res = await fetch(`https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_${season}.csv.gz`);
    if (!res.ok) throw new Error(`nflverse download: HTTP ${res.status}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  return parseCsv(zlib.gunzipSync(fs.readFileSync(file)).toString("utf8")).filter(r => Number(r.week) === week && r.season_type === "REG");
}

function nflverseTds(rows: Record<string, string>[]): Td[] {
  return rows.filter(r => r.touchdown === "1" && r.td_team && r.td_team !== "NA").map(r => {
    const kind = r.pass_touchdown === "1" ? "pass" : r.rush_touchdown === "1" ? "rush"
      : `${r.play_type} return/recovery`;
    // Return TDs: nflverse yards_gained is the scrimmage result (often 0). The return distance is
    // return_yards for kicks/INTs, and fumble_recovery_N_yards for fumble returns.
    const offensive = r.pass_touchdown === "1" || r.rush_touchdown === "1";
    const fumbleYds = ["1", "2"].map(i => (r[`fumble_recovery_${i}_team`] === r.td_team ? r[`fumble_recovery_${i}_yards`] : "")).find(x => x && x !== "NA");
    return {
      qtr: Number(r.qtr), clock: r.time ?? "?", clockSec: clockSec(r.time ?? "0:00"),
      team: team(r.td_team!), kind,
      yards: Number(offensive ? r.yards_gained : fumbleYds ?? (r.return_yards && r.return_yards !== "NA" ? r.return_yards : r.yards_gained)),
      scorer: r.td_player_name || "?", text: (r.desc ?? "").slice(0, 100)
    };
  });
}

// ---- Pairing and report --------------------------------------------------------
function pair(espn: Td[], nfl: Td[]) {
  const used = new Set<number>();
  const rows: { e?: Td; n?: Td }[] = [];
  for (const e of espn) {
    let best = -1, bestD = Infinity;
    nfl.forEach((n, i) => {
      if (used.has(i) || n.qtr !== e.qtr || n.team !== e.team) return;
      const d = Math.abs(n.clockSec - e.clockSec) + (lastName(n.scorer) === lastName(e.scorer) ? 0 : 1000);
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best >= 0 && bestD < 1200) { used.add(best); rows.push({ e, n: nfl[best]! }); }
    else rows.push({ e });
  }
  nfl.forEach((n, i) => { if (!used.has(i)) rows.push({ n }); });
  return rows.sort((a, b) => ((a.e ?? a.n)!.qtr - (b.e ?? b.n)!.qtr) || ((b.e ?? b.n)!.clockSec - (a.e ?? a.n)!.clockSec));
}

const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));

const sb = await http.get<{ events?: EspnEvent[] }>(`${ESPN}/scoreboard?dates=${season}&seasontype=2&week=${week}`);
const events = (sb.events ?? []).filter(e => e.competitions?.[0]?.status?.type?.name === "STATUS_FINAL");
const pick = !gameArg ? events.slice(0, 1)
  : gameArg === "all" ? events
  : events.filter(e => e.id === gameArg || e.shortName.replace(/\s/g, "").replace("VS", "@").toUpperCase() === gameArg.toUpperCase());
if (!pick.length) {
  console.error(`No final game matched "${gameArg ?? "(first)"}". Final games: ${events.map(e => `${e.id} ${e.shortName}`).join(", ")}`);
  process.exit(1);
}

const rows = await nflverseRows();
let totalTds = 0, agree = 0;
const problems: string[] = [];
for (const ev of pick) {
  const comp = ev.competitions[0]!;
  const home = team(comp.competitors.find(c => c.homeAway === "home")!.team.abbreviation);
  const away = team(comp.competitors.find(c => c.homeAway === "away")!.team.abbreviation);
  const warnings: string[] = [];
  const e = await espnTds(ev.id, m => warnings.push(m));
  const gameRows = rows.filter(r => team(r.home_team!) === home && team(r.away_team!) === away);
  if (!gameRows.length) { problems.push(`${away}@${home}: not in nflverse yet`); continue; }
  const n = nflverseTds(gameRows);

  console.log(`\n${away} @ ${home}  (ESPN ${ev.id}, nflverse ${gameRows[0]!.game_id})   TDs: ESPN ${e.length}, nflverse ${n.length}`);
  console.log(`  ${pad("Q", 2)}${pad("ESPN clk", 9)}${pad("Team", 5)}${pad("ESPN type", 28)}${pad("Scorer (ESPN)", 22)}${pad("Scorer (nflverse)", 18)}${pad("ESPN yds", 9)}${pad("nfl yds", 8)}`);
  for (const { e: a, n: b } of pair(e, n)) {
    totalTds++;
    const yardsOk = !!a && !!b && a.yards === b.yards;
    const nameOk = !!a && !!b && lastName(a.scorer) === lastName(b.scorer);
    const ok = yardsOk && nameOk;
    if (ok) agree++;
    const ref = (a ?? b)!;
    const espnYds = a ? `${a.yards}${a.yards2 !== undefined && a.yards2 !== a.yards ? `/${a.yards2}` : ""}` : "—";
    console.log(`  ${pad(String(ref.qtr), 2)}${pad(a?.clock ?? "—", 9)}${pad(ref.team, 5)}${pad(a?.kind ?? "(missing in ESPN)", 28)}${pad(a?.scorer ?? "—", 22)}${pad(b?.scorer ?? "(missing)", 18)}${pad(espnYds, 9)}${pad(b ? String(b.yards) : "—", 8)}${ok ? "✓" : "✗ " + [!a && "not in ESPN", !b && "not in nflverse", a && b && !yardsOk && "yards differ", a && b && !nameOk && "scorer differs"].filter(Boolean).join(", ")}`);
    if (!ok) problems.push(`${away}@${home} Q${ref.qtr} ${ref.team}: ESPN "${a?.text ?? "—"}" vs nflverse "${b?.text ?? "—"}"`);
  }
  for (const w of warnings) problems.push(`${away}@${home}: ${w}`);
}

console.log(`\n${agree}/${totalTds} TDs agree on scorer and yardage across ${pick.length} game(s).`);
console.log("ESPN yds = statYardage (and yards to the end zone at the snap, when different).");
if (problems.length) console.log("\nNeeds a look:\n  " + problems.join("\n  "));
