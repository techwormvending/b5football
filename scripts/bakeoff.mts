/* Stats-provider bake-off: score a provider's weeks with our engine and compare
   every player and team defense to MFL's official scores (league 22689).
   2026 only; delete with the other MFL code after the migration.

   Usage:
     node scripts/bakeoff.mts <provider> <season> <weeks...>
     provider = nflverse (ESPN live adapter to be added)
     e.g. node scripts/bakeoff.mts nflverse 2026 1 2 3 4 5

   Env:
     B5_BAKEOFF_DATA   folder with MFL answer-key files (default .bakeoff/):
                         mfl/<season>/players.json   api.myfantasyleague.com/<season>/export?TYPE=players&JSON=1
                         mfl/<season>/scores-w<week>.json
                                                     www45.myfantasyleague.com/<season>/export?TYPE=playerScores&L=22689&W=<week>&JSON=1
                         ids.csv                     github.com/dynastyprocess/data/raw/master/files/db_playerids.csv
                       Run with --fetch-mfl to download the MFL files for the given season/weeks.
     B5_CACHE          cache folder for provider downloads (default .cache/)
     SHOW=n            how many mismatches to print (default 30) */

import fs from "node:fs";
import path from "node:path";
import { scoreStatLine } from "../src/scoring/engine.ts";
import type { Position, StatLine } from "../src/scoring/types.ts";
import { gameStatLines } from "../src/ingest/statlines.ts";
import { parseCsv } from "../src/ingest/csv.ts";
import { team } from "../src/ingest/teams.ts";
import { normalizeName } from "../src/ingest/names.ts";
import { nflverseProvider } from "../src/ingest/nflverse.ts";
import type { PlayerRef, StatsProvider } from "../src/ingest/types.ts";

const args = process.argv.slice(2).filter(a => !a.startsWith("--"));
const [providerName, seasonArg, ...weekArgs] = args;
const season = Number(seasonArg);
const weeks = weekArgs.map(Number).filter(Boolean);
if (!providerName || !season || !weeks.length) {
  console.error("Usage: node scripts/bakeoff.mts <nflverse> <season> <weeks...> [--fetch-mfl]");
  process.exit(1);
}
const DATA = path.resolve(process.env.B5_BAKEOFF_DATA || ".bakeoff");
const CACHE = path.resolve(process.env.B5_CACHE || ".cache");
const mflDir = path.join(DATA, "mfl", String(season));

// ---- MFL answer key ---------------------------------------------------------
if (process.argv.includes("--fetch-mfl")) {
  fs.mkdirSync(mflDir, { recursive: true });
  const get = async (url: string, file: string) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    fs.writeFileSync(path.join(mflDir, file), await res.text());
  };
  await get(`https://api.myfantasyleague.com/${season}/export?TYPE=players&JSON=1`, "players.json");
  for (const w of weeks) await get(`https://www45.myfantasyleague.com/${season}/export?TYPE=playerScores&L=22689&W=${w}&JSON=1`, `scores-w${w}.json`);
  if (!fs.existsSync(path.join(DATA, "ids.csv"))) {
    const res = await fetch("https://github.com/dynastyprocess/data/raw/master/files/db_playerids.csv");
    fs.writeFileSync(path.join(DATA, "ids.csv"), await res.text());
  }
}

const list = <T,>(x: T | T[] | undefined): T[] => (x == null ? [] : Array.isArray(x) ? x : [x]);
const readJson = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));
const POS: Record<string, Position> = { QB: "QB", RB: "RB", WR: "WR", TE: "TE", PK: "K", Def: "DEF" };
interface MflPlayer { id: string; name: string; position: string; team: string }
const mflPlayers = new Map<string, MflPlayer>(list<MflPlayer>(readJson(path.join(mflDir, "players.json")).players.player).map(p => [p.id, p]));

// MFL id <- provider player, by known ID crosswalk (nflverse) or by name + team + position.
const ids = parseCsv(fs.readFileSync(path.join(DATA, "ids.csv"), "utf8"));
const mflByGsis = new Map(ids.filter(r => r.gsis_id && r.gsis_id !== "NA" && r.mfl_id !== "NA").map(r => [r.gsis_id!, r.mfl_id!]));
const flipMfl = (n: string) => { const [last, first] = n.split(", "); return first ? `${first} ${last}` : n; };
const mflByName = new Map<string, string[]>();
for (const p of mflPlayers.values()) {
  if (!POS[p.position] || p.position === "Def") continue;
  const k = normalizeName(flipMfl(p.name));
  mflByName.set(k, [...(mflByName.get(k) ?? []), p.id]);
}
function mflIdFor(ref: PlayerRef): string | undefined {
  if (ref.provider === "nflverse") return mflByGsis.get(ref.id);
  const cands = mflByName.get(normalizeName(ref.name)) ?? [];
  if (cands.length <= 1) return cands[0];
  const byTeam = cands.filter(id => { try { return ref.team && team(mflPlayers.get(id)!.team) === ref.team; } catch { return false; } });
  return byTeam.length === 1 ? byTeam[0] : undefined;
}

