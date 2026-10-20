/* Week buttons keep you on the page you're on (bug 2026-10-20: the Confidence Pool's week
   buttons opened the Schedule, because the Schedule's click handler matched any [data-week]). */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const read = (f: string) => fs.readFileSync(path.resolve(import.meta.dirname, "../..", f), "utf8");
const ctx: Record<string, unknown> = { LEAGUE: { season: 2026, teams: [] } };
vm.runInNewContext(read("route.js"), ctx);
vm.runInNewContext(read("pools.js"), ctx);
const R = ctx.B5Route as { parse(hash: string, known: (k: string) => boolean): { page: string; week: number | null } };
const P = ctx.B5Pools as { weekChipsHtml(cfg: { start_week: number; end_week: number }, week: number): string };
const PAGES = new Set(["home", "myteam", "schedule", "teams", "payouts", "survivor", "confidence", "history", "rules", "traditions", "account", "commish", "commish-payouts"]);
const known = (k: string) => PAGES.has(k);

test("every Confidence week button links back to the Confidence page with that week", () => {
  const html = P.weekChipsHtml({ start_week: 1, end_week: 17 }, 7);
  const links = [...html.matchAll(/<a [^>]*href="([^"]+)"[^>]*>(\d+)<\/a>/g)];
  assert.equal(links.length, 17);
  for (const [, href, label] of links) {
    assert.deepEqual({ ...R.parse(href!, known) }, { page: "confidence", week: Number(label) }, `${href} must stay on the pool`);
  }
  assert.match(html, /class="wk active" href="#confidence\/7"/, "the current week is highlighted");
});

test("no pool button carries the Schedule's week attribute (the Schedule handler can't grab it)", () => {
  assert.doesNotMatch(read("pools.js"), /data-sched-week|data-week=/);
  const app = read("app.js");
  assert.match(app, /closest\("\[data-sched-week\]"\)/);
  assert.match(app, /curPage !== "schedule"/, "the Schedule's week handler only acts on the Schedule page");
});

test("routes: pool weeks, old #pool links, matchups, old #lineups, unknown pages", () => {
  assert.deepEqual({ ...R.parse("#confidence/12", known) }, { page: "confidence", week: 12 });
  assert.deepEqual({ ...R.parse("#pool/7", known) }, { page: "confidence", week: 7 });
  assert.deepEqual({ ...R.parse("#confidence", known) }, { page: "confidence", week: null });
  assert.deepEqual({ ...R.parse("#survivor", known) }, { page: "survivor", week: null });
  assert.deepEqual({ ...R.parse("#matchup/3/0005-0006", known) }, { page: "matchup", week: 3, away: "0005", home: "0006" });
  assert.deepEqual({ ...R.parse("#lineups", known) }, { page: "myteam", week: null });
  assert.deepEqual({ ...R.parse("#nope", known) }, { page: "home", week: null });
  assert.deepEqual({ ...R.parse("", known) }, { page: "home", week: null });
});
