/* Survivor and Confidence pools: scoring rules (pure). Settings come from
   season_settings.pools (2026 defaults read from MFL league 22689).

   SURVIVOR
   - Each week pick one NFL team to win; never the same team twice (the database enforces it).
   - Loss or tie = eliminated. No pick by the week's last kickoff = eliminated
     (setting missed_pick_eliminates, default true; the commissioner's rule, to confirm).
   - Last team standing wins. If everyone left is eliminated the same week, they split.
     If several survive the final week, they split.
   - Results are only applied for games that are final; a week with a pending result
     stops the standings there (projected) until it's decided.

   CONFIDENCE (straight up, no spread)
   - Each week pick every game's winner and assign points 1..N (N = games that week),
     each value once (the database enforces it).
   - A correct pick earns its points; a wrong pick, a tied game or a missing pick earns 0.
   - Season standings over start..end weeks feed Pick'em 1st/2nd (ties split, in payouts.ts). */

export interface PoolSettings {
  survivor?: { start_week: number; end_week: number; missed_pick_eliminates?: boolean };
  confidence?: { start_week: number; end_week: number };
}
export interface NflGame {
  week: number; game_key: string; home: string; away: string;
  kickoff: string | null; home_score: number | null; away_score: number | null; status: string;
}
export interface SurvivorPick { week: number; team_id: string; nfl_team: string }
export interface ConfidencePick { week: number; team_id: string; game_key: string; pick: string; points: number }
export interface SurvivorStatus { team_id: string; alive: boolean; eliminated_week: number | null; reason: string | null; winner: boolean; picks_used: number }
export interface ConfidenceWeek { week: number; team_id: string; points: number; correct: number; decided: number; games: number }
export interface PoolFlag { kind: "survivor_reuse" | "survivor_bad_pick" | "confidence_values" | "confidence_bad_pick"; week?: number; team_id?: string; message: string }

/** Final result of a game: the winner, null for a tie, or "pending". */
export function gameResult(g: NflGame): string | null | "pending" {
  if (g.status !== "final" || g.home_score == null || g.away_score == null) return "pending";
  return g.home_score > g.away_score ? g.home : g.away_score > g.home_score ? g.away : null;
}

export function survivorStandings(input: { settings: PoolSettings; teams: string[]; picks: SurvivorPick[]; games: NflGame[]; now: number }): {
  status: SurvivorStatus[]; winners: string[]; decided: boolean; decidedWeek: number | null; flags: PoolFlag[];
} {
  const s = input.settings.survivor;
  const st = new Map<string, SurvivorStatus>(input.teams.map(t => [t, { team_id: t, alive: true, eliminated_week: null, reason: null, winner: false, picks_used: 0 }]));
  const flags: PoolFlag[] = [];
  if (!s) return { status: [...st.values()], winners: [], decided: false, decidedWeek: null, flags };
  const pick = new Map(input.picks.map(p => [`${p.week}|${p.team_id}`, p.nfl_team]));
  const used = new Map<string, Set<string>>();
  for (const p of input.picks) {
    const u = used.get(p.team_id) ?? new Set<string>();
    if (u.has(p.nfl_team)) flags.push({ kind: "survivor_reuse", week: p.week, team_id: p.team_id, message: `${p.team_id} picked ${p.nfl_team} twice.` });
    u.add(p.nfl_team); used.set(p.team_id, u);
    const x = st.get(p.team_id); if (x) x.picks_used++;
  }
  let alive = [...input.teams];
  let winners: string[] = [], decided = false, decidedWeek: number | null = null;
  const out = (t: string, w: number, reason: string) => { const x = st.get(t)!; x.alive = false; x.eliminated_week = w; x.reason = reason; };

  for (let w = s.start_week; w <= s.end_week && alive.length > 1; w++) {
    const games = input.games.filter(g => g.week === w);
    if (!games.length) continue;
    const kicks = games.map(g => (g.kickoff ? Date.parse(g.kickoff) : NaN)).filter(k => !isNaN(k));
    const weekOver = kicks.length > 0 && input.now >= Math.max(...kicks);
    const survivors: string[] = [], gone: string[] = [];
    let pending = false;
    for (const t of alive) {
      const p = pick.get(`${w}|${t}`);
      if (!p) {
        if (!weekOver) { pending = true; survivors.push(t); }
        else if (s.missed_pick_eliminates !== false) gone.push(t), out(t, w, "no pick");
        else survivors.push(t);
        continue;
      }
      const g = games.find(x => x.home === p || x.away === p);
      if (!g) { flags.push({ kind: "survivor_bad_pick", week: w, team_id: t, message: `Week ${w}: ${t} picked ${p}, who doesn't play that week.` }); pending = true; survivors.push(t); continue; }
      const r = gameResult(g);
      if (r === "pending") { pending = true; survivors.push(t); continue; }
      if (r === p) survivors.push(t);
      else { gone.push(t); out(t, w, r === null ? "tie" : "loss"); }
    }
    if (pending) { alive = survivors; break; }                     // standings stop at an undecided week
    if (!survivors.length) {                                        // everyone left went out together: they split
      winners = gone; decided = true; decidedWeek = w; alive = []; break;
    }
    alive = survivors;
    if (alive.length === 1) { winners = alive; decided = true; decidedWeek = w; }
  }
  // Several still alive after the last week (all decided): they split.
  if (!decided && alive.length > 1) {
    const last = input.games.filter(g => g.week === s.end_week);
    const lastDone = last.length > 0 && last.every(g => gameResult(g) !== "pending");
    const survivedLast = alive.every(t => { const p = pick.get(`${s.end_week}|${t}`); return !!p || (s.missed_pick_eliminates === false); });
    if (lastDone && survivedLast) { winners = alive; decided = true; decidedWeek = s.end_week; }
  }
  if (alive.length === 1 && !decided) { winners = alive; decided = true; }
  for (const w of winners) st.get(w)!.winner = true;
  return { status: [...st.values()], winners, decided, decidedWeek, flags };
}