// ---- Provider -----------------------------------------------------------------
function provider(): StatsProvider {
  switch (providerName) {
    case "nflverse": return nflverseProvider({ cacheDir: path.join(CACHE, "nflverse"), maxAgeHours: Number(process.env.MAX_AGE_HOURS || 6) });
    default: throw new Error(`Unknown provider ${providerName}`);
  }
}

// ---- Compare ------------------------------------------------------------------
const p = provider();
const summary: Record<string, { ok: number; bad: number; unmapped: number }> = {};
const mismatches: string[] = [];
const warnings: string[] = [];
for (const week of weeks) {
  const games = await p.week(season, week);
  const ours = new Map<string, StatLine>();       // MFL id -> stat line
  const teamsPlayed = new Set<string>();
  const unmappedRefs: PlayerRef[] = [];
  for (const g of games) {
    for (const w of g.warnings) warnings.push(`W${week} ${g.away}@${g.home}: ${w}`);
    teamsPlayed.add(g.home); teamsPlayed.add(g.away);
    const lines = gameStatLines(g);
    for (const { player, stats } of lines.players.values()) {
      const id = mflIdFor(player);
      if (id) ours.set(id, stats); else unmappedRefs.push(player);
    }
    for (const [t, stats] of lines.defenses) ours.set(`DEF:${t}`, stats);
  }

  for (const ms of list<{ id: string; score: string }>(readJson(path.join(mflDir, `scores-w${week}.json`)).playerScores.playerScore)) {
    const pl = mflPlayers.get(ms.id);
    const pos = pl && POS[pl.position];
    if (!pl || !pos) continue;
    const s = (summary[pos] ??= { ok: 0, bad: 0, unmapped: 0 });
    let stats: StatLine | undefined;
    if (pos === "DEF") {
      const t = team(pl.team);
      if (!teamsPlayed.has(t)) continue;           // bye week
      stats = ours.get(`DEF:${t}`);
    } else {
      stats = ours.get(ms.id);
      if (!stats) {
        // No stats from the provider. Fine if MFL also has 0; otherwise a mapping gap.
        if (Number(ms.score) === 0) { s.ok++; continue; }
        s.unmapped++;
        mismatches.push(`W${week} ${pos.padEnd(3)} ${pl.name.padEnd(26)} MFL ${ms.score.padStart(5)}  (no stats matched for this player)`);
        continue;
      }
    }
    let got: number;
    try { got = scoreStatLine(pos, stats!).total; }
    catch (err) { s.bad++; mismatches.push(`W${week} ${pos} ${pl.name}: ${(err as Error).message}`); continue; }
    const want = Number(ms.score);
    if (Math.abs(got - want) < 0.001) s.ok++;
    else { s.bad++; mismatches.push(`W${week} ${pos.padEnd(3)} ${pl.name.padEnd(26)} MFL ${String(want).padStart(5)} ours ${String(got).padStart(5)}  ${JSON.stringify(stats)}`); }
  }
}

let ok = 0, total = 0;
console.log(`${p.name} ${season} weeks ${weeks.join(",")}`);
for (const [pos, s] of Object.entries(summary)) {
  ok += s.ok; total += s.ok + s.bad + s.unmapped;
  console.log(`  ${pos.padEnd(4)} ${s.ok}/${s.ok + s.bad + s.unmapped}${s.unmapped ? `  (${s.unmapped} not matched to a provider player)` : ""}`);
}
console.log(`  ALL  ${ok}/${total} (${(ok / Math.max(total, 1) * 100).toFixed(2)}%)`);
if (warnings.length) console.log(`\n${warnings.length} adapter warnings:\n  ` + warnings.slice(0, 20).join("\n  "));
console.log(`\n${mismatches.length} mismatches`);
if (mismatches.length) console.log("  " + mismatches.slice(0, Number(process.env.SHOW || 30)).join("\n  "));
