/* account.js: role text, badges and the officer row's role set (several roles per person). */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const doc = { getElementById: () => null, addEventListener: () => {}, querySelector: () => null, hidden: true };
const ctx: Record<string, unknown> = { window: { addEventListener: () => {}, document: doc } as Record<string, unknown>, document: doc, setTimeout: () => 0, setInterval: () => 0 };
(ctx.window as Record<string, unknown>).B5Team = { name: (id: string) => id };
vm.runInNewContext(fs.readFileSync(path.resolve(import.meta.dirname, "../../account.js"), "utf8"), ctx);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Acc = (ctx.window as any).B5Account;
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x));

test("every role a person holds, in a fixed order", () => {
  assert.equal(Acc.rolesText(["treasurer", "admin"]), "Admin · Treasurer");
  assert.equal(Acc.rolesText(["commissioner", "treasurer", "admin"]), "Admin · Commissioner · Treasurer");
  assert.equal(Acc.rolesText([]), "");
  assert.equal(Acc.roleBadges(["treasurer", "admin"]), '<span class="tag role-admin">Admin</span> <span class="tag role-treasurer">Treasurer</span>');
});

test("an officer row saves only the roles the viewer may change; the rest pass through unchanged", () => {
  const commish = (r: string) => r !== "admin", admin = (r: string) => r === "admin";
  // A commissioner unticks Treasurer and ticks Commissioner on an Admin + Treasurer: admin stays
  assert.deepEqual(plain(Acc.nextRoles(["admin", "treasurer"], ["commissioner"], commish)), ["admin", "commissioner"]);
  // An admin can't drop someone's commissioner role by leaving the disabled box out of the form
  assert.deepEqual(plain(Acc.nextRoles(["commissioner"], ["admin"], admin)), ["admin", "commissioner"]);
  assert.equal(Acc.roleChangeText(["admin", "treasurer"], ["admin", "commissioner"]), "add Commissioner; remove Treasurer");
  assert.equal(Acc.roleChangeText(["admin"], ["admin"]), "");
});
