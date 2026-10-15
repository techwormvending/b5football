/* Commissioner overrides. Stored separately from live and final numbers and
   applied when scores are read, so nightly re-runs (which replace the raw
   numbers) never erase them. Two kinds:
     stats   replace specific stat-line fields (null removes a field); points
             are recomputed by the scoring engine
     points  pin the total, regardless of stats
   A points override beats a stats override on the same target. Removing an
   override deactivates it (kept for history); every add/remove is audited. */

import crypto from "node:crypto";
import { scoreStatLine } from "../scoring/engine.ts";
import type { Position, StatLine } from "../scoring/types.ts";
import type { Crosswalk } from "../ingest/crosswalk.ts";
import { positionOf, type DefenseScore, type PlayerScore, type WeekSnapshot } from "./scores.ts";
import type { ScoreStore } from "./store.ts";

export type OverrideTarget = { kind: "player"; key: string } | { kind: "defense"; team: string };

export interface Override {
  id: string;
  season: number;
  week: number;
  target: OverrideTarget;
  type: "stats" | "points";
  /** stats: fields to replace; a null value removes the field. */
  stats?: Partial<Record<keyof StatLine, number | number[] | null>>;
  points?: number;
  reason: string;
  by: string;
  at: string;
  active: boolean;
  removedAt?: string;
  removedBy?: string;
  removedReason?: string;
}

/** On an overridden score: what the source said, and which overrides changed it. */
export interface OverrideMark { ids: string[]; type: "stats" | "points"; source: { points: number | null; stats: StatLine | null } }

export type MarkedPlayer = PlayerScore & { override?: OverrideMark };
export type MarkedDefense = DefenseScore & { override?: OverrideMark };
export type ScoredWeek = Omit<WeekSnapshot, "players" | "defenses"> & { players: Record<string, MarkedPlayer>; defenses: Record<string, MarkedDefense> };

const LIST_FIELDS = new Set(["passTdLengths", "rushTdLengths", "recTdLengths", "fgMadeLengths"]);
const NUM_FIELDS = new Set([
  "passYds", "rushYds", "recYds", "receptions", "interceptionsThrown", "twoPtPasses", "twoPtRushes", "twoPtReceptions",
  "puntReturnTds", "kickReturnTds", "intReturnTds", "defFumbleRecoveryTds", "offFumbleRecoveryTds", "extraPoints",
  "interceptions", "fumbleRecoveries", "sacks", "safeties", "blockedFgs", "blockedFgTds", "blockedPunts", "blockedPuntTds",
  "defTwoPtReturns", "passYdsAllowed", "rushYdsAllowed", "offensiveTdsAllowed", "opponentPoints"
]);

export const targetKey = (t: OverrideTarget) => (t.kind === "player" ? t.key : `DEF:${t.team}`);

/** Throws with a readable message if the override is malformed. */
export function validateOverride(o: Pick<Override, "target" | "type" | "stats" | "points" | "reason">): void {
  if (!o.reason?.trim()) throw new Error("A reason is required.");
  if (o.target.kind === "player" && !/^[a-z]+:.+/.test(o.target.key)) throw new Error(`Bad player key "${o.target.key}".`);
  if (o.target.kind === "defense" && !/^[A-Z]{2,3}$/.test(o.target.team)) throw new Error(`Bad team "${o.target.team}".`);
  if (o.type === "points") {
    if (typeof o.points !== "number" || !Number.isFinite(o.points)) throw new Error("Points override needs a number.");
    if (Math.abs(o.points) > 200) throw new Error("Points override over 200 looks like a typo.");
    return;
  }
  const entries = Object.entries(o.stats ?? {});
  if (!entries.length) throw new Error("Stats override needs at least one field.");
  for (const [k, v] of entries) {
    if (LIST_FIELDS.has(k)) {
      if (v !== null && !(Array.isArray(v) && v.every(x => Number.isInteger(x) && x >= 0 && x <= 110))) throw new Error(`${k} must be a list of yardages 0-110, e.g. [52, 7].`);
    } else if (NUM_FIELDS.has(k)) {
      if (v !== null && !(typeof v === "number" && Number.isFinite(v))) throw new Error(`${k} must be a number.`);
    } else throw new Error(`Unknown stat "${k}". Valid: ${[...NUM_FIELDS, ...LIST_FIELDS].join(", ")}.`);
  }
}

function patch(stats: StatLine, p: NonNullable<Override["stats"]>): StatLine {
  const out: Record<string, unknown> = { ...stats };
  for (const [k, v] of Object.entries(p)) { if (v === null) delete out[k]; else out[k] = v; }
  return out as StatLine;
}

