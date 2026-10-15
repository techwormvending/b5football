/* Nightly finalization. nflverse is the system of record: each run pulls
   nflverse, rescores every week that isn't locked, overwrites the live
   numbers, and logs every live-vs-final difference (and every later stat
   correction) for the commissioner.

   Week lifecycle:
     live            no nflverse numbers yet; matchups show live (ESPN) scores
     pending_review  nflverse numbers in; matchups show them; awaiting the commissioner
     final           locked: confirmed by the commissioner, or auto-finalized
                     (default Tuesday 11 PM ET after the week's last game, configurable)
   Re-runs keep picking up NFL stat corrections until the week is final.
   The commissioner can confirm (only once every game is in, unless forced)
   or reopen a week; both are written to the audit log. */

import type { Crosswalk } from "../ingest/crosswalk.ts";
import type { FinalStatsSource } from "../ingest/types.ts";
import { diffSnapshots, gameKey, scoreWeek, type DiffEntry, type WeekSnapshot } from "./scores.ts";
import type { ScoreStore, WeekRecord, WeekStatus } from "./store.ts";
import { applyOverrides, targetKey, type Override, type ScoredWeek } from "./overrides.ts";

export interface FinalizeConfig {
  autoFinalize: {
    enabled: boolean;
    /** 0 = Sunday ... 6 = Saturday, US Eastern. */
    weekday: number;
    /** Hour of day, US Eastern (0-23). */
    hour: number;
  };
}
export const DEFAULT_FINALIZE: FinalizeConfig = { autoFinalize: { enabled: true, weekday: 2, hour: 23 } };

const ET = "America/New_York";

/** Wall-clock time in US Eastern -> UTC ms (handles daylight saving). */
export function etToUtc(y: number, m: number, d: number, h: number): number {
  for (const offset of [4, 5]) {
    const t = Date.UTC(y, m - 1, d, h + offset);
    const hh = Number(new Intl.DateTimeFormat("en-US", { timeZone: ET, hour: "numeric", hourCycle: "h23" }).format(new Date(t)));
    if (hh === h) return t;
  }
  return Date.UTC(y, m - 1, d, h + 5);
}

/** First `weekday` at `hour` US Eastern strictly after `afterMs`. */
export function nextEasternTime(afterMs: number, weekday: number, hour: number): number {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: ET, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(afterMs)).split("-").map(Number);
  const [y, m, d] = parts as [number, number, number];
  for (let i = 0; i < 8; i++) {
    const day = new Date(Date.UTC(y, m - 1, d + i));
    if (day.getUTCDay() !== weekday) continue;
    const t = etToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hour);
    if (t > afterMs) return t;
  }
  throw new Error("unreachable");
}

function restrict(s: WeekSnapshot | undefined, keys: Set<string>): WeekSnapshot | undefined {
  if (!s) return undefined;
  const pick = <T extends { gameKey: string }>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).filter(([, v]) => keys.has(v.gameKey)));
  return { ...s, games: s.games.filter(g => keys.has(g.gameKey)), players: pick(s.players), defenses: pick(s.defenses) };
}

export interface FinalizeResult {
  season: number;
  week: number;
  action: "skipped_locked" | "no_data" | "updated" | "auto_finalized" | "error";
  status?: WeekStatus;
  liveVsFinal: number;
  corrections: number;
  missingGames: string[];
  message?: string;
}

export interface FinalizerDeps {
  final: FinalStatsSource;
  crosswalk: Crosswalk;
  store: ScoreStore;
  now?: () => number;
  log?: (msg: string) => void;
}

