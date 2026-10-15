import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { crosswalkFromRows } from "../ingest/crosswalk.ts";
import type { FinalStatsSource, GameData, LiveStatsSource, LiveWeek, PlayerRef } from "../ingest/types.ts";
import { diffSnapshots, mergeLive, scoreWeek } from "./scores.ts";
import { jsonFileStore, type ScoreStore } from "./store.ts";
import { DEFAULT_POLLER, createLivePoller, planNextPoll } from "./livePoller.ts";
import { createFinalizer, etToUtc, nextEasternTime, weekScores } from "./finalizer.ts";

// ---- fixtures ------------------------------------------------------------------
const cw = crosswalkFromRows([
  { gsis_id: "G-QB", espn_id: "1", display_name: "Jared Goff", position: "QB", latest_team: "DET" },
  { gsis_id: "G-WR", espn_id: "2", display_name: "Jameson Williams", position: "WR", latest_team: "DET" },
  { gsis_id: "G-OL", espn_id: "3", display_name: "Penei Sewell", position: "T", latest_team: "DET" },
  { gsis_id: "G-RB", espn_id: "4", display_name: "Bijan Robinson", position: "RB", latest_team: "ATL" }
]);
const ref = (provider: string, id: string, name: string, team: string): PlayerRef => ({ provider, id, name, team });

/** One game. `prov` = "espn" (live, needs crosswalk) or "nflverse" (final, canonical). */
function game(prov: "espn" | "nflverse", o: { home?: string; away?: string; status?: GameData["status"]; kickoff?: string; recYds?: number; tdLen?: number; homeScore?: number; awayScore?: number; extraEspn?: boolean } = {}): GameData {
  const home = o.home ?? "ARI", away = o.away ?? "DET";
  // Only DET@ARI uses the known players; any other game gets its own (unscored) players.
  const known = home === "ARI" && away === "DET";
  const id = (espn: string, gsis: string) => (known ? (prov === "espn" ? espn : gsis) : `${away}-${espn}`);
  const qb = ref(prov, id("1", "G-QB"), "Jared Goff", away), wr = ref(prov, id("2", "G-WR"), "Jameson Williams", away), ol = ref(prov, id("3", "G-OL"), "Penei Sewell", away);
  return {
    provider: prov, gameId: prov === "espn" ? "401" : "2026_05_DET_ARI", season: 2026, week: 5, home, away,
    homeScore: o.homeScore ?? 21, awayScore: o.awayScore ?? 45, status: o.status ?? "final", ...(o.kickoff ? { kickoff: o.kickoff } : {}),
    players: [{ player: qb, passYds: 271 }, { player: wr, recYds: o.recYds ?? 88, receptions: 4 }, { player: ol, rushYds: 0 },
      ...(o.extraEspn ? [{ player: ref("espn", "999", "Mystery Man", away), recYds: 10, receptions: 1 }] : [])],
    teams: { [home]: { netPassYds: 231, rushYds: 90 }, [away]: { netPassYds: 249, rushYds: 163 } },
    events: [{ kind: "td", td: "pass", team: away, length: o.tdLen ?? 39, passer: qb, scorer: wr }],
    warnings: []
  };
}
const tmpStore = () => jsonFileStore(fs.mkdtempSync(path.join(os.tmpdir(), "b5-league-")));
const T = (iso: string) => Date.parse(iso);

