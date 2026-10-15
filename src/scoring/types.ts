/* Scoring types. Stats providers convert their feeds into a StatLine; the
   engine never talks to a provider. */

export type Position = "QB" | "RB" | "WR" | "TE" | "K" | "DEF";

/** One player's (or one team defense's) stats for one game. Omitted = 0 / none. */
export interface StatLine {
  // Touchdowns by length, one entry per TD (yards of the scoring play)
  passTdLengths?: number[];
  rushTdLengths?: number[];
  recTdLengths?: number[];

  // Offense
  passYds?: number;
  rushYds?: number;
  recYds?: number;
  receptions?: number;
  interceptionsThrown?: number;
  twoPtPasses?: number;
  twoPtRushes?: number;
  twoPtReceptions?: number;

  // Return / recovery TDs (players and team defense)
  puntReturnTds?: number;
  kickReturnTds?: number;
  intReturnTds?: number;
  /** Opponent fumble recovered and returned for a TD (defense or special teams). */
  defFumbleRecoveryTds?: number;
  /** Own team's fumble recovered and advanced for a TD. */
  offFumbleRecoveryTds?: number;

  // Kicking
  /** Length of each field goal MADE. */
  fgMadeLengths?: number[];
  extraPoints?: number;

  // Team defense
  interceptions?: number;
  /** Opponent fumbles recovered, defense and special teams. */
  fumbleRecoveries?: number;
  sacks?: number;
  safeties?: number;
  blockedFgs?: number;
  blockedFgTds?: number;
  blockedPunts?: number;
  blockedPuntTds?: number;
  /** Defensive two-point conversion returns. */
  defTwoPtReturns?: number;
  /** NET passing yards allowed (sack yardage subtracted), as MFL scores it. */
  passYdsAllowed?: number;
  rushYdsAllowed?: number;
  /** Passing + rushing TDs scored by the opponent's offense. */
  offensiveTdsAllowed?: number;
  /** MFL code OPPOPS (label unconfirmed): treated as points scored by the opponent. */
  opponentPoints?: number;
}

/** Stats a rule can be keyed on. "Length" stats are evaluated per play. */
export type RuleStat =
  | "passTdLength" | "rushTdLength" | "recTdLength" | "fgLength"
  | "passTds" | "rushTds" | "recTds" | "scrimmageYds"
  | "receptions" | "interceptionsThrown" | "twoPtPasses" | "twoPtRushes" | "twoPtReceptions"
  | "puntReturnTds" | "kickReturnTds" | "intReturnTds" | "defFumbleRecoveryTds" | "offFumbleRecoveryTds"
  | "extraPoints" | "interceptions" | "fumbleRecoveries" | "sacks" | "safeties"
  | "blockedFgs" | "blockedFgTds" | "blockedPunts" | "blockedPuntTds" | "defTwoPtReturns"
  | "passYdsAllowed" | "rushYdsAllowed" | "offensiveTdsAllowed" | "opponentPoints";

export type RulePoints =
  | { flat: number }
  | { per: number }
  /** base at the range's low end, plus `points` per full `every` units above it */
  | { base: number; every: number; points: number };

export interface Rule {
  /** Original MFL rule code, for traceability during migration. */
  mfl?: string;
  stat: RuleStat;
  range: readonly [number, number];
  points: RulePoints;
}

export type RuleSet = Record<Position, readonly Rule[]>;

export interface ScoreLine {
  stat: RuleStat;
  /** The stat value this line scored (the play length for per-play rules). */
  value: number;
  points: number;
}

export interface Score {
  total: number;
  lines: ScoreLine[];
}
