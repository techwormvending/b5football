/* Weekly official Confidence Pool import (2026 test mode; MFL is official this season).
   Delete with the other MFL code after the migration.

   For one finished week:
   1. Official picks for all 12 teams from MFL's public export
      (TYPE=pool&POOLTYPE=NFL, no login, no API key). If the export fails or lacks the week,
      fall back to the public pool results page (options?O=122), which lists every pick.
   2. Only if one of them worked: replace that week's picks (test and site) with the official
      ones, in one transaction (public.replace_week_confidence).
   3. Score the week with our engine (via refreshPayouts) and compare our weekly totals and
      season standings with MFL's own results (the results page's summary table).
   If both sources fail, the test picks stay and the attempt is logged as failed (the Commish
   page warns; the database schedule retries hourly that Tuesday).
   Every attempt is written to public.pool_imports. No MFL credentials anywhere. */

import { team } from "../ingest/teams.ts";
import { mflMatchupKey } from "./pools.ts";
import { mflPoolRows } from "./mflPools.ts";
import { refreshPayouts } from "./payoutsSync.ts";
import { sbBase, sbHeaders, type SbConfig } from "./supabaseRest.ts";

export const MFL_LEAGUE = "22689";
const UA = { "User-Agent": "b5-fantasy-site/0.1 (private league)" };

export interface PickRow { team_id: string; game_key: string; pick: string; points: number }
export interface PoolPage {
  summary: Map<string, { weeks: number[]; total: number }>;        // franchise -> points by week (index 0 = week 1), total
  weeks: Map<number, { picks: PickRow[]; totals: Map<string, number> }>;
}

const decode = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;|&#8217;/g, "'").trim();

