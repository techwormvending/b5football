/* Player ID crosswalk: ESPN athlete IDs -> nflverse (GSIS) IDs, our canonical
   player ID. Built from nflverse's players.csv, which carries espn_id.
   Never guesses by name: a player without a crosswalk entry is flagged for
   commissioner review and is not credited to any league player. */

import fs from "node:fs";
import path from "node:path";
import { parseCsv } from "./csv.ts";
import type { GameData, PlayerRef, ScoringEvent } from "./types.ts";

export const CANONICAL = "nflverse";

export interface CrosswalkEntry { gsisId: string; name: string; position?: string; team?: string }

export interface Crosswalk {
  fromEspn(espnId: string): CrosswalkEntry | undefined;
  /** Any nflverse player by GSIS ID (name, position, team), with or without an ESPN ID. */
  player(gsisId: string): CrosswalkEntry | undefined;
  readonly size: number;
}

/** Rows from nflverse players.csv (needs gsis_id, espn_id, display_name, position, latest_team). */
export function crosswalkFromRows(rows: Record<string, string>[]): Crosswalk {
  const byEspn = new Map<string, CrosswalkEntry>();
  const byGsis = new Map<string, CrosswalkEntry>();
  const dupes = new Set<string>();
  const ok = (x: string | undefined): x is string => !!x && x !== "NA";
  for (const r of rows) {
    if (ok(r.gsis_id)) byGsis.set(r.gsis_id, {
      gsisId: r.gsis_id, name: r.display_name ?? r.gsis_id,
      ...(ok(r.position) ? { position: r.position } : {}),
      ...(ok(r.latest_team) ? { team: r.latest_team } : {})
    });
    if (!ok(r.espn_id) || !ok(r.gsis_id)) continue;
    const prev = byEspn.get(r.espn_id);
    if (prev && prev.gsisId !== r.gsis_id) { dupes.add(r.espn_id); continue; }
    byEspn.set(r.espn_id, {
      gsisId: r.gsis_id, name: r.display_name ?? r.gsis_id,
      ...(ok(r.position) ? { position: r.position } : {}),
      ...(ok(r.latest_team) ? { team: r.latest_team } : {})
    });
  }
  // An ESPN ID pointing at two different players is ambiguous: treat as unmatched.
  for (const d of dupes) byEspn.delete(d);
  return { fromEspn: id => byEspn.get(id), player: id => byGsis.get(id), size: byEspn.size };
}

const PLAYERS_URL = "https://github.com/nflverse/nflverse-data/releases/download/players/players.csv";

/** Load (and cache for `maxAgeHours`, default 24) nflverse players.csv. */
export async function loadCrosswalk(opts: { cacheDir: string; maxAgeHours?: number; fetchImpl?: typeof fetch }): Promise<Crosswalk> {
  const file = path.join(opts.cacheDir, "players.csv");
  const maxAge = (opts.maxAgeHours ?? 24) * 3600 * 1000;
  if (!fs.existsSync(file) || Date.now() - fs.statSync(file).mtimeMs > maxAge) {
    try {
      const res = await (opts.fetchImpl ?? fetch)(PLAYERS_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fs.mkdirSync(opts.cacheDir, { recursive: true });
      fs.writeFileSync(file + ".tmp", await res.text());
      fs.renameSync(file + ".tmp", file);
    } catch (err) {
      if (!fs.existsSync(file)) throw new Error(`Can't load nflverse players.csv: ${(err as Error).message}`);
      // Keep using the cached copy.
    }
  }
  return crosswalkFromRows(parseCsv(fs.readFileSync(file, "utf8")));
}

/** A player the crosswalk couldn't place. For the commissioner's review queue. */
export interface UnmatchedPlayer {
  provider: string;
  providerId: string;
  name: string;
  team?: string;
  gameId: string;
  week: number;
  reason: string;
}

/** Rewrite an ESPN game's player refs to canonical (nflverse) IDs. Unmatched refs keep their ESPN identity and are reported. */
export function toCanonical(g: GameData, cw: Crosswalk): { game: GameData; unmatched: UnmatchedPlayer[] } {
  const unmatched = new Map<string, UnmatchedPlayer>();
  const map = (p: PlayerRef): PlayerRef => {
    if (p.provider === CANONICAL) return p;
    const e = p.provider === "espn" ? cw.fromEspn(p.id) : undefined;
    if (e) return { provider: CANONICAL, id: e.gsisId, name: e.name, ...(p.team ? { team: p.team } : {}), ...(e.position ? { position: e.position } : {}) };
    if (!unmatched.has(p.id)) {
      unmatched.set(p.id, {
        provider: p.provider, providerId: p.id, name: p.name, gameId: g.gameId, week: g.week,
        ...(p.team ? { team: p.team } : {}),
        reason: `no ${CANONICAL} ID for ${p.provider} athlete ${p.id}`
      });
    }
    return p;
  };
  const mapEvent = (e: ScoringEvent): ScoringEvent => {
    switch (e.kind) {
      case "td": return { ...e, ...(e.scorer ? { scorer: map(e.scorer) } : {}), ...(e.passer ? { passer: map(e.passer) } : {}) };
      case "fg": case "xp": return { ...e, ...(e.kicker ? { kicker: map(e.kicker) } : {}) };
      case "twoPt": return { ...e, ...(e.passer ? { passer: map(e.passer) } : {}), ...(e.receiver ? { receiver: map(e.receiver) } : {}), ...(e.rusher ? { rusher: map(e.rusher) } : {}) };
      default: return e;
    }
  };
  const game: GameData = {
    ...g,
    players: g.players.map(b => ({ ...b, player: map(b.player) })),
    events: g.events.map(mapEvent)
  };
  return { game, unmatched: [...unmatched.values()] };
}
