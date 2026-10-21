/* Points breakdown for the Live page: the engine's own score lines (scoreStatLine), each
   with a readable description of the rule that produced it. No second calculation: the
   points are the engine's, this only adds words. Stored with every player score
   (player_scores.lines), so the browser only displays them. */

import { scoreStatLine } from "./engine.ts";
import { B5_RULES } from "./rules.ts";
import type { Position, Rule, RuleSet, RuleStat, StatLine } from "./types.ts";

export interface BreakdownLine {
  /** Rule stat, or "override" for a commissioner-pinned score. */
  stat: RuleStat | "override";
  value: number;
  points: number;
  text: string;
}

// [singular, plural] labels for counted stats.
const COUNT: Partial<Record<RuleStat, [string, string]>> = {
  passTds: ["passing TD", "passing TDs"], rushTds: ["rushing TD", "rushing TDs"], recTds: ["receiving TD", "receiving TDs"],
  receptions: ["reception", "receptions"], interceptionsThrown: ["INT thrown", "INTs thrown"],
  twoPtPasses: ["2-pt pass", "2-pt passes"], twoPtRushes: ["2-pt rush", "2-pt rushes"], twoPtReceptions: ["2-pt catch", "2-pt catches"],
  puntReturnTds: ["punt return TD", "punt return TDs"], kickReturnTds: ["kick return TD", "kick return TDs"],
  intReturnTds: ["INT return TD", "INT return TDs"], defFumbleRecoveryTds: ["fumble recovery TD", "fumble recovery TDs"],
  offFumbleRecoveryTds: ["own-fumble recovery TD", "own-fumble recovery TDs"], extraPoints: ["extra point", "extra points"],
  interceptions: ["interception", "interceptions"], fumbleRecoveries: ["fumble recovery", "fumble recoveries"],
  sacks: ["sack", "sacks"], safeties: ["safety", "safeties"], blockedFgs: ["blocked FG", "blocked FGs"],
  blockedFgTds: ["blocked FG TD", "blocked FG TDs"], blockedPunts: ["blocked punt", "blocked punts"],
  blockedPuntTds: ["blocked punt TD", "blocked punt TDs"], defTwoPtReturns: ["defensive 2-pt return", "defensive 2-pt returns"]
};

const num = (x: number) => String(Math.round(x * 100) / 100);
// Top tiers end at 110 (the longest possible play) or 200+ (yards, counts): show them as "N+".
const range = (r: Rule) => (r.range[1] === 110 || r.range[1] >= 200 ? `${r.range[0]}+` : `${r.range[0]}–${r.range[1]}`);

function label(stat: RuleStat, v: number): string {
  switch (stat) {
    case "passTdLength": return `${v}-yd passing TD`;
    case "rushTdLength": return `${v}-yd rushing TD`;
    case "recTdLength": return `${v}-yd receiving TD`;
    case "fgLength": return `${v}-yd field goal`;
    case "scrimmageYds": return `${v} total yards`;
    case "passYdsAllowed": return `${v} net passing yards allowed`;
    case "rushYdsAllowed": return `${v} rushing yards allowed`;
    case "offensiveTdsAllowed": return v === 0 ? "No offensive TDs allowed" : `${v} offensive TDs allowed`;
    case "opponentPoints": return v === 0 ? "Opponent held scoreless" : `Opponent scored ${v}`;
    default: { const c = COUNT[stat]; return c ? `${v} ${v === 1 ? c[0] : c[1]}` : `${stat} ${v}`; }
  }
}

/** Readable description of how `rule` scored `value`. */
export function describe(rule: Rule, value: number): string {
  const l = label(rule.stat, value), p = rule.points;
  if ("per" in p) return `${l} × ${num(p.per)}`;
  if ("flat" in p) return rule.range[0] === rule.range[1] ? l : `${l} (${range(rule)})`;
  const n = Math.floor((value - rule.range[0]) / p.every);
  const per = p.every === 1 ? "yard" : `full ${p.every}`;
  return `${l} (${range(rule)}): ${num(p.base)}` + (n > 0 ? ` + ${num(p.points)} × ${n} (per ${per} over ${rule.range[0]})` : "");
}

const ruleFor = (rules: RuleSet, position: Position, stat: RuleStat, value: number) =>
  rules[position].find(r => r.stat === stat && value >= r.range[0] && value <= r.range[1]);

/** The engine's lines for one player's game, described. With `points` (the stored, possibly
    commissioner-pinned score), a pinned difference gets its own "override" line, so the
    lines always add up to the points shown. */
export function breakdown(position: Position, stats: StatLine, points?: number, rules: RuleSet = B5_RULES): BreakdownLine[] {
  let score;
  try { score = scoreStatLine(position, stats, rules); }
  catch { score = { total: 0, lines: [] }; }   // a DEF line without allowed-stats isn't scored (see engine)
  const out: BreakdownLine[] = score.lines.map(l => {
    const r = ruleFor(rules, position, l.stat, l.value);
    return { stat: l.stat, value: l.value, points: l.points, text: r ? describe(r, l.value) : label(l.stat, l.value) };
  });
  if (points != null) {
    const diff = Math.round((points - score.total) * 100) / 100;
    if (diff !== 0) out.push({ stat: "override", value: points, points: diff, text: `Commissioner override (score set to ${num(points)})` });
  }
  return out;
}

/** Sum of a breakdown, rounded like the engine's totals. */
export const breakdownTotal = (lines: { points: number }[]) => {
  const t = Math.round(lines.reduce((a, l) => a + l.points, 0) * 100) / 100;
  return t === 0 ? 0 : t;
};
