/* TEMPORARY (2026 only; delete with the other MFL code after the migration):
   mirror MFL's current rosters into public.roster_entries, mapped to our player IDs.

   - Players: MFL ID -> nflverse GSIS ID through dynastyprocess's ID map
     (db_playerids.csv, the table behind nflreadr's load_ff_playerids). An MFL ID
     must map to exactly one GSIS ID that is in nfl_players; otherwise the player is
     UNMATCHED and goes to the commissioner's review queue. Never matched by name.
   - Team defenses: MFL position "Def" + MFL team code -> "DEF:<TEAM>".

   Pure functions; scripts/sync-mfl-rosters.mts does the fetching and writing. */

import { team } from "../ingest/teams.ts";

export interface MflRosterPlayer { id: string; drafted?: string; status?: string }
export interface MflFranchise { id: string; player?: MflRosterPlayer | MflRosterPlayer[] }
export interface MflPlayerInfo { id: string; name: string; position: string; team: string }

export interface RosterEntryRow { season: number; team_id: string; player_id: string; acquired: string | null }
export interface UnmatchedRosterPlayer { franchise: string; mflId: string; name: string; position: string; team: string; reason: string }

const list = <T>(x: T | T[] | undefined): T[] => (x == null ? [] : Array.isArray(x) ? x : [x]);
/** "Taylor, Jonathan" -> "Jonathan Taylor"; "Panthers, Carolina" -> "Carolina Panthers". */
export const mflName = (n: string) => { const i = n.indexOf(", "); return i < 0 ? n : `${n.slice(i + 2)} ${n.slice(0, i)}`; };

/** MFL ID -> GSIS IDs from dynastyprocess db_playerids.csv rows (several = ambiguous). */
export function mflToGsis(rows: Record<string, string>[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const r of rows) {
    const mfl = r.mfl_id?.trim(), g = r.gsis_id?.trim();
    if (!mfl || mfl === "NA" || !g || g === "NA") continue;
    const cur = m.get(mfl) ?? [];
    if (!cur.includes(g)) cur.push(g);
    m.set(mfl, cur);
  }
  return m;
}

/** One MFL player ID -> our player ID (defenses by MFL team code, players through the ID map; never by name),
    or the reason it can't be mapped. */
export function mapMflId(id: string, players: Map<string, MflPlayerInfo>, idMap: Map<string, string[]>, known: Set<string>): { id: string } | { reason: string } {
  const info = players.get(id);
  let playerId: string;
  if (info?.position === "Def") {
    try { playerId = `DEF:${team(info.team)}`; } catch { return { reason: `unknown NFL team code "${info.team}"` }; }
  } else {
    const g = idMap.get(id) ?? [];
    if (g.length === 0) return { reason: "no nflverse ID for this MFL player in the ID map" };
    if (g.length > 1) return { reason: `MFL ID maps to several nflverse IDs (${g.join(", ")})` };
    playerId = g[0]!;
  }
  if (!known.has(playerId)) return { reason: `${playerId} is not in nfl_players` };
  return { id: playerId };
}

export function mapRosters(input: {
  season: number;
  franchises: MflFranchise[];
  players: Map<string, MflPlayerInfo>;      // MFL TYPE=players
  idMap: Map<string, string[]>;             // mflToGsis()
  known: Set<string>;                       // nfl_players ids
}): { entries: RosterEntryRow[]; unmatched: UnmatchedRosterPlayer[]; mflIds: Map<string, string> } {
  const entries: RosterEntryRow[] = [], unmatched: UnmatchedRosterPlayer[] = [];
  const mflIds = new Map<string, string>();   // MFL ID -> our player ID, for every mapped rostered player
  for (const f of input.franchises) {
    for (const p of list(f.player)) {
      const info = input.players.get(p.id);
      const base = { franchise: f.id, mflId: p.id, name: info ? mflName(info.name) : "", position: info?.position ?? "", team: info?.team ?? "" };
      const m = mapMflId(p.id, input.players, input.idMap, input.known);
      if ("reason" in m) { unmatched.push({ ...base, reason: m.reason }); continue; }
      const playerId = m.id;
      entries.push({ season: input.season, team_id: f.id, player_id: playerId, acquired: p.drafted?.trim() || null });
      mflIds.set(p.id, playerId);
    }
  }
  return { entries, unmatched, mflIds };
}
