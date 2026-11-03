/* Draft Room ADP (average draft position), 2026-11-02. Two free public sources, both stored:
   - PRIMARY: MFL's site-wide ADP export (all MFL leagues, not ours; no login):
     api.myfantasyleague.com/<year>/export?TYPE=adp&PERIOD=RECENT&FCOUNT=12&IS_PPR=1&IS_KEEPER=N&IS_MOCK=-1&JSON=1
     (12 teams, PPR, redraft, real and mock drafts). RECENT = the last two weeks; out of draft season it
     holds a handful of drafts, so below MIN_DRAFTS we use PERIOD=ALL (the whole season's drafts).
     Players are MFL IDs -> our GSIS IDs through the nflverse crosswalk (dynastyprocess db_playerids.csv,
     nflreadr's load_ff_playerids), defenses by MFL team code: mapMflId, the roster sync's rules. Never by name.
   - FALLBACK / comparison: Fantasy Football Calculator, half-PPR, 12 teams:
     fantasyfootballcalculator.com/api/v1/adp/half-ppr?teams=12&year=<year>&position=all
     FFC has its own player IDs, which no crosswalk carries, so a player matches only when exactly ONE of
     our players has that name (punctuation and Jr/III ignored) and position, the NFL team breaking a tie
     (players change teams after a list is made); defenses by team.
     Anything else is unmatched and flagged, never guessed.
   Unmatched fantasy-position players go to review_queue (providers adp-mfl / adp-ffc, Admin page).
   IDP positions in MFL's list (DE, LB, CB, S, DT) are not ours and are skipped silently.
   Pure functions; scripts/sync-adp.mts fetches and writes. */

import { team } from "../ingest/teams.ts";
import { mapMflId, type MflPlayerInfo } from "./mflRosters.ts";

export type AdpSource = "mfl" | "ffc";
export interface AdpRow { player_id: string; adp: number; pos_rank: string }
export interface AdpUnmatched { provider_id: string; name: string; team: string | null; reason: string }
export interface OurPlayer { id: string; name: string; position: string; nfl_team: string | null }

export const MIN_DRAFTS = 50;
const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"];
const MFL_POS: Record<string, string> = { QB: "QB", RB: "RB", WR: "WR", TE: "TE", PK: "K", Def: "DEF" };
const FFC_POS: Record<string, string> = { QB: "QB", RB: "RB", WR: "WR", TE: "TE", PK: "K", K: "K", DEF: "DEF" };

export const mflAdpUrl = (year: number, period: "RECENT" | "ALL") =>
  `https://api.myfantasyleague.com/${year}/export?TYPE=adp&PERIOD=${period}&FCOUNT=12&IS_PPR=1&IS_KEEPER=N&IS_MOCK=-1&JSON=1`;
export const ffcAdpUrl = (year: number) => `https://fantasyfootballcalculator.com/api/v1/adp/half-ppr?teams=12&year=${year}&position=all`;

/** MFL's export: the drafts behind it and each player's average pick. */
export function parseMflAdp(json: unknown): { drafts: number; players: { id: string; adp: number }[] } {
  const a = (json as { adp?: { totalDrafts?: string; player?: unknown } })?.adp;
  if (!a) throw new Error("MFL ADP export: no adp block");
  const list = ([] as { id?: string; averagePick?: string }[]).concat((a.player as never) ?? []);
  return { drafts: Number(a.totalDrafts) || 0, players: list.filter(p => p.id && isFinite(Number(p.averagePick))).map(p => ({ id: String(p.id), adp: Number(p.averagePick) })) };
}
/** RECENT unless it holds too few drafts (out of draft season), then ALL. */
export const usePeriod = (recentDrafts: number): "RECENT" | "ALL" => (recentDrafts >= MIN_DRAFTS ? "RECENT" : "ALL");

export function parseFfcAdp(json: unknown): { drafts: number; players: { id: string; name: string; pos: string; team: string; adp: number }[] } {
  const j = json as { status?: string; meta?: { total_drafts?: number }; players?: { player_id: number; name: string; position: string; team: string; adp: number }[] };
  if (!j || j.status !== "Success" || !Array.isArray(j.players)) throw new Error("FFC ADP: unexpected response");
  return { drafts: Number(j.meta?.total_drafts) || 0, players: j.players.filter(p => isFinite(Number(p.adp))).map(p => ({ id: String(p.player_id), name: p.name, pos: p.position, team: p.team, adp: Number(p.adp) })) };
}

