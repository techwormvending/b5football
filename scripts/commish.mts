/* Commissioner tools for scoring weeks (until the web admin exists).

   node scripts/commish.mts status <season>                week statuses
   node scripts/commish.mts diffs <season> <week>          live-vs-final differences and stat corrections
   node scripts/commish.mts confirm <season> <week> [--force]   lock the week as final
   node scripts/commish.mts reopen <season> <week> "<reason>"   unlock a final week
   node scripts/commish.mts review                         players flagged for review (no ID match)
   node scripts/commish.mts audit                          audit log

   Scores and overrides (overrides survive nightly re-runs; every change is audited):
   node scripts/commish.mts scores <season> <week> [name|position]     effective scores, overrides marked *
   node scripts/commish.mts find <season> <week> <name>                player keys for a name
   node scripts/commish.mts override <season> <week> <target> stats '<json>' "<reason>"
   node scripts/commish.mts override <season> <week> <target> points <number> "<reason>"
       target = player name, nflverse:<gsis id>, or DEF:<TEAM>
       stats JSON replaces only the fields given (null removes one), e.g. '{"recTdLengths":[52],"recYds":104}'
   node scripts/commish.mts overrides <season> <week>                  list overrides (active and removed)
   node scripts/commish.mts unoverride <season> <week> <id> "<reason>"
   Env: B5_DATA (default data/league), B5_ACTOR (default: your OS user name), B5_CACHE (default .cache/) */

import os from "node:os";
import path from "node:path";
import { jsonFileStore } from "../src/league/store.ts";
import { createFinalizer } from "../src/league/finalizer.ts";
import { loadCrosswalk, type Crosswalk } from "../src/ingest/crosswalk.ts";
import { weekScores } from "../src/league/finalizer.ts";
import { createOverrides, type OverrideTarget } from "../src/league/overrides.ts";
import type { FinalStatsSource } from "../src/ingest/types.ts";

const store = jsonFileStore(path.resolve(process.env.B5_DATA || "data/league"));
const actor = process.env.B5_ACTOR || os.userInfo().username;
const [cmd, a1, a2, a3, a4, a5, a6] = process.argv.slice(2).filter(x => x !== "--force");
const force = process.argv.includes("--force");
// confirm / reopen don't fetch stats, so no live data sources are needed here.
const finalizer = createFinalizer({ final: {} as FinalStatsSource, crosswalk: {} as Crosswalk, store });
const et = (iso?: string) => iso ? new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " ET" : "—";
const pts = (n: number | null) => (n === null ? "—" : String(n));
const cwLoad = () => loadCrosswalk({ cacheDir: path.join(path.resolve(process.env.B5_CACHE || ".cache"), "nflverse") });

/** Resolve a target: DEF:XXX, a canonical key, or a player name in that week's scores. Never picks between several. */
async function resolveTarget(season: number, week: number, raw: string, cw: Crosswalk): Promise<OverrideTarget> {
  const def = raw.match(/^DEF:([A-Za-z]{2,3})$/);
  if (def) return { kind: "defense", team: def[1]!.toUpperCase() };
  if (/^nflverse:/.test(raw)) return { kind: "player", key: raw };
  if (!raw.trim()) throw new Error("Give a player name, nflverse:<gsis id>, or DEF:<TEAM>.");
  const snap = (await weekScores(store, season, week, cw)).snapshot;
  const hits = Object.values(snap?.players ?? {}).filter(p => p.name.toLowerCase().includes(raw.toLowerCase()));
  if (hits.length === 1) return { kind: "player", key: hits[0]!.key };
  if (!hits.length) throw new Error(`No player matching "${raw}" in ${season} week ${week}. For a player with no stats, use nflverse:<gsis id>.`);
  throw new Error(`"${raw}" matches several players; use the key:\n${hits.map(h => `  ${h.key}  ${h.name} (${h.position}, ${h.team ?? "?"})`).join("\n")}`);
}

