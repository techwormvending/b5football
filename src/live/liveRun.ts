/* One live-scoring pass. Host: Supabase Edge Function "b5-live", called every minute by
   pg_cron + pg_net, but only while an NFL game is near (the database checks nfl_games
   before calling; see migration live_scoring_cron). Stateless: everything it needs is in
   ESPN or Supabase.

   1. ESPN scoreboard. Work only if a game is IN PROGRESS, or finished within ~4.5 h of
      kickoff and its final live numbers haven't been captured yet (public.live_games).
      Otherwise it exits after that one request.
   2. If nflverse has already finalized the week (score_weeks status pending_review/final),
      live numbers never overwrite it.
   3. Each active game: ESPN summary + core plays -> GameData -> canonical player IDs
      (crosswalk from nfl_players.espn_id, fetched only for the athletes in these games)
      -> our engine. A game that fails keeps its previous numbers (only processed games
      are written).
   4. player_scores (source "live"), score_weeks (live, delayed flag), review_queue (ESPN
      athletes with no nflverse match; never guessed), live_games (finished games captured).
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
const AFTER_MS = 4.5 * 3600_000;
const IN_CHUNK = 120;   // IDs per "in.(...)" filter, keeps URLs short

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

/** Games worth polling: in progress, or finished within ~4.5 h of kickoff (final capture pending). */
export function activeEvents(events: SbEvent[], now: number): { inProgress: SbEvent[]; recentlyFinished: SbEvent[] } {
  const inProgress: SbEvent[] = [], recentlyFinished: SbEvent[] = [];
  for (const e of events) {
    const state = e.competitions?.[0]?.status?.type?.state;
    const k = e.date ? Date.parse(e.date) : NaN;
    if (state === "in") inProgress.push(e);
    else if (state === "post" && !isNaN(k) && now - k < AFTER_MS) recentlyFinished.push(e);
  }
  return { inProgress, recentlyFinished };
}

