/* Tests for payouts.js's pure helpers (classic browser script, loaded into a VM context). */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ctx: Record<string, unknown> = { LEAGUE: { season: 2026, teams: [{ id: "0001", name: "NSFW" }, { id: "0002", name: "Stealers" }] } };
vm.runInNewContext(fs.readFileSync(path.resolve(import.meta.dirname, "../../payouts.js"), "utf8"), ctx);
type Award = { kind: string; week: number | null; place: number | null; team_id: string; amount: number; status: string; source: string; label?: string; note?: string };
const P = ctx.B5Payouts as {
  effectiveAwards(a: Award[]): Award[];
  winningsByTeam(a: Award[]): Record<string, { final: number; projected: number }>;
  balances(a: Award[], p: { team_id: string; amount: number }[], f: { team_id: string; amount_due: number; paid: boolean }[]): { team_id: string; won: number; projected: number; paid_out: number; owed: number; fee_paid: boolean | null }[];
  empireState(s: unknown, a: Award[]): { balance: number; outcome: string; team: string | null };
  potOf(s: unknown): number;
  csv(rows: unknown[][]): string;
  money(n: number): string;
};
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const aw = (o: Partial<Award>): Award => ({ kind: "weekly_high", week: 1, place: null, team_id: "0001", amount: 35, status: "final", source: "auto", ...o });

test("an override hides the auto awards of its group (before the next refresh removes them)", () => {
  const eff = P.effectiveAwards([aw({}), aw({ team_id: "0002", source: "override" }), aw({ week: 2 })]);
  assert.deepEqual(plain(eff.map(a => [a.week, a.team_id, a.source])), [[1, "0002", "override"], [2, "0001", "auto"]]);
});

test("winnings: final vs projected, summed in cents", () => {
  const w = P.winningsByTeam([aw({ amount: 17.5 }), aw({ week: 2, amount: 11.67 }), aw({ week: 3, status: "projected", amount: 35 })]);
  assert.deepEqual(plain(w), { "0001": { final: 29.17, projected: 35 } });
});

test("balances: owed = final winnings - paid out; fee status; teams with nothing still listed", () => {
  const b = P.balances([aw({ amount: 35 }), aw({ week: 2, amount: 240, kind: "manual", source: "manual" })], [{ team_id: "0001", amount: 35 }], [{ team_id: "0001", amount_due: 360, paid: true }]);
  assert.deepEqual(plain(b.map(x => [x.team_id, x.won, x.paid_out, x.owed, x.fee_paid])), [["0001", 275, 35, 240, true], ["0002", 0, 0, 0, null]]);
});

test("pot and Empire: $4,120 paid out; $360 on watch, paid to a repeat champion, rolled otherwise", () => {
  const s = { team_count: 12, buy_in: 360, website_fee: 80, empire_contribution: 120, empire_carry_in: 240, empire_defending_team: "0001" };
  assert.equal(P.potOf(s), 4120);
  assert.deepEqual(plain(P.empireState(s, [])), { balance: 360, outcome: "watch", team: null, defending: "0001" });
  assert.equal(P.empireState(s, [aw({ kind: "empire", week: null, amount: 360 })]).outcome, "paid");
  assert.equal(P.empireState(s, [aw({ kind: "champion", week: 17, team_id: "0002", amount: 240 })]).outcome, "rolled");
  assert.equal(P.empireState(s, [aw({ kind: "champion", week: 17, team_id: "0002", amount: 240, status: "projected" })]).outcome, "watch");
});

test("CSV export escapes commas, quotes and newlines; money formats cents", () => {
  assert.equal(P.csv([["Pick'em, 1st", 'He said "hi"', "a\nb", null]]), `"Pick'em, 1st","He said ""hi""","a\nb",\n`);
  assert.equal(P.money(17.5), "$17.50");
  assert.equal(P.money(4120), "$4,120");
  assert.equal(P.money(-11.66), "-$11.66");
});
