import { test } from "node:test";
import assert from "node:assert/strict";
import { txnRows } from "./mflTransactions.ts";

test("MFL's 2026 transactions become log rows: free agents, waivers, trades; non-moves skipped; unmapped players kept, never guessed", () => {
  const map = new Map([["16212", "00-A"], ["17478", "00-B"], ["15768", "00-C"], ["14842", "00-D"], ["111", "00-E"]]);
  const r = txnRows(2026, [
    { type: "FREE_AGENT", transaction: "16212,|17478,", timestamp: "1792681836", franchise: "0003" },
    { type: "FREE_AGENT", transaction: "16212,|", timestamp: "1792681900", franchise: "0004" },
    { type: "FREE_AGENT", transaction: "|17478,", timestamp: "1792681999", franchise: "0004" },
    { type: "WAIVER", added: "15768,", dropped: "14842,", timestamp: "1792616400", franchise: "0001" },
    { type: "WAIVER", added: "99999,", dropped: "", timestamp: "1792616400", franchise: "0010" },
    { type: "TRADE", franchise: "0002", franchise2: "0005", franchise1_gave_up: "111,", franchise2_gave_up: "16212,", timestamp: "1792700000" },
    { type: "AUTO_PROCESS_WAIVERS", transaction: "", timestamp: "1792616400", franchise: "" },
    { type: "LOCK_ALL_PLAYERS", transaction: "", timestamp: "1792461600", franchise: "" }
  ], map);
  assert.deepEqual(r.rows.map(x => [x.team_id, x.type, x.players_in.join(), x.players_out.join(), x.partner_team_id]), [
    ["0003", "add_drop", "00-A", "00-B", null],
    ["0004", "add", "00-A", "", null],
    ["0004", "drop", "", "00-B", null],
    ["0001", "add_drop", "00-C", "00-D", null],
    ["0010", "add", "mfl:99999", "", null],
    ["0002", "trade", "00-A", "00-E", "0005"]]);
  assert.deepEqual(r.unmapped, ["99999"]);
  assert.equal(r.rows[0]!.created_at, new Date(1792681836 * 1000).toISOString());
  assert.ok(r.rows.every(x => x.via === "mfl" && x.status === "processed"));
  assert.equal(new Set(r.rows.map(x => x.mfl_key)).size, r.rows.length, "a stable unique key per transaction (re-runs don't duplicate)");
});
