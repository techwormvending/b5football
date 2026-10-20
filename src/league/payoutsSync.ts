/* Recompute a season's auto payouts from the database and write them back atomically
   (public.replace_auto_payouts). Called by the nightly job (scripts/payouts.mts) and by the
   live scorer after each live pass, so projections move during games. Service role only.
   Manual awards and the commissioner's overrides are read, never rewritten. */

import { computePayouts, type SeasonSettings } from "./payouts.ts";
import { sbBase, sbHeaders, type SbConfig } from "./supabaseRest.ts";

export interface PayoutRefresh { season: number; awards: number; eliminations: number; flags: { kind: string; message: string }[]; skipped?: string }

export async function refreshPayouts(sb: SbConfig, season: number, fetchImpl: typeof fetch = fetch): Promise<PayoutRefresh> {
  const get = async <T>(path: string): Promise<T> => {
    const r = await fetchImpl(sbBase(sb) + path, { headers: sbHeaders(sb) });
    if (!r.ok) throw new Error(`${path.replace(/\?.*$/, "")}: HTTP ${r.status}`);
    return r.json() as Promise<T>;
  };
  const [settings] = await get<SeasonSettings[]>(`season_settings?season=eq.${season}&select=*`);
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
  const num = (x: number | string | null) => (x == null ? null : Number(x));
  const r = computePayouts({
    settings: { ...settings, buy_in: Number(settings.buy_in), website_fee: Number(settings.website_fee), empire_contribution: Number(settings.empire_contribution), empire_carry_in: Number(settings.empire_carry_in) },
    teams: teams.map(t => t.id),
    scores: scores.map(s => ({ ...s, points: Number(s.points) })),
    weekStatus: new Map(weeks.map(w => [w.week, w.status])),
    matchups: matchups.map(m => ({ ...m, home_score: num(m.home_score), away_score: num(m.away_score) })),
    overrides,
    guillotineOverrides: new Map(gOver.map(g => [g.week, g.team_id]))
  });
  const res = await fetchImpl(sbBase(sb) + "rpc/replace_auto_payouts", {
    method: "POST", headers: sbHeaders(sb),
    body: JSON.stringify({ p_season: season, p_awards: r.awards, p_guillotine: r.eliminations, p_flags: r.flags })
  });
  if (!res.ok) throw new Error(`replace_auto_payouts: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return { season, awards: r.awards.length, eliminations: r.eliminations.length, flags: r.flags };
}
