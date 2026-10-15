/* Week score snapshots: every player's and team defense's points for one NFL
   week, from either the live source (ESPN) or the final source (nflverse).
   Players are keyed by canonical ID ("nflverse:<gsis>"). Games are keyed
   "AWAY@HOME" because ESPN and nflverse use different game IDs. */

import { scoreStatLine } from "../scoring/engine.ts";
import type { Position, StatLine } from "../scoring/types.ts";
import { gameStatLines } from "../ingest/statlines.ts";
import { CANONICAL, type Crosswalk, type UnmatchedPlayer } from "../ingest/crosswalk.ts";
import type { GameData, GameStatus } from "../ingest/types.ts";

export interface PlayerScore { key: string; name: string; position: Position; team?: string; gameKey: string; points: number; stats: StatLine }
export interface DefenseScore { team: string; gameKey: string; points: number; stats: StatLine }
export interface GameSummary { gameKey: string; sourceGameId: string; home: string; away: string; homeScore: number; awayScore: number; status: GameStatus; kickoff?: string; gameDate?: string }

export interface WeekSnapshot {
  season: number;
  week: number;
  source: "live" | "final";
  computedAt: string;
  /** Live only: some numbers are stale because the source failed. Show "live scoring delayed". */
  delayed: boolean;
  errors: string[];
  games: GameSummary[];
  players: Record<string, PlayerScore>;
  defenses: Record<string, DefenseScore>;
  unmatched: UnmatchedPlayer[];
  warnings: string[];
}

export const gameKey = (g: { home: string; away: string }) => `${g.away}@${g.home}`;

const FANTASY_POS: Record<string, Position> = { QB: "QB", RB: "RB", FB: "RB", WR: "WR", TE: "TE", K: "K", PK: "K" };

/** Fantasy position of a canonical player, or undefined if he can't score (OL, defenders, unknown). */
export function positionOf(cw: Crosswalk, key: string): Position | undefined {
  if (!key.startsWith(`${CANONICAL}:`)) return undefined;
  const p = cw.player(key.slice(CANONICAL.length + 1))?.position;
  return p ? FANTASY_POS[p] : undefined;
}

/** Score a week's games. Games must already use canonical player refs (see toCanonical). */
export function scoreWeek(games: GameData[], o: {
  season: number; week: number; source: "live" | "final"; cw: Crosswalk; computedAt: string;
  delayed?: boolean; errors?: string[]; unmatched?: UnmatchedPlayer[];
}): WeekSnapshot {
  const snap: WeekSnapshot = {
    season: o.season, week: o.week, source: o.source, computedAt: o.computedAt,
    delayed: o.delayed ?? false, errors: o.errors ?? [], games: [], players: {}, defenses: {},
    unmatched: o.unmatched ?? [], warnings: []
  };
  for (const g of games) {
    const gk = gameKey(g);
    snap.games.push({ gameKey: gk, sourceGameId: g.gameId, home: g.home, away: g.away, homeScore: g.homeScore, awayScore: g.awayScore, status: g.status, ...(g.kickoff ? { kickoff: g.kickoff } : {}), ...(g.gameDate ? { gameDate: g.gameDate } : {}) });
    for (const w of g.warnings) snap.warnings.push(`${gk}: ${w}`);
    if (g.status === "scheduled") continue;
    const lines = gameStatLines(g);
    for (const [key, { player, stats }] of lines.players) {
      const position = positionOf(o.cw, key);
      if (!position) continue;   // non-fantasy player, or unmatched (flagged for review, never credited)
      // Full name from nflverse's player table (play-by-play only has "J.Williams").
      const name = o.cw.player(key.slice(CANONICAL.length + 1))?.name ?? player.name;
      snap.players[key] = { key, name, position, ...(player.team ? { team: player.team } : {}), gameKey: gk, points: scoreStatLine(position, stats).total, stats };
    }
    for (const [team, stats] of lines.defenses) {
      try { snap.defenses[team] = { team, gameKey: gk, points: scoreStatLine("DEF", stats).total, stats }; }
      catch (err) { snap.warnings.push(`${gk} DEF ${team}: ${(err as Error).message}`); }
    }
  }
  return snap;
}

/** Keep the last good numbers: when `next` is delayed, games it lacks are carried over from `prev`. */
export function mergeLive(prev: WeekSnapshot | undefined, next: WeekSnapshot): WeekSnapshot {
  if (!prev || !next.delayed || prev.season !== next.season || prev.week !== next.week) return next;
  const have = new Set(next.games.map(g => g.gameKey));
  const carry = new Set(prev.games.filter(g => !have.has(g.gameKey)).map(g => g.gameKey));
  if (!carry.size) return next;
  const out: WeekSnapshot = { ...next, games: [...next.games], players: { ...next.players }, defenses: { ...next.defenses } };
  for (const g of prev.games) if (carry.has(g.gameKey)) out.games.push(g);
  for (const [k, p] of Object.entries(prev.players)) if (carry.has(p.gameKey) && !out.players[k]) out.players[k] = p;
  for (const [t, d] of Object.entries(prev.defenses)) if (carry.has(d.gameKey) && !out.defenses[t]) out.defenses[t] = d;
  return out;
}

export interface DiffEntry {
  key: string;                       // player key or "DEF:<team>"
  name: string;
  position: Position;
  gameKey: string;
  from: number | null;               // null = not present before
  to: number | null;
  changes: Record<string, [unknown, unknown]>;
  /** Set when an active commissioner override covers this player/defense (override IDs). */
  overriddenBy?: string[];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Every player / defense whose points or stat line differ between two snapshots. */
export function diffSnapshots(from: WeekSnapshot | undefined, to: WeekSnapshot): DiffEntry[] {
  const out: DiffEntry[] = [];
  const statChanges = (a: StatLine | undefined, b: StatLine | undefined) => {
    const ch: Record<string, [unknown, unknown]> = {};
    for (const k of new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])) {
      const x = (a as Record<string, unknown> | undefined)?.[k], y = (b as Record<string, unknown> | undefined)?.[k];
      if (!same(x, y)) ch[k] = [x ?? null, y ?? null];
    }
    return ch;
  };
  const fp = from?.players ?? {}, fd = from?.defenses ?? {};
  for (const key of new Set([...Object.keys(fp), ...Object.keys(to.players)])) {
    const a = fp[key], b = to.players[key];
    const changes = statChanges(a?.stats, b?.stats);
    if ((a?.points ?? null) !== (b?.points ?? null) || Object.keys(changes).length) {
      const ref = (b ?? a)!;
      out.push({ key, name: ref.name, position: ref.position, gameKey: ref.gameKey, from: a?.points ?? null, to: b?.points ?? null, changes });
    }
  }
  for (const team of new Set([...Object.keys(fd), ...Object.keys(to.defenses)])) {
    const a = fd[team], b = to.defenses[team];
    const changes = statChanges(a?.stats, b?.stats);
    if ((a?.points ?? null) !== (b?.points ?? null) || Object.keys(changes).length) {
      out.push({ key: `DEF:${team}`, name: `${team} defense`, position: "DEF", gameKey: (b ?? a)!.gameKey, from: a?.points ?? null, to: b?.points ?? null, changes });
    }
  }
  return out.sort((x, y) => Math.abs((y.to ?? 0) - (y.from ?? 0)) - Math.abs((x.to ?? 0) - (x.from ?? 0)));
}
