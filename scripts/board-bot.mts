/* B5 Bot: post the weekly recap and final payout awards to the message board (src/league/boardBot.ts).
   Run nightly by the finalize workflow, after payouts. Server job (service_role); posts carry no author.
   Usage:  node scripts/board-bot.mts [season]      default 2026
   Env:    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (Actions secret; never in the repo) */

import { planBotPosts, type Award, type BotSettings, type Chop, type Matchup, type TeamScore } from "../src/league/boardBot.ts";
import { sbBase, sbHeaders, selectAll, type SbConfig } from "../src/league/supabaseRest.ts";

const url = process.env.SUPABASE_URL, serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) { console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."); process.exit(1); }
const sb: SbConfig = { url, serviceKey };
const season = Number(process.argv[2]) || 2026;
const all = <T>(table: string, q: string) => selectAll<T>(sb, table, q);
const post = async (path: string, body: unknown, prefer = "return=representation") => {
  const r = await fetch(sbBase(sb) + path, { method: "POST", headers: sbHeaders(sb, { Prefer: prefer }), body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
  return prefer.includes("representation") ? r.json() : null;
};

const [settings] = await all<BotSettings>("board_settings", "select=auto_recap,auto_awards");
const [seenRows, teams, weeks, scores, matchups, awards, chops] = await Promise.all([
  all<{ key: string }>("board_bot_keys", "select=key"),
  all<{ id: string; name: string }>("teams", "select=id,name"),
  all<{ week: number }>("score_weeks", `season=eq.${season}&status=eq.final&select=week`),
  all<TeamScore>("team_scores", `season=eq.${season}&select=week,team_id,points`),
  all<Matchup>("matchups", `season=eq.${season}&select=week,home_team,away_team,home_score,away_score`),
  all<Award>("awards", `season=eq.${season}&select=kind,week,place,label,team_id,amount,status`),
  all<Chop>("guillotine", `season=eq.${season}&select=week,team_id,points`)
]);
const names = new Map(teams.map(t => [t.id, t.name]));
const num = (x: unknown) => (x == null ? null : Number(x));
const plan = planBotPosts({
  season, settings: settings ?? { auto_recap: true, auto_awards: true }, seen: new Set(seenRows.map(r => r.key)),
  finalWeeks: weeks.map(w => w.week),
  scores: scores.map(s => ({ ...s, points: Number(s.points) })),
  matchups: matchups.map(m => ({ ...m, home_score: num(m.home_score), away_score: num(m.away_score) })),
  awards: awards.map(a => ({ ...a, amount: Number(a.amount) })),
  chops: chops.map(c => ({ ...c, points: num(c.points) })),
  name: id => names.get(id) ?? id
});

for (const p of plan.posts) {
  // One thread per key (source_key is unique): a re-run after a partial failure won't duplicate.
  const [t] = await post("board_threads?on_conflict=source_key", [{ title: p.title, is_bot: true, source_key: p.key }],
    "resolution=ignore-duplicates,return=representation") as { id: number }[];
  if (!t) { console.log(`exists: ${p.key}`); continue; }
  await post("board_posts", [{ thread_id: t.id, is_bot: true, is_opener: true, body: p.body }], "return=minimal");
  console.log(`posted: ${p.title}`);
}
if (plan.keys.length) await post("board_bot_keys?on_conflict=key", plan.keys, "resolution=merge-duplicates,return=minimal");
console.log(`B5 Bot ${season}: ${plan.posts.length} posted, ${plan.keys.length - plan.posts.length} recorded without posting${seenRows.length ? "" : " (first run: existing results recorded, nothing posted)"}`);
