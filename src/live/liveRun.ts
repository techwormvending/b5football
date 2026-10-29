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
   4. nfl_games (score, quarter, clock), then player_scores (source "live", with the engine's
      points breakdown; a trigger logs each change as a scoring play in score_events),
      score_weeks (live, delayed flag; browsers on #live subscribe to it via Realtime),
      review_queue (ESPN athletes with no nflverse match; never guessed), live_games
      (finished games captured).
   5. 2026 shadow season: MFL's starters into lineup_slots (until each player's kickoff) and
      our totals vs MFL's live scoring (live_compare). TEMPORARY; see mflLive.ts.
   6. matchups: each team's total = its starters' current points.
   Never throws. Everything goes through the injected fetch. */

import { gameFromEspn, type EspnPlay, type EspnSummary } from "../ingest/espn.ts";
import { crosswalkFromRows, toCanonical, type UnmatchedPlayer } from "../ingest/crosswalk.ts";
import { scoreWeek } from "../league/scores.ts";
import { sbBase, sbHeaders, type SbConfig } from "../league/supabaseRest.ts";
import { rowsFromScoreboard, upsertGameInfo } from "../league/gameInfoSync.ts";
import type { EspnEvent } from "../league/gameInfo.ts";
import type { GameData } from "../ingest/types.ts";
import { refreshPayouts } from "../league/payoutsSync.ts";
import { syncMflPools } from "../league/mflPools.ts";
import { team as canon } from "../ingest/teams.ts";
import { breakdown } from "../scoring/explain.ts";
import { syncMflLive } from "./mflLive.ts";
export { mirrorSlots } from "./mflLive.ts";

const SITE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";
const CORE = "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl";
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

interface SbSituation { possession?: string; isRedZone?: boolean; downDistanceText?: string; possessionText?: string; down?: number }
interface SbCompetition { status?: { period?: number; displayClock?: string; type?: { state?: string; name?: string; shortDetail?: string } };
  competitors?: { homeAway?: string; score?: string; team?: { id?: string; abbreviation?: string } }[]; situation?: SbSituation }
interface SbEvent { id?: string; date?: string; competitions?: SbCompetition[] }

/** Who has the ball, red zone, and "2nd & 6 at KC 14" for an in-progress game (ESPN's situation block).
    Nobody has the ball at halftime, at the end of a quarter, or when ESPN gives no possession. The red
    zone is ESPN's flag, or the ball inside the opponent's 20 by the ball position ("KC 14", KC defending). */
export function gameSituation(c: SbCompetition | undefined): { possession: string | null; red_zone: boolean; down_distance: string | null } {
  const none = { possession: null, red_zone: false, down_distance: null };
  const st = c?.status?.type, sit = c?.situation;
  if (st?.state !== "in" || !sit?.possession) return none;
  if (/HALFTIME|END_PERIOD|END_OF_PERIOD/i.test(st.name ?? "") || /^(Halftime|End of)/i.test(st.shortDetail ?? "")) return none;
  const team = c?.competitors?.find(x => x.team?.id === String(sit.possession))?.team?.abbreviation;
  let possession: string;
  try { possession = canon(team ?? ""); } catch { return none; }
  const m = /^([A-Z]{2,3})\s+(\d{1,2})$/.exec(sit.possessionText ?? "");
  let side: string | null = null;
  try { side = m ? canon(m[1]!) : null; } catch { side = null; }
  const red = sit.isRedZone === true || (!!m && side !== null && side !== possession && Number(m[2]) <= 20);
  return { possession, red_zone: red, down_distance: sit.downDistanceText || null };
}

/** Live/final NFL scores and game clock from the scoreboard, as nfl_games rows (pools score from these; #live shows them). */
export function scoreboardGames(events: SbEvent[], season: number, week: number, at: string) {
  const out: { season: number; week: number; game_key: string; home: string; away: string; kickoff: string | null; status: string; home_score: number; away_score: number;
    period: number | null; clock: string | null; status_detail: string | null; possession: string | null; red_zone: boolean; down_distance: string | null; updated_at: string }[] = [];
  for (const e of events) {
    const c = e.competitions?.[0], state = c?.status?.type?.state;
    if (state !== "in" && state !== "post") continue;
    const h = c?.competitors?.find(x => x.homeAway === "home"), a = c?.competitors?.find(x => x.homeAway === "away");
    let home: string, away: string;
    try { home = canon(h?.team?.abbreviation ?? ""); away = canon(a?.team?.abbreviation ?? ""); } catch { continue; }
    out.push({ season, week, game_key: `${away}@${home}`, home, away, kickoff: e.date ? new Date(e.date).toISOString() : null,
      status: state === "post" ? "final" : "in_progress", home_score: Number(h?.score ?? 0), away_score: Number(a?.score ?? 0),
      period: c?.status?.period ?? null, clock: c?.status?.displayClock ?? null, status_detail: c?.status?.type?.shortDetail ?? null, ...gameSituation(c), updated_at: at });
  }
  return out;
}

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

