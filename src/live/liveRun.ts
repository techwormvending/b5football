/* One live-scoring pass, for a host that calls it every minute (Cloudflare Worker cron or
   a Supabase Edge Function). Stateless: everything it needs is in ESPN or Supabase.

   1. ESPN scoreboard (current week). Outside a live window (no game in progress, none
      kicking off within 10 minutes, none finished in the last ~4.5 h) it stops here: one request.
   2. If nflverse has already finalized the week (score_weeks status pending_review/final),
      live numbers never overwrite it.
   3. Each active game: ESPN summary + core plays -> GameData -> canonical player IDs
      (crosswalk built from nfl_players.espn_id) -> our engine. A game that fails keeps its
      previous numbers in the database (only processed games are written).
   4. player_scores (source "live"), score_weeks (live, delayed flag), review_queue (ESPN
      athletes with no nflverse match; never guessed).
   5. 2026 shadow season: mirror MFL's current-week starters into lineup_slots
      (via mfl_player_map). TEMPORARY; remove with the other MFL code.
   6. matchups: each team's total = its starters' current points.
   Never throws. Everything goes through the injected fetch. */

import { gameFromEspn, type EspnPlay, type EspnSummary } from "../ingest/espn.ts";
import { crosswalkFromRows, toCanonical, type UnmatchedPlayer } from "../ingest/crosswalk.ts";
import { scoreWeek } from "../league/scores.ts";
import { sbBase, sbHeaders, type SbConfig } from "../league/supabaseRest.ts";
import type { GameData } from "../ingest/types.ts";

const SITE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";
const CORE = "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl";
const MFL = "https://www45.myfantasyleague.com";
const LEAD_MS = 10 * 60_000, AFTER_MS = 4.5 * 3600_000;

export interface LiveDeps {
  fetch: typeof fetch;
  sb: SbConfig;
  now?: () => number;
  log?: (m: string) => void;
  /** TEMPORARY 2026: MFL league whose starters are mirrored; omit to skip. */
  mflLeague?: string;
}
export interface LiveResult {
  state: "offseason" | "idle" | "live" | "final-week" | "error";
  season?: number; week?: number;
  games: number; failedGames: number; players: number; matchups: number; mirroredLineups: number;
  delayed: boolean; errors: string[];
}

interface SbEvent { id?: string; date?: string; competitions?: { status?: { type?: { state?: string } } }[] }

/** Which scoreboard events need polling now. */
export function activeEvents(events: SbEvent[], now: number): { live: SbEvent[]; inWindow: boolean } {
  const live: SbEvent[] = [];
  let inWindow = false;
  for (const e of events) {
    const state = e.competitions?.[0]?.status?.type?.state;
    const k = e.date ? Date.parse(e.date) : NaN;
    if (state === "in") { live.push(e); inWindow = true; }
    else if (state === "post" && !isNaN(k) && now - k < AFTER_MS) { live.push(e); inWindow = true; }
    else if (state === "pre" && !isNaN(k) && k - now <= LEAD_MS) inWindow = true;   // includes late starts
  }
  return { live, inWindow };
}

/** Team totals from starters (slot rows) and current points (missing = 0). */
export function teamTotals(slots: { team_id: string; player_id: string }[], points: Map<string, number>): Map<string, number> {
  const t = new Map<string, number>();
  for (const s of slots) t.set(s.team_id, Math.round(((t.get(s.team_id) ?? 0) + (points.get(s.player_id) ?? 0)) * 100) / 100);
  return t;
}

/** MFL starters (comma lists per franchise) -> lineup_slots rows, slotted QB RB RB WR WR WR TE K DEF by our positions. */
export function mirrorSlots(season: number, week: number, starters: { team: string; mflIds: string[] }[],
  map: Map<string, string>, position: Map<string, string>): { rows: { season: number; week: number; team_id: string; slot: number; player_id: string }[]; missing: string[] } {
  const ORDER = ["QB", "RB", "RB", "WR", "WR", "WR", "TE", "K", "DEF"];
  const rows: { season: number; week: number; team_id: string; slot: number; player_id: string }[] = [], missing: string[] = [];
  for (const s of starters) {
    const used = ORDER.map(() => false);
    for (const m of s.mflIds) {
      const pid = map.get(m);
      if (!pid) { missing.push(`${s.team}:${m}`); continue; }
      const pos = pid.startsWith("DEF:") ? "DEF" : position.get(pid);
      const i = ORDER.findIndex((p, k) => p === pos && !used[k]);
      if (i < 0) { missing.push(`${s.team}:${m}`); continue; }
      used[i] = true;
      rows.push({ season, week, team_id: s.team, slot: i, player_id: pid });
    }
  }
  return { rows, missing };
}