// ---- scores ----------------------------------------------------------------------
describe("scoreWeek / mergeLive / diffSnapshots", () => {
  const snap = scoreWeek([game("nflverse")], { season: 2026, week: 5, source: "final", cw, computedAt: "x" });
  test("scores fantasy players by position; skips non-fantasy positions; scores defenses", () => {
    // Goff: 39-yd pass TD = 8; 271 yds -> 5 + 2 = 7. Total 15.  Williams: 39-yd TD 8 + 88 yds 4 + 4 rec x 0.5 = 14
    assert.equal(snap.players["nflverse:G-QB"]!.points, 15);
    assert.equal(snap.players["nflverse:G-WR"]!.points, 14);
    assert.equal(snap.players["nflverse:G-OL"], undefined);
    assert.ok(snap.defenses.ARI && snap.defenses.DET);
    assert.equal(snap.games[0]!.gameKey, "DET@ARI");
  });
  test("scheduled games are listed but not scored", () => {
    const s = scoreWeek([game("nflverse", { status: "scheduled" })], { season: 2026, week: 5, source: "live", cw, computedAt: "x" });
    assert.equal(s.games.length, 1);
    assert.deepEqual(s.players, {});
    assert.deepEqual(s.defenses, {});
  });
  test("mergeLive keeps games the delayed snapshot lacks", () => {
    const prev = scoreWeek([game("nflverse"), game("nflverse", { home: "ATL", away: "BAL" })], { season: 2026, week: 5, source: "live", cw, computedAt: "1" });
    const partial = scoreWeek([game("nflverse")], { season: 2026, week: 5, source: "live", cw, computedAt: "2", delayed: true });
    const merged = mergeLive(prev, partial);
    assert.deepEqual(merged.games.map(g => g.gameKey).sort(), ["BAL@ATL", "DET@ARI"]);
    assert.ok(merged.defenses.ATL && merged.defenses.BAL);
    assert.equal(merged.computedAt, "2");
    // Not delayed: the new snapshot stands as-is
    assert.equal(mergeLive(prev, { ...partial, delayed: false }).games.length, 1);
  });
  test("diffSnapshots lists point and stat changes, biggest first", () => {
    const after = scoreWeek([game("nflverse", { recYds: 102, tdLen: 52 })], { season: 2026, week: 5, source: "final", cw, computedAt: "y" });
    const d = diffSnapshots(snap, after);
    const wr = d.find(e => e.key === "nflverse:G-WR")!;
    assert.deepEqual([wr.from, wr.to], [14, 18]);          // TD 8 -> 10, yds 4 -> 6
    assert.deepEqual(wr.changes.recYds, [88, 102]);
    assert.deepEqual(wr.changes.recTdLengths, [[39], [52]]);
    assert.equal(d[0]!.key, "nflverse:G-WR");
    assert.deepEqual(diffSnapshots(snap, snap), []);
  });
});

// ---- store -------------------------------------------------------------------------
describe("jsonFileStore", () => {
  test("round-trips live snapshots, week records, review items (deduped) and the audit log", async () => {
    const s = tmpStore();
    const snap = scoreWeek([game("nflverse")], { season: 2026, week: 5, source: "live", cw, computedAt: "x" });
    await s.putLive(snap);
    assert.deepEqual(await s.getLive(2026, 5), snap);
    assert.equal(await s.getLive(2026, 6), undefined);
    await s.putWeek({ season: 2026, week: 5, status: "pending_review", missingGames: [], diffLog: [], updatedAt: "x" });
    await s.putWeek({ season: 2026, week: 3, status: "final", missingGames: [], diffLog: [], updatedAt: "x" });
    assert.deepEqual((await s.listWeeks(2026)).map(w => w.week), [3, 5]);
    const u = { provider: "espn", providerId: "999", name: "Mystery Man", gameId: "401", week: 5, reason: "r" };
    assert.equal(await s.addReviewItems([u], "t1"), 1);
    assert.equal(await s.addReviewItems([u], "t2"), 0);
    const [r] = await s.listReview();
    assert.deepEqual([r!.firstSeen, r!.lastSeen, r!.status], ["t1", "t2", "open"]);
    await s.audit({ at: "t", actor: "commish", action: "confirm_week", season: 2026, week: 5 });
    assert.equal((await s.listAudit())[0]!.action, "confirm_week");
  });
});

// ---- poll planning ----------------------------------------------------------------
describe("planNextPoll", () => {
  const now = T("2026-10-18T16:00:00Z");
  const r0 = () => 0, r1 = () => 1;
  test("in-progress game: every 30-60 s (jittered)", () => {
    const g = [{ status: "in_progress" as const }];
    assert.deepEqual(planNextPoll(g, now, 0, DEFAULT_POLLER, r0), { state: "live", delayMs: 30_000 });
    assert.deepEqual(planNextPoll(g, now, 0, DEFAULT_POLLER, r1), { state: "live", delayMs: 60_000 });
  });
  test("kickoff within 10 minutes counts as live; so does a game past kickoff that hasn't started", () => {
    assert.equal(planNextPoll([{ status: "scheduled", kickoff: "2026-10-18T16:09:00Z" }], now, 0, DEFAULT_POLLER, r0).state, "live");
    assert.equal(planNextPoll([{ status: "scheduled", kickoff: "2026-10-18T15:30:00Z" }], now, 0, DEFAULT_POLLER, r0).state, "live");
  });
  test("nothing live: sleep until 10 min before the next kickoff, capped at the idle check", () => {
    assert.deepEqual(planNextPoll([{ status: "final" }, { status: "scheduled", kickoff: "2026-10-18T17:00:00Z" }], now, 0, DEFAULT_POLLER, r0), { state: "idle", delayMs: 50 * 60_000 });
    assert.deepEqual(planNextPoll([{ status: "scheduled", kickoff: "2026-10-20T00:15:00Z" }], now, 0, DEFAULT_POLLER, r0), { state: "idle", delayMs: 360 * 60_000 });
    assert.deepEqual(planNextPoll([{ status: "final" }], now, 0, DEFAULT_POLLER, r0), { state: "idle", delayMs: 360 * 60_000 });
  });
  test("errors during live play back off exponentially, capped at 5 minutes", () => {
    const g = [{ status: "in_progress" as const }];
    assert.deepEqual(planNextPoll(g, now, 1, DEFAULT_POLLER, r0), { state: "backoff", delayMs: 60_000 });
    assert.deepEqual(planNextPoll(g, now, 2, DEFAULT_POLLER, r0), { state: "backoff", delayMs: 120_000 });
    assert.deepEqual(planNextPoll(g, now, 9, DEFAULT_POLLER, r0), { state: "backoff", delayMs: 300_000 });
  });
});

