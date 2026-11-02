/* Money is for members (2026-11-01): signed-out visitors see no dollar amounts anywhere.
   The database refuses anon (rls.test.ts "money is for members"); these tests cover the pages:
   no amounts in any committed page text, Payouts gone from the signed-out nav, #payouts and team
   winnings signed out, and the member view unchanged. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const read = (f: string) => fs.readFileSync(path.resolve(import.meta.dirname, "../..", f), "utf8");
const AMOUNT = /\$\s?\d/;

test("no dollar amounts in any committed page file or the league data (they come from the database, members only)", () => {
  const pages = fs.readdirSync(path.resolve(import.meta.dirname, "../..")).filter(f => /\.(js|html|css)$/.test(f));
  assert.ok(pages.includes("league-data.js") && pages.includes("payouts.js"));
  for (const f of pages) {
    // Code that formats an amount ("$" + n) is fine; a literal amount in text isn't
    const lits = [...read(f).matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g)].map(m => m[2]!).filter(s => AMOUNT.test(s.replace(/\$\{[^}]*\}/g, "").replace(/\$\d(?![\d,.])/g, "")));   // ${x} and $1 regex placeholders aren't amounts
    assert.deepEqual(lits, [], f);
  }
  const ctx: Record<string, unknown> = { window: {} };
  vm.runInNewContext(read("league-data.js"), ctx);
  assert.doesNotMatch(JSON.stringify((ctx.window as Record<string, unknown>).LEAGUE), AMOUNT, "league-data.js");
  assert.doesNotMatch(read("CLAUDE.md"), AMOUNT, "CLAUDE.md describes the rules without the league's amounts");
  assert.doesNotMatch(read("README.md"), AMOUNT);
  for (const f of fs.readdirSync(path.resolve(import.meta.dirname, "../../supabase/migrations"))) {
    const sql = read("supabase/migrations/" + f).replace(/\$\d\b/g, "");   // $1 placeholders
    assert.doesNotMatch(sql, AMOUNT, f);
  }
});

test("signed out: Payouts isn't in the nav or More; members see it", () => {
  const ctx: Record<string, unknown> = {};
  vm.runInNewContext(read("nav.js"), ctx);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const N = ctx.B5Nav as any;
  assert.doesNotMatch(N.topHtml({ signedIn: false, roles: [] }, {}) + N.moreHtml({ signedIn: false, roles: [] }), /#payouts|Payouts/);
  assert.doesNotMatch(N.topHtml({ signedIn: true, name: "X", roles: [], member: false }, {}), /#payouts/, "signed in but not on a team");
  assert.match(N.topHtml({ signedIn: true, name: "Mike", roles: [], member: true }, {}), /<a href="#payouts">Payouts<\/a>/);
  assert.match(N.moreHtml({ signedIn: true, name: "Mike", roles: [], member: true }), /href="#payouts"/);
});

/** payouts.js with a stubbed account and Data API; returns the page HTML and the requests made. */
async function payoutsAs(me: unknown) {
  const calls: string[] = [];
  const ctx: Record<string, unknown> = {
    LEAGUE: { season: 2026, teams: [{ id: "0001", name: "NSFW" }] },
    B5_SUPABASE: { configured: true, url: "https://x.supabase.co", publishableKey: "k" },
    B5Auth: { api: (_c: unknown, _s: unknown, p: string) => { calls.push(p); return Promise.resolve({ ok: true, data: p.startsWith("rpc/") ? { buy_in: 100, prizes: {} } : [] }); } },
    B5Account: { load: () => Promise.resolve(me), refreshNav() {}, seesMoney: (m: { teams: unknown[] } | null) => !!(m && m.teams.length) }
  };
  vm.runInNewContext(read("teamlink.js"), ctx);
  vm.runInNewContext(read("payouts.js"), ctx);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const P = ctx.B5Payouts as any;
  const el = { innerHTML: "" };
  P.start("public", el);
  await new Promise(r => setTimeout(r, 20));
  const won = await P.teamWinnings();
  return { html: el.innerHTML, calls, won };
}

test("signed out: #payouts says sign in and asks the database for nothing; team winnings are empty", async () => {
  const out = await payoutsAs(null);
  assert.match(out.html, /Sign in to view payouts\./);
  assert.doesNotMatch(out.html, AMOUNT);
  assert.deepEqual(out.calls, [], "no money requests at all");
  assert.deepEqual(JSON.parse(JSON.stringify(out.won)), {}, "no season winnings on team pages");
  const stranger = await payoutsAs({ session: {}, profile: {}, teams: [] });
  assert.match(stranger.html, /Payouts are for league members/);
});

test("member: the payouts page loads the amounts (season_money and awards) as before", async () => {
  const out = await payoutsAs({ session: { access_token: "t" }, profile: {}, teams: [{ team_id: "0001" }] });
  assert.ok(out.calls.includes("rpc/season_money"), out.calls.join(", "));
  assert.ok(out.calls.some(c => c.startsWith("awards?")));
  assert.doesNotMatch(out.html, /Sign in to view payouts/);
});