/** "RB7": rank within the position by ADP (ties keep list order). */
export function withPosRanks(rows: { player_id: string; adp: number }[], posOf: (id: string) => string): AdpRow[] {
  const n: Record<string, number> = {};
  return rows.slice().sort((a, b) => a.adp - b.adp).map(r => { const p = posOf(r.player_id); n[p] = (n[p] ?? 0) + 1; return { ...r, pos_rank: p + n[p] }; });
}

/** MFL ADP -> our players. */
export function mapMflAdp(list: { id: string; adp: number }[], players: Map<string, MflPlayerInfo>, idMap: Map<string, string[]>, ours: OurPlayer[]): { rows: AdpRow[]; unmatched: AdpUnmatched[] } {
  const known = new Set(ours.map(p => p.id)), pos = new Map(ours.map(p => [p.id, p.position]));
  const rows: { player_id: string; adp: number }[] = [], unmatched: AdpUnmatched[] = [], seen = new Set<string>();
  for (const p of list) {
    const info = players.get(p.id);
    if (!info || !MFL_POS[info.position]) continue;                  // IDP or not in MFL's player list
    const m = mapMflId(p.id, players, idMap, known);
    if ("reason" in m) { unmatched.push({ provider_id: p.id, name: info.name, team: info.team || null, reason: m.reason }); continue; }
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    rows.push({ player_id: m.id, adp: p.adp });
  }
  return { rows: withPosRanks(rows, id => pos.get(id) ?? "?"), unmatched };
}

export const normName = (s: string) => String(s || "").toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, "").replace(/[^a-z0-9]/g, "");

/** FFC ADP -> our players: exactly one of ours with that name, position and team (defenses by team). */
export function mapFfcAdp(list: { id: string; name: string; pos: string; team: string; adp: number }[], ours: OurPlayer[]): { rows: AdpRow[]; unmatched: AdpUnmatched[] } {
  const byName = new Map<string, OurPlayer[]>(), known = new Set(ours.map(p => p.id)), pos = new Map(ours.map(p => [p.id, p.position]));
  for (const p of ours) if (p.position !== "DEF") { const k = normName(p.name); byName.set(k, [...(byName.get(k) ?? []), p]); }
  const rows: { player_id: string; adp: number }[] = [], unmatched: AdpUnmatched[] = [], seen = new Set<string>();
  for (const p of list) {
    const position = FFC_POS[p.pos];
    if (!position) continue;
    let code: string | null = null;
    try { code = p.team ? team(p.team) : null; } catch { code = null; }
    let id: string | null = null, reason = "";
    if (position === "DEF") {
      if (code && known.has(`DEF:${code}`)) id = `DEF:${code}`; else reason = `unknown NFL team code "${p.team}"`;
    } else {
      // name + position; the team only breaks a tie (players change teams after a list is made)
      const named = (byName.get(normName(p.name)) ?? []).filter(o => o.position === position);
      const c = named.length > 1 && code ? named.filter(o => o.nfl_team === code) : named;
      if (c.length === 1) id = c[0]!.id;
      else reason = c.length ? `several of our players match ${p.name} (${position} ${p.team})` : `no ${position} named ${p.name}`;
    }
    if (!id) { unmatched.push({ provider_id: p.id, name: p.name, team: p.team || null, reason }); continue; }
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push({ player_id: id, adp: p.adp });
  }
  return { rows: withPosRanks(rows, i => pos.get(i) ?? "?"), unmatched };
}

/** Refresh today? Nightly in the preseason (July 1 until the season's real draft is complete, at the
    latest Sept 15), weekly (Mondays, UTC) the rest of the year. */
export function adpDue(now: Date, realDraftDone: boolean): boolean {
  const m = now.getUTCMonth() + 1, d = now.getUTCDate();
  const preseason = (m === 7 || m === 8 || (m === 9 && d <= 15)) && !realDraftDone;
  return preseason || now.getUTCDay() === 1;
}

export { POSITIONS };