try {
  switch (cmd) {
    case "status": {
      const weeks = await store.listWeeks(Number(a1));
      if (!weeks.length) console.log("No finalized weeks yet (all weeks are live).");
      for (const w of weeks) {
        const diffs = w.diffLog.reduce((n, d) => n + d.entries.length, 0);
        console.log(`Week ${String(w.week).padStart(2)}  ${w.status.padEnd(15)} ${w.finalizedBy ? `by ${w.finalizedBy} ${et(w.finalizedAt)}` : `auto-finalizes ${et(w.autoFinalizeAt)}`}  diffs logged: ${diffs}${w.missingGames.length ? `  MISSING: ${w.missingGames.join(" ")}` : ""}`);
      }
      break;
    }
    case "diffs": {
      const w = await store.getWeek(Number(a1), Number(a2));
      if (!w) { console.log("No final numbers for that week yet."); break; }
      for (const d of w.diffLog) {
        console.log(`\n${d.kind === "live_vs_final" ? "Live vs final" : "Stat correction"} (${et(d.at)}): ${d.entries.length} change(s)${d.note ? ` (${d.note})` : ""}`);
        for (const e of d.entries) {
          const ch = Object.entries(e.changes).map(([k, [x, y]]) => `${k} ${JSON.stringify(x)}→${JSON.stringify(y)}`).join(", ");
          console.log(`  ${e.position.padEnd(3)} ${e.name.padEnd(26)} ${pts(e.from).padStart(6)} → ${pts(e.to).padEnd(6)} ${e.gameKey.padEnd(9)} ${ch}${e.overriddenBy ? `  [OVERRIDDEN by ${e.overriddenBy.join(",")}: check it still applies]` : ""}`);
        }
      }
      break;
    }
    case "confirm": {
      const w = await finalizer.confirmWeek(Number(a1), Number(a2), actor, { force });
      console.log(`Week ${w.week} is final (confirmed by ${actor}).`);
      break;
    }
    case "reopen": {
      const w = await finalizer.reopenWeek(Number(a1), Number(a2), actor, a3 ?? "");
      console.log(`Week ${w.week} reopened (now ${w.status}).`);
      break;
    }
    case "review": {
      const items = (await store.listReview()).filter(r => r.status === "open");
      if (!items.length) console.log("Nothing to review.");
      for (const r of items) console.log(`  ${r.name} (${r.team ?? "?"}) ${r.provider} ${r.providerId}, first seen week ${r.week} ${et(r.firstSeen)}: ${r.reason}`);
      break;
    }
    case "audit": {
      for (const e of await store.listAudit()) console.log(`${et(e.at)}  ${e.actor.padEnd(12)} ${e.action}${e.week ? ` ${e.season} wk ${e.week}` : ""} ${e.details ? JSON.stringify(e.details) : ""}`);
      break;
    }
    case "scores": {
      const cw = await cwLoad();
      const w = await weekScores(store, Number(a1), Number(a2), cw);
      if (!w.snapshot) { console.log("No scores for that week yet."); break; }
      console.log(`${a1} week ${a2}: ${w.status}${w.liveDelayed ? " (LIVE SCORING DELAYED)" : ""}, source ${w.snapshot.source}, ${w.overrides.length} active override(s)`);
      const f = (a3 ?? "").toLowerCase();
      const rows = [...Object.values(w.snapshot.players), ...Object.values(w.snapshot.defenses).map(d => ({ ...d, key: `DEF:${d.team}`, name: `${d.team} defense`, position: "DEF" as const }))]
        .filter(p => !f || p.name.toLowerCase().includes(f) || p.position.toLowerCase() === f)
        .sort((x, y) => y.points - x.points).slice(0, f ? 200 : 40);
      for (const p of rows) console.log(`  ${p.override ? "*" : " "} ${p.position.padEnd(3)} ${p.name.padEnd(26)} ${String(p.points).padStart(6)}${p.override ? `   (source ${pts(p.override.source.points)}, ${p.override.type} override ${p.override.ids.join(",")})` : ""}`);
      break;
    }
    case "find": {
      const cw = await cwLoad();
      const snap = (await weekScores(store, Number(a1), Number(a2), cw)).snapshot;
      const q = (a3 ?? "").toLowerCase();
      if (!q.trim()) throw new Error("Give part of a player's name.");
      for (const p of Object.values(snap?.players ?? {}).filter(p => p.name.toLowerCase().includes(q))) console.log(`  ${p.key}  ${p.name} (${p.position}, ${p.team ?? "?"}) ${p.points} pts`);
      break;
    }
    case "override": {
      const cw = await cwLoad();
      const season = Number(a1), week = Number(a2);
      const target = await resolveTarget(season, week, a3 ?? "", cw);
      const ov = createOverrides({ store, crosswalk: cw });
      let o;
      if (a4 === "points") o = await ov.add({ season, week, target, type: "points", points: Number(a5), reason: a6 ?? "", by: actor });
      else if (a4 === "stats") {
        let stats;
        try { stats = JSON.parse(a5 ?? ""); } catch { throw new Error(`Stats must be JSON, e.g. '{"recYds":104}'.`); }
        o = await ov.add({ season, week, target, type: "stats", stats, reason: a6 ?? "", by: actor });
      } else throw new Error('Use "stats" or "points".');
      const after = (await weekScores(store, season, week, cw)).snapshot;
      const shown = target.kind === "defense" ? after?.defenses[target.team] : after?.players[target.key];
      const label = target.kind === "defense" ? `${target.team} defense` : (after?.players[target.key]?.name ?? target.key);
      console.log(`Override ${o.id} added. ${shown ? `${label} now ${shown.points} (source ${pts(shown.override?.source.points ?? null)}).` : "Not shown yet (no scores for that week)."}`);
      break;
    }
    case "overrides": {
      const list = await store.listOverrides(Number(a1), Number(a2));
      if (!list.length) console.log("No overrides for that week.");
      for (const o of list) {
        const t = o.target.kind === "player" ? o.target.key : `DEF:${o.target.team}`;
        const what = o.type === "points" ? `points = ${o.points}` : `stats ${JSON.stringify(o.stats)}`;
        console.log(`  ${o.id} ${o.active ? "ACTIVE " : "removed"} ${t.padEnd(22)} ${what}  by ${o.by} ${et(o.at)}: ${o.reason}${o.active ? "" : `  [removed by ${o.removedBy} ${et(o.removedAt)}: ${o.removedReason}]`}`);
      }
      break;
    }
    case "unoverride": {
      const cw = await cwLoad();
      const o = await createOverrides({ store, crosswalk: cw }).remove(Number(a1), Number(a2), a3 ?? "", actor, a4 ?? "");
      console.log(`Override ${o.id} removed.`);
      break;
    }
    default:
      console.log("Commands: status | diffs | confirm | reopen | review | audit | scores | find | override | overrides | unoverride. See the top of scripts/commish.mts.");
  }
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
