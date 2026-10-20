/* Shadow mode (2026 only; delete with the other MFL code after the migration):
   compare each team's weekly total from OUR engine against MFL's official total.

   Our total = the points our engine gave MFL's starters (nflverse stats, overrides
   applied). A starter with no stat line scored 0 (didn't play). Every player whose
   points differ from MFL's is listed with our rule-by-rule breakdown and the plays
   that produced his scoring events, so each difference can be traced.

   Pure functions; scripts/shadow.mts fetches, writes and reports. */

import { scoreStatLine } from "../scoring/engine.ts";
import type { Position, StatLine } from "../scoring/types.ts";
import type { GameData, PlayerRef } from "../ingest/types.ts";
import { team as canonTeam } from "../ingest/teams.ts";
import type { MflPlayerInfo } from "./mflRosters.ts";
import { mflName } from "./mflRosters.ts";

export const SLOTS: readonly Position[] = ["QB", "RB", "RB", "WR", "WR", "WR", "TE", "K", "DEF"];
const MFL_POS: Record<string, Position> = { QB: "QB", RB: "RB", WR: "WR", TE: "TE", PK: "K", K: "K", Def: "DEF" };

/** Snapshot entries as weekScores() returns them (players keyed "nflverse:<gsis>", defenses by team). */
export interface ScoredEntry { points: number; stats: StatLine }
export interface WeekScores { players: Record<string, ScoredEntry & { position: Position; name: string }>; defenses: Record<string, ScoredEntry> }

export interface MflWeeklyFranchise {
  id: string; score?: string; isHome?: string; starters?: string;
  player?: { id: string; status?: string; score?: string } | { id: string; status?: string; score?: string }[];
}
export interface MflWeeklyResults { week?: string; matchup?: { franchise: MflWeeklyFranchise[] } | { franchise: MflWeeklyFranchise[] }[] }

export interface StarterRow { mflId: string; name: string; position: Position | null; playerId: string | null; mfl: number; ours: number | null }
export interface PlayerDiff { mflId: string; playerId: string | null; name: string; position: Position | null; mfl: number; ours: number;
  lines: { stat: string; value: number; points: number }[]; plays: string[]; note?: string }
export interface TeamComparison {
  /** mflScore is null until MFL posts the week (its export then has no score); nothing is compared before that. */
  teamId: string; mflScore: number | null; ourScore: number; matched: boolean;
  starters: StarterRow[];            // in slot order when they fit
  slots: (string | null)[];          // our player IDs for lineup_slots (QB RB RB WR WR WR TE K DEF)
  diffs: PlayerDiff[];
  unmapped: { mflId: string; name: string; reason: string }[];
}
export interface WeekComparison { season: number; week: number; teams: TeamComparison[]; matchups: { home: string; away: string }[] }

const list = <T>(x: T | T[] | undefined): T[] => (x == null ? [] : Array.isArray(x) ? x : [x]);
const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (s: string | undefined) => (s == null || s === "" ? 0 : Number(s));

/** Our player ID for an MFL ID: "DEF:<TEAM>" for defenses, else the single GSIS ID from the ID map. */
export function ourId(mflId: string, info: MflPlayerInfo | undefined, idMap: Map<string, string[]>): { id: string | null; reason?: string } {
  if (info?.position === "Def") {
    try { return { id: `DEF:${canonTeam(info.team)}` }; } catch { return { id: null, reason: `unknown NFL team code "${info.team}"` }; }
  }
  const g = idMap.get(mflId) ?? [];
  if (g.length === 1) return { id: g[0]! };
  return { id: null, reason: g.length ? `MFL ID maps to several nflverse IDs (${g.join(", ")})` : "no nflverse ID in the ID map" };
}

const refMatches = (r: PlayerRef | undefined, gsis: string) => !!r && r.id === gsis;

/** Human-readable scoring plays for one player (by GSIS ID) or one defense ("DEF:<TEAM>"), from the week's games. */
export function playsFor(playerId: string, games: GameData[]): string[] {
  const out: string[] = [];
  const def = playerId.startsWith("DEF:") ? playerId.slice(4) : null;
  for (const g of games) {
    for (const e of g.events) {
      const where = `${g.away}@${g.home}`;
      if (def) {
        if (e.team !== def) continue;
        if (e.kind === "td" && e.td !== "pass" && e.td !== "rush" && e.td !== "offFumbleRecovery") out.push(`${where}: ${e.length}-yd ${e.td} TD`);
        else if (e.kind === "safety") out.push(`${where}: safety`);
        else if (e.kind === "defTwoPt") out.push(`${where}: defensive 2-pt return`);
        continue;
      }
      if (e.kind === "td" && (refMatches(e.scorer, playerId) || refMatches(e.passer, playerId))) {
        const role = refMatches(e.passer, playerId) && !refMatches(e.scorer, playerId) ? `threw, to ${e.scorer?.name ?? "?"}` : e.passer ? `caught from ${e.passer.name}` : "scored";
        out.push(`${where}: ${e.length}-yd ${e.td} TD (${role})`);
      } else if (e.kind === "fg" && refMatches(e.kicker, playerId)) out.push(`${where}: ${e.distance}-yd FG`);
      else if (e.kind === "xp" && refMatches(e.kicker, playerId)) out.push(`${where}: extra point`);
      else if (e.kind === "twoPt" && (refMatches(e.passer, playerId) || refMatches(e.receiver, playerId) || refMatches(e.rusher, playerId))) out.push(`${where}: 2-pt ${e.method}`);
    }
  }
  return out;
}