export function createFinalizer(deps: FinalizerDeps, config: Partial<FinalizeConfig> = {}) {
  const cfg: FinalizeConfig = { ...DEFAULT_FINALIZE, ...config, autoFinalize: { ...DEFAULT_FINALIZE.autoFinalize, ...config.autoFinalize } };
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const blank = (season: number, week: number): WeekRecord => ({ season, week, status: "live", missingGames: [], diffLog: [], updatedAt: new Date(now()).toISOString() });

  async function finalizeWeek(season: number, week: number): Promise<FinalizeResult> {
    const base = { season, week, liveVsFinal: 0, corrections: 0, missingGames: [] as string[] };
    const rec = (await deps.store.getWeek(season, week)) ?? blank(season, week);
    if (rec.status === "final") return { ...base, action: "skipped_locked", status: "final" };

    let games;
    try { games = await deps.final.week(season, week); }
    catch (err) { return { ...base, action: "error", status: rec.status, message: `nflverse: ${(err as Error).message}` }; }
    if (!games.length) return { ...base, action: "no_data", status: rec.status };

    const at = new Date(now()).toISOString();
    const live = await deps.store.getLive(season, week);
    const finalSnap = scoreWeek(games, { season, week, source: "final", cw: deps.crosswalk, computedAt: at });

    // Games newly in nflverse are compared with the live numbers; games already finalized
    // earlier are compared with the previous final (= NFL stat corrections).
    const nowKeys = new Set(games.map(gameKey));
    const before = new Set((rec.final?.games ?? []).map(g => g.gameKey));
    const fresh = new Set([...nowKeys].filter(k => !before.has(k)));
    const seen = new Set([...nowKeys].filter(k => before.has(k)));
    // With no live numbers for these games there is nothing to compare: log a note instead of
    // listing every player as a "difference".
    const liveHas = new Set((live?.games ?? []).filter(g => g.status !== "scheduled").map(g => g.gameKey));
    const comparable = new Set([...fresh].filter(k => liveHas.has(k)));
    const unrecorded = [...fresh].filter(k => !liveHas.has(k));
    const liveVsFinal: DiffEntry[] = comparable.size ? diffSnapshots(restrict(live, comparable), restrict(finalSnap, comparable)!) : [];
    const corrections: DiffEntry[] = seen.size ? diffSnapshots(restrict(rec.final, seen), restrict(finalSnap, seen)!) : [];
    // Flag changes under an active override: the commissioner may want to revisit it.
    const overridden = new Map<string, string[]>();
    for (const o of (await deps.store.listOverrides(season, week)).filter(x => x.active)) overridden.set(targetKey(o.target), [...(overridden.get(targetKey(o.target)) ?? []), o.id]);
    for (const e of [...liveVsFinal, ...corrections]) { const ids = overridden.get(e.key); if (ids) e.overriddenBy = ids; }
    if (fresh.size) rec.diffLog.push({ at, kind: "live_vs_final", entries: liveVsFinal,   // logged even when empty: proof it was checked
      ...(unrecorded.length ? { note: `no live numbers were recorded for ${unrecorded.join(", ")}` } : {}) });
    if (corrections.length) rec.diffLog.push({ at, kind: "correction", entries: corrections });

    // Schedule = what the live poller saw (ESPN lists every game of the week).
    const missing = (live?.games ?? []).map(g => g.gameKey).filter(k => !nowKeys.has(k));
    // Last game of the week: live kickoff times, else nflverse game dates (noon ET as a stand-in).
    let kickoffs = (live?.games ?? []).map(g => g.kickoff).filter((k): k is string => !!k).map(Date.parse);
    if (!kickoffs.length) kickoffs = finalSnap.games.map(g => g.gameDate).filter((d): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d))
      .map(d => { const [y, m, dd] = d.split("-").map(Number) as [number, number, number]; return etToUtc(y, m, dd, 12); });
    rec.final = finalSnap;
    rec.missingGames = missing;
    rec.status = "pending_review";
    if (kickoffs.length) rec.autoFinalizeAt = new Date(nextEasternTime(Math.max(...kickoffs), cfg.autoFinalize.weekday, cfg.autoFinalize.hour)).toISOString();
    rec.updatedAt = at;

    let action: FinalizeResult["action"] = "updated";
    if (cfg.autoFinalize.enabled && rec.autoFinalizeAt && now() >= Date.parse(rec.autoFinalizeAt) && !missing.length) {
      rec.status = "final"; rec.finalizedAt = at; rec.finalizedBy = "auto";
      action = "auto_finalized";
      await deps.store.audit({ at, actor: "system", action: "auto_finalize_week", season, week, details: { autoFinalizeAt: rec.autoFinalizeAt } });
    }
    await deps.store.putWeek(rec);
    log(`${season} wk ${week}: ${action}, ${liveVsFinal.length} live-vs-final diffs, ${corrections.length} corrections${missing.length ? `, missing ${missing.join(" ")}` : ""}`);
    return { season, week, action, status: rec.status, liveVsFinal: liveVsFinal.length, corrections: corrections.length, missingGames: missing };
  }

  /** Nightly job: every week from 1 through `throughWeek` that isn't locked. */
  async function runNightly(season: number, throughWeek: number): Promise<FinalizeResult[]> {
    const out: FinalizeResult[] = [];
    for (let w = 1; w <= throughWeek; w++) out.push(await finalizeWeek(season, w));
    return out;
  }

  async function confirmWeek(season: number, week: number, actor: string, opts: { force?: boolean } = {}): Promise<WeekRecord> {
    const rec = await deps.store.getWeek(season, week);
    if (!rec?.final) throw new Error(`Week ${week} has no final (nflverse) numbers yet.`);
    if (rec.status === "final") throw new Error(`Week ${week} is already final.`);
    if (rec.missingGames.length && !opts.force) throw new Error(`Week ${week} is missing games in nflverse: ${rec.missingGames.join(", ")}. Wait for the next nightly run, or confirm with force.`);
    const at = new Date(now()).toISOString();
    rec.status = "final"; rec.finalizedAt = at; rec.finalizedBy = actor; rec.updatedAt = at;
    await deps.store.putWeek(rec);
    await deps.store.audit({ at, actor, action: "confirm_week", season, week, details: { forced: !!opts.force, missingGames: rec.missingGames } });
    return rec;
  }

  async function reopenWeek(season: number, week: number, actor: string, reason: string): Promise<WeekRecord> {
    const rec = await deps.store.getWeek(season, week);
    if (!rec || rec.status !== "final") throw new Error(`Week ${week} isn't final.`);
    if (!reason.trim()) throw new Error("A reason is required to reopen a week.");
    const at = new Date(now()).toISOString();
    rec.status = "pending_review"; delete rec.finalizedAt; delete rec.finalizedBy; rec.updatedAt = at;
    // Push auto-finalize out so a reopened week isn't instantly re-locked by the next run.
    if (rec.autoFinalizeAt && Date.parse(rec.autoFinalizeAt) <= now()) rec.autoFinalizeAt = new Date(nextEasternTime(now(), cfg.autoFinalize.weekday, cfg.autoFinalize.hour)).toISOString();
    await deps.store.putWeek(rec);
    await deps.store.audit({ at, actor, action: "reopen_week", season, week, details: { reason } });
    return rec;
  }

  return { finalizeWeek, runNightly, confirmWeek, reopenWeek };
}

/** What matchups should show for a week: final numbers once nflverse has them, otherwise live,
    with the commissioner's active overrides applied on top either way. */
export async function weekScores(store: ScoreStore, season: number, week: number, cw: Crosswalk): Promise<{ status: WeekStatus; snapshot?: ScoredWeek; liveDelayed: boolean; overrides: Override[] }> {
  const overrides = (await store.listOverrides(season, week)).filter(o => o.active);
  const rec = await store.getWeek(season, week);
  const base = rec?.final ?? (await store.getLive(season, week));
  return {
    status: rec?.final ? rec.status : "live",
    ...(base ? { snapshot: applyOverrides(base, overrides, cw) } : {}),
    liveDelayed: !rec?.final && !!base?.delayed,
    overrides
  };
}
