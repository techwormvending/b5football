import { test } from "node:test";
import assert from "node:assert/strict";
import { currentWeek, injuryRows, reportStatus, rosterStatus } from "./injuries.ts";

test("weekly report statuses; a practice-only row is no designation", () => {
  assert.equal(reportStatus("Out"), "Out");
  assert.equal(reportStatus("Doubtful"), "Doubtful");
  assert.equal(reportStatus("Questionable"), "Questionable");
  assert.equal(reportStatus(""), null);
  assert.equal(reportStatus(undefined), null);
});

test("roster statuses from players.csv: injured reserve, PUP, suspended, other reserve; active players none", () => {
  assert.equal(rosterStatus("RES", "R/Injured"), "IR");
  assert.equal(rosterStatus("RES", "R/Injured; DFR"), "IR");
  assert.equal(rosterStatus("RES", "R/I-W/I; Not 90"), "IR");
  assert.equal(rosterStatus("RES", "R/PUP"), "PUP");
  assert.equal(rosterStatus("PUP", "Active/PUP"), null, "on the active roster: plays");
  assert.equal(rosterStatus("RES", "R/Left Squad"), "Reserve");
  assert.equal(rosterStatus("SUS", ""), "Suspended");
  assert.equal(rosterStatus("ACT", "Active"), null);
  assert.equal(rosterStatus("DEV", "Practice Squad"), null);
});

test("current week: the first week whose last kickoff was under 5 hours ago", () => {
  const g = [{ week: 6, kickoff: "2026-10-20T00:15:00Z" }, { week: 7, kickoff: "2026-10-23T00:15:00Z" }, { week: 7, kickoff: "2026-10-27T00:15:00Z" }];
  assert.equal(currentWeek(g, Date.parse("2026-10-20T03:00:00Z")), 6, "Monday night game just ended");
  assert.equal(currentWeek(g, Date.parse("2026-10-21T14:00:00Z")), 7);
  assert.equal(currentWeek(g, Date.parse("2026-11-01T00:00:00Z")), null, "season over");
});

test("one row per week and player, most serious status wins; roster status only for the current week; unknown players skipped", () => {
  const report = [
    { season: "2026", season_type: "REG", week: "7", gsis_id: "A", report_status: "Questionable", report_primary_injury: "Ankle", practice_status: "Limited Participation in Practice" },
    { season: "2026", season_type: "REG", week: "6", gsis_id: "A", report_status: "Out", report_primary_injury: "Ankle", practice_status: "Did Not Participate In Practice" },
    { season: "2026", season_type: "REG", week: "7", gsis_id: "B", report_status: "Out", report_primary_injury: "Knee", practice_status: "" },
    { season: "2026", season_type: "REG", week: "7", gsis_id: "C", report_status: "", report_primary_injury: "", practice_status: "Full Participation in Practice" },
    { season: "2026", season_type: "REG", week: "7", gsis_id: "LB", report_status: "Out", report_primary_injury: "Hamstring", practice_status: "" }
  ];
  const players = [{ gsis_id: "B", status: "RES", ngs_status_short_description: "R/Injured" }, { gsis_id: "D", status: "SUS", ngs_status_short_description: "" },
    { gsis_id: "A", status: "ACT", ngs_status_short_description: "Active" }];
  const rows = injuryRows({ season: 2026, currentWeek: 7, known: new Set(["A", "B", "C", "D"]), report, players });
  assert.deepEqual(rows.map(r => [r.week, r.player_id, r.status, r.injury, r.source]), [
    [6, "A", "Out", "Ankle", "report"],
    [7, "A", "Questionable", "Ankle", "report"],
    [7, "B", "IR", "Knee", "roster"],
    [7, "D", "Suspended", null, "roster"]]);
  assert.equal(rows[1]!.practice, "Limited Participation in Practice");
  assert.equal(injuryRows({ season: 2026, currentWeek: null, known: new Set(["B", "D"]), report: [], players }).length, 0, "no current week: roster statuses aren't applied anywhere");
});
