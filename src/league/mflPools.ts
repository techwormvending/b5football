/* TEMPORARY (2026: MFL is official; delete with the other MFL code after the migration):
   map MFL's Survivor and Confidence pool exports (league 22689) to our rows, and mirror
   the Survivor picks (syncMflPools). Confidence is imported weekly by poolImport.ts.

   MFL exports (public): TYPE=survivorPool -> franchise[].week[] { week, pick: "NEP" | "" };
   TYPE=pool -> poolPicks.franchise[].week[].game[] { matchup: "AWAY,HOME", pick, rank }. */

import { team } from "../ingest/teams.ts";
import { mflMatchupKey } from "./pools.ts";
import { deleteWhere, sbBase, sbHeaders, selectAll, type SbConfig } from "./supabaseRest.ts";

const list = <T>(x: T | T[] | undefined): T[] => (x == null ? [] : Array.isArray(x) ? x : [x]);

export interface SurvivorRow { season: number; week: number; team_id: string; nfl_team: string }
export interface ConfidenceRow { season: number; week: number; team_id: string; game_key: string; pick: string; points: number }

/** MFL exports -> our rows (canonical team codes and game keys). Unknown codes are reported, not guessed. */
export function mflPoolRows(season: number, survivor: unknown, pool: unknown, onlyWeek?: number): { survivor: SurvivorRow[]; confidence: ConfidenceRow[]; problems: string[] } {
  const problems: string[] = [];
  const canon = (c: string) => { try { return team(c); } catch { problems.push(`unknown team code "${c}"`); return null; } };
  const sv: SurvivorRow[] = [];
  for (const f of list((survivor as { survivorPool?: { franchise?: unknown } })?.survivorPool?.franchise as { id: string; week?: unknown }[] | undefined)) {
    for (const w of list(f.week as { week: string; pick?: string }[] | undefined)) {
      const week = Number(w.week);
      if (!w.pick || (onlyWeek && week !== onlyWeek)) continue;
      const t = canon(w.pick);
      if (t) sv.push({ season, week, team_id: f.id, nfl_team: t });
    }
  }
  const cf: ConfidenceRow[] = [];
  for (const f of list((pool as { poolPicks?: { franchise?: unknown } })?.poolPicks?.franchise as { id: string; week?: unknown }[] | undefined)) {
    for (const w of list(f.week as { week: string; game?: unknown }[] | undefined)) {
      const week = Number(w.week);
      if (onlyWeek && week !== onlyWeek) continue;
      for (const g of list(w.game as { matchup?: string; pick?: string; rank?: string }[] | undefined)) {
        if (!g.matchup || !g.pick || !g.rank) continue;
        const pick = canon(g.pick);
        let key: string | null = null;
        try { key = mflMatchupKey(g.matchup, team); } catch { problems.push(`unknown matchup "${g.matchup}"`); }
        if (pick && key) cf.push({ season, week, team_id: f.id, game_key: key, pick, points: Number(g.rank) });
      }
    }
  }
  return { survivor: sv, confidence: cf, problems };
}

/** Mirror MFL's SURVIVOR picks (read-only, source "mfl"). Confidence picks are NOT mirrored here:
    in 2026 test mode they come only from the weekly official import (poolImport.ts), so members'
    test picks for the current week survive until that week is imported. Picks entered on this site
    (source "site") are never overwritten; mirrored picks that disappeared from MFL are removed. */
export async function syncMflPools(sb: SbConfig, season: number, league: string, fetchImpl: typeof fetch = fetch, onlyWeek?: number) {
  const r = await fetchImpl(`https://www45.myfantasyleague.com/${season}/export?TYPE=survivorPool&L=${league}&JSON=1`, { headers: { "User-Agent": "b5-fantasy-site/0.1 (private league)" } });
  if (!r.ok) throw new Error(`MFL survivorPool: HTTP ${r.status}`);
  const rows = mflPoolRows(season, await r.json(), null, onlyWeek);
  const wk = onlyWeek ? `&week=eq.${onlyWeek}` : "";
  const existing = await selectAll<SurvivorRow & { source: string }>(sb, "survivor_picks", `season=eq.${season}${wk}&select=season,week,team_id,nfl_team,source`, fetchImpl);
  const siteSet = new Set(existing.filter(x => x.source === "site").map(x => `${x.week}|${x.team_id}`));
  const sv = rows.survivor.filter(x => !siteSet.has(`${x.week}|${x.team_id}`)).map(x => ({ ...x, source: "mfl" }));
  for (const x of existing) if (x.source === "mfl" && !sv.some(y => y.week === x.week && y.team_id === x.team_id)) {
    await deleteWhere(sb, "survivor_picks", `season=eq.${season}&week=eq.${x.week}&team_id=eq.${x.team_id}&source=eq.mfl`, fetchImpl);
  }
  if (sv.length) {
    const p = await fetchImpl(`${sbBase(sb)}survivor_picks?on_conflict=season,week,team_id`, { method: "POST", headers: sbHeaders(sb, { Prefer: "resolution=merge-duplicates,return=minimal" }), body: JSON.stringify(sv) });
    if (!p.ok) throw new Error(`survivor_picks: HTTP ${p.status} ${(await p.text()).slice(0, 200)}`);
  }
  return { survivor: sv.length, problems: rows.problems, keptSitePicks: siteSet.size };
}
