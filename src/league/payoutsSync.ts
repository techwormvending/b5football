/* Recompute a season's pools and auto payouts from the database and write them back.
   Called by the nightly job (scripts/payouts.mts, full season) and by the live scorer after
   each live pass (opts.liveWeek: only that week's confidence picks are re-read; earlier weeks
   come from confidence_scores, to keep live egress small). Service role only.
   Manual awards and the commissioner's overrides are read, never rewritten.

   Pools (src/league/pools.ts): survivor_status and confidence_scores are rewritten here,
   and their results feed the Survivor and Pick'em prizes (src/league/payouts.ts). */

import { computePayouts, type SeasonSettings } from "./payouts.ts";
import { confidenceScores, survivorStandings, type ConfidencePick, type NflGame, type PoolSettings, type ConfidenceWeek } from "./pools.ts";
import { sbBase, sbHeaders, selectAll, type SbConfig } from "./supabaseRest.ts";

export interface PayoutRefresh {
  season: number; awards: number; eliminations: number; flags: { kind: string; message: string }[]; skipped?: string;
  survivor?: { winners: string[]; decided: boolean; alive: number };
}

export async function refreshPayouts(sb: SbConfig, season: number, fetchImpl: typeof fetch = fetch, opts: { liveWeek?: number; now?: number } = {}): Promise<PayoutRefresh> {
  const get = async <T>(path: string): Promise<T> => {
    const r = await fetchImpl(sbBase(sb) + path, { headers: sbHeaders(sb) });
    if (!r.ok) throw new Error(`${path.replace(/\?.*$/, "")}: HTTP ${r.status}`);
    return r.json() as Promise<T>;
  };
  const post = async (path: string, body: unknown, prefer = "resolution=merge-duplicates,return=minimal") => {
    const r = await fetchImpl(sbBase(sb) + path, { method: "POST", headers: sbHeaders(sb, { Prefer: prefer }), body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`${path.replace(/\?.*$/, "")}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  };
  const [settings] = await get<(SeasonSettings & { pools?: PoolSettings })[]>(`season_settings?season=eq.${season}&select=*`);
  if (!settings) return { season, awards: 0, eliminations: 0, flags: [], skipped: "no season settings" };
  const [teams, scores, weeks, matchups, overrides, gOver] = await Promise.all([
    get<{ id: string }[]>(`teams?select=id`),
    get<{ week: number; team_id: string; points: number }[]>(`team_scores?season=eq.${season}&select=week,team_id,points&limit=1000`),
    get<{ week: number; status: string }[]>(`score_weeks?season=eq.${season}&select=week,status`),
    get<{ week: number; home_team: string; away_team: string; home_score: number | null; away_score: number | null; is_playoff: boolean }[]>(
      `matchups?season=eq.${season}&is_playoff=eq.true&select=week,home_team,away_team,home_score,away_score,is_playoff`),
    get<{ kind: string; week: number | null; place: number | null; team_id: string }[]>(`awards?season=eq.${season}&source=eq.override&select=kind,week,place,team_id`),
    get<{ week: number; team_id: string }[]>(`guillotine?season=eq.${season}&source=eq.override&select=week,team_id`)
  ]);
  const teamIds = teams.map(t => t.id);
  const num = (x: number | string | null) => (x == null ? null : Number(x));

  // ---- Pools ----
  const P = settings.pools ?? {};
  const poolFlags: { kind: string; message: string }[] = [];
  let pools: Parameters<typeof computePayouts>[0]["pools"] = {};
  let survivorOut: PayoutRefresh["survivor"];
  if (P.survivor || P.confidence) {
    const games = (await get<NflGame[]>(`nfl_games?season=eq.${season}&select=week,game_key,home,away,kickoff,home_score,away_score,status&limit=1000`))
      .map(g => ({ ...g, home_score: num(g.home_score), away_score: num(g.away_score) }));
    const now = opts.now ?? Date.now();
    if (P.survivor) {
      const picks = await get<{ week: number; team_id: string; nfl_team: string }[]>(`survivor_picks?season=eq.${season}&select=week,team_id,nfl_team&limit=1000`);
      const s = survivorStandings({ settings: P, teams: teamIds, picks, games, now });
      await post("survivor_status?on_conflict=season,team_id", s.status.map(x => ({ season, ...x, updated_at: new Date(now).toISOString() })));
      poolFlags.push(...s.flags);
      pools.survivor = { winners: s.winners, decided: s.decided };
      survivorOut = { winners: s.winners, decided: s.decided, alive: s.status.filter(x => x.alive).length };
    }
    if (P.confidence) {
      const wk = opts.liveWeek;
      const picks = await selectAll<ConfidencePick>(sb, "confidence_picks",
        `season=eq.${season}${wk ? `&week=eq.${wk}` : ""}&select=week,team_id,game_key,pick,points`, fetchImpl);
      const range = wk ? { start_week: wk, end_week: wk } : P.confidence;
      const c = confidenceScores({ settings: { confidence: range }, teams: teamIds, picks, games });
      if (c.weekly.length) await post("confidence_scores?on_conflict=season,week,team_id", c.weekly.map(x => ({ season, ...x, updated_at: new Date(now).toISOString() })));
      poolFlags.push(...c.flags);
      // Season totals: this pass's weeks plus stored weeks (live pass) or everything (full pass).
      let all: ConfidenceWeek[] = c.weekly;
      if (wk) {
        const stored = await get<ConfidenceWeek[]>(`confidence_scores?season=eq.${season}&week=neq.${wk}&select=week,team_id,points,correct,decided,games&limit=1000`);
        all = [...stored.filter(x => x.week >= P.confidence!.start_week && x.week <= P.confidence!.end_week), ...c.weekly];
      }
      const totals = new Map(teamIds.map(t => [t, 0]));
      for (const x of all) totals.set(x.team_id, (totals.get(x.team_id) ?? 0) + Number(x.points));
      const inRange = games.filter(g => g.week >= P.confidence!.start_week && g.week <= P.confidence!.end_week);
      const complete = inRange.length > 0 && inRange.every(g => g.status === "final" && g.home_score != null);
      pools.pickem = { totals: [...totals].map(([team_id, points]) => ({ team_id, points })), complete };
    }
  }

  const r = computePayouts({
    settings: { ...settings, buy_in: Number(settings.buy_in), website_fee: Number(settings.website_fee), empire_contribution: Number(settings.empire_contribution), empire_carry_in: Number(settings.empire_carry_in) },
    teams: teamIds,
    scores: scores.map(s => ({ ...s, points: Number(s.points) })),
    weekStatus: new Map(weeks.map(w => [w.week, w.status])),
    matchups: matchups.map(m => ({ ...m, home_score: num(m.home_score), away_score: num(m.away_score) })),
    overrides,
    guillotineOverrides: new Map(gOver.map(g => [g.week, g.team_id])),
    pools
  });
  const flags = [...r.flags, ...poolFlags];
  const res = await fetchImpl(sbBase(sb) + "rpc/replace_auto_payouts", {
    method: "POST", headers: sbHeaders(sb),
    body: JSON.stringify({ p_season: season, p_awards: r.awards, p_guillotine: r.eliminations, p_flags: flags })
  });
  if (!res.ok) throw new Error(`replace_auto_payouts: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return { season, awards: r.awards.length, eliminations: r.eliminations.length, flags, ...(survivorOut ? { survivor: survivorOut } : {}) };
}
