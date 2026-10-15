import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { crosswalkFromRows } from "../ingest/crosswalk.ts";
import type { FinalStatsSource, GameData, PlayerRef } from "../ingest/types.ts";
import { scoreWeek } from "./scores.ts";
import { jsonFileStore } from "./store.ts";
import { applyOverrides, createOverrides, validateOverride, type Override } from "./overrides.ts";
import { createFinalizer, weekScores } from "./finalizer.ts";

const cw = crosswalkFromRows([
  { gsis_id: "G-QB", espn_id: "1", display_name: "Jared Goff", position: "QB", latest_team: "DET" },
  { gsis_id: "G-WR", espn_id: "2", display_name: "Jameson Williams", position: "WR", latest_team: "DET" },
  { gsis_id: "G-TE", espn_id: "5", display_name: "Sam LaPorta", position: "TE", latest_team: "DET" },
  { gsis_id: "G-OL", espn_id: "3", display_name: "Penei Sewell", position: "T", latest_team: "DET" }
]);
const ref = (id: string, name: string): PlayerRef => ({ provider: "nflverse", id, name, team: "DET" });
function game(recYds = 88): GameData {
  const qb = ref("G-QB", "Jared Goff"), wr = ref("G-WR", "Jameson Williams");
  return {
    provider: "nflverse", gameId: "g", season: 2026, week: 5, home: "ARI", away: "DET", homeScore: 21, awayScore: 45, status: "final",
    players: [{ player: qb, passYds: 271 }, { player: wr, recYds, receptions: 4 }],
    teams: { ARI: { netPassYds: 231, rushYds: 90 }, DET: { netPassYds: 249, rushYds: 163, sacks: 2 } },
    events: [{ kind: "td", td: "pass", team: "DET", length: 39, passer: qb, scorer: wr }], warnings: []
  };
}
const snap = (recYds = 88, source: "live" | "final" = "final") => scoreWeek([game(recYds)], { season: 2026, week: 5, source, cw, computedAt: "x" });
let n = 0;
const ov = (o: Partial<Override> & Pick<Override, "target" | "type">): Override =>
  ({ id: `o${++n}`, season: 2026, week: 5, reason: "r", by: "commish", at: `2026-10-20T0${n % 10}:00:00Z`, active: true, ...o });
const WR = { kind: "player" as const, key: "nflverse:G-WR" };
const tmp = () => jsonFileStore(fs.mkdtempSync(path.join(os.tmpdir(), "b5-ov-")));

describe("validateOverride", () => {
  const base = { target: WR, type: "stats" as const, reason: "Official correction" };
  test("accepts valid stats and points overrides", () => {
    validateOverride({ ...base, stats: { recTdLengths: [52], recYds: 104, receptions: null } });
    validateOverride({ ...base, type: "points", points: 12.5 });
  });
  test("rejects bad input with a readable reason", () => {
    assert.throws(() => validateOverride({ ...base, stats: { recYds: 1 }, reason: " " }), /reason is required/);
    assert.throws(() => validateOverride({ ...base, stats: {} }), /at least one field/);
    assert.throws(() => validateOverride({ ...base, stats: { recieving: 5 } as never }), /Unknown stat "recieving"/);
    assert.throws(() => validateOverride({ ...base, stats: { recTdLengths: [52.5] } }), /list of yardages/);
    assert.throws(() => validateOverride({ ...base, stats: { recYds: "104" as never } }), /must be a number/);
    assert.throws(() => validateOverride({ ...base, type: "points", points: NaN }), /needs a number/);
    assert.throws(() => validateOverride({ ...base, type: "points", points: 1250 }), /typo/);
    assert.throws(() => validateOverride({ ...base, target: { kind: "defense", team: "philly" }, type: "points", points: 3 }), /Bad team/);
  });
});

