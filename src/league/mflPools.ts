/* TEMPORARY (2026: MFL is official; delete with the other MFL code after the migration):
   mirror MFL's Survivor and Confidence pool picks (league 22689) into survivor_picks and
   confidence_picks, read-only here. Picks the commissioner fixed on this site (source
   "commissioner") are never overwritten; imported picks that disappeared from MFL are removed.

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

/** Fetch MFL's pools and write them. Returns counts and problems. Never touches commissioner fixes. */
export async function syncMflPools(sb: SbConfig, season: number, league: string, fetchImpl: typeof fetch = fetch, onlyWeek?: number) {
  const H = `https://www45.myfantasyleague.com/${season}/export`;
  const getMfl = async (type: string) => {
    const r = await fetchImpl(`${H}?TYPE=${type}&L=${league}&JSON=1`, { headers: { "User-Agent": "b5-fantasy-site/0.1 (private league)" } });
    if (!r.ok) throw new Error(`MFL ${type}: HTTP ${r.status}`);
    return r.json();
  };
  const rows = mflPoolRows(season, await getMfl("survivorPool"), await getMfl("pool"), onlyWeek);
  const wk = onlyWeek ? `&week=eq.${onlyWeek}` : "";
  const existingS = await selectAll<SurvivorRow & { source: string }>(sb, "survivor_picks", `season=eq.${season}${wk}&select=season,week,team_id,nfl_team,source`, fetchImpl);
  const existingC = await selectAll<ConfidenceRow & { source: string }>(sb, "confidence_picks", `season=eq.${season}${wk}&select=season,week,team_id,game_key,pick,points,source`, fetchImpl);
  const fixedS = new Set(existingS.filter(r => r.source === "commissioner").map(r => `${r.week}|${r.team_id}`));
  const fixedC = new Set(existingC.filter(r => r.source === "commissioner").map(r => `${r.week}|${r.team_id}`));   // a fixed week stays as fixed
  const sv = rows.survivor.filter(r => !fixedS.has(`${r.week}|${r.team_id}`)).map(r => ({ ...r, source: "mfl_import" }));
  const cf = rows.confidence.filter(r => !fixedC.has(`${r.week}|${r.team_id}`)).map(r => ({ ...r, source: "mfl_import" }));
  const post = async (table: string, onConflict: string, body: unknown[]) => {
    if (!body.length) return;
    const r = await fetchImpl(`${sbBase(sb)}${table}?on_conflict=${onConflict}`, { method: "POST", headers: sbHeaders(sb, { Prefer: "resolution=merge-duplicates,return=minimal" }), body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`${table}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  };
  // Imported picks no longer on MFL (changed before kickoff, or removed): delete them first, then upsert.
  const wantS = new Set(sv.map(r => `${r.week}|${r.team_id}|${r.nfl_team}`));
  for (const r of existingS) if (r.source === "mfl_import" && !wantS.has(`${r.week}|${r.team_id}|${r.nfl_team}`) && !sv.some(x => x.week === r.week && x.team_id === r.team_id)) {
    await deleteWhere(sb, "survivor_picks", `season=eq.${season}&week=eq.${r.week}&team_id=eq.${r.team_id}&source=eq.mfl_import`, fetchImpl);
  }
  const wantC = new Set(cf.map(r => `${r.week}|${r.team_id}|${r.game_key}`));
  for (const r of existingC) if (r.source === "mfl_import" && !wantC.has(`${r.week}|${r.team_id}|${r.game_key}`)) {
    await deleteWhere(sb, "confidence_picks", `season=eq.${season}&week=eq.${r.week}&team_id=eq.${r.team_id}&game_key=eq.${encodeURIComponent(r.game_key)}&source=eq.mfl_import`, fetchImpl);
  }
  await post("survivor_picks", "season,week,team_id", sv);
  await post("confidence_picks", "season,week,team_id,game_key", cf);
  return { survivor: sv.length, confidence: cf.length, problems: rows.problems, keptCommissionerFixes: fixedS.size + fixedC.size };
}
