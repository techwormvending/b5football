/* Tests for myteam.js's pure helpers (classic browser script, loaded into a VM context). */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

interface MyTeam {
  lineupsOpen(L: unknown): boolean;
  recordFor(L: unknown, id: string): null | { w: number; l: number; t: number; pf: number; pa: number; rank: number; of: number };
  leagueRoster(L: unknown, id: string): { name: string; pos: string; nfl: string; acquired: string }[];
  pickWeek(games: { week: number; kickoff: string }[], now: number): number | null;
  draftFrom(slots: { slot: number; player_id: string }[], prev: { slot: number; player_id: string }[], prevWeek: number):
    { draft: (string | null)[]; saved: boolean; carried: number | null };
  kickoffFor(games: { home: string; away: string; kickoff: string }[], team: string): number | null;
}
const ctx: Record<string, unknown> = {};
vm.runInNewContext(fs.readFileSync(path.resolve(import.meta.dirname, "../../teamlink.js"), "utf8"), ctx);
vm.runInNewContext(fs.readFileSync(path.resolve(import.meta.dirname, "../../myteam.js"), "utf8"), ctx);
const M = ctx.B5MyTeam as MyTeam;
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x));   // VM-realm objects -> this realm, for deepEqual

const L = {
  season: 2026, lineupsFrom: 2027,
  standings: { rows: [["0010", 4, 1, 0, 559.9, 454.6], ["0001", 4, 1, 0, 531.8, 490.9], ["0002", 1, 4, 0, 400, 500]] },
  rosters: { teams: { "0001": [["Ja'Marr Chase", "WR", "CIN", "1.02", "1"], ["Joe Burrow", "QB", "CIN", "4.07", "2"],
    ["Steelers", "DEF", "PIT", "Waiv", "3"], ["Bijan Robinson", "RB", "ATL", "1.01", "4"], ["Puka Nacua", "WR", "LAR", "", "5"]] } }
};

test("lineups open from LEAGUE.lineupsFrom (2027), not before, and not without the setting", () => {
  assert.equal(M.lineupsOpen(L), false);
  assert.equal(M.lineupsOpen({ ...L, season: 2027 }), true);
  assert.equal(M.lineupsOpen({ season: 2027 }), false);
});

test("record and standings place come from the site's standings", () => {
  assert.deepEqual(plain(M.recordFor(L, "0001")), { w: 4, l: 1, t: 0, pf: 531.8, pa: 490.9, rank: 2, of: 3 });
  assert.equal(M.recordFor(L, "0099"), null);
  assert.equal(M.recordFor({}, "0001"), null);
});

test("roster is grouped QB RB WR TE K DEF, keeping order within a position", () => {
  assert.deepEqual(M.leagueRoster(L, "0001").map(p => `${p.pos} ${p.name} ${p.acquired}`),
    ["QB Joe Burrow 4.07", "RB Bijan Robinson 1.01", "WR Ja'Marr Chase 1.02", "WR Puka Nacua ", "DEF Steelers Waiv"]);
  assert.deepEqual(plain(M.leagueRoster(L, "0005")), []);
});

test("current week = first week whose last kickoff was under 5 hours ago", () => {
  const games = [
    { week: 6, kickoff: "2026-10-16T00:15:00Z" }, { week: 6, kickoff: "2026-10-20T00:15:00Z" },   // Thu ... Mon night
    { week: 7, kickoff: "2026-10-23T00:15:00Z" }, { week: 7, kickoff: "2026-10-27T00:15:00Z" }
  ];
  assert.equal(M.pickWeek(games, Date.parse("2026-10-18T17:00:00Z")), 6);
  assert.equal(M.pickWeek(games, Date.parse("2026-10-20T04:00:00Z")), 6, "Monday night game still on");
  assert.equal(M.pickWeek(games, Date.parse("2026-10-20T06:00:00Z")), 7);
  assert.equal(M.pickWeek(games, Date.parse("2027-01-30T00:00:00Z")), null, "season over");
  assert.equal(M.pickWeek([{ week: 1, kickoff: "" }], 0), null);
});

test("lineup draft: this week's saved slots, else last week's carried over", () => {
  const saved = M.draftFrom([{ slot: 0, player_id: "QB1" }, { slot: 8, player_id: "DEF:PIT" }], [{ slot: 0, player_id: "OLD" }], 6);
  assert.deepEqual(plain(saved), { draft: ["QB1", null, null, null, null, null, null, null, "DEF:PIT"], saved: true, carried: null });
  const carried = M.draftFrom([], [{ slot: 1, player_id: "RB1" }], 6);
  assert.deepEqual(plain(carried), { draft: [null, "RB1", null, null, null, null, null, null, null], saved: false, carried: 6 });
  assert.deepEqual(plain(M.draftFrom([], [], 0)), { draft: Array(9).fill(null), saved: false, carried: null });
});

