/* treasury.js: the Treasury page's helpers. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ctx: Record<string, unknown> = {};
vm.runInNewContext(fs.readFileSync(path.resolve(import.meta.dirname, "../../treasury.js"), "utf8"), ctx);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const T = ctx.B5Treasury as any;

test("who may confirm a pending entry: a commissioner who didn't record it and doesn't own that team", () => {
  const e = { status: "pending", created_by: "bob", team_id: "0002" };
  assert.equal(T.canConfirm(e, { id: "adam", commissioner: true, teams: ["0011"] }), true);
  assert.equal(T.canConfirm(e, { id: "bob", commissioner: true, teams: [] }), false, "not your own entry");
  assert.equal(T.canConfirm(e, { id: "adam", commissioner: true, teams: ["0002"] }), false, "not your own team");
  assert.equal(T.canConfirm(e, { id: "amy", commissioner: false, teams: [] }), false, "treasurers don't confirm");
  assert.equal(T.canConfirm({ ...e, status: "confirmed" }, { id: "adam", commissioner: true, teams: [] }), false);
});

test("Empire pot balance counts confirmed entries; header text by role", () => {
  assert.equal(T.empireBalance([{ amount: 240, status: "confirmed" }, { amount: 120, status: "confirmed" }, { amount: -360, status: "pending" }]), 360);
  assert.equal(T.roleText({ is_treasurer: true, keeps_books: true, treasurers: 1 }), "You keep the books as treasurer.");
  assert.equal(T.roleText({ is_treasurer: false, keeps_books: true, treasurers: 0 }), "No treasurer is assigned, so commissioners keep the books.");
  assert.equal(T.roleText({ is_treasurer: false, keeps_books: false, treasurers: 1 }), "Read-only: the treasurer keeps the books.");
});

test("ledger CSV: balances, fees, payouts and the Empire pot, quoted where needed", () => {
  const rows = T.ledgerRows({
    balances: [{ team_id: "0001", fee_due: 360, fee_paid: 360, won: 70, projected: 35, paid_out: 35, owed: 35, pending: 0 }],
    fees: [{ team_id: "0001", amount: 360, paid_at: "2026-09-01", method: "Venmo", status: "confirmed", note: null }],
    payouts: [{ team_id: "0001", amount: 35, paid_at: "2026-10-25", method: "Cash", status: "pending", note: 'wk 7, "high"' }],
    empire: [{ season: 2026, kind: "carry_in", team_id: null, amount: 240, entry_date: "2026-09-01", status: "confirmed", note: null }]
  }, (id: string) => (id === "0001" ? "NSFW" : id));
  const text = String(T.csv(rows));
  assert.match(text, /^Balances,/);
  assert.match(text, /NSFW,360,360,70,35,35,35,0/);
  assert.match(text, /,NSFW,35,2026-10-25,Cash,pending,"wk 7, ""high"""/);
  assert.match(text, /,2026,Carried in,,240,2026-09-01,confirmed,/);
});