describe("applyOverrides", () => {
  test("stats override replaces only the given fields and the engine recomputes points", () => {
    // Williams: 39-yd TD 8 + 88 yds 4 + 4 rec 2 = 14. TD corrected to 52 yds (10) and 104 yds (6): 10 + 6 + 2 = 18
    const s = applyOverrides(snap(), [ov({ target: WR, type: "stats", stats: { recTdLengths: [52], recYds: 104 } })], cw);
    const p = s.players["nflverse:G-WR"]!;
    assert.equal(p.points, 18);
    assert.deepEqual(p.stats, { recYds: 104, receptions: 4, recTdLengths: [52] });
    assert.deepEqual(p.override!.source, { points: 14, stats: { recYds: 88, receptions: 4, recTdLengths: [39] } });
    assert.equal(s.players["nflverse:G-QB"]!.override, undefined, "other players untouched");
  });
  test("null removes a field", () => {
    const s = applyOverrides(snap(), [ov({ target: WR, type: "stats", stats: { recTdLengths: null } })], cw);
    assert.equal(s.players["nflverse:G-WR"]!.points, 6);       // TD removed: 4 + 2
  });
  test("points override pins the total and beats a stats override; the latest points override wins", () => {
    const s = applyOverrides(snap(), [
      ov({ target: WR, type: "stats", stats: { recYds: 150 } }),
      ov({ target: WR, type: "points", points: 9 }),
      ov({ target: WR, type: "points", points: 11.5 })
    ], cw);
    const p = s.players["nflverse:G-WR"]!;
    assert.equal(p.points, 11.5);
    assert.equal(p.override!.type, "points");
  });
  test("removed overrides and other weeks' overrides are ignored", () => {
    const s = applyOverrides(snap(), [ov({ target: WR, type: "points", points: 1, active: false }), ov({ target: WR, type: "points", points: 2, week: 6 })], cw);
    assert.equal(s.players["nflverse:G-WR"]!.points, 14);
  });
  test("defense stats override", () => {
    // DET defense: 2 sacks (2) + ARI net pass 231 (0) + rush 90 (6) + no offensive TDs allowed (8) = 16; add an INT (+2) = 18
    const s = applyOverrides(snap(), [ov({ target: { kind: "defense", team: "DET" }, type: "stats", stats: { interceptions: 1 } })], cw);
    assert.equal(s.defenses.DET!.points, 18);
    assert.equal(s.defenses.DET!.override!.source.points, 16);
  });
  test("a defense override that removes a required stat isn't applied (and says why)", () => {
    const s = applyOverrides(snap(), [ov({ target: { kind: "defense", team: "DET" }, type: "stats", stats: { passYdsAllowed: null } })], cw);
    assert.equal(s.defenses.DET!.points, 16);
    assert.match(s.warnings.at(-1)!, /missing passYdsAllowed; not applied/);
  });
  test("credits a player the source didn't have (e.g. flagged as unmatched)", () => {
    const s = applyOverrides(snap(), [ov({ target: { kind: "player", key: "nflverse:G-TE" }, type: "stats", stats: { receptions: 3, recYds: 30 } })], cw);
    const te = s.players["nflverse:G-TE"]!;
    assert.deepEqual([te.name, te.position, te.points], ["Sam LaPorta", "TE", 5]);   // 3 rec x 1 + 30 yds (2)
    assert.equal(te.override!.source.points, null);
  });
  test("a non-fantasy player can't be overridden into scoring", () => {
    const s = applyOverrides(snap(), [ov({ target: { kind: "player", key: "nflverse:G-OL" }, type: "points", points: 6 })], cw);
    assert.equal(s.players["nflverse:G-OL"], undefined);
    assert.match(s.warnings.at(-1)!, /no fantasy position/);
  });
});

