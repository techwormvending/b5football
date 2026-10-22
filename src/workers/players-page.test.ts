/* Players page helpers (players.js, a classic browser script loaded into a VM context). */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const read = (f: string) => fs.readFileSync(path.resolve(import.meta.dirname, "../..", f), "utf8");
const ctx: Record<string, unknown> = { LEAGUE: { season: 2027, teams: [{ id: "0011", name: "Mac Daddies" }, { id: "0001", name: "NSFW" }] } };
vm.runInNewContext(read("route.js"), ctx);
vm.runInNewContext(read("players.js"), ctx);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const P = ctx.B5Players as any;
const R = ctx.B5Route as { parse(h: string, k: (x: string) => boolean): Record<string, unknown> };
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x));

test("row action: Add for free agents, Claim (with the reason) for locked/waivers, nothing when closed", () => {
  assert.equal(P.action({ status: "fcfs" }).kind, "add");
  const c = P.action({ status: "claims", reason: "Game has kicked off", until: "2027-09-14T04:00:00Z" });
  assert.equal(c.kind, "claim");
  assert.match(c.note, /^Game has kicked off · until Tue/);
  assert.equal(P.action({ status: "claims", reason: "On waivers until claims process" }).note, "On waivers until claims process");
  assert.equal(P.action({ status: "closed", reason: "Season closed" }).kind, null);
});

test("search by name or NFL team, filter by position", () => {
  const list = [{ name: "Joe Burrow", pos: "QB", nfl_team: "CIN" }, { name: "Ja'Marr Chase", pos: "WR", nfl_team: "CIN" }, { name: "Bo Nix", pos: "QB", nfl_team: "DEN" }];
  assert.deepEqual(P.filterPlayers(list, "cin", "").map((p: { name: string }) => p.name), ["Joe Burrow", "Ja'Marr Chase"]);
  assert.deepEqual(P.filterPlayers(list, "", "QB").map((p: { name: string }) => p.name), ["Joe Burrow", "Bo Nix"]);
  assert.deepEqual(P.filterPlayers(list, "nix", "WR"), []);
});

test("drag to rank moves one claim", () => {
  assert.deepEqual(plain(P.moveItem([1, 2, 3, 4], 0, 2)), [2, 3, 1, 4]);
  assert.deepEqual(plain(P.moveItem([1, 2, 3, 4], 3, 0)), [4, 1, 2, 3]);
  assert.deepEqual(plain(P.moveItem([1, 2, 3], 1, 9)), [1, 3, 2]);
});

test("transaction lines", () => {
  const names = { a: "Joe Burrow", b: "Bo Nix" };
  assert.equal(P.txnText({ team_id: "0011", type: "add_drop", players_in: ["a"], players_out: ["b"], via: "waiver", status: "processed" }, names),
    "Mac Daddies added Joe Burrow, dropped Bo Nix (waiver claim)");
  assert.equal(P.txnText({ team_id: "0001", type: "drop", players_in: [], players_out: ["b"], via: "free_agent", status: "reversed" }, names), "NSFW dropped Bo Nix — reversed");
  assert.equal(P.txnText({ team_id: "0001", type: "add", players_in: ["mfl:16000"], players_out: [], via: "mfl", status: "processed" }, names), "NSFW added MFL player 16000 (on MFL)");
});

test("calendar text comes from the season's settings", () => {
  const t = P.calendarText({ rounds: 8, dropLockHours: 24, rosterMax: 18, waiversStart: { isodow: 1, time: "22:00" }, process: { isodow: 3, time: "17:00" } });
  assert.match(t, /Monday 10:00 PM ET every free agent goes on waivers/);
  assert.match(t, /Wednesday 5:00 PM ET \(worst-to-first by total points, up to 8 rounds\)/);
  assert.match(t, /claims-only for 24 hours\. Rosters max 18\./);
});

test("routes: #players and its tabs", () => {
  assert.deepEqual(plain(R.parse("#players/claims", () => true)), { page: "players", week: null, tab: "claims" });
  assert.equal(R.parse("#players", k => k === "players").page, "players");
  assert.equal(R.parse("#players/bogus", k => k === "players").page, "home");
});