/** Every ESPN athlete ID referenced in a game (box score and scoring events). */
export function espnIds(g: GameData): string[] {
  const out = new Set<string>();
  const walk = (x: unknown) => {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    const o = x as Record<string, unknown>;
    if (o.provider === "espn" && typeof o.id === "string") out.add(o.id);
    for (const v of Object.values(o)) walk(v);
  };
  walk(g.players); walk(g.events);
  return [...out];
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

const chunks = <T>(a: T[], n: number): T[][] => { const out: T[][] = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; };
const inList = (ids: string[]) => encodeURIComponent(ids.map(i => `"${i.replace(/"/g, "")}"`).join(","));

export async function runLive(deps: LiveDeps): Promise<LiveResult> {
  const now = deps.now ?? Date.now, log = deps.log ?? (() => {});
  const res: LiveResult = { state: "idle", games: 0, failedGames: 0, players: 0, matchups: 0, mirroredLineups: 0, delayed: false, errors: [] };
  const getJson = async <T>(u: string, init?: RequestInit): Promise<T> => {
    const r = await deps.fetch(u, init);
    if (!r.ok) throw new Error(`${u.replace(/\?.*$/, "")}: HTTP ${r.status}`);
    return r.json() as Promise<T>;
  };
  const rest = <T>(path: string) => getJson<T>(sbBase(deps.sb) + path, { headers: sbHeaders(deps.sb) });
  const write = async (path: string, method: string, body: unknown, prefer: string) => {
    const r = await deps.fetch(sbBase(deps.sb) + path, { method, headers: sbHeaders(deps.sb, { Prefer: prefer }), body: body == null ? null : JSON.stringify(body) });
    if (!r.ok) throw new Error(`${path.replace(/\?.*$/, "")} ${method}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  };
  const upsert = (table: string, onConflict: string, rows: unknown[]) =>
    rows.length ? write(`${table}?on_conflict=${onConflict}`, "POST", rows, "resolution=merge-duplicates,return=minimal") : Promise.resolve();

  try {
    const sb = await getJson<{ season?: { year?: number; type?: number }; week?: { number?: number }; events?: SbEvent[] }>(`${SITE}/scoreboard`);
    if (sb.season?.type !== 2 || !sb.season.year || !sb.week?.number) return { ...res, state: "offseason" };
    const season = sb.season.year, week = sb.week.number;
    Object.assign(res, { season, week });
    const { inProgress, recentlyFinished } = activeEvents(sb.events ?? [], now());
    if (!inProgress.length && !recentlyFinished.length) return res;           // nothing in progress: exit

    let finished = recentlyFinished;
    if (finished.length) {
      const done = new Set((await rest<{ event_id: string }[]>(`live_games?event_id=in.(${inList(finished.map(e => e.id!))})&select=event_id`)).map(r => r.event_id));
      finished = finished.filter(e => !done.has(e.id!));
    }
    const todo = [...inProgress, ...finished];
    if (!todo.length) return res;                                             // finished games already captured

    const sw = await rest<{ status: string }[]>(`score_weeks?season=eq.${season}&week=eq.${week}&select=status`);
    if (sw[0] && sw[0].status !== "live") return { ...res, state: "final-week" };
    res.state = "live";

    const raw: { game: GameData; event: SbEvent }[] = [];
    for (const e of todo) {
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
        raw.push({ game: g, event: e });
      } catch (err) {
        res.failedGames++;
        res.errors.push(`game ${e.id}: ${(err as Error).message}`);
      }
    }

    // Crosswalk only for the athletes in these games (ESPN ID -> nflverse ID); never name-matched.
    const ids = [...new Set(raw.flatMap(r => espnIds(r.game)))];
    const pl: { id: string; espn_id: string | null; name: string; position: string; nfl_team: string | null }[] = [];
    for (const c of chunks(ids, IN_CHUNK)) pl.push(...await rest<typeof pl>(`nfl_players?espn_id=in.(${inList(c)})&select=id,espn_id,name,position,nfl_team`));
    const cw = crosswalkFromRows(pl.map(p => ({ gsis_id: p.id, espn_id: p.espn_id ?? "", display_name: p.name, position: p.position, latest_team: p.nfl_team ?? "" })));

    const games: GameData[] = [], unmatched: UnmatchedPlayer[] = [];
    for (const r of raw) { const c = toCanonical(r.game, cw); unmatched.push(...c.unmatched); games.push(c.game); }
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
    await upsert("player_scores", "season,week,player_id", rows);
    res.players = rows.length;
    await upsert("score_weeks", "season,week", [{ season, week, status: "live", live_delayed: res.delayed, updated_at: at }]);
    if (unmatched.length) {
      const seen = new Map(unmatched.map(u => [u.providerId, u]));
      await upsert("review_queue", "provider,provider_id", [...seen.values()].map(u => ({
        provider: "espn", provider_id: u.providerId, name: u.name, team: u.team ?? null, first_week: week,
        reason: "ESPN athlete with no nflverse match: not credited until reviewed", status: "open", last_seen: at })));
    }

    // TEMPORARY 2026: mirror MFL's current-week starters (lineups are set on MFL this season).
    if (deps.mflLeague) {
      try {
        const wr = await getJson<{ weeklyResults?: { matchup?: unknown } }>(`${MFL}/${season}/export?TYPE=weeklyResults&L=${deps.mflLeague}&W=${week}&JSON=1`);
        const fr = ([] as { franchise: { id: string; starters?: string }[] }[]).concat((wr.weeklyResults?.matchup ?? []) as never).flatMap(m => m.franchise);
        const starters = fr.map(f => ({ team: f.id, mflIds: (f.starters ?? "").split(",").map(s => s.trim()).filter(Boolean) })).filter(s => s.mflIds.length);
        if (starters.length) {
          const all = [...new Set(starters.flatMap(s => s.mflIds))];
          const map = new Map<string, string>();
          for (const c of chunks(all, IN_CHUNK)) for (const r of await rest<{ mfl_id: string; player_id: string }[]>(`mfl_player_map?mfl_id=in.(${inList(c)})&select=mfl_id,player_id`)) map.set(r.mfl_id, r.player_id);
          const pos = new Map<string, string>();
          const pids = [...new Set(map.values())].filter(p => !p.startsWith("DEF:"));
          for (const c of chunks(pids, IN_CHUNK)) for (const r of await rest<{ id: string; position: string }[]>(`nfl_players?id=in.(${inList(c)})&select=id,position`)) pos.set(r.id, r.position);
          const { rows: slots, missing } = mirrorSlots(season, week, starters, map, pos);
          if (missing.length) res.errors.push(`MFL starters not mapped: ${missing.join(", ")}`);
          await write(`lineup_slots?season=eq.${season}&week=eq.${week}&team_id=in.(${inList(starters.map(s => s.team))})`, "DELETE", null, "return=minimal");
          if (slots.length) await write(`lineup_slots`, "POST", slots, "return=minimal");
          res.mirroredLineups = starters.length;
        }
      } catch (err) { res.errors.push(`MFL lineups: ${(err as Error).message}`); }   // keep last mirrored lineups
    }

    // Matchup totals from starters x current points.
    const slots = await rest<{ team_id: string; player_id: string }[]>(`lineup_slots?season=eq.${season}&week=eq.${week}&select=team_id,player_id`);
    const pts = await rest<{ player_id: string; points: number }[]>(`player_scores?season=eq.${season}&week=eq.${week}&select=player_id,points&limit=2000`);
    const totals = teamTotals(slots, new Map(pts.map(p => [p.player_id, Number(p.points)])));
    const ms = await rest<{ home_team: string; away_team: string; is_playoff: boolean }[]>(`matchups?season=eq.${season}&week=eq.${week}&select=home_team,away_team,is_playoff`);
    await upsert("matchups", "season,week,home_team", ms.map(m => ({ season, week, home_team: m.home_team, away_team: m.away_team, is_playoff: m.is_playoff,
      home_score: totals.get(m.home_team) ?? 0, away_score: totals.get(m.away_team) ?? 0 })));
    res.matchups = ms.length;

    // Finished games whose numbers were just written won't be polled again.
    const captured = raw.filter(r => r.event.competitions?.[0]?.status?.type?.state === "post").map(r => ({ event_id: r.event.id, season, week, captured_at: at }));
    await upsert("live_games", "event_id", captured);

    log(`live ${season} wk ${week}: ${res.games} games (${res.failedGames} failed), ${res.players} players, ${res.matchups} matchups${res.delayed ? " DELAYED" : ""}`);
    return res;
  } catch (err) {
    // Never throw: mark the week delayed if we can, keep the last good numbers.
    res.errors.push((err as Error).message);
    res.delayed = true;
    if (res.state === "live" && res.season) {
      try { await upsert("score_weeks", "season,week", [{ season: res.season, week: res.week, status: "live", live_delayed: true, updated_at: new Date(now()).toISOString() }]); } catch { /* ignore */ }
    }
    if (res.state !== "live") res.state = "error";
    log(`live scoring error: ${(err as Error).message}`);
    return res;
  }
}
