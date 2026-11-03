/* League history page helpers (history.js): titles and runner-ups per franchise, back-to-back champions,
   a team's title seasons, and names that are linked only once their lineage is approved. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ctx: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
ctx.globalThis = ctx;
ctx.LEAGUE = { teams: [{ id: "0001", name: "NSFW" }, { id: "0002", name: "Stealers" }, { id: "0003", name: "H.N.I.C" }, { id: "0007", name: "Sissy Boys" }, { id: "0011", name: "Mac Daddies" }] };
for (const f of ["teamlink.js", "history.js"]) vm.runInNewContext(fs.readFileSync(path.resolve(import.meta.dirname, "../..", f), "utf8"), ctx);
const H = ctx.B5History;
const plain = (x: unknown) => JSON.parse(JSON.stringify(x));

const lineage = [
  { mfl_id: "0002", name: "Stealers", status: "approved", team_id: "0002" },
  { mfl_id: "0012", name: "Stealers", status: "proposed", team_id: "0002" },
  { mfl_id: "0003", name: "H.N.I.C", status: "approved", team_id: "0003" },
  { mfl_id: "0007", name: "The Sissy Boys", status: "approved", team_id: "0007" },
  { mfl_id: "0007", name: "Sissy Boys", status: "approved", team_id: "0007" },
  { mfl_id: "0001", name: "Phantom", status: "proposed", team_id: "0001" },
  { mfl_id: "0006", name: "BFPM", status: "historical", team_id: null }
];
const rows = [
  { season: 2025, champion: "Sissy Boys", champion_mfl: "0007", runner_up: "H.N.I.C", runner_up_mfl: "0003", verified: true },
  { season: 2022, champion: "H.N.I.C", champion_mfl: "0003", runner_up: "Sissy Boys", runner_up_mfl: "0007", verified: true },
  { season: 2021, champion: "Stealers", champion_mfl: "0002", runner_up: "Sissy Boys", runner_up_mfl: "0007", verified: true },
  { season: 2020, champion: "Stealers", champion_mfl: "0002", runner_up: "NSFW", runner_up_mfl: "0001", verified: true },
  { season: 2019, champion: "BFPM", champion_mfl: "0006", runner_up: "H.N.I.C", runner_up_mfl: "0003", verified: true },
  { season: 2016, champion: "Phantom", champion_mfl: "0001", runner_up: "BFPM", runner_up_mfl: "0006", verified: true },
  { season: 2012, champion: "Phantom", champion_mfl: "0001", runner_up: null, runner_up_mfl: null, verified: true },
  { season: 2009, champion: "The Sissy Boys", champion_mfl: "0007", runner_up: null, runner_up_mfl: null, verified: true },
  { season: 2007, champion: "Stealers", champion_mfl: "0012", runner_up: "H.N.I.C", runner_up_mfl: "0003", verified: true },
  { season: 2002, champion: null, champion_mfl: null, runner_up: null, runner_up_mfl: null, verified: false }
];

test("titles per franchise: approved names count for today's team (all its names once); others stand as former names", () => {
  const t = plain(H.tally(rows, lineage, "champion"));
  const by = Object.fromEntries(t.map((e: { key: string; years: number[] }) => [e.key, e.years]));
  assert.deepEqual(by["team:0007"], [2025, 2009], "Sissy Boys incl. The Sissy Boys");
  assert.deepEqual(by["team:0002"], [2021, 2020], "the 2007 Stealers (franchise 0012) don't count until approved");
  assert.deepEqual(by["name:stealers"], [2007]);
  assert.deepEqual(by["name:phantom"], [2016, 2012], "a proposed name stays on its own");
  assert.deepEqual(by["name:bfpm"], [2019]);
  assert.equal(t[0].years.length, 2, "most titles first");
  const ru = plain(H.tally(rows, lineage, "runner_up"));
  assert.deepEqual(ru.find((e: { key: string }) => e.key === "team:0003").years, [2025, 2019, 2007]);
});

test("back-to-back champions (Empire winners): same franchise in consecutive seasons", () => {
  assert.deepEqual(plain(H.repeats(rows, lineage)), [{ years: [2020, 2021], team: "0002", name: "Stealers", verified: true }]);
  const withGap = rows.concat([{ season: 2008, champion: "H.N.I.C", champion_mfl: "0003", runner_up: null, runner_up_mfl: null, verified: true }]);
  assert.equal(plain(H.repeats(withGap, lineage)).length, 1, "2007 Stealers / 2008 H.N.I.C / 2009 Sissy Boys: no repeat");
  const sissy = rows.concat([{ season: 2008, champion: "The Sissy Boys", champion_mfl: "0007", runner_up: null, runner_up_mfl: null, verified: false }]);
  assert.deepEqual(plain(H.repeats(sissy, lineage))[1], { years: [2008, 2009], team: "0007", name: "The Sissy Boys", verified: false }, "unverified when either season is");
});

test("a team's titles and names: linked only when approved, with the old name; others plain and escaped", () => {
  assert.deepEqual(plain(H.titleYears(rows, lineage, "0002")), [2021, 2020]);
  assert.deepEqual(plain(H.titleYears(rows, lineage, "0001")), [], "Phantom not approved yet");
  assert.match(H.nameHtml(lineage, "0007", "The Sissy Boys"), /href="#team\/0007"/);
  assert.doesNotMatch(H.nameHtml(lineage, "0007", "The Sissy Boys"), /as The Sissy Boys/, "same name but 'The': no 'as'");
  assert.doesNotMatch(H.nameHtml(lineage, "0012", "Stealers"), /href=/, "proposed: plain text even though the name matches a team today");
  assert.match(H.nameHtml(lineage, "0001", "<script>x</script>"), /&lt;script&gt;/);
  assert.match(H.nameHtml(lineage, null, null), /Unknown/);
  const approved = lineage.concat([{ mfl_id: "0001", name: "Polar Express", status: "approved", team_id: "0001" }]);
  assert.match(H.nameHtml(approved, "0001", "Polar Express"), /href="#team\/0001".*as Polar Express/);
});