// ---- poller ------------------------------------------------------------------------
function fakeLive(): LiveStatsSource & { next: LiveWeek | (() => never); cur: { season: number; week: number } | undefined } {
  const src = {
    name: "fake", cur: { season: 2026, week: 5 } as { season: number; week: number } | undefined,
    next: { games: [], delayed: false, errors: [], fetchedAt: "x" } as LiveWeek | (() => never),
    async currentWeek() { return src.cur; },
    async week() { return typeof src.next === "function" ? src.next() : src.next; }
  };
  return src;
}

describe("live poller", () => {
  const now = () => T("2026-10-18T18:00:00Z");
  test("writes a scored live snapshot with canonical IDs; unmatched players go to review, not to scores", async () => {
    const store = tmpStore(), live = fakeLive();
    live.next = { games: [game("espn", { status: "in_progress", extraEspn: true })], delayed: false, errors: [], fetchedAt: "x" };
    const p = createLivePoller({ live, crosswalk: cw, store, now, random: () => 0 });
    const r = await p.tick();
    assert.deepEqual([r.state, r.delayMs, r.wrote, r.newReviewItems], ["live", 30_000, true, 1]);
    const snap = (await store.getLive(2026, 5))!;
    assert.equal(snap.players["nflverse:G-WR"]!.points, 14);
    assert.equal(Object.keys(snap.players).some(k => k.startsWith("espn:")), false);
    assert.equal((await store.listReview())[0]!.name, "Mystery Man");
  });

  test("ESPN down after a restart: last good numbers are kept, marked delayed, and polling backs off", async () => {
    const store = tmpStore(), live = fakeLive();
    live.next = { games: [game("espn", { status: "in_progress" })], delayed: false, errors: [], fetchedAt: "x" };
    await createLivePoller({ live, crosswalk: cw, store, now, random: () => 0 }).tick();
    // New process (empty memory); ESPN returns nothing but says delayed
    live.next = { games: [], delayed: true, errors: ["scoreboard: HTTP 503"], fetchedAt: "y" };
    const p2 = createLivePoller({ live, crosswalk: cw, store, now, random: () => 0 });
    const r = await p2.tick();
    assert.equal(r.delayed, true);
    const snap = (await store.getLive(2026, 5))!;
    assert.equal(snap.delayed, true);
    assert.equal(snap.players["nflverse:G-WR"]!.points, 14, "last good numbers kept");
    assert.equal(r.state, "idle", "no game info this process, so it re-checks later rather than hammering");
  });

  test("a throwing source never crashes the loop: tick returns a backoff result", async () => {
    const store = tmpStore(), live = fakeLive();
    live.next = { games: [game("espn", { status: "in_progress" })], delayed: false, errors: [], fetchedAt: "x" };
    const p = createLivePoller({ live, crosswalk: cw, store, now, random: () => 0 });
    await p.tick();
    live.next = () => { throw new Error("boom"); };
    const r = await p.tick();
    assert.deepEqual([r.state, r.delayed, r.errors.at(-1)], ["backoff", true, "boom"]);
    assert.equal(p.failures, 1);
    assert.equal((await store.getLive(2026, 5))!.players["nflverse:G-WR"]!.points, 14);
  });

  test("a final (locked) week is never overwritten by live numbers", async () => {
    const store = tmpStore(), live = fakeLive();
    await store.putWeek({ season: 2026, week: 5, status: "final", missingGames: [], diffLog: [], updatedAt: "x" });
    live.next = { games: [game("espn")], delayed: false, errors: [], fetchedAt: "x" };
    const r = await createLivePoller({ live, crosswalk: cw, store, now }).tick();
    assert.equal(r.wrote, false);
    assert.equal(await store.getLive(2026, 5), undefined);
  });

  test("offseason (no current week): sleeps for the idle check", async () => {
    const live = fakeLive(); live.cur = undefined;
    const r = await createLivePoller({ live, crosswalk: cw, store: tmpStore(), now }).tick();
    assert.deepEqual([r.state, r.delayMs], ["offseason", 360 * 60_000]);
  });
});

