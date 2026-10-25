/* Weekly official lineup import (2026 test lineups; MFL is official this season).
   Delete with the other MFL code after the migration.

   For one finished week:
   1. Official starting lineups for all 12 teams from MFL's public weeklyResults export (no login,
      no API key), with MFL's team scores. MFL player IDs map through public.mfl_player_map
      (written by the nightly roster sync; never by name).
   2. Only if that worked for every team (12 franchises, scores posted, every starter mapped):
      public.replace_week_lineups swaps the official lineups into lineup_slots in one transaction,
      archives the week's test lineups (kept for "your test lineup would have scored X") and
      recomputes the week's matchup and team totals from the official lineups.
   3. Compare our team totals with MFL's (the shadow-mode check); differences go to Commish.
   A failure leaves the test lineups alone; the attempt is logged in public.lineup_imports as
   failed (Admin shows it; the database schedule retries hourly that Tuesday). */

import { MFL_LEAGUE } from "./poolImport.ts";
import type { MflWeeklyFranchise, MflWeeklyResults } from "./shadow.ts";
import { mirrorSlots } from "../live/mflLive.ts";
import { sbBase, sbHeaders, type SbConfig } from "./supabaseRest.ts";

const UA = { "User-Agent": "b5-fantasy-site/0.1 (private league)" };
const arr = <T>(x: T | T[] | undefined | null): T[] => (x == null ? [] : Array.isArray(x) ? x : [x]);

export interface OfficialLineup { team: string; score: number; mflIds: string[]; players: Map<string, number> }

/** weeklyResults -> each franchise's official starters and score (null score = MFL hasn't posted the week). */
export function parseWeeklyLineups(j: unknown): { lineups: OfficialLineup[]; unposted: string[] } {
  const wr = (j as { weeklyResults?: MflWeeklyResults }).weeklyResults ?? {};
  const fr: MflWeeklyFranchise[] = arr(wr.matchup).flatMap(m => arr(m.franchise));
  const lineups: OfficialLineup[] = [], unposted: string[] = [];
  for (const f of fr) {
    if (f.score == null || f.score === "") { unposted.push(f.id); continue; }
    const players = new Map(arr(f.player).filter(p => p.status === "starter").map(p => [p.id, Number(p.score ?? 0)] as [string, number]));
    const mflIds = (f.starters ?? "").split(",").map(s => s.trim()).filter(Boolean);
    lineups.push({ team: f.id, score: Number(f.score), mflIds: mflIds.length ? mflIds : [...players.keys()], players });
  }
  return { lineups, unposted };
}

export interface TeamCheck { team_id: string; ours: number; mfl: number; players?: { player_id: string; mfl_id: string; ours: number; mfl: number }[] }
/** Our totals (official lineups x our scores) vs MFL's; a team differing by a cent or more is a mismatch. */
export function compareLineups(lineups: OfficialLineup[], ours: Record<string, number>, perPlayer?: (team: string) => TeamCheck["players"]) {
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const mismatches: TeamCheck[] = [];
  for (const l of lineups) {
    const o = r2(Number(ours[l.team] ?? 0));
    if (Math.abs(o - l.score) >= 0.005) mismatches.push({ team_id: l.team, ours: o, mfl: r2(l.score), ...(perPlayer ? { players: perPlayer(l.team) } : {}) });
  }
  return { checked: true, teams: lineups.length, mismatches };
}

export interface LineupImportResult { season: number; week: number; status: "ok" | "failed"; teams: number; archivedTest: number; message: string; compare: unknown }