/** Parse MFL's public pool results page (options?L=..&O=122). Franchises come from their "franchise_NNNN" class. */
export function parsePoolPage(html: string): PoolPage {
  const page: PoolPage = { summary: new Map(), weeks: new Map() };
  for (const [, table] of html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/g)) {
    const caption = decode(/<caption>([\s\S]*?)<\/caption>/.exec(table!)?.[1] ?? "");
    const rows = [...table!.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(m => m[1]!);
    if (/Confidence Pool Summary/i.test(caption)) {
      for (const r of rows) {
        const id = /franchise_(\d{4})/.exec(r)?.[1];
        if (!id) continue;
        const cells = [...r.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => decode(m[1]!)).slice(1).map(Number);
        page.summary.set(id, { weeks: cells.slice(0, -1), total: cells[cells.length - 1] ?? 0 });
      }
      continue;
    }
    const wk = /^Week (\d+) NFL Picks/i.exec(caption);
    if (!wk) continue;
    const head = [...(rows[0] ?? "").matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map(m => decode(m[1]!));
    const games = head.slice(1, -1).map(h => { try { return mflMatchupKey(h.replace(/\s*@\s*/, ","), team); } catch { return null; } });
    const week = { picks: [] as PickRow[], totals: new Map<string, number>() };
    for (const r of rows.slice(1)) {
      const id = /franchise_(\d{4})/.exec(r)?.[1];
      if (!id) continue;
      const cells = [...r.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => decode(m[1]!)).slice(1);
      week.totals.set(id, Number(cells[cells.length - 1] || 0));
      cells.slice(0, -1).forEach((c, i) => {
        const m = /^([A-Z]{2,3})\s*\((\d+)\)$/.exec(c);
        const key = games[i];
        if (!m || !key) return;
        try { week.picks.push({ team_id: id, game_key: key, pick: team(m[1]!), points: Number(m[2]) }); } catch { /* unknown code: skipped */ }
      });
    }
    page.weeks.set(Number(wk[1]), week);
  }
  return page;
}

/** Our totals vs MFL's results page: week points and season totals per team. */
export function comparePool(week: number, ours: { week: Map<string, number>; season: Map<string, number> }, mfl: PoolPage | null, teams: string[]) {
  if (!mfl || !mfl.summary.size) return { checked: false, note: "MFL's results page wasn't available; nothing compared.", mismatches: [] as unknown[] };
  const mismatches: { team_id: string; what: "week" | "season"; ours: number; mfl: number }[] = [];
  for (const t of teams) {
    const s = mfl.summary.get(t);
    const mw = mfl.weeks.get(week)?.totals.get(t) ?? s?.weeks[week - 1] ?? 0, ow = ours.week.get(t) ?? 0;
    if (Math.abs(mw - ow) > 0.001) mismatches.push({ team_id: t, what: "week", ours: ow, mfl: mw });
    const ms = s?.total ?? 0, os = ours.season.get(t) ?? 0;
    if (Math.abs(ms - os) > 0.001) mismatches.push({ team_id: t, what: "season", ours: os, mfl: ms });
  }
  return { checked: true, mismatches };
}

export interface ImportResult { season: number; week: number; status: "ok" | "failed"; source?: "export" | "page"; picks: number; teams: number; replacedTest: number; message: string; compare: unknown }

export async function runPoolImport(sb: SbConfig, season: number, week: number, opts: { by?: string; fetchImpl?: typeof fetch; now?: number } = {}): Promise<ImportResult> {
  const f = opts.fetchImpl ?? fetch;
  const rest = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const r = await f(sbBase(sb) + path, { ...init, headers: sbHeaders(sb, (init.headers as Record<string, string>) ?? {}) });
    const text = await r.text();
    if (!r.ok) throw new Error(`${path.replace(/\?.*$/, "")}: HTTP ${r.status} ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : null) as T;
  };
  const H = `https://www45.myfantasyleague.com/${season}`;
  const problems: string[] = [];
  let picks: PickRow[] | null = null, source: "export" | "page" | undefined;

  // 1a. The public export
  try {
    const r = await f(`${H}/export?TYPE=pool&POOLTYPE=NFL&L=${MFL_LEAGUE}&JSON=1`, { headers: UA });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const rows = mflPoolRows(season, null, await r.json(), week).confidence;
    if (!rows.length) throw new Error(`no week ${week} picks in the export`);
    picks = rows.map(({ team_id, game_key, pick, points }) => ({ team_id, game_key, pick, points }));
    source = "export";
  } catch (err) { problems.push(`export: ${(err as Error).message}`); }

  // 1b. The public results page: fallback picks, and MFL's own results for the comparison
  let page: PoolPage | null = null;
  try {
    const r = await f(`${H}/options?L=${MFL_LEAGUE}&O=122`, { headers: UA });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    page = parsePoolPage(await r.text());
    if (!page.summary.size) throw new Error("no pool summary table on the page");
  } catch (err) { problems.push(`results page: ${(err as Error).message}`); page = null; }
  if (!picks && page) {
    const wp = page.weeks.get(week)?.picks ?? [];
    if (wp.length) { picks = wp; source = "page"; }
    else problems.push(`results page: no week ${week} picks`);
  }

  const prev = await rest<{ attempts: number }[]>(`pool_imports?season=eq.${season}&week=eq.${week}&select=attempts`).catch(() => []);
  const attempts = (prev[0]?.attempts ?? 0) + 1;
  const log = (row: Record<string, unknown>) => rest(`pool_imports?on_conflict=season,week`, {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{ season, week, attempts, attempted_at: new Date(opts.now ?? Date.now()).toISOString(), triggered_by: opts.by ?? "schedule", ...row }])
  });

  if (!picks) {
    const message = `Import failed; test picks kept. ${problems.join("; ")}`;
    await log({ status: "failed", source: null, picks: 0, teams: 0, replaced_test: 0, message });
    return { season, week, status: "failed", picks: 0, teams: 0, replacedTest: 0, message, compare: {} };
  }

  // 2. Replace the week's picks atomically
  const replacedTest = await rest<number>("rpc/replace_week_confidence", { method: "POST", body: JSON.stringify({ p_season: season, p_week: week, p_rows: picks }) });

  // 3. Score with our engine (pools + payouts), then compare with MFL's results
  await refreshPayouts(sb, season, f, { ...(opts.now ? { now: opts.now } : {}) });
  const scores = await rest<{ week: number; team_id: string; points: number }[]>(`confidence_scores?season=eq.${season}&select=week,team_id,points&limit=1000`);
  const teams = (await rest<{ id: string }[]>(`teams?select=id`)).map(t => t.id);
  const ours = { week: new Map<string, number>(), season: new Map<string, number>() };
  for (const s of scores) {
    ours.season.set(s.team_id, (ours.season.get(s.team_id) ?? 0) + Number(s.points));
    if (s.week === week) ours.week.set(s.team_id, Number(s.points));
  }
  const compare = comparePool(week, ours, page, teams);
  const teamCount = new Set(picks.map(p => p.team_id)).size;
  const message = `Imported ${picks.length} official picks for ${teamCount} team(s) from MFL's ${source === "export" ? "export" : "results page"}` +
    (replacedTest ? `; replaced ${replacedTest} test pick(s)` : "") +
    (compare.checked ? (compare.mismatches.length ? `; ${compare.mismatches.length} mismatch(es) with MFL's results` : "; matches MFL's results") : `; ${compare.note}`) +
    (problems.length ? ` (${problems.join("; ")})` : "");
  await log({ status: "ok", source, picks: picks.length, teams: teamCount, replaced_test: replacedTest, message, compare,
    succeeded_at: new Date(opts.now ?? Date.now()).toISOString() });
  return { season, week, status: "ok", ...(source ? { source } : {}), picks: picks.length, teams: teamCount, replacedTest, message, compare };
}
