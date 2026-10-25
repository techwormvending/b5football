/* playername.js: the player schedule pop-up (pure helpers and the open/close rules). */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ctx: Record<string, unknown> = {};
vm.runInNewContext(fs.readFileSync(path.resolve(import.meta.dirname, "../../playername.js"), "utf8"), ctx);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const P = ctx.B5Player as any;
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x));

// A 17-week season: KC plays everyone else, bye in week 10; weeks 1-17 all have games.
const games: { week: number; home: string; away: string; kickoff: string }[] = [];
for (let w = 1; w <= 17; w++) {
  const k = new Date(Date.UTC(2026, 8, 13 + (w - 1) * 7, 17, 0)).toISOString();   // Sundays, 1:00 PM EDT
  games.push({ week: w, home: "BUF", away: "MIA", kickoff: k });
  if (w !== 10) games.push({ week: w, home: w % 2 ? "KC" : "LV", away: w % 2 ? "LV" : "KC", kickoff: k });
}

describe("schedule", () => {
  test("remaining weeks run from the current week to 17, with home/away and kickoff", () => {
    const s = plain(P.remainingSchedule(games, "KC", 8));
    assert.deepEqual(s.rows.map((r: { week: number }) => r.week), [8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
    assert.deepEqual(s.rows[0], { week: 8, bye: false, home: false, opp: "LV", kickoff: games.find(g => g.week === 8)!.kickoff, playoff: false });
    assert.equal(s.rows[1].home, true);
    assert.equal(s.byeDone, null);
  });
  test("the bye week is flagged in the list; once it's passed it's 'done'", () => {
    const s = plain(P.remainingSchedule(games, "KC", 8));
    assert.deepEqual(s.rows.find((r: { week: number }) => r.week === 10), { week: 10, bye: true, playoff: false });
    const later = plain(P.remainingSchedule(games, "KC", 12));
    assert.equal(later.byeDone, 10);
    assert.equal(later.rows.some((r: { bye: boolean }) => r.bye), false);
  });
  test("fantasy playoff weeks 15-17 are marked; week 18 is never listed", () => {
    const withWk18 = games.concat([{ week: 18, home: "KC", away: "DEN", kickoff: "2027-01-10T18:00:00Z" }]);
    const s = plain(P.remainingSchedule(withWk18, "KC", 14));
    assert.deepEqual(s.rows.map((r: { week: number; playoff: boolean }) => [r.week, r.playoff]), [[14, false], [15, true], [16, true], [17, true]]);
  });
  test("current week = the first week whose last kickoff was under 5 hours ago", () => {
    const wk7 = Date.parse(games.find(g => g.week === 7)!.kickoff);
    assert.equal(P.currentWeek(games, wk7 + 4 * 3600e3), 7);
    assert.equal(P.currentWeek(games, wk7 + 6 * 3600e3), 8);
  });
  test("the pop-up body: header with status tag, BYE row, playoffs, times ET, legend", () => {
    const now = Date.parse(games.find(g => g.week === 8)!.kickoff) - 3600e3;
    const html = String(P.bodyHtml({ name: "Patrick Mahomes", pos: "QB", nfl: "KC", status: "Questionable" },
      { games, grades: plain(P.matchupGrades([{ team: "LV", pos: "QB", avg: 25 }, { team: "BUF", pos: "QB", avg: 15 }, { team: "MIA", pos: "QB", avg: 10 }])), cache: {} }, now));
    assert.match(html, /<b>Patrick Mahomes<\/b> <span class="pn-tag">Q<\/span>/);
    assert.match(html, /pn-row bye"><span class="pn-wk">10<\/span><b class="pn-bye">BYE<\/b>/);
    assert.match(html, /pn-row po"><span class="pn-wk">15<\/span>.*Playoffs/);
    assert.match(html, /pn-row now"><span class="pn-wk">8<\/span><span class="pn-opp"><i class="pn-dot good"[^>]*><\/i>@ LV<\/span><span class="pn-ko">Sun, 11\/1, 12:00 PM<\/span>/, "17:00 UTC is noon ET once DST ends (Nov 1)");
    assert.match(html, /Weeks 8–17 · times ET/);
    assert.match(html, /fantasy points the opponent allows to QBs/);
    assert.doesNotMatch(String(P.bodyHtml({ name: "X<script>", pos: "QB", nfl: "KC" }, { games, grades: {}, cache: {} }, now)), /<script>/, "escaped");
  });
});

test("matchup colors: thirds by points allowed per game, per position", () => {
  const rows = ["A", "B", "C", "D", "E", "F"].map((t, i) => ({ team: t, pos: "RB", avg: 30 - i * 3 }));
  assert.deepEqual(plain(P.matchupGrades(rows)).RB, { A: "good", B: "good", C: "ok", D: "ok", E: "bad", F: "bad" });
});

test("placement: below, else above, else the roomier side; always inside a 390 px screen", () => {
  const r = (top: number, left = 300) => ({ top, bottom: top + 20, left });
  assert.deepEqual(plain(P.place(r(100), 300, 390, 844)), { left: 42, top: 124, width: 340, maxHeight: 712, above: false }, "pushed left so 340 px fits (390 - 340 - 8)");
  assert.equal(P.place(r(700), 300, 390, 844).above, true, "flips above near the bottom");
  assert.equal(P.place(r(700), 300, 390, 844).top, 396);
  const tight = P.place(r(300), 900, 390, 844);
  assert.equal(tight.above, false, "neither fits: the side with more room, scrolling");
  assert.ok(P.place(r(100, 0), 200, 320, 600).width <= 304, "narrow phone: width = screen minus margins");
});

describe("open / close rules", () => {
  function harness() {
    const log: string[] = [];
    let timers: { fn: () => void; ms: number; id: number }[] = [], next = 1;
    const c = P.createController({
      open: (el: string) => log.push("open " + el), close: () => log.push("close"),
      setTimeout: (fn: () => void, ms: number) => { const id = next++; timers.push({ fn, ms, id }); return id; },
      clearTimeout: (id: number) => { timers = timers.filter(t => t.id !== id); }
    });
    const tick = () => { const t = timers; timers = []; t.forEach(x => x.fn()); };
    return { c, log, tick, pending: () => timers.map(t => t.ms) };
  }
  test("hover: opens after ~300 ms, not before; leaving closes; the pop-up itself keeps it open", () => {
    const h = harness();
    h.c.hoverName("goff");
    assert.deepEqual(h.log, [], "nothing at once");
    assert.deepEqual(h.pending(), [300]);
    h.tick();
    assert.deepEqual(h.log, ["open goff"]);
    h.c.leaveName(); h.c.hoverPopup();       // moving onto the pop-up cancels the close
    h.tick();
    assert.deepEqual(h.log, ["open goff"]);
    h.c.leavePopup(); h.tick();
    assert.deepEqual(h.log, ["open goff", "close"]);
    h.c.hoverName("kelce"); h.c.leaveName(); h.tick();
    assert.deepEqual(h.log, ["open goff", "close"], "a pass-by under 300 ms opens nothing");
  });
  test("tap: opens at once, tapping the name again or outside closes", () => {
    const h = harness();
    h.c.tapName("goff"); assert.deepEqual(h.log, ["open goff"]);
    h.c.tapName("goff"); assert.deepEqual(h.log, ["open goff", "close"]);
    h.c.tapName("goff"); h.c.tapName("kelce"); h.c.tapOutside();
    assert.deepEqual(h.log.slice(2), ["open goff", "open kelce", "close"]);
  });
  test("keyboard: focus opens, Esc closes and hands back the name, moving focus away closes", () => {
    const h = harness();
    h.c.focusName("goff"); assert.deepEqual(h.log, ["open goff"]);
    assert.equal(h.c.escape(), "goff");
    assert.deepEqual(h.log, ["open goff", "close"]);
    h.c.focusName("kelce"); h.c.blur();
    assert.deepEqual(h.log.slice(2), ["open kelce", "close"]);
  });
});

test("markup: escaped, focusable unless inside a button, describes the player", () => {
  const html = String(P.html({ id: "00-1", name: 'Ja"Marr <b>', pos: "WR", nfl: "CIN", status: "Out" }));
  assert.match(html, /^<span class="pn" data-pn-id="00-1" data-pn-name="Ja&quot;Marr &lt;b&gt;" data-pn-pos="WR" data-pn-nfl="CIN" data-pn-status="Out" tabindex="0" aria-haspopup="dialog">Ja&quot;Marr &lt;b&gt;<\/span>$/);
  assert.doesNotMatch(String(P.html({ name: "A", pos: "QB", nfl: "KC" }, { focusable: false })), /tabindex/);
});
