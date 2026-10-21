/* Injury status for the Live page (public.player_injuries). Both sources are nflverse and keyed by
   GSIS ID (our player ID), so no crosswalk is needed:
   - injuries_<season>.csv: the NFL's official weekly injury report (report_status Out / Doubtful /
     Questionable, primary injury, practice status), one row per player per week.
   - players.csv `status` / `ngs_status_short_description`: roster status, for players who are on
     no weekly report because they're on a reserve list (injured reserve, PUP, suspended, other
     reserve). Applied to the current week only (it's today's status).
   One row per (season, week, player): the most serious status wins (reserve lists > Out > Doubtful
   > Questionable). Not covered: game-day inactives (announced 90 minutes before kickoff).
   Written nightly by scripts/sync-nfl.mts through public.replace_injuries. */

export type InjuryStatus = "IR" | "PUP" | "Suspended" | "Reserve" | "Out" | "Doubtful" | "Questionable";
export interface InjuryRow {
  season: number; week: number; player_id: string; status: InjuryStatus;
  injury: string | null; practice: string | null; source: "report" | "roster";
}

const RANK: Record<InjuryStatus, number> = { IR: 5, PUP: 5, Suspended: 5, Reserve: 5, Out: 4, Doubtful: 3, Questionable: 2 };

/** Weekly report status -> ours (blank = practice report only: not an injury designation). */
export function reportStatus(s: string | undefined): InjuryStatus | null {
  const v = (s ?? "").trim().toLowerCase();
  return v === "out" ? "Out" : v === "doubtful" ? "Doubtful" : v === "questionable" ? "Questionable" : null;
}

/** Roster status from players.csv (status + NGS description) -> ours, or null for an active player. */
export function rosterStatus(status: string | undefined, desc: string | undefined): InjuryStatus | null {
  const s = (status ?? "").toUpperCase(), d = desc ?? "";
  if (s === "SUS" || /susp/i.test(d)) return "Suspended";
  if (s === "PUP" || /PUP/.test(d)) return s === "PUP" && /^Active/i.test(d) ? null : "PUP";   // "Active/PUP" plays
  if (s === "RES" || s === "RSR" || s === "RSN") return /R\/I|Injur/i.test(d) ? "IR" : "Reserve";
  return null;
}

/** The current week: the first week whose last kickoff is less than 5 hours ago (same rule as the pages). */
export function currentWeek(games: { week: number; kickoff: string | null }[], now: number): number | null {
  const last = new Map<number, number>();
  for (const g of games) if (g.kickoff) last.set(g.week, Math.max(last.get(g.week) ?? 0, Date.parse(g.kickoff)));
  const weeks = [...last.keys()].sort((a, b) => a - b);
  return weeks.find(w => last.get(w)! > now - 5 * 3600_000) ?? null;
}

/** Merge both sources into one row per (week, player), only for players we know (nfl_players). */
export function injuryRows(o: {
  season: number; currentWeek: number | null; known: Set<string>;
  report: Record<string, string>[]; players: Record<string, string>[];
}): InjuryRow[] {
  const out = new Map<string, InjuryRow>();
  const put = (r: InjuryRow) => {
    const k = `${r.week}:${r.player_id}`, prev = out.get(k);
    if (!prev) { out.set(k, r); return; }
    const win = RANK[r.status] > RANK[prev.status] ? r : prev;
    out.set(k, { ...win, injury: win.injury ?? (win === r ? prev.injury : r.injury), practice: prev.practice ?? r.practice });
  };
  for (const x of o.report) {
    const status = reportStatus(x.report_status);
    if (!status || Number(x.season) !== o.season || (x.season_type && x.season_type !== "REG") || !o.known.has(x.gsis_id ?? "")) continue;
    put({ season: o.season, week: Number(x.week), player_id: x.gsis_id!, status, injury: x.report_primary_injury?.trim() || null,
      practice: x.practice_status?.trim() || null, source: "report" });
  }
  if (o.currentWeek != null) {
    for (const p of o.players) {
      const status = rosterStatus(p.status, p.ngs_status_short_description);
      if (!status || !o.known.has(p.gsis_id ?? "")) continue;
      put({ season: o.season, week: o.currentWeek, player_id: p.gsis_id!, status, injury: null, practice: null, source: "roster" });
    }
  }
  return [...out.values()].sort((a, b) => a.week - b.week || a.player_id.localeCompare(b.player_id));
}