export async function runLive(deps: LiveDeps): Promise<LiveResult> {
  const now = deps.now ?? Date.now, log = deps.log ?? (() => {});
  const res: LiveResult = { state: "idle", games: 0, failedGames: 0, players: 0, matchups: 0, mirroredLineups: 0, delayed: false, errors: [] };
  const getJson = async <T>(u: string, init?: RequestInit): Promise<T> => {
    const r = await deps.fetch(u, init);
    if (!r.ok) throw new Error(`${u.replace(/\?.*$/, "")}: HTTP ${r.status}`);
    return r.json() as Promise<T>;
  };
  const rest = (path: string, init: RequestInit = {}) =>
    getJson<unknown>(sbBase(deps.sb) + path, { ...init, headers: sbHeaders(deps.sb, (init.headers as Record<string, string>) ?? {}) });
  const write = async (path: string, method: string, body: unknown, prefer: string) => {
    const r = await deps.fetch(sbBase(deps.sb) + path, { method, headers: sbHeaders(deps.sb, { Prefer: prefer }), body: body == null ? null : JSON.stringify(body) });
    if (!r.ok) throw new Error(`${path.replace(/\?.*$/, "")} ${method}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  };

  try {
    const sb = await getJson<{ season?: { year?: number; type?: number }; week?: { number?: number }; events?: SbEvent[] }>(`${SITE}/scoreboard`);
    if (sb.season?.type !== 2 || !sb.season.year || !sb.week?.number) return { ...res, state: "offseason" };
    const season = sb.season.year, week = sb.week.number;
    Object.assign(res, { season, week });
    const { live, inWindow } = activeEvents(sb.events ?? [], now());
    if (!inWindow) return res;

    const sw = await rest(`score_weeks?season=eq.${season}&week=eq.${week}&select=status`) as { status: string }[];
    if (sw[0] && sw[0].status !== "live") return { ...res, state: "final-week" };
    res.state = "live";

    // Crosswalk from our players table (ESPN ID -> nflverse ID); never name-matched.
    const pl: { id: string; espn_id: string | null; name: string; position: string; nfl_team: string | null }[] = [];
    for (let from = 0; ; from += 1000) {
      const page = await rest(`nfl_players?select=id,espn_id,name,position,nfl_team&id=not.like.DEF:*`, { headers: { Range: `${from}-${from + 999}` } }) as typeof pl;
      pl.push(...page);
      if (page.length < 1000) break;
    }
    const cw = crosswalkFromRows(pl.map(p => ({ gsis_id: p.id, espn_id: p.espn_id ?? "", display_name: p.name, position: p.position, latest_team: p.nfl_team ?? "" })));

    const games: GameData[] = [], unmatched: UnmatchedPlayer[] = [];
    for (const e of live) {
      try {
        const summary = await getJson<EspnSummary>(`${SITE}/summary?event=${e.id}`);
        const plays: EspnPlay[] = [];
        for (let page = 1; ; page++) {
          const p = await getJson<{ items?: EspnPlay[]; pageCount?: number }>(`${CORE}/events/${e.id}/competitions/${e.id}/plays?limit=1000&page=${page}`);
          if (!Array.isArray(p.items)) throw new Error("core plays: no items array");
          plays.push(...p.items);
          if (!p.pageCount || page >= p.pageCount) break;
        }
        const g = gameFromEspn(summary, plays);
        g.season ||= season; g.week ||= week;
        const c = toCanonical(g, cw);
        unmatched.push(...c.unmatched);
        games.push(c.game);
      } catch (err) {
        res.failedGames++;
        res.errors.push(`game ${e.id}: ${(err as Error).message}`);
      }
    }
    res.games = games.length;
    res.delayed = res.failedGames > 0;
    const at = new Date(now()).toISOString();
    const snap = scoreWeek(games, { season, week, source: "live", cw, computedAt: at, unmatched });

    const known = new Set(pl.map(p => p.id));
    const rows = [
      ...Object.values(snap.players).map(p => ({ id: p.key.replace(/^nflverse:/, ""), p })).filter(x => known.has(x.id))
        .map(({ id, p }) => ({ season, week, player_id: id, game_key: p.gameKey, points: p.points, stats: p.stats, source: "live", overridden: false, updated_at: at })),
      ...Object.values(snap.defenses).map(d => ({ season, week, player_id: `DEF:${d.team}`, game_key: d.gameKey, points: d.points, stats: d.stats, source: "live", overridden: false, updated_at: at }))
    ];
    if (rows.length) await write(`player_scores?on_conflict=season,week,player_id`, "POST", rows, "resolution=merge-duplicates,return=minimal");
    res.players = rows.length;
    await write(`score_weeks?on_conflict=season,week`, "POST", [{ season, week, status: "live", live_delayed: res.delayed, updated_at: at }], "resolution=merge-duplicates,return=minimal");
    if (unmatched.length) {
      const seen = new Map(unmatched.map(u => [u.providerId, u]));
      await write(`review_queue?on_conflict=provider,provider_id`, "POST", [...seen.values()].map(u => ({
        provider: "espn", provider_id: u.providerId, name: u.name, team: u.team ?? null, first_week: week,
        reason: "ESPN athlete with no nflverse match: not credited until reviewed", status: "open", last_seen: at })), "resolution=merge-duplicates,return=minimal");
    }

    // TEMPORARY 2026: mirror MFL's current-week starters (lineups are set on MFL this season).
    if (deps.mflLeague) {
      try {
        const wr = await getJson<{ weeklyResults?: { matchup?: unknown } }>(`${MFL}/${season}/export?TYPE=weeklyResults&L=${deps.mflLeague}&W=${week}&JSON=1`);
        const fr = ([] as { franchise: { id: string; starters?: string }[] }[]).concat((wr.weeklyResults?.matchup ?? []) as never).flatMap(m => m.franchise);
        const starters = fr.map(f => ({ team: f.id, mflIds: (f.starters ?? "").split(",").map(s => s.trim()).filter(Boolean) })).filter(s => s.mflIds.length);
        if (starters.length) {
          const map = new Map((await rest(`mfl_player_map?select=mfl_id,player_id`) as { mfl_id: string; player_id: string }[]).map(r => [r.mfl_id, r.player_id]));
          const { rows: slots, missing } = mirrorSlots(season, week, starters, map, new Map(pl.map(p => [p.id, p.position])));
          if (missing.length) res.errors.push(`MFL starters not mapped: ${missing.join(", ")}`);
          await write(`lineup_slots?season=eq.${season}&week=eq.${week}&team_id=in.(${starters.map(s => `"${s.team}"`).join(",")})`, "DELETE", null, "return=minimal");
          if (slots.length) await write(`lineup_slots`, "POST", slots, "return=minimal");
          res.mirroredLineups = starters.length;
        }
      } catch (err) { res.errors.push(`MFL lineups: ${(err as Error).message}`); }   // keep last mirrored lineups
    }

    // Matchup totals from starters x current points.
    const slots = await rest(`lineup_slots?season=eq.${season}&week=eq.${week}&select=team_id,player_id`) as { team_id: string; player_id: string }[];
    const pts = await rest(`player_scores?season=eq.${season}&week=eq.${week}&select=player_id,points&limit=2000`) as { player_id: string; points: number }[];
    const totals = teamTotals(slots, new Map(pts.map(p => [p.player_id, Number(p.points)])));
    const ms = await rest(`matchups?season=eq.${season}&week=eq.${week}&select=home_team,away_team,is_playoff`) as { home_team: string; away_team: string; is_playoff: boolean }[];
    const upd = ms.map(m => ({ season, week, home_team: m.home_team, away_team: m.away_team, is_playoff: m.is_playoff,
      home_score: totals.get(m.home_team) ?? 0, away_score: totals.get(m.away_team) ?? 0 }));
    if (upd.length) await write(`matchups?on_conflict=season,week,home_team`, "POST", upd, "resolution=merge-duplicates,return=minimal");
    res.matchups = upd.length;
    log(`live ${season} wk ${week}: ${res.games} games (${res.failedGames} failed), ${res.players} players, ${res.matchups} matchups${res.delayed ? " DELAYED" : ""}`);
    return res;
  } catch (err) {
    // Never throw: mark the week delayed if we can, keep the last good numbers.
    res.errors.push((err as Error).message);
    res.delayed = true;
    if (res.state === "live" && res.season) {
      try { await write(`score_weeks?on_conflict=season,week`, "POST", [{ season: res.season, week: res.week, status: "live", live_delayed: true, updated_at: new Date(now()).toISOString() }], "resolution=merge-duplicates,return=minimal"); } catch { /* ignore */ }
    }
    if (res.state !== "live") res.state = "error";
    log(`live scoring error: ${(err as Error).message}`);
    return res;
  }
}