test("kickoff for a player's team in the week, or null on a bye", () => {
  const wk = [{ home: "CIN", away: "PIT", kickoff: "2026-10-18T17:00:00Z" }];
  assert.equal(M.kickoffFor(wk, "PIT"), Date.parse("2026-10-18T17:00:00Z"));
  assert.equal(M.kickoffFor(wk, "CIN"), Date.parse("2026-10-18T17:00:00Z"));
  assert.equal(M.kickoffFor(wk, "DAL"), null);
});

test("database rosters group by team and position (QB RB WR TE K DEF)", () => {
  const R = (ctx.B5MyTeam as { rostersFromRows(rows: unknown[]): Record<string, { id: string; pos: string; nfl: string }[]> }).rostersFromRows([
    { team_id: "0011", player_id: "DEF:PIT", acquired: "Waiv", nfl_players: { name: "PIT Defense", position: "DEF", nfl_team: "PIT" } },
    { team_id: "0011", player_id: "00-1", acquired: "1.07", nfl_players: { name: "Jonathan Taylor", position: "RB", nfl_team: "IND" } },
    { team_id: "0011", player_id: "00-2", acquired: null, nfl_players: { name: "Joe Burrow", position: "QB", nfl_team: "CIN" } },
    { team_id: "0003", player_id: "00-3", acquired: "2.01", nfl_players: null }
  ]);
  assert.deepEqual(plain(R["0011"]!.map(p => p.id)), ["00-2", "00-1", "DEF:PIT"]);
  assert.equal(R["0003"]![0]!.id, "00-3", "a player missing from nfl_players still shows (by ID)");
});

test("matchup status: no week row = not started; live (with delay note); final; awaiting sign-off", () => {
  const T = (ctx.B5MyTeam as { statusText(s: unknown): string }).statusText;
  assert.equal(T(null), "Not started");
  assert.equal(T({ status: null, delayed: false }), "Not started");
  assert.equal(T({ status: "live", delayed: false }), "Live");
  assert.match(T({ status: "live", delayed: true }), /Live \(scoring delayed/);
  assert.equal(T({ status: "final" }), "Final");
  assert.equal(T({ status: "pending_review" }), "Final (awaiting commissioner sign-off)");
});

test("co-owners: team activity reads as who changed what; last change; the other owner's newer save is recognized", () => {
  const X = ctx.B5MyTeam as unknown as {
    activityText(a: unknown, names: Record<string, string>, players: Record<string, string>): string;
    lastChangedText(meta: unknown, names: Record<string, string>): string;
    isConflict(msg: string): boolean;
  };
  const names = { u1: "Adam", u2: "Mike" }, players = { p1: "Jared Goff", p2: "Matthew Stafford", p3: "Jahmyr Gibbs" };
  assert.equal(X.activityText({ kind: "lineup", week: 7, actor: "u2", details: { in: [{ slot: 0, player: "p1" }], out: [{ slot: 0, player: "p2" }] } }, names, players),
    "Mike changed the week 7 lineup (in: Jared Goff; out: Matthew Stafford)");
  assert.equal(X.activityText({ kind: "lineup", week: 7, actor: "u1", details: { in: [{ slot: 2, player: "p3" }], out: [{ slot: 1, player: "p3" }] } }, names, players),
    "Adam changed the week 7 lineup (moved: Jahmyr Gibbs)");
  assert.equal(X.activityText({ kind: "survivor", week: 8, actor: "u1", details: { picks: [{ op: "insert", nfl_team: "DET" }, { op: "update", nfl_team: "KC" }] } }, names, players),
    "Adam picked KC in Survivor (week 8)");
  assert.equal(X.activityText({ kind: "confidence", week: 8, actor: "u2", details: { picks: [{}, {}, {}] } }, names, players),
    "Mike updated the week 8 Confidence picks (3 changes)");
  assert.match(X.lastChangedText({ changed_by: "u2", changed_at: "2026-10-25T18:14:00Z" }, names), /^Lineup last changed by Mike, Sun 2:14 PM$/);
  assert.equal(X.lastChangedText(null, names), "");
  assert.equal(X.isConflict("Lineup changed by Mike at 2:14 PM since you opened it"), true);
  assert.equal(X.isConflict("Player x is locked: his game has kicked off"), false);
  assert.match(fs.readFileSync(path.resolve(import.meta.dirname, "../../myteam.js"), "utf8"), /p_expected_version: expected/, "saves send the version the page loaded");
});
