/* Live polling scheduler. Polls ESPN only during live game windows (a game in
   progress, or a kickoff within `leadMinutes`), every 30-60 s with jitter.
   Backs off on errors, keeps the last good numbers, and never throws: a bad
   tick is logged and the loop carries on.

   Outside live windows it sleeps until shortly before the next kickoff (or
   `idleCheckMinutes`, whichever is sooner), so off-hours cost one scoreboard
   request every few hours. */

import { toCanonical, type Crosswalk, type UnmatchedPlayer } from "../ingest/crosswalk.ts";
import type { GameData, LiveStatsSource } from "../ingest/types.ts";
import { mergeLive, scoreWeek } from "./scores.ts";
import type { ScoreStore } from "./store.ts";

export interface PollerConfig {
  minIntervalSec: number;    // 30
  maxIntervalSec: number;    // 60
  leadMinutes: number;       // start polling this long before a kickoff
  idleCheckMinutes: number;  // longest sleep when nothing is live
  maxBackoffSec: number;     // cap on error backoff
}
export const DEFAULT_POLLER: PollerConfig = { minIntervalSec: 30, maxIntervalSec: 60, leadMinutes: 10, idleCheckMinutes: 360, maxBackoffSec: 300 };

export type PollState = "live" | "idle" | "backoff" | "offseason";

export interface TickResult {
  state: PollState;
  delayMs: number;
  season?: number;
  week?: number;
  delayed: boolean;
  wrote: boolean;
  newReviewItems: number;
  errors: string[];
}

/** Pure: how long to wait before the next poll. */
export function planNextPoll(games: Pick<GameData, "status" | "kickoff">[], now: number, failures: number, cfg: PollerConfig, random: () => number): { state: PollState; delayMs: number } {
  const lead = cfg.leadMinutes * 60_000;
  const live = games.some(g => g.status === "in_progress" || (g.status === "scheduled" && g.kickoff && Date.parse(g.kickoff) - lead <= now));
  if (live) {
    const base = (cfg.minIntervalSec + random() * (cfg.maxIntervalSec - cfg.minIntervalSec)) * 1000;
    if (failures > 0) {
      const backoff = Math.min(cfg.maxBackoffSec * 1000, cfg.minIntervalSec * 1000 * 2 ** failures);
      return { state: "backoff", delayMs: Math.max(base, backoff) };
    }
    return { state: "live", delayMs: base };
  }
  const upcoming = games.filter(g => g.status === "scheduled" && g.kickoff).map(g => Date.parse(g.kickoff!) - lead).filter(t => t > now);
  const idleMax = cfg.idleCheckMinutes * 60_000;
  const untilNext = upcoming.length ? Math.min(...upcoming) - now : idleMax;
  return { state: "idle", delayMs: Math.max(cfg.minIntervalSec * 1000, Math.min(idleMax, untilNext)) };
}

export interface PollerDeps {
  live: LiveStatsSource;
  crosswalk: Crosswalk;
  store: ScoreStore;
  now?: () => number;
  random?: () => number;
  log?: (msg: string) => void;
}

export function createLivePoller(deps: PollerDeps, config: Partial<PollerConfig> = {}) {
  const cfg = { ...DEFAULT_POLLER, ...config };
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const log = deps.log ?? (() => {});
  let failures = 0;
  let lastWeek: { season: number; week: number } | undefined;
  let lastGames: GameData[] = [];

  async function tick(): Promise<TickResult> {
    const errors: string[] = [];
    try {
      const cur = (await deps.live.currentWeek()) ?? lastWeek;
      if (!cur) {
        return { state: "offseason", delayMs: cfg.idleCheckMinutes * 60_000, delayed: false, wrote: false, newReviewItems: 0, errors: ["no current regular-season week"] };
      }
      lastWeek = cur;
      const lw = await deps.live.week(cur.season, cur.week);
      errors.push(...lw.errors);

      const unmatched: UnmatchedPlayer[] = [];
      const games = lw.games.map(g => { const r = toCanonical(g, deps.crosswalk); unmatched.push(...r.unmatched); return r.game; });
      const at = new Date(now()).toISOString();
      const snap = scoreWeek(games, { season: cur.season, week: cur.week, source: "live", cw: deps.crosswalk, computedAt: at, delayed: lw.delayed, errors: lw.errors, unmatched });

      // A locked (final) week is never overwritten by live numbers.
      const rec = await deps.store.getWeek(cur.season, cur.week);
      let wrote = false;
      if (rec?.status !== "final") {
        const merged = mergeLive(await deps.store.getLive(cur.season, cur.week), snap);
        await deps.store.putLive(merged);
        wrote = true;
        lastGames = games.length ? games : lastGames;
      }
      const newReviewItems = await deps.store.addReviewItems(unmatched, at);
      if (newReviewItems) log(`${newReviewItems} new player(s) flagged for commissioner review`);

      failures = lw.delayed ? failures + 1 : 0;
      if (lw.delayed) log(`live scoring delayed: ${lw.errors.join("; ")}`);
      const plan = planNextPoll(games.length ? games : lastGames, now(), failures, cfg, random);
      return { ...plan, season: cur.season, week: cur.week, delayed: lw.delayed, wrote, newReviewItems, errors };
    } catch (err) {
      // Never crash the loop (e.g. store write failed). Back off and try again.
      failures++;
      const msg = (err as Error).message;
      log(`poll failed: ${msg}`);
      const plan = planNextPoll(lastGames, now(), failures, cfg, random);
      return { state: plan.state === "live" ? "backoff" : plan.state, delayMs: plan.state === "idle" ? plan.delayMs : Math.max(plan.delayMs, cfg.minIntervalSec * 1000), delayed: true, wrote: false, newReviewItems: 0, errors: [...errors, msg] };
    }
  }

  /** Poll forever (until `signal` aborts), sleeping between ticks as planned. */
  async function run(signal?: AbortSignal, sleep = (ms: number) => new Promise<void>(r => { const t = setTimeout(r, ms); signal?.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true }); })) {
    while (!signal?.aborted) {
      const r = await tick();
      log(`${r.state}${r.week ? ` ${r.season} wk ${r.week}` : ""}${r.delayed ? " (DELAYED)" : ""}; next poll in ${Math.round(r.delayMs / 1000)} s`);
      await sleep(r.delayMs);
    }
  }

  return { tick, run, get failures() { return failures; } };
}
