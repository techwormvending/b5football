/* Payout rules (pure). Replaces the league's payout spreadsheet; a ledger only.

   Input: season settings (pot + prize rules), every team's weekly total, week status,
   playoff matchups, and the commissioner's overrides. Output: auto awards, guillotine
   eliminations, flags for the commissioner, and the Empire pot outcome.

   Rules (confirmed by the commissioner 2026-10-20):
   - Weekly high score, weeks first..last (1-17), league-wide, every team every week.
   - Playoffs (8-team bracket): each round-1 win (week 15), round-2 win (week 16) and the
     championship (week 17) pays; the champion collects all three rounds.
   - Season points (weeks 1-17): most, 2nd, 3rd.
   - Guillotine: from start_week, the lowest score among teams still alive is eliminated;
     the last team left wins.
   - TIES split the money evenly; ties across places pool those places' prizes and split them.
     Splits are in cents and always add up exactly (extra cents go to teams in ID order).
   - An award is "projected" until its week(s) are final (score_weeks status "final").
   - A guillotine tie for lowest, or a tied playoff game, is NOT decided automatically:
     it's flagged for the commissioner, who overrides.
   - Overrides: an override replaces the whole auto group (same kind + week + place).
   - Empire pot: paid to a team that wins the championship two seasons in a row (this
     season's champion = the defending champion); otherwise it rolls over. */

export interface PrizeRules {
  weekly_high?: { amount: number; first_week: number; last_week: number };
  playoffs?: { r1: number; r1_games: number; r2: number; r2_games: number; champion: number; weeks: [number, number, number] };
  season_points?: { amounts: number[]; first_week: number; last_week: number };
  guillotine?: { amount: number; start_week: number };
  survivor?: { amount: number };                 // from the Survivor pool (pools.ts)
  pickem?: { amounts: number[] };                // Confidence pool season standings: 1st, 2nd, ...
  manual?: { key: string; label: string; amount: number }[];
}
export interface SeasonSettings {
  season: number; team_count: number; buy_in: number; website_fee: number;
  empire_contribution: number; empire_carry_in: number; empire_defending_team: string | null;
  prizes: PrizeRules;
  seed?: { weekly_high?: Record<string, string>; guillotine?: Record<string, string> };
}
export interface TeamWeekScore { week: number; team_id: string; points: number }
export interface Matchup { week: number; home_team: string; away_team: string; home_score: number | null; away_score: number | null; is_playoff?: boolean }
export interface AwardRow { kind: string; week: number | null; place: number | null; label: string; team_id: string; amount: number; status: "projected" | "final"; note?: string | null }
export interface Elimination { week: number; team_id: string; points: number; status: "projected" | "final" }
export interface Flag { kind: "guillotine_tie" | "playoff_tie" | "playoff_bracket" | "seed_mismatch" | "pot_mismatch"; week?: number; teams?: string[]; message: string }
export interface Empire { balance: number; defending: string | null; outcome: "watch" | "paid" | "rolled"; champion: string | null; next_carry_in: number }

const cents = (d: number) => Math.round(d * 100);
const dollars = (c: number) => c / 100;
const money = (d: number) => `$${(Math.round(d * 100) / 100).toFixed(2).replace(/\.00$/, "")}`;

/** Split an amount evenly among teams, in cents; any extra cents go to teams in ID order. */
export function splitEven(amount: number, teams: string[]): { team_id: string; amount: number }[] {
  const ids = [...teams].sort();
  const total = cents(amount), base = Math.floor(total / ids.length), extra = total - base * ids.length;
  return ids.map((t, i) => ({ team_id: t, amount: dollars(base + (i < extra ? 1 : 0)) }));
}

/** Money paid out of the fees: teams x buy-in - website - Empire contribution. */
export function pot(s: SeasonSettings): number {
  return dollars(cents(s.team_count * s.buy_in) - cents(s.website_fee) - cents(s.empire_contribution));
}

/** What the configured prizes add up to (checked against the pot). */
export function prizeTotal(p: PrizeRules): number {
  let c = 0;
  if (p.weekly_high) c += cents(p.weekly_high.amount) * (p.weekly_high.last_week - p.weekly_high.first_week + 1);
  if (p.playoffs) c += cents(p.playoffs.r1) * p.playoffs.r1_games + cents(p.playoffs.r2) * p.playoffs.r2_games + cents(p.playoffs.champion);
  if (p.season_points) c += p.season_points.amounts.reduce((s, a) => s + cents(a), 0);
  if (p.guillotine) c += cents(p.guillotine.amount);
  if (p.survivor) c += cents(p.survivor.amount);
  if (p.pickem) c += p.pickem.amounts.reduce((s, a) => s + cents(a), 0);
  for (const m of p.manual ?? []) c += cents(m.amount);
  return dollars(c);
}

