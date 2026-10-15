/* Scoring engine: turns a StatLine into fantasy points under a RuleSet.
   Pure and provider-agnostic. See rules.ts for how each rule type scores. */

import { B5_RULES } from "./rules.ts";
import type { Position, Rule, RuleSet, RuleStat, Score, ScoreLine, StatLine } from "./types.ts";

const PER_PLAY: ReadonlySet<RuleStat> = new Set(["passTdLength", "rushTdLength", "recTdLength", "fgLength"]);

const sum = (...xs: (number | undefined)[]) => xs.reduce<number>((a, x) => a + (x ?? 0), 0);

// Avoid float noise like 0.1 * 47 = 4.700000000000001
const round = (x: number) => Math.round(x * 10000) / 10000;

/** Values for per-play stats: one entry per play. */
function plays(stat: RuleStat, s: StatLine): number[] {
  switch (stat) {
    case "passTdLength": return s.passTdLengths ?? [];
    case "rushTdLength": return s.rushTdLengths ?? [];
    case "recTdLength": return s.recTdLengths ?? [];
    case "fgLength": return s.fgMadeLengths ?? [];
    default: return [];
  }
}

/** Value for whole-game stats. */
function total(stat: RuleStat, s: StatLine): number {
  switch (stat) {
    case "passTds": return s.passTdLengths?.length ?? 0;
    case "rushTds": return s.rushTdLengths?.length ?? 0;
    case "recTds": return s.recTdLengths?.length ?? 0;
    // MFL "Total Yards from Scrimmage" includes passing yards.
    case "scrimmageYds": return sum(s.passYds, s.rushYds, s.recYds);
    case "passTdLength": case "rushTdLength": case "recTdLength": case "fgLength":
      throw new Error(`${stat} is a per-play stat`);
    default: return s[stat] ?? 0;
  }
}

function rulePoints(rule: Rule, value: number): number | null {
  const [lo, hi] = rule.range;
  if (value < lo || value > hi) return null;
  const p = rule.points;
  if ("flat" in p) return p.flat;
  if ("per" in p) return p.per * value;
  return p.base + p.points * Math.floor((value - lo) / p.every);
}

// Defense rules pay for allowing zero (e.g. no offensive TDs allowed = 8), so a
// missing value must never be read as 0. Callers score a game that hasn't
// started as 0 instead of passing an empty stat line.
const DEF_REQUIRED = ["passYdsAllowed", "rushYdsAllowed", "offensiveTdsAllowed", "opponentPoints"] as const;

/** Score one player's game. Lines with 0 points are left out. */
export function scoreStatLine(position: Position, stats: StatLine, rules: RuleSet = B5_RULES): Score {
  if (position === "DEF") {
    const missing = DEF_REQUIRED.filter(k => stats[k] === undefined);
    if (missing.length) throw new Error(`DEF stat line is missing ${missing.join(", ")}`);
  }
  const lines: ScoreLine[] = [];
  for (const rule of rules[position]) {
    const values = PER_PLAY.has(rule.stat) ? plays(rule.stat, stats) : [total(rule.stat, stats)];
    for (const value of values) {
      const pts = rulePoints(rule, value);
      if (pts) lines.push({ stat: rule.stat, value, points: round(pts) });
    }
  }
  const t = Math.round(lines.reduce((a, l) => a + l.points, 0) * 100) / 100;
  return { total: t === 0 ? 0 : t, lines };
}
