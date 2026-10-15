/* Verify the ESPN live adapter against nflverse (the system of record): score
   every player and team defense from both sources with our engine and compare.

   Usage: node scripts/verify-espn.mts <season> <weeks...>
   e.g.   node scripts/verify-espn.mts 2026 1 2 3 4 5
   Env:   B5_CACHE (default .cache/), MAX_AGE_HOURS for nflverse downloads, SHOW=n mismatches to print. */

import path from "node:path";
import fs from "node:fs";
import { scoreStatLine } from "../src/scoring/engine.ts";
import type { Position, StatLine } from "../src/scoring/types.ts";
import { gameStatLines } from "../src/ingest/statlines.ts";
import { nflverseProvider } from "../src/ingest/nflverse.ts";
import { espnLiveSource } from "../src/ingest/espn.ts";
import { loadCrosswalk, toCanonical, type UnmatchedPlayer } from "../src/ingest/crosswalk.ts";
import { parseCsv } from "../src/ingest/csv.ts";

const [seasonArg, ...weekArgs] = process.argv.slice(2);
const season = Number(seasonArg), weeks = weekArgs.map(Number).filter(Boolean);
if (!season || !weeks.length) { console.error("Usage: node scripts/verify-espn.mts <season> <weeks...>"); process.exit(1); }
const CACHE = path.resolve(process.env.B5_CACHE || ".cache");

const final = nflverseProvider({ cacheDir: path.join(CACHE, "nflverse"), maxAgeHours: Number(process.env.MAX_AGE_HOURS || 6) });
const live = espnLiveSource({ cacheDir: path.join(CACHE, "espn") });
const cw = await loadCrosswalk({ cacheDir: path.join(CACHE, "nflverse") });

// Fantasy position per nflverse player (FB scores as RB).
const POS: Record<string, Position> = { QB: "QB", RB: "RB", FB: "RB", WR: "WR", TE: "TE", K: "K" };
const posByGsis = new Map(parseCsv(fs.readFileSync(path.join(CACHE, "nflverse", "players.csv"), "utf8"))
  .filter(r => POS[r.position ?? ""]).map(r => [r.gsis_id!, POS[r.position!]!]));

const summary: Record<string, { ok: number; bad: number }> = {};
const mismatches: string[] = [], warnings: string[] = [], unmatched: UnmatchedPlayer[] = [], problems: string[] = [];
const score = (pos: Position, s: StatLine | undefined) => { try { return scoreStatLine(pos, s ?? (pos === "DEF" ? undefined as never : {})).total; } catch (e) { return `ERR ${(e as Error).message}`; } };

for (const week of weeks) {
  const lw = await live.week(season, week);
  if (lw.delayed) problems.push(`W${week}: live source delayed: ${lw.errors.join("; ")}`);
  const nfl = await final.week(season, week);
  for (const eg of lw.games.filter(g => g.status === "final")) {
    const ng = nfl.find(g => g.home === eg.home && g.away === eg.away);
    if (!ng) { problems.push(`W${week} ${eg.away}@${eg.home}: not in nflverse`); continue; }
    for (const w of eg.warnings) warnings.push(`W${week} ${eg.away}@${eg.home}: ${w}`);
    const { game, unmatched: um } = toCanonical(eg, cw);
    unmatched.push(...um);
    const e = gameStatLines(game), n = gameStatLines(ng);

    const ids = new Set([...e.players.keys(), ...n.players.keys()].filter(k => k.startsWith("nflverse:")));
    for (const key of ids) {
      const gsis = key.slice(9), pos = posByGsis.get(gsis);
      if (!pos) continue;                                   // not a fantasy position
      const es = e.players.get(key), ns = n.players.get(key);
      const a = score(pos, es?.stats ?? {}), b = score(pos, ns?.stats ?? {});
      const s = (summary[pos] ??= { ok: 0, bad: 0 });
      if (a === b) s.ok++;
      else { s.bad++; mismatches.push(`W${week} ${eg.away}@${eg.home} ${pos} ${(es ?? ns)!.player.name}: ESPN ${a} nflverse ${b}\n      ESPN     ${JSON.stringify(es?.stats ?? {})}\n      nflverse ${JSON.stringify(ns?.stats ?? {})}`); }
    }
    for (const t of [eg.home, eg.away]) {
      const a = score("DEF", e.defenses.get(t)), b = score("DEF", n.defenses.get(t));
      const s = (summary.DEF ??= { ok: 0, bad: 0 });
      if (a === b) s.ok++;
      else { s.bad++; mismatches.push(`W${week} ${eg.away}@${eg.home} DEF ${t}: ESPN ${a} nflverse ${b}\n      ESPN     ${JSON.stringify(e.defenses.get(t))}\n      nflverse ${JSON.stringify(n.defenses.get(t))}`); }
    }
  }
}

let ok = 0, all = 0;
console.log(`ESPN vs nflverse, ${season} weeks ${weeks.join(",")}`);
for (const [pos, s] of Object.entries(summary)) { ok += s.ok; all += s.ok + s.bad; console.log(`  ${pos.padEnd(4)} ${s.ok}/${s.ok + s.bad}`); }
console.log(`  ALL  ${ok}/${all} (${(ok / Math.max(all, 1) * 100).toFixed(2)}%)`);
const fantasyUnmatched = unmatched.filter((u, i, arr) => arr.findIndex(x => x.providerId === u.providerId) === i);
console.log(`\nUnmatched ESPN players flagged for review: ${fantasyUnmatched.length}`);
for (const u of fantasyUnmatched.slice(0, 15)) console.log(`  W${u.week} ${u.name} (${u.team ?? "?"}) ESPN ${u.providerId}`);
if (warnings.length) console.log(`\nAdapter warnings (${warnings.length}):\n  ` + warnings.slice(0, 20).join("\n  "));
if (problems.length) console.log(`\nProblems:\n  ` + problems.join("\n  "));
console.log(`\n${mismatches.length} mismatches`);
if (mismatches.length) console.log("  " + mismatches.slice(0, Number(process.env.SHOW || 25)).join("\n  "));