const ordinal = (n: number) => `${n}${["th", "st", "nd", "rd"][(n % 100 - 20) % 10] ?? ["th", "st", "nd", "rd"][n % 100] ?? "th"}`;
export const groupKey = (a: { kind: string; week: number | null; place: number | null }) => `${a.kind}|${a.week ?? ""}|${a.place ?? ""}`;

/** Places p..q (1-based) of a ranked list, ties pooled: [{ teams, place, amount each }]. */
export function pooledPlaces(totals: { team_id: string; points: number }[], amounts: number[]): { place: number; teams: string[]; shares: { team_id: string; amount: number }[]; tied: boolean }[] {
  const sorted = [...totals].sort((a, b) => b.points - a.points || a.team_id.localeCompare(b.team_id));
  const out: ReturnType<typeof pooledPlaces> = [];
  let i = 0;
  while (i < sorted.length && i < amounts.length) {
    const pts = sorted[i]!.points;
    let j = i;
    while (j < sorted.length && Math.abs(sorted[j]!.points - pts) < 0.005) j++;
    const teams = sorted.slice(i, j).map(t => t.team_id);
    const pool = amounts.slice(i, Math.min(j, amounts.length)).reduce((s, a) => s + cents(a), 0);
    out.push({ place: i + 1, teams, shares: splitEven(dollars(pool), teams), tied: teams.length > 1 });
    i = j;
  }
  return out;
}