// ---- Eastern time ------------------------------------------------------------------
describe("Eastern time helpers", () => {
  test("etToUtc handles daylight saving", () => {
    assert.equal(new Date(etToUtc(2026, 10, 20, 23)).toISOString(), "2026-10-21T03:00:00.000Z");   // EDT
    assert.equal(new Date(etToUtc(2026, 12, 15, 23)).toISOString(), "2026-12-16T04:00:00.000Z");   // EST
  });
  test("next Tuesday 11 PM ET after Monday Night Football", () => {
    assert.equal(new Date(nextEasternTime(T("2026-10-20T00:15:00Z"), 2, 23)).toISOString(), "2026-10-21T03:00:00.000Z");
    // After the DST change (Nov 1, 2026)
    assert.equal(new Date(nextEasternTime(T("2026-11-03T01:15:00Z"), 2, 23)).toISOString(), "2026-11-04T04:00:00.000Z");
  });
});

// ---- finalizer ---------------------------------------------------------------------
function fakeFinal(games: () => GameData[]): FinalStatsSource { return { name: "nflverse", async week() { return games(); } }; }

describe("finalizer", () => {
  const kick = { mnf: "2026-10-20T00:15:00Z" };
  async function withLive(store: ScoreStore, games: GameData[]) {
    const unmatchedFree = games;   // espn fixtures without extras map fully
    const snap = scoreWeek(unmatchedFree.map(g => ({ ...g, provider: "nflverse", players: g.players.map(b => ({ ...b, player: { ...b.player, provider: "nflverse", id: { "1": "G-QB", "2": "G-WR", "3": "G-OL" }[b.player.id] ?? b.player.id } })), events: g.events.map(e => e.kind === "td" ? { ...e, passer: { ...e.passer!, provider: "nflverse", id: "G-QB" }, scorer: { ...e.scorer!, provider: "nflverse", id: "G-WR" } } : e) })),
      { season: 2026, week: 5, source: "live", cw, computedAt: "live" });
    await store.putLive(snap);
  }

  test("first run: final numbers replace live, every difference is logged, week waits for the commissioner", async () => {
    const store = tmpStore();
    await withLive(store, [game("espn", { recYds: 88, kickoff: "2026-10-18T17:00:00Z" })]);
    let now = T("2026-10-19T09:00:00Z");
    const f = createFinalizer({ final: fakeFinal(() => [game("nflverse", { recYds: 92 })]), crosswalk: cw, store, now: () => now });
    const r = await f.finalizeWeek(2026, 5);
    assert.deepEqual([r.action, r.status, r.liveVsFinal, r.corrections], ["updated", "pending_review", 1, 0]);
    const rec = (await store.getWeek(2026, 5))!;
    assert.equal(rec.diffLog[0]!.kind, "live_vs_final");
    assert.deepEqual(rec.diffLog[0]!.entries[0]!.changes.recYds, [88, 92]);
    assert.equal(rec.autoFinalizeAt, "2026-10-21T03:00:00.000Z");
    const shown = await weekScores(store, 2026, 5, cw);
    assert.equal(shown.status, "pending_review");
    assert.equal(shown.snapshot!.source, "final");
  });

  test("a game missing from nflverse blocks auto-finalize and confirmation; later runs log corrections", async () => {
    const store = tmpStore();
    await withLive(store, [game("espn", { kickoff: "2026-10-18T17:00:00Z" }), game("espn", { home: "ATL", away: "BAL", kickoff: kick.mnf })]);
    let now = T("2026-10-20T08:00:00Z");
    let finals = [game("nflverse")];
    const f = createFinalizer({ final: fakeFinal(() => finals), crosswalk: cw, store, now: () => now });
    let r = await f.finalizeWeek(2026, 5);
    assert.deepEqual(r.missingGames, ["BAL@ATL"]);
    await assert.rejects(f.confirmWeek(2026, 5, "commish"), /missing games in nflverse: BAL@ATL/);

    // Past the deadline but still missing a game: stays pending
    now = T("2026-10-21T08:00:00Z");
    r = await f.finalizeWeek(2026, 5);
    assert.equal(r.status, "pending_review");

    // MNF arrives, plus an NFL stat correction to the first game
    finals = [game("nflverse", { recYds: 95 }), game("nflverse", { home: "ATL", away: "BAL" })];
    r = await f.finalizeWeek(2026, 5);
    assert.deepEqual([r.action, r.status, r.corrections, r.missingGames], ["auto_finalized", "final", 1, []]);
    const rec = (await store.getWeek(2026, 5))!;
    assert.deepEqual(rec.diffLog.map(d => d.kind), ["live_vs_final", "live_vs_final", "correction"]);
    assert.equal(rec.finalizedBy, "auto");
    assert.equal((await store.listAudit())[0]!.action, "auto_finalize_week");

    // Locked: further runs don't touch it
    finals = [game("nflverse", { recYds: 200 })];
    assert.equal((await f.finalizeWeek(2026, 5)).action, "skipped_locked");
  });

  test("auto-finalize can be turned off; the commissioner confirms (audited); reopen needs a reason and is audited", async () => {
    const store = tmpStore();
    await withLive(store, [game("espn", { kickoff: "2026-10-18T17:00:00Z" })]);
    const now = T("2026-10-25T08:00:00Z");   // well past the deadline
    const f = createFinalizer({ final: fakeFinal(() => [game("nflverse")]), crosswalk: cw, store, now: () => now }, { autoFinalize: { enabled: false, weekday: 2, hour: 23 } });
    assert.equal((await f.finalizeWeek(2026, 5)).status, "pending_review");
    await f.confirmWeek(2026, 5, "commish");
    assert.equal((await store.getWeek(2026, 5))!.finalizedBy, "commish");
    await assert.rejects(f.confirmWeek(2026, 5, "commish"), /already final/);
    await assert.rejects(f.reopenWeek(2026, 5, "commish", " "), /reason is required/);
    const re = await f.reopenWeek(2026, 5, "commish", "Stat correction from the league office");
    assert.equal(re.status, "pending_review");
    assert.deepEqual((await store.listAudit()).map(a => a.action), ["confirm_week", "reopen_week"]);
  });

  test("week never polled live: no fake 'differences', a note instead; deadline from nflverse game dates", async () => {
    const store = tmpStore();
    const now = T("2026-10-01T08:00:00Z");
    const f = createFinalizer({ final: fakeFinal(() => [{ ...game("nflverse"), gameDate: "2026-09-27" }]), crosswalk: cw, store, now: () => now });
    const r = await f.finalizeWeek(2026, 5);
    assert.equal(r.liveVsFinal, 0);
    const rec = (await store.getWeek(2026, 5))!;
    assert.deepEqual(rec.diffLog.map(d => [d.kind, d.entries.length, d.note]), [["live_vs_final", 0, "no live numbers were recorded for DET@ARI"]]);
    assert.equal(rec.autoFinalizeAt, "2026-09-30T03:00:00.000Z");   // Tue Sep 29, 11 PM EDT
  });

  test("no nflverse data yet, or nflverse errors: week left as is", async () => {
    const store = tmpStore();
    assert.equal((await createFinalizer({ final: fakeFinal(() => []), crosswalk: cw, store }).finalizeWeek(2026, 6)).action, "no_data");
    const bad = createFinalizer({ final: { name: "x", async week() { throw new Error("HTTP 502"); } }, crosswalk: cw, store });
    const r = await bad.finalizeWeek(2026, 6);
    assert.deepEqual([r.action, r.message], ["error", "nflverse: HTTP 502"]);
    assert.equal(await store.getWeek(2026, 6), undefined);
  });

  test("weekScores shows live numbers (with the delayed flag) until nflverse has the week", async () => {
    const store = tmpStore();
    await store.putLive({ ...scoreWeek([game("nflverse")], { season: 2026, week: 6, source: "live", cw, computedAt: "x" }), delayed: true });
    const s = await weekScores(store, 2026, 6, cw);
    assert.deepEqual([s.status, s.liveDelayed, s.snapshot!.source], ["live", true, "live"]);
  });
});