/** Apply active overrides for this week to a snapshot (live or final). Pure. */
export function applyOverrides(snap: WeekSnapshot, overrides: Override[], cw: Crosswalk): ScoredWeek {
  const active = overrides.filter(o => o.active && o.season === snap.season && o.week === snap.week).sort((a, b) => a.at.localeCompare(b.at));
  const out: ScoredWeek = { ...snap, players: { ...snap.players }, defenses: { ...snap.defenses } };
  const byTarget = new Map<string, Override[]>();
  for (const o of active) byTarget.set(targetKey(o.target), [...(byTarget.get(targetKey(o.target)) ?? []), o]);

  for (const [key, list] of byTarget) {
    const isDef = key.startsWith("DEF:");
    const src = isDef ? snap.defenses[key.slice(4)] : snap.players[key];
    const pointsO = list.filter(o => o.type === "points").at(-1);           // latest points override wins
    const statsO = list.filter(o => o.type === "stats");
    const stats = statsO.reduce((s, o) => patch(s, o.stats!), (src?.stats ?? {}) as StatLine);
    const position: Position | undefined = isDef ? "DEF" : (src as PlayerScore | undefined)?.position ?? positionOf(cw, key);
    if (!position) { out.warnings = [...out.warnings, `override ${list.map(o => o.id).join(",")}: no fantasy position for ${key}; not applied`]; continue; }

    let points: number;
    if (pointsO) points = pointsO.points!;
    else {
      try { points = scoreStatLine(position, stats).total; }
      catch (err) { out.warnings = [...out.warnings, `override on ${key}: ${(err as Error).message}; not applied`]; continue; }
    }
    const mark: OverrideMark = {
      ids: (pointsO ? [pointsO] : statsO).map(o => o.id),
      type: pointsO ? "points" : "stats",
      source: { points: src?.points ?? null, stats: src?.stats ?? null }
    };
    if (isDef) {
      const team = key.slice(4);
      const base: DefenseScore = (src as DefenseScore | undefined) ?? { team, gameKey: "", points: 0, stats: {} };
      out.defenses[team] = { ...base, stats, points, override: mark };
    } else {
      // A player the source doesn't have (e.g. flagged as unmatched) can still be credited by override.
      const base: PlayerScore = (src as PlayerScore | undefined)
        ?? { key, name: cw.player(key.split(":")[1] ?? "")?.name ?? key, position, gameKey: "", points: 0, stats: {} };
      out.players[key] = { ...base, stats, points, override: mark };
    }
  }
  return out;
}

/** Commissioner operations on overrides (validated, stored, audited). */
export function createOverrides(deps: { store: ScoreStore; crosswalk: Crosswalk; now?: () => number }) {
  const now = deps.now ?? Date.now;

  async function add(input: Omit<Override, "id" | "at" | "active">): Promise<Override> {
    validateOverride(input);
    if (input.target.kind === "player" && input.target.key.startsWith("nflverse:") && !deps.crosswalk.player(input.target.key.slice(9))) {
      throw new Error(`Unknown player ${input.target.key}.`);
    }
    const at = new Date(now()).toISOString();
    const o: Override = { ...input, id: crypto.randomBytes(4).toString("hex"), at, active: true };
    const list = await deps.store.listOverrides(o.season, o.week);
    await deps.store.saveOverrides(o.season, o.week, [...list, o]);
    const rec = await deps.store.getWeek(o.season, o.week);
    await deps.store.audit({ at, actor: o.by, action: "add_override", season: o.season, week: o.week,
      details: { id: o.id, target: targetKey(o.target), type: o.type, ...(o.stats ? { stats: o.stats } : {}), ...(o.points !== undefined ? { points: o.points } : {}), reason: o.reason, weekStatus: rec?.status ?? "live" } });
    return o;
  }

  async function remove(season: number, week: number, id: string, by: string, reason: string): Promise<Override> {
    if (!reason.trim()) throw new Error("A reason is required.");
    const list = await deps.store.listOverrides(season, week);
    const o = list.find(x => x.id === id);
    if (!o) throw new Error(`No override ${id} in ${season} week ${week}.`);
    if (!o.active) throw new Error(`Override ${id} was already removed.`);
    const at = new Date(now()).toISOString();
    Object.assign(o, { active: false, removedAt: at, removedBy: by, removedReason: reason });
    await deps.store.saveOverrides(season, week, list);
    await deps.store.audit({ at, actor: by, action: "remove_override", season, week, details: { id, target: targetKey(o.target), reason } });
    return o;
  }

  return { add, remove, list: (season: number, week: number) => deps.store.listOverrides(season, week) };
}