describe("overrides end to end", () => {
  test("add / remove are stored and audited; unknown players and missing reasons are refused", async () => {
    const store = tmp();
    const o = createOverrides({ store, crosswalk: cw, now: () => Date.parse("2026-10-20T12:00:00Z") });
    await assert.rejects(o.add({ season: 2026, week: 5, target: { kind: "player", key: "nflverse:NOPE" }, type: "points", points: 3, reason: "x", by: "commish" }), /Unknown player/);
    const a = await o.add({ season: 2026, week: 5, target: WR, type: "points", points: 20, reason: "League vote", by: "commish" });
    await assert.rejects(o.remove(2026, 5, a.id, "commish", ""), /reason is required/);
    await o.remove(2026, 5, a.id, "commish", "Vote reversed");
    await assert.rejects(o.remove(2026, 5, a.id, "commish", "again"), /already removed/);
    const [saved] = await o.list(2026, 5);
    assert.deepEqual([saved!.active, saved!.removedBy, saved!.removedReason], [false, "commish", "Vote reversed"]);
    const audit = await store.listAudit();
    assert.deepEqual(audit.map(e => e.action), ["add_override", "remove_override"]);
    assert.deepEqual(audit[0]!.details, { id: a.id, target: "nflverse:G-WR", type: "points", points: 20, reason: "League vote", weekStatus: "live" });
  });

  test("applies on top of live numbers, then survives nightly finalization and stat corrections", async () => {
    const store = tmp();
    await store.putLive(snap(88, "live"));
    const o = createOverrides({ store, crosswalk: cw });
    await o.add({ season: 2026, week: 5, target: WR, type: "stats", stats: { recTdLengths: [52] }, reason: "TD was 52 yards per league office", by: "commish" });

    let shown = await weekScores(store, 2026, 5, cw);
    assert.deepEqual([shown.status, shown.snapshot!.source, shown.snapshot!.players["nflverse:G-WR"]!.points], ["live", "live", 16]);

    // Nightly run: nflverse replaces live (with a different yardage). The override still applies.
    let finalGames = [game(92)];
    const f = createFinalizer({ final: { name: "nflverse", async week() { return finalGames; } } as FinalStatsSource, crosswalk: cw, store, now: () => Date.parse("2026-10-19T09:00:00Z") });
    await f.finalizeWeek(2026, 5);
    shown = await weekScores(store, 2026, 5, cw);
    const wr = shown.snapshot!.players["nflverse:G-WR"]!;
    assert.deepEqual([shown.snapshot!.source, wr.points, wr.stats.recYds, wr.stats.recTdLengths], ["final", 16, 92, [52]]);   // 52-yd TD 10 + 92 yds (75-99 tier) 4 + 4 rec 2
    // The raw final numbers are stored untouched; only the read applies the override
    assert.deepEqual((await store.getWeek(2026, 5))!.final!.players["nflverse:G-WR"]!.stats.recTdLengths, [39]);
    // The live-vs-final diff for Williams is flagged as overridden
    const lvf = (await store.getWeek(2026, 5))!.diffLog[0]!.entries.find(e => e.key === "nflverse:G-WR")!;
    assert.equal(lvf.overriddenBy!.length, 1);

    // A later stat correction: still applied on top
    finalGames = [game(110)];
    await f.finalizeWeek(2026, 5);
    shown = await weekScores(store, 2026, 5, cw);
    assert.equal(shown.snapshot!.players["nflverse:G-WR"]!.points, 18);   // 52-yd TD 10 + 110 yds (6 at 100) + 2
  });

  test("works on a locked (final) week too: the commissioner can edit anything", async () => {
    const store = tmp();
    const f = createFinalizer({ final: { name: "nflverse", async week() { return [game()]; } } as FinalStatsSource, crosswalk: cw, store });
    await f.finalizeWeek(2026, 5);
    await f.confirmWeek(2026, 5, "commish");
    await createOverrides({ store, crosswalk: cw }).add({ season: 2026, week: 5, target: { kind: "defense", team: "ARI" }, type: "points", points: 0, reason: "Forfeit ruling", by: "commish" });
    const shown = await weekScores(store, 2026, 5, cw);
    assert.deepEqual([shown.status, shown.snapshot!.defenses.ARI!.points], ["final", 0]);
    assert.equal((await store.listAudit()).at(-1)!.details!.weekStatus, "final");
  });
});
