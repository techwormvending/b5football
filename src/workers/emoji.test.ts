/* Emoji (emoji.js): shortcodes, autocomplete, emoji-only detection, the team list; and the reaction sets
   in board.js / chat.js. The database side ("any emoji reactions") is in rls.test.ts. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const read = (f: string) => fs.readFileSync(path.resolve(import.meta.dirname, "../..", f), "utf8");
const ctx: Record<string, unknown> = { Intl };
vm.runInNewContext(read("emoji.js"), ctx);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const E = ctx.B5Emoji as any;
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x));

test("all 32 teams: code, nickname and emoji; shortcodes by code or nickname", () => {
  assert.equal(E.TEAMS.length, 32);
  assert.equal(new Set(E.TEAMS.map((t: string[]) => t[0])).size, 32);
  assert.equal(E.convert("Go :steelers: and :PIT:!"), "Go ⚙️ and ⚙️!");
  assert.equal(E.convert(":chiefs: :kc:"), "🔥 🔥");
  assert.equal(E.convert(":49ers: :niners: :sf:"), "⛏️ ⛏️ ⛏️");
  assert.equal(E.convert(":bucs: :tb:"), "🏴‍☠️ 🏴‍☠️");
  assert.equal(E.convert(":football: :trophy: :flex: :party: :tada: :gold: :silver: :bronze:"), "🏈 🏆 💪 🥳 🎉 🥇 🥈 🥉");
  assert.equal(E.convert("at 3:05 and :nope: stay"), "at 3:05 and :nope: stay", "unknown codes and times stay as typed");
  assert.equal(E.convert(":ravens:"), "🐦‍⬛");
  assert.equal(E.convert(":ravens:", { ravens: false }), "🐦 BAL", "older devices: the fallback");
  for (const [code, nick, emoji] of E.TEAMS) { assert.equal(E.CODES[code.toLowerCase()], emoji, code); assert.equal(E.CODES[nick], emoji, nick); }
  assert.deepEqual(plain(E.FAVORITES), ["🏈", "💪", "🏆", "🥳", "🎉", "🎊", "🥇", "🥈", "🥉", "🔥", "😂", "💀", "👏", "🤘", "🗑️", "⚽", "🎽"]);
});

test("autocomplete: ':' opens it (start or after a space), prefix matches with teams first", () => {
  assert.deepEqual(plain(E.typing("Nice :ste", 9)), { from: 5, prefix: "ste" });
  assert.deepEqual(plain(E.typing(":", 1)), { from: 0, prefix: "" });
  assert.equal(E.typing("at 3:0", 6), null, "not inside a time");
  assert.equal(E.typing("a:b", 3), null);
  assert.deepEqual(plain(E.matches("ste").map((x: { code: string; emoji: string }) => [x.code, x.emoji])), [["steelers", "⚙️"]]);
  assert.deepEqual(plain(E.matches("pi").map((x: { code: string }) => x.code)), ["pit"]);
  assert.equal(E.matches("", 8).length, 8, "':' alone shows the first 8");
  assert.deepEqual(plain(E.matches("tro").map((x: { code: string }) => x.code)), ["trophy"]);
});

test("emoji-only messages (1-10 emoji) show larger; text, digits or long runs don't", () => {
  for (const s of ["🏈", "🔥🔥🔥", " 🏆 🥳 ", "⚙️", "🏴‍☠️", "🇺🇸", "👍🏽", "🐦‍⬛"]) assert.equal(E.isEmojiOnly(s), true, s);
  for (const s of ["", "go 🏈", "🏈!", "1️⃣", "🔥".repeat(11), "hello"]) assert.equal(E.isEmojiOnly(s), false, s);
});

test("reactions: the quick set is 👍 😂 🔥 🏈 🏆 💀 🗑️ plus '+' for any emoji, on the board and in chat", () => {
  for (const f of ["board.js", "chat.js"]) assert.match(read(f), /var EMOJI = \["👍", "😂", "🔥", "🏈", "🏆", "💀", "🗑️"\]/, f);
  assert.match(read("board.js"), /data-bd="react-more"/);
  assert.match(read("chat.js"), /data-ch="react-more"/);
  assert.match(read("index.html"), /<script src="emoji\.js\?v=[^"]+"><\/script>\s*<script src="board\.js/);
});
