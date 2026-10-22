/* B5 Bot: automatic message-board posts (no author, is_bot), written by scripts/board-bot.mts in
   the nightly workflow after payouts.
   - Weekly recap, once a week is final (score_weeks.status = final): high score (and the $ it
     won), the guillotine chop, the biggest blowout and the closest game.
   - Payout awards as they become final (status final). Weekly high scores are left to the recap.
   Each post has a key (recap:<season>:<week>, award:<season>:<kind>:<week>:<place>:<team>) kept
   in board_bot_keys, so nothing is posted twice. The first run only records what already exists
   (no flood of old weeks); a type switched off in Commish is recorded as seen, not posted. */

export interface BotSettings { auto_recap: boolean; auto_awards: boolean }
export interface TeamScore { week: number; team_id: string; points: number }
export interface Matchup { week: number; home_team: string; away_team: string; home_score: number | null; away_score: number | null }
export interface Award { kind: string; week: number | null; place: number | null; label: string; team_id: string; amount: number; status: string }
export interface Chop { week: number; team_id: string; points: number | null }
export interface BotPost { key: string; title: string; body: string }

const n1 = (x: number) => (Math.round(x * 10) / 10).toFixed(1);
const money = (x: number) => (Number.isInteger(x) ? `$${x}` : `$${x.toFixed(2)}`);
const names = (ids: string[], name: (id: string) => string) => {
  const l = ids.map(name);
  return l.length <= 1 ? l.join("") : `${l.slice(0, -1).join(", ")} and ${l[l.length - 1]}`;
};

export const recapKey = (season: number, week: number) => `recap:${season}:${week}`;
export const awardKey = (season: number, a: Award) => `award:${season}:${a.kind}:${a.week ?? ""}:${a.place ?? ""}:${a.team_id}`;

/** The week's recap, or null when its scores aren't in. */
export function weeklyRecap(o: { season: number; week: number; scores: TeamScore[]; matchups: Matchup[]; awards: Award[]; chops: Chop[]; name: (id: string) => string }): BotPost | null {
  const scores = o.scores.filter(s => s.week === o.week);
  const games = o.matchups.filter(m => m.week === o.week && m.home_score != null && m.away_score != null);
  if (!scores.length && !games.length) return null;
  const lines: string[] = [];
  if (scores.length) {
    const top = Math.max(...scores.map(s => s.points));
    const winners = scores.filter(s => s.points === top).map(s => s.team_id);
    const prize = o.awards.filter(a => a.kind === "weekly_high" && a.week === o.week);
    const each = prize.length ? prize[0]!.amount : null;
    lines.push(`🏆 **High score:** ${names(winners, o.name)}, ${n1(top)}${each != null ? ` (${money(each)}${winners.length > 1 ? " each" : ""})` : ""}`);
  }
  const chop = o.chops.find(c => c.week === o.week);
  if (chop) lines.push(`🪓 **Guillotine:** ${o.name(chop.team_id)} chopped${chop.points != null ? ` (${n1(chop.points)})` : ""}`);
  if (games.length) {
    const margin = (m: Matchup) => Math.abs(m.home_score! - m.away_score!);
    const line = (m: Matchup) => {
      const homeWon = m.home_score! >= m.away_score!;
      const [w, l, ws, ls] = homeWon ? [m.home_team, m.away_team, m.home_score!, m.away_score!] : [m.away_team, m.home_team, m.away_score!, m.home_score!];
      return `${o.name(w)} ${n1(ws)} – ${o.name(l)} ${n1(ls)} (by ${n1(margin(m))})`;
    };
    const sorted = [...games].sort((a, b) => margin(b) - margin(a));
    lines.push(`💥 **Biggest blowout:** ${line(sorted[0]!)}`);
    if (games.length > 1) lines.push(`😬 **Closest game:** ${line(sorted[sorted.length - 1]!)}`);
  }
  return { key: recapKey(o.season, o.week), title: `Week ${o.week} recap`, body: lines.join("\n") };
}

export function awardPost(season: number, a: Award, name: (id: string) => string): BotPost {
  return { key: awardKey(season, a), title: `💰 ${a.label}: ${name(a.team_id)}`, body: `**${name(a.team_id)}** wins **${a.label}**: ${money(a.amount)}. It's final.` };
}

/** What to post now, and every key to record. */
export function planBotPosts(o: {
  season: number; settings: BotSettings; seen: Set<string>; finalWeeks: number[];
  scores: TeamScore[]; matchups: Matchup[]; awards: Award[]; chops: Chop[]; name: (id: string) => string;
}): { posts: BotPost[]; keys: { key: string; posted: boolean }[] } {
  const firstRun = o.seen.size === 0;
  const posts: BotPost[] = [], keys: { key: string; posted: boolean }[] = [];
  const consider = (p: BotPost | null, on: boolean) => {
    if (!p || o.seen.has(p.key) || keys.some(k => k.key === p.key)) return;
    const post = on && !firstRun;
    keys.push({ key: p.key, posted: post });
    if (post) posts.push(p);
  };
  for (const w of [...o.finalWeeks].sort((a, b) => a - b))
    consider(weeklyRecap({ season: o.season, week: w, scores: o.scores, matchups: o.matchups, awards: o.awards, chops: o.chops, name: o.name }), o.settings.auto_recap);
  for (const a of o.awards.filter(x => x.status === "final" && x.kind !== "weekly_high"))
    consider(awardPost(o.season, a, o.name), o.settings.auto_awards);
  return { posts, keys };
}