export async function runLineupImport(sb: SbConfig, season: number, week: number,
  opts: { by?: string; fetchImpl?: typeof fetch; now?: number; teamCount?: number } = {}): Promise<LineupImportResult> {
  const f = opts.fetchImpl ?? fetch;
  const at = () => new Date(opts.now ?? Date.now()).toISOString();
  const rest = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const r = await f(sbBase(sb) + path, { ...init, headers: sbHeaders(sb, (init.headers as Record<string, string>) ?? {}) });
    const text = await r.text();
    if (!r.ok) throw new Error(`${path.replace(/\?.*$/, "")}: HTTP ${r.status} ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : null) as T;
  };
  const inList = (ids: string[]) => encodeURIComponent(ids.map(i => `"${i.replace(/"/g, "")}"`).join(","));
  const prev = await rest<{ attempts: number }[]>(`lineup_imports?season=eq.${season}&week=eq.${week}&select=attempts`).catch(() => []);
  const attempts = (prev[0]?.attempts ?? 0) + 1;
  const log = (row: Record<string, unknown>) => rest(`lineup_imports?on_conflict=season,week`, {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{ season, week, attempts, attempted_at: at(), triggered_by: opts.by ?? "schedule", ...row }])
  });
  const fail = async (why: string): Promise<LineupImportResult> => {
    const message = `Lineup import failed; test lineups kept. ${why}`;
    await log({ status: "failed", teams: 0, archived_test: 0, message });
    return { season, week, status: "failed", teams: 0, archivedTest: 0, message, compare: {} };
  };

  // 1. MFL's official lineups and scores
  let parsed: ReturnType<typeof parseWeeklyLineups>;
  try {
    const r = await f(`https://www45.myfantasyleague.com/${season}/export?TYPE=weeklyResults&L=${MFL_LEAGUE}&W=${week}&JSON=1`, { headers: UA });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    parsed = parseWeeklyLineups(await r.json());
  } catch (err) { return fail(`weeklyResults: ${(err as Error).message}`); }
  const need = opts.teamCount ?? 12;
  if (parsed.unposted.length) return fail(`MFL hasn't posted week ${week} scores yet (${parsed.unposted.length} team(s)).`);
  if (parsed.lineups.length !== need) return fail(`expected ${need} teams in weeklyResults, got ${parsed.lineups.length}.`);
  const empty = parsed.lineups.filter(l => !l.mflIds.length).map(l => l.team);
  if (empty.length) return fail(`no starters for ${empty.join(", ")}.`);

  // Map MFL IDs (the roster sync keeps mfl_player_map, defenses included)
  const ids = [...new Set(parsed.lineups.flatMap(l => l.mflIds))];
  const map = new Map<string, string>(), position = new Map<string, string>();
  try {
    for (let i = 0; i < ids.length; i += 100)
      for (const r of await rest<{ mfl_id: string; player_id: string }[]>(`mfl_player_map?mfl_id=in.(${inList(ids.slice(i, i + 100))})&select=mfl_id,player_id`)) map.set(r.mfl_id, r.player_id);
    const pids = [...new Set(map.values())];
    for (let i = 0; i < pids.length; i += 100)
      for (const r of await rest<{ id: string; position: string }[]>(`nfl_players?id=in.(${inList(pids.slice(i, i + 100))})&select=id,position`)) position.set(r.id, r.position);
  } catch (err) { return fail(`player map: ${(err as Error).message}`); }
  const { rows, missing } = mirrorSlots(season, week, parsed.lineups.map(l => ({ team: l.team, mflIds: l.mflIds })), map, position);
  if (missing.length) return fail(`unmapped or unplaceable MFL starters: ${missing.join(", ")} (fix mfl_player_map, then Run import now).`);

  // 2. Swap them in (one transaction)
  let swap: { archived_test: number; totals: Record<string, number> };
  try {
    swap = await rest("rpc/replace_week_lineups", { method: "POST", body: JSON.stringify({ p_season: season, p_week: week,
      p_rows: rows.map(({ team_id, slot, player_id }) => ({ team_id, slot, player_id })) }) });
  } catch (err) { return fail(`replace_week_lineups: ${(err as Error).message}`); }

  // 3. Compare with MFL's weekly results (per player for any team that differs)
  const differing = parsed.lineups.filter(l => Math.abs(Number(swap.totals[l.team] ?? 0) - l.score) >= 0.005);
  const ourPts = new Map<string, number>();
  if (differing.length) {
    const pids = [...new Set(rows.filter(r => differing.some(d => d.team === r.team_id)).map(r => r.player_id))];
    for (const r of await rest<{ player_id: string; points: number }[]>(`player_scores?season=eq.${season}&week=eq.${week}&player_id=in.(${inList(pids)})&select=player_id,points`).catch(() => []))
      ourPts.set(r.player_id, Number(r.points));
  }
  const inv = new Map([...map].map(([m, p]) => [p, m]));
  const compare = compareLineups(parsed.lineups, swap.totals, team => {
    const l = parsed.lineups.find(x => x.team === team)!;
    return rows.filter(r => r.team_id === team).map(r => ({ player_id: r.player_id, mfl_id: inv.get(r.player_id) ?? "", ours: ourPts.get(r.player_id) ?? 0, mfl: l.players.get(inv.get(r.player_id) ?? "") ?? 0 }))
      .filter(p => Math.abs(p.ours - p.mfl) >= 0.005);
  });
  const message = `Imported the official week ${week} lineups for ${parsed.lineups.length} teams` +
    (swap.archived_test ? `; ${swap.archived_test} test lineup(s) kept for comparison` : "") +
    (compare.mismatches.length ? `; ${compare.mismatches.length} team(s) differ from MFL's scores` : "; every team matches MFL's scores");
  await log({ status: "ok", teams: parsed.lineups.length, archived_test: swap.archived_test, message, compare, succeeded_at: at() });
  return { season, week, status: "ok", teams: parsed.lineups.length, archivedTest: swap.archived_test, message, compare };
}