/** Put starters into the 9 slots by position, in MFL's order. Extra or unfittable starters are left out (and reported). */
export function slotStarters(starters: { playerId: string | null; position: Position | null }[]): (string | null)[] {
  const slots: (string | null)[] = SLOTS.map(() => null);
  for (const s of starters) {
    if (!s.playerId || !s.position) continue;
    const i = SLOTS.findIndex((p, k) => p === s.position && slots[k] === null);
    if (i >= 0) slots[i] = s.playerId;
  }
  return slots;
}

export function compareWeek(input: {
  season: number; week: number;
  results: MflWeeklyResults;
  mflPlayers: Map<string, MflPlayerInfo>;
  idMap: Map<string, string[]>;
  scores: WeekScores;
  games: GameData[];
}): WeekComparison {
  const teams: TeamComparison[] = [], matchups: { home: string; away: string }[] = [];
  for (const m of list(input.results.matchup)) {
    const fr = list(m.franchise);
    const home = fr.find(f => f.isHome === "1"), away = fr.find(f => f.isHome !== "1");
    if (home && away) matchups.push({ home: home.id, away: away.id });
    for (const f of fr) {
      const posted = f.score != null && f.score !== "";
      const mflScoreById = new Map(list(f.player).map(p => [p.id, num(p.score)]));
      const starterIds = (f.starters ?? "").split(",").map(s => s.trim()).filter(Boolean);
      const starters: StarterRow[] = [], diffs: PlayerDiff[] = [], unmapped: TeamComparison["unmapped"] = [];
      for (const mflId of starterIds) {
        const info = input.mflPlayers.get(mflId);
        const name = info ? mflName(info.name) : `MFL ${mflId}`;
        const position = info ? MFL_POS[info.position] ?? null : null;
        const { id, reason } = ourId(mflId, info, input.idMap);
        const mfl = mflScoreById.get(mflId) ?? 0;
        if (!id) {
          unmapped.push({ mflId, name, reason: reason! });
          starters.push({ mflId, name, position, playerId: null, mfl, ours: null });
          if (posted) diffs.push({ mflId, playerId: null, name, position, mfl, ours: 0, lines: [], plays: [], note: `not scored: ${reason}` });
          continue;
        }
        const entry = id.startsWith("DEF:") ? input.scores.defenses[id.slice(4)] : input.scores.players[`nflverse:${id}`];
        const ours = round2(entry?.points ?? 0);
        starters.push({ mflId, name, position, playerId: id, mfl, ours });
        if (posted && Math.abs(ours - mfl) >= 0.005) {
          const lines = entry && position ? scoreStatLine(position, entry.stats).lines.map(l => ({ stat: l.stat, value: l.value, points: l.points })) : [];
          diffs.push({ mflId, playerId: id, name, position, mfl, ours, lines, plays: playsFor(id, input.games),
            ...(entry ? {} : { note: "no stat line from nflverse (did he play?)" }) });
        }
      }
      const ourScore = round2(starters.reduce((s, r) => s + (r.ours ?? 0), 0));
      const mflScore = posted ? round2(num(f.score)) : null;
      teams.push({ teamId: f.id, mflScore, ourScore, matched: mflScore != null && Math.abs(ourScore - mflScore) < 0.005, starters,
        slots: slotStarters(starters), diffs, unmapped });
    }
  }
  return { season: input.season, week: input.week, teams, matchups };
}

/** Regular-season standings from matchups with both scores: W-L-T, points for/against, rank by win% then points for. */
export function standingsFrom(matchups: { week: number; home_team: string; away_team: string; home_score: number | null; away_score: number | null }[], regularSeasonWeeks = 14) {
  const t = new Map<string, { team_id: string; wins: number; losses: number; ties: number; points_for: number; points_against: number }>();
  const row = (id: string) => t.get(id) ?? (t.set(id, { team_id: id, wins: 0, losses: 0, ties: 0, points_for: 0, points_against: 0 }), t.get(id)!);
  for (const m of matchups) {
    if (m.week > regularSeasonWeeks || m.home_score == null || m.away_score == null) continue;
    const h = row(m.home_team), a = row(m.away_team);
    h.points_for += m.home_score; h.points_against += m.away_score;
    a.points_for += m.away_score; a.points_against += m.home_score;
    if (m.home_score > m.away_score) { h.wins++; a.losses++; } else if (m.home_score < m.away_score) { a.wins++; h.losses++; } else { h.ties++; a.ties++; }
  }
  const pct = (r: { wins: number; losses: number; ties: number }) => { const g = r.wins + r.losses + r.ties; return g ? (r.wins + r.ties / 2) / g : 0; };
  return [...t.values()]
    .map(r => ({ ...r, points_for: round2(r.points_for), points_against: round2(r.points_against) }))
    .sort((a, b) => pct(b) - pct(a) || b.points_for - a.points_for)
    .map((r, i) => ({ ...r, rank: i + 1 }));
}
