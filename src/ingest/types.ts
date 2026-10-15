/* Provider-neutral game data. Every stats adapter (nflverse for final
   scores, ESPN for live) produces GameData; statlines.ts turns it into the scoring
   engine's StatLines. Special-teams and defensive TD rules live in one place. */

/** Canonical NFL team code (see teams.ts). */
export type Team = string;

/** A player as one provider identifies him. Mapping to league player IDs happens elsewhere. */
export interface PlayerRef {
  provider: string;
  id: string;
  name: string;
  team?: Team;
  position?: string;
}

/** Box-score totals for one player in one game. */
export interface PlayerBox {
  player: PlayerRef;
  passYds?: number;
  rushYds?: number;
  recYds?: number;
  receptions?: number;
  interceptionsThrown?: number;
}

/** Defensive / special-teams counting stats earned by one team in one game. */
export interface TeamBox {
  sacks?: number;
  interceptions?: number;
  /** Opponent fumbles recovered, defense and special teams. */
  fumbleRecoveries?: number;
  blockedFgs?: number;
  blockedPunts?: number;
  /** This team's OFFENSE: net passing yards (after sack yardage). Becomes the opponent's yards allowed. */
  netPassYds?: number;
  /** This team's OFFENSE: rushing yards. Becomes the opponent's yards allowed. */
  rushYds?: number;
}

export type TdKind =
  | "pass" | "rush"                 // offensive TDs (count toward "offensive TDs allowed")
  | "kickReturn" | "puntReturn" | "intReturn"
  | "defFumbleReturn"               // opponent's fumble recovered for a TD (defense or special teams)
  | "offFumbleRecovery"             // own team's fumble recovered for a TD
  | "blockedFgReturn" | "blockedPuntReturn"
  | "otherDefST";                   // any other non-offensive TD (e.g. kicking team recovers kickoff in end zone)

export type ScoringEvent =
  | { kind: "td"; td: TdKind; team: Team; length: number; scorer?: PlayerRef; passer?: PlayerRef }
  | { kind: "fg"; team: Team; distance: number; kicker?: PlayerRef }
  | { kind: "xp"; team: Team; kicker?: PlayerRef }
  | { kind: "twoPt"; team: Team; method: "pass" | "rush"; passer?: PlayerRef; receiver?: PlayerRef; rusher?: PlayerRef }
  | { kind: "defTwoPt"; team: Team }
  | { kind: "safety"; team: Team };

export type GameStatus = "scheduled" | "in_progress" | "final";

export interface GameData {
  provider: string;
  gameId: string;
  season: number;
  week: number;
  home: Team;
  away: Team;
  homeScore: number;
  awayScore: number;
  status: GameStatus;
  /** Scheduled kickoff (ISO, UTC), when the source knows it. */
  kickoff?: string;
  /** Local game date (YYYY-MM-DD) when only the date is known (nflverse). */
  gameDate?: string;
  players: PlayerBox[];
  teams: Record<Team, TeamBox>;
  events: ScoringEvent[];
  /** Things the adapter couldn't interpret. Surfaced in the bake-off report, never silently dropped. */
  warnings: string[];
}

/** System-of-record source (nflverse). Complete, corrected stats, updated nightly. */
export interface FinalStatsSource {
  readonly name: string;
  /** All played games of a regular-season week. */
  week(season: number, week: number): Promise<GameData[]>;
}
/** @deprecated use FinalStatsSource */
export type StatsProvider = FinalStatsSource;

/** Live source (ESPN). Never throws: on trouble it returns the last good data with `delayed: true`. */
export interface LiveStatsSource {
  readonly name: string;
  week(season: number, week: number): Promise<LiveWeek>;
  /** The source's current regular-season week, or undefined if it can't tell (offseason, outage). */
  currentWeek(): Promise<{ season: number; week: number } | undefined>;
}

export interface LiveWeek {
  games: GameData[];
  /** True when any game's numbers are stale because the source failed or changed shape. Show "live scoring delayed". */
  delayed: boolean;
  /** What went wrong, for logs. */
  errors: string[];
  fetchedAt: string;
}
