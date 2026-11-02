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

test("Empire pot balance counts confirmed entries; header text by role", () => {
  assert.equal(T.empireBalance([{ amount: 90 }, { amount: 70 }, { amount: -160 }]), 0, "every entry counts (no pending state)");
  assert.equal(T.roleText({ is_treasurer: true, keeps_books: true, treasurers: 1 }), "You keep the books as treasurer.");
  assert.equal(T.roleText({ is_treasurer: false, keeps_books: true, treasurers: 0 }), "No treasurer is assigned, so commissioners keep the books.");
  assert.equal(T.roleText({ is_treasurer: false, keeps_books: false, treasurers: 1 }), "Read-only: the treasurer keeps the books.");
});

test("ledger CSV: balances, fees, payouts and the Empire pot, quoted where needed", () => {
  const rows = T.ledgerRows({
    balances: [{ team_id: "0001", fee_due: 100, fee_paid: 100, won: 40, projected: 20, paid_out: 20, owed: 20, pending: 0 }],
    fees: [{ team_id: "0001", amount: 100, paid_at: "2026-09-01", method: "Venmo", status: "confirmed", note: null }],
    payouts: [{ team_id: "0001", amount: 20, paid_at: "2026-10-25", method: "Cash", status: "pending", note: 'wk 7, "high"' }],
    empire: [{ season: 2026, kind: "carry_in", team_id: null, amount: 90, entry_date: "2026-09-01", status: "confirmed", note: null }]
  }, (id: string) => (id === "0001" ? "NSFW" : id));
  const text = String(T.csv(rows));
  assert.match(text, /^Balances,/);
  assert.match(text, /NSFW,100,100,40,20,20,20\n/);
  assert.match(text, /,NSFW,20,2026-10-25,Cash,"wk 7, ""high"""/);
  assert.match(text, /,2026,Carried in,,90,2026-09-01,/);
});
