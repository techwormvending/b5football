/* GameData -> scoring-engine StatLines (one per player, one per team defense).
   This is the only place that decides which TD counts as what, so every
   provider scores special teams the same way. Verified against MFL's
   official scores (see scripts/bakeoff.mts). */

import type { StatLine } from "../scoring/types.ts";
import type { GameData, PlayerRef, TdKind, Team } from "./types.ts";

export interface GameStatLines {
  /** Keyed by `${provider}:${playerId}`. */
  players: Map<string, { player: PlayerRef; stats: StatLine }>;
  defenses: Map<Team, StatLine>;
}

type NumKey = { [K in keyof StatLine]-?: NonNullable<StatLine[K]> extends number ? K : never }[keyof StatLine];
type ListKey = "passTdLengths" | "rushTdLengths" | "recTdLengths" | "fgMadeLengths";

/** Player stat credited for a non-offensive TD. QBs only score the fumble-recovery kinds (rules.ts). */
const PLAYER_TD: Record<Exclude<TdKind, "pass" | "rush">, NumKey> = {
  kickReturn: "kickReturnTds",
  puntReturn: "puntReturnTds",
  intReturn: "intReturnTds",
  defFumbleReturn: "defFumbleRecoveryTds",
  offFumbleRecovery: "offFumbleRecoveryTds",
  blockedFgReturn: "defFumbleRecoveryTds",
  blockedPuntReturn: "defFumbleRecoveryTds",
  otherDefST: "defFumbleRecoveryTds"
};

/** Team-defense stat credited for a TD scored by that team. Own-fumble recoveries are offense, so none. */
const DEFENSE_TD: Partial<Record<TdKind, NumKey>> = {
  kickReturn: "kickReturnTds",
  puntReturn: "puntReturnTds",
  intReturn: "intReturnTds",
  defFumbleReturn: "defFumbleRecoveryTds",
  blockedFgReturn: "blockedFgTds",
  blockedPuntReturn: "blockedPuntTds",
  otherDefST: "defFumbleRecoveryTds"
};

export function gameStatLines(g: GameData): GameStatLines {
  const players = new Map<string, { player: PlayerRef; stats: StatLine }>();
  const of = (p: PlayerRef) => {
    const key = `${p.provider}:${p.id}`;
    let e = players.get(key);
    if (!e) { e = { player: p, stats: {} }; players.set(key, e); }
    return e.stats;
  };
  const add = (s: StatLine, k: NumKey, v = 1) => { s[k] = (s[k] ?? 0) + v; };
  const push = (s: StatLine, k: ListKey, v: number) => { (s[k] ??= []).push(v); };

  for (const b of g.players) {
    const s = of(b.player);
    if (b.passYds) add(s, "passYds", b.passYds);
    if (b.rushYds) add(s, "rushYds", b.rushYds);
    if (b.recYds) add(s, "recYds", b.recYds);
    if (b.receptions) add(s, "receptions", b.receptions);
    if (b.interceptionsThrown) add(s, "interceptionsThrown", b.interceptionsThrown);
  }

  const defenses = new Map<Team, StatLine>();
  const opp = (t: Team) => (t === g.home ? g.away : g.home);
  for (const t of [g.home, g.away]) {
    const box = g.teams[t] ?? {};
    const oBox = g.teams[opp(t)] ?? {};
    const d: StatLine = {
      opponentPoints: t === g.home ? g.awayScore : g.homeScore,
      offensiveTdsAllowed: 0
    };
    // Yards allowed come from the opponent's offense. Left undefined if unknown,
    // so the engine refuses to score rather than award "0 yards allowed" points.
    if (oBox.netPassYds !== undefined) d.passYdsAllowed = oBox.netPassYds;
    if (oBox.rushYds !== undefined) d.rushYdsAllowed = oBox.rushYds;
    for (const k of ["sacks", "interceptions", "fumbleRecoveries", "blockedFgs", "blockedPunts"] as const) {
      if (box[k]) d[k] = box[k];
    }
    defenses.set(t, d);
  }

  for (const e of g.events) {
    switch (e.kind) {
      case "td": {
        if (e.td === "pass" || e.td === "rush") {
          const def = defenses.get(opp(e.team));
          if (def) add(def, "offensiveTdsAllowed");
          if (e.td === "pass") {
            if (e.passer) push(of(e.passer), "passTdLengths", e.length);
            if (e.scorer) push(of(e.scorer), "recTdLengths", e.length);
          } else if (e.scorer) push(of(e.scorer), "rushTdLengths", e.length);
          break;
        }
        if (e.scorer) add(of(e.scorer), PLAYER_TD[e.td]);
        const dk = DEFENSE_TD[e.td];
        const def = defenses.get(e.team);
        if (dk && def) add(def, dk);
        break;
      }
      case "fg":
        if (e.kicker) push(of(e.kicker), "fgMadeLengths", e.distance);
        break;
      case "xp":
        if (e.kicker) add(of(e.kicker), "extraPoints");
        break;
      case "twoPt":
        if (e.method === "pass") {
          if (e.passer) add(of(e.passer), "twoPtPasses");
          if (e.receiver) add(of(e.receiver), "twoPtReceptions");
        } else if (e.rusher) add(of(e.rusher), "twoPtRushes");
        break;
      case "defTwoPt": {
        const def = defenses.get(e.team);
        if (def) add(def, "defTwoPtReturns");
        break;
      }
      case "safety": {
        const def = defenses.get(e.team);
        if (def) add(def, "safeties");
        break;
      }
    }
  }
  return { players, defenses };
}