export function confidenceScores(input: { settings: PoolSettings; teams: string[]; picks: ConfidencePick[]; games: NflGame[] }): {
  weekly: ConfidenceWeek[]; totals: { team_id: string; points: number }[]; complete: boolean; flags: PoolFlag[];
} {
  const c = input.settings.confidence;
  const flags: PoolFlag[] = [];
  if (!c) return { weekly: [], totals: [], complete: false, flags };
  const weekly: ConfidenceWeek[] = [];
  const totals = new Map<string, number>(input.teams.map(t => [t, 0]));
  let complete = true;
  for (let w = c.start_week; w <= c.end_week; w++) {
    const games = input.games.filter(g => g.week === w);
    if (!games.length) { complete = false; continue; }
    const results = new Map(games.map(g => [g.game_key, gameResult(g)]));
    const decided = [...results.values()].filter(r => r !== "pending").length;
    if (decided < games.length) complete = false;
    const weekPicks = input.picks.filter(p => p.week === w);
    for (const t of input.teams) {
      const mine = weekPicks.filter(p => p.team_id === t);
      if (!mine.length && !decided) continue;
      const values = mine.map(p => p.points);
      if (new Set(values).size !== values.length || values.some(v => v < 1 || v > games.length)) {
        flags.push({ kind: "confidence_values", week: w, team_id: t, message: `Week ${w}: ${t}'s confidence values aren't unique 1-${games.length}.` });
      }
      let points = 0, correct = 0;
      for (const p of mine) {
        const r = results.get(p.game_key);
        if (r === undefined) { flags.push({ kind: "confidence_bad_pick", week: w, team_id: t, message: `Week ${w}: ${t} picked ${p.game_key}, which isn't a week ${w} game.` }); continue; }
        if (r !== "pending" && r !== null && r === p.pick) { points += p.points; correct++; }
      }
      weekly.push({ week: w, team_id: t, points, correct, decided, games: games.length });
      totals.set(t, (totals.get(t) ?? 0) + points);
    }
  }
  return { weekly, totals: [...totals].map(([team_id, points]) => ({ team_id, points })), complete, flags };
}

/** MFL matchup "AWAY,HOME" (MFL team codes) -> our game key "AWAY@HOME". */
export function mflMatchupKey(matchup: string, canon: (code: string) => string): string {
  const [a, h] = matchup.split(",");
  return `${canon(a!)}@${canon(h!)}`;
}