export function computePayouts(input: {
  settings: SeasonSettings;
  teams: string[];                               // all teams in the league
  scores: TeamWeekScore[];                       // team weekly totals
  weekStatus: Map<number, string>;               // score_weeks status by week
  matchups: Matchup[];                           // at least the playoff weeks' matchups
  overrides?: { kind: string; week: number | null; place: number | null; team_id: string }[];   // source "override" awards
  guillotineOverrides?: Map<number, string>;     // week -> eliminated team (commissioner's pick)
  /** Pool results (pools.ts): Survivor winners, Confidence season totals. */
  pools?: { survivor?: { winners: string[]; decided: boolean }; pickem?: { totals: { team_id: string; points: number }[]; complete: boolean } };
  /** Regular-season standings, best first: the league tiebreaker for a tied playoff game. */
  standingsOrder?: string[];
}): { awards: AwardRow[]; eliminations: Elimination[]; flags: Flag[]; empire: Empire; alive: string[] } {
  const { settings: s, teams } = input;
  const P = s.prizes;
  const awards: AwardRow[] = [], eliminations: Elimination[] = [], flags: Flag[] = [];
  const isFinal = (w: number) => input.weekStatus.get(w) === "final";
  const status = (...weeks: number[]): "projected" | "final" => weeks.length && weeks.every(isFinal) ? "final" : "projected";
  const byWeek = new Map<number, Map<string, number>>();
  for (const x of input.scores) {
    if (!byWeek.has(x.week)) byWeek.set(x.week, new Map());
    byWeek.get(x.week)!.set(x.team_id, Number(x.points));
  }
  const overridden = new Set((input.overrides ?? []).map(groupKey));
  const add = (a: AwardRow) => { if (!overridden.has(groupKey(a))) awards.push(a); };

  // Pot check
  if (Math.abs(prizeTotal(P) - pot(s)) >= 0.005) {
    flags.push({ kind: "pot_mismatch", message: `Prizes add up to ${money(prizeTotal(P))} but the pot is ${money(pot(s))}.` });
  }

  // Weekly high score
  const weeklyWinners = new Map<number, string[]>();
  if (P.weekly_high) {
    for (let w = P.weekly_high.first_week; w <= P.weekly_high.last_week; w++) {
      const ws = byWeek.get(w);
      if (!ws || ![...ws.values()].some(p => p > 0)) continue;
      const max = Math.max(...ws.values());
      const winners = [...ws].filter(([, p]) => Math.abs(p - max) < 0.005).map(([t]) => t);
      weeklyWinners.set(w, winners);
      for (const sh of splitEven(P.weekly_high.amount, winners)) {
        add({ kind: "weekly_high", week: w, place: null, label: `Week ${w} high score${winners.length > 1 ? ` (${winners.length}-way tie)` : ""}`,
          team_id: sh.team_id, amount: sh.amount, status: status(w), note: `${max.toFixed(2)} points` });
      }
    }
  }

  // Guillotine
  let alive = [...teams].sort();
  if (P.guillotine) {
    const gWeeks: number[] = [];
    for (let w = P.guillotine.start_week; w <= 17 && alive.length > 1; w++) {
      const forced = input.guillotineOverrides?.get(w);
      const ws = byWeek.get(w);
      if (forced) {
        alive = alive.filter(t => t !== forced);
        gWeeks.push(w);
        continue;
      }
      if (!ws || alive.some(t => !ws.has(t)) || ![...ws.values()].some(p => p > 0)) break;   // week not scored yet
      const min = Math.min(...alive.map(t => ws.get(t)!));
      const lowest = alive.filter(t => Math.abs(ws.get(t)! - min) < 0.005);
      if (lowest.length > 1) {
        flags.push({ kind: "guillotine_tie", week: w, teams: lowest, message: `Week ${w}: ${lowest.length} teams tied for the lowest score (${min.toFixed(2)}). Pick who is eliminated.` });
        break;
      }
      eliminations.push({ week: w, team_id: lowest[0]!, points: min, status: status(w) });
      alive = alive.filter(t => t !== lowest[0]);
      gWeeks.push(w);
    }
    if (alive.length === 1) {
      add({ kind: "guillotine", week: null, place: null, label: "Guillotine (last team standing)", team_id: alive[0]!, amount: P.guillotine.amount, status: status(...gWeeks) });
    }
  }

  // Playoffs: round winners advance; the champion collects every round he won.
  let champion: string | null = null, championStatus: "projected" | "final" = "projected";
  if (P.playoffs) {
    const [w1, w2, w3] = P.playoffs.weeks;
    const overrideWinners = (kind: string, week: number) => {
      const o = (input.overrides ?? []).filter(x => x.kind === kind && x.week === week).map(x => x.team_id);
      return o.length ? o : null;
    };
    let undecided = false;   // a tied game earlier in the bracket: later rounds can't be checked yet
    const round = (week: number, kind: string, label: string, amount: number, eligible: Set<string> | null, expected: number) => {
      const games = input.matchups.filter(m => m.week === week && (eligible ? eligible.has(m.home_team) && eligible.has(m.away_team) : m.is_playoff !== false));
      const forced = overrideWinners(kind, week);
      if (forced) return new Set(forced);
      if (!undecided && games.length && games.length !== expected) flags.push({ kind: "playoff_bracket", week, message: `Week ${week}: expected ${expected} playoff game(s), found ${games.length}.` });
      const winners = new Set<string>();
      for (const g of games) {
        if (g.home_score == null || g.away_score == null) continue;
        if (Math.abs(g.home_score - g.away_score) < 0.005) {
          // A tie splits this game's round money; the league tiebreaker (regular-season standing) decides who advances.
          for (const x of splitEven(amount, [g.home_team, g.away_team])) add({ kind, week, place: null, label: label + " (tie: split)", team_id: x.team_id, amount: x.amount, status: status(week) });
          const order = input.standingsOrder ?? [];
          const ra = order.indexOf(g.home_team), rb = order.indexOf(g.away_team);
          if (ra < 0 || rb < 0) {
            undecided = true;
            flags.push({ kind: "playoff_tie", week, teams: [g.home_team, g.away_team], message: `Week ${week}: ${g.away_team} and ${g.home_team} tied at ${g.home_score.toFixed(2)}. The round money is split; pick who advances (no standings to break the tie).` });
            continue;
          }
          const adv = ra < rb ? g.home_team : g.away_team;
          winners.add(adv);
          flags.push({ kind: "playoff_tie", week, teams: [g.home_team, g.away_team], message: `Week ${week}: ${g.away_team} and ${g.home_team} tied at ${g.home_score.toFixed(2)}. Round money split; ${adv} advances on the tiebreaker (better regular-season standing).` });
          continue;
        }
        const win = g.home_score > g.away_score ? g.home_team : g.away_team;
        winners.add(win);
        add({ kind, week, place: null, label, team_id: win, amount, status: status(week) });
      }
      return winners;
    };
    const r1 = round(w1, "playoff_r1", "Playoffs: round 1 win", P.playoffs.r1, null, P.playoffs.r1_games);
    const r2 = r1.size ? round(w2, "playoff_r2", "Playoffs: round 2 win", P.playoffs.r2, r1, P.playoffs.r2_games) : new Set<string>();
    const champ = r2.size ? round(w3, "champion", "Champion", P.playoffs.champion, r2, 1) : new Set<string>();
    if (champ.size === 1) { champion = [...champ][0]!; championStatus = status(w3); }
  }

  // Season points
  if (P.season_points) {
    const totals = new Map<string, number>();
    const weeks: number[] = [];
    for (let w = P.season_points.first_week; w <= P.season_points.last_week; w++) {
      weeks.push(w);
      for (const [t, p] of byWeek.get(w) ?? []) totals.set(t, (totals.get(t) ?? 0) + p);
    }
    if (totals.size) {
      for (const g of pooledPlaces([...totals].map(([team_id, points]) => ({ team_id, points: Math.round(points * 100) / 100 })), P.season_points.amounts)) {
        for (const sh of g.shares) {
          add({ kind: "season_points", week: null, place: g.place, label: `Most points: ${g.tied ? "tied for " : ""}${ordinal(g.place)}`,
            team_id: sh.team_id, amount: sh.amount, status: status(...weeks), note: `${(totals.get(sh.team_id) ?? 0).toFixed(2)} points` });
        }
      }
    }
  }

  // Pools: Survivor winner(s) split the prize; Pick'em pays the Confidence pool's season standings (ties pooled).
  if (P.survivor && input.pools?.survivor?.decided && input.pools.survivor.winners.length) {
    const w = input.pools.survivor.winners;
    for (const sh of splitEven(P.survivor.amount, w)) {
      add({ kind: "survivor", week: null, place: null, label: `Survivor${w.length > 1 ? ` (${w.length}-way split)` : ""}`, team_id: sh.team_id, amount: sh.amount, status: "final" });
    }
  }
  if (P.pickem && input.pools?.pickem && input.pools.pickem.totals.some(t => t.points > 0)) {
    const pk = input.pools.pickem;
    for (const g of pooledPlaces(pk.totals, P.pickem.amounts)) {
      for (const sh of g.shares) {
        add({ kind: "pickem", week: null, place: g.place, label: `Pick'em: ${g.tied ? "tied for " : ""}${ordinal(g.place)}`, team_id: sh.team_id, amount: sh.amount,
          status: pk.complete ? "final" : "projected", note: `${pk.totals.find(t => t.team_id === sh.team_id)?.points ?? 0} confidence points` });
      }
    }
  }

  // Empire pot
  const balance = dollars(cents(s.empire_carry_in) + cents(s.empire_contribution));
  let empire: Empire = { balance, defending: s.empire_defending_team, outcome: "watch", champion, next_carry_in: balance };
  if (champion && championStatus === "final") {
    if (s.empire_defending_team && champion === s.empire_defending_team) {
      add({ kind: "empire", week: null, place: null, label: "Empire pot (back-to-back champion)", team_id: champion, amount: balance, status: "final" });
      empire = { ...empire, outcome: "paid", next_carry_in: 0 };
    } else {
      empire = { ...empire, outcome: "rolled", next_carry_in: balance };
    }
  }

  // Seed check: the spreadsheet's recorded winners vs ours
  for (const [wk, seedTeam] of Object.entries(s.seed?.weekly_high ?? {})) {
    const w = Number(wk), ours = weeklyWinners.get(w);
    if (!ours) flags.push({ kind: "seed_mismatch", week: w, message: `Week ${w} high score: the spreadsheet says ${seedTeam}, but this site has no scores for week ${w}.` });
    else if (ours.length !== 1 || ours[0] !== seedTeam) flags.push({ kind: "seed_mismatch", week: w, teams: ours, message: `Week ${w} high score: the spreadsheet says ${seedTeam}, this site says ${ours.join(" & ")}.` });
  }
  for (const [wk, seedTeam] of Object.entries(s.seed?.guillotine ?? {})) {
    const w = Number(wk), ours = eliminations.find(e => e.week === w)?.team_id ?? input.guillotineOverrides?.get(w);
    if (ours !== seedTeam) flags.push({ kind: "seed_mismatch", week: w, message: `Week ${w} guillotine: the spreadsheet says ${seedTeam}, this site says ${ours ?? "nobody yet"}.` });
  }

  return { awards, eliminations, flags, empire, alive };
}