const chunks = <T>(a: T[], n: number): T[][] => { const out: T[][] = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; };
const inList = (ids: string[]) => encodeURIComponent(ids.map(i => `"${i.replace(/"/g, "")}"`).join(","));

export async function runLive(deps: LiveDeps): Promise<LiveResult> {
  const now = deps.now ?? Date.now, log = deps.log ?? (() => {});
  const res: LiveResult = { state: "idle", games: 0, failedGames: 0, players: 0, matchups: 0, mirroredLineups: 0, delayed: false, errors: [] };
  // ESPN refuses (403) requests with the Edge runtime's default "Deno" User-Agent; send ours, as the Node adapter does.
  const UA = { "User-Agent": "b5-fantasy-site/0.1 (private league)" };
  const getJson = async <T>(u: string, init?: RequestInit): Promise<T> => {
    const r = await deps.fetch(u, { ...init, headers: { ...UA, ...((init?.headers as Record<string, string>) ?? {}) } });
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
        .map(({ id, p }) => ({ season, week, player_id: id, game_key: p.gameKey, points: p.points, stats: p.stats, lines: breakdown(p.position, p.stats), source: "live", overridden: false, updated_at: at })),
      ...Object.values(snap.defenses).map(d => ({ season, week, player_id: `DEF:${d.team}`, game_key: d.gameKey, points: d.points, stats: d.stats, lines: breakdown("DEF", d.stats), source: "live", overridden: false, updated_at: at }))
    ];
    // Game clock first: the scoring-play trigger on player_scores stamps each play with it.
    await upsert("nfl_games", "season,week,game_key", scoreboardGames(sb.events ?? [], season, week, at));
    // Records and betting lines for the pool's game cards, from the same scoreboard (never stops scoring).
    try { await upsertGameInfo(deps.sb, (u, i) => deps.fetch(u, i), rowsFromScoreboard((sb.events ?? []) as EspnEvent[], season, week, at)); }
    catch (err) { deps.log?.("game info: " + (err as Error).message); }
    await upsert("player_scores", "season,week,player_id", rows);
    res.players = rows.length;
    await upsert("score_weeks", "season,week", [{ season, week, status: "live", live_delayed: res.delayed, updated_at: at }]);
    if (unmatched.length) {
      const seen = new Map(unmatched.map(u => [u.providerId, u]));
      await upsert("review_queue", "provider,provider_id", [...seen.values()].map(u => ({
        provider: "espn", provider_id: u.providerId, name: u.name, team: u.team ?? null, first_week: week,
        reason: "ESPN athlete with no nflverse match: not credited until reviewed", status: "open", last_seen: at })));
    }

    // TEMPORARY 2026: MFL's starters (until each player's kickoff) and the MFL live comparison.
    if (deps.mflLeague) {
      try {
        const m = await syncMflLive({ sb: deps.sb, fetch: (u, i) => deps.fetch(u, i), league: deps.mflLeague, season, week, now: now() });
        if (m.missing.length) res.errors.push(`MFL starters not mapped: ${m.missing.join(", ")}`);
        if (m.ignored.length) res.errors.push(`MFL starters changed after kickoff (kept ours): ${m.ignored.join(", ")}`);
        res.mirroredLineups = m.teams;
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
    // Every team's live total (payouts: weekly high, guillotine, season points), then projected payouts.
    const teamIds = new Set([...totals.keys(), ...ms.flatMap(m => [m.home_team, m.away_team])]);
    await upsert("team_scores", "season,week,team_id", [...teamIds].map(t => ({ season, week, team_id: t, points: totals.get(t) ?? 0, status: "live", updated_at: at })));
    // TEMPORARY 2026: this week's MFL pool picks (Survivor, Confidence), then pools + payouts.
    if (deps.mflLeague) {
      try { await syncMflPools(deps.sb, season, deps.mflLeague, (u, i) => deps.fetch(u, i), week); }
      catch (err) { res.errors.push(`MFL pools: ${(err as Error).message}`); }
    }
    try { await refreshPayouts(deps.sb, season, (u, i) => deps.fetch(u, i), { liveWeek: week, now: now() }); }
    catch (err) { res.errors.push(`payouts: ${(err as Error).message}`); }   // scores are written; payouts catch up next pass

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
