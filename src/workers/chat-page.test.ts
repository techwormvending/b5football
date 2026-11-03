/* Chat page helpers (chat.js, a classic browser script loaded into a VM context). */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const read = (f: string) => fs.readFileSync(path.resolve(import.meta.dirname, "../..", f), "utf8");
const ctx: Record<string, unknown> = { LEAGUE: { season: 2026, teams: [{ id: "0011", name: "Mac Daddies" }, { id: "0001", name: "NSFW" }] } };
vm.runInNewContext(read("teamlink.js"), ctx);
vm.runInNewContext(read("route.js"), ctx);
vm.runInNewContext(read("board.js"), ctx);
vm.runInNewContext(read("chat.js"), ctx);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const C = ctx.B5Chat as any;
const R = ctx.B5Route as { parse(h: string, k: (x: string) => boolean): Record<string, unknown> };
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const NOW = Date.parse("2027-08-28T23:00:00Z");

test("draft header: idle, on the clock with time left, paused, done", () => {
  assert.equal(C.draftHeader(null, NOW).status, "idle");
  const live = C.draftHeader({ status: "live", team_id: "0011", round: 3, pick: 7, clock_ends_at: new Date(NOW + 83_000).toISOString() }, NOW);
  assert.deepEqual([live.title, live.sub], ["On the clock: Mac Daddies", "Round 3, Pick 7 · 1:23 left"]);
  const paused = C.draftHeader({ status: "paused", team_id: "0001", round: 1, pick: 2, paused_remaining: 45 }, NOW);
  assert.deepEqual([paused.title, paused.sub], ["⏸️ Paused: NSFW on the clock", "Round 1, Pick 2 · 0:45 left when it resumes"]);
  assert.equal(C.draftHeader({ status: "done" }, NOW).title, "The draft is complete");
  assert.equal(C.fmtClock(-5), "0:00");
  assert.equal(C.fmtClock(605), "10:05");
});

test("typing and who's online", () => {
  assert.equal(C.typingText([]), "");
  assert.equal(C.typingText(["Mike"]), "Mike is typing…");
  assert.equal(C.typingText(["Mike", "Bob"]), "Mike and Bob are typing…");
  assert.equal(C.typingText(["A", "B", "C"]), "3 people are typing…");
  const online = C.onlineList([{ key: "u2", metas: [{ name: "Mike", team: "0011" }] }, { key: "u1", metas: [{ name: "Old" }, { name: "Adam", team: "0011" }] }, { key: "u3", metas: [{ name: "Bob" }] }], "u1");
  assert.deepEqual(plain(online.map((p: { user: string; name: string }) => [p.user, p.name])), [["u1", "Adam"], ["u3", "Bob"], ["u2", "Mike"]], "you first, one entry per person, latest meta");
});

test("history: messages merge by id in order (Realtime echoes and older pages never duplicate)", () => {
  const m = (id: number, body = "x") => ({ id, body });
  const merged = C.mergeMessages([m(5), m(6)], [m(6, "edited"), m(7), m(1)]);
  assert.deepEqual(plain(merged.map((x: { id: number; body: string }) => [x.id, x.body])), [[1, "x"], [5, "x"], [6, "edited"], [7, "x"]]);
});

test("mentions of you, and grouping a person's quick messages", () => {
  assert.equal(C.mentionsMe("nice pick @Mac Daddies", ["Adam", "Mac Daddies"]), true);
  assert.equal(C.mentionsMe("@adam you up?", ["Adam"]), true);
  assert.equal(C.mentionsMe("mac daddies stink", ["Mac Daddies"]), false, "no @, no mention");
  const a = { author_id: "u1", is_bot: false, created_at: "2027-08-28T23:00:00Z" };
  assert.equal(C.continues(a, { ...a, created_at: "2027-08-28T23:04:00Z" }), true);
  assert.equal(C.continues(a, { ...a, created_at: "2027-08-28T23:06:00Z" }), false);
  assert.equal(C.continues(a, { ...a, author_id: "u2" }), false);
  assert.equal(C.continues(a, { ...a, is_bot: true }), false);
});

test("routes: #messages/chat, #messages/chat/<room>, big-screen .../draft/tv; old #chat links redirect", () => {
  const known = (k: string) => ["home", "chat"].includes(k);
  assert.deepEqual({ ...R.parse("#messages/chat", known) }, { page: "chat", week: null });
  assert.deepEqual({ ...R.parse("#messages/chat/draft", known) }, { page: "chat", week: null, room: "draft", tv: false });
  assert.deepEqual({ ...R.parse("#messages/chat/draft/tv", known) }, { page: "chat", week: null, room: "draft", tv: true });
  assert.deepEqual({ ...R.parse("#chat", known) }, { page: "chat", week: null, redirect: "#messages/chat" });
  assert.deepEqual({ ...R.parse("#chat/draft/tv", known) }, { page: "chat", week: null, room: "draft", tv: true, redirect: "#messages/chat/draft/tv" });
  assert.equal(R.parse("#messages/chat/<script>", known).page, "home");
});

test("messages use the board's sanitizer: no raw HTML", () => {
  const src = read("chat.js");
  assert.match(src, /B\(\)\.formatBody\(m\.body, ctx\)/);
  assert.doesNotMatch(src, /innerHTML\s*=\s*m\.body/);
});

test("one-row composer (Chat, Draft chat, DMs): a real textarea that keeps its width; 📷/🔗 behind + when narrow; icon emoji button", () => {
  const read = (f: string) => fs.readFileSync(path.resolve(import.meta.dirname, "../..", f), "utf8");
  const css = read("style.css");
  for (const f of ["chat.js", "dm.js"]) {
    const js = read(f);
    assert.match(js, /<textarea name="body" rows="1"[^>]*placeholder="Type a message…"/, f + ": a textarea with the placeholder");
    assert.doesNotMatch(js, /type="number"/, f + ": never a number input");
    assert.match(js, /class="ch-icon ch-plus" data-plus/, f + ": the + menu");
    assert.match(js, /<div class="ch-extra">/, f + ": 📷 and 🔗 grouped for the + menu");
    assert.match(js, /class="ch-send-i"/, f + ": ➤ when narrow");
  }
  assert.match(css, /\.ch-row \.bd-ta \{ flex: 1 1 0; min-width: 160px; \}/, "the text box takes the remaining width, at least 160px");
  assert.match(css, /\.ch-compose textarea \{[^}]*font: 18px/, "18px text");
  assert.match(css, /\.ch-compose textarea \{[^}]*background: var\(--ink\)[^}]*caret-color/, "dark background and a visible cursor");
  assert.match(css, /\.ch-compose textarea \{[^}]*max-height: 116px/, "about 4 lines, then it scrolls");
  assert.match(css, /@container \(max-width: 420px\) \{[^@]*\.ch-row \.ch-plus \{ display: flex; \}[^@]*\.ch-extra \{ display: none; \}/, "narrow: + instead of 📷 🔗");
  assert.doesNotMatch(css, /\.dr-dock \.ch-row[^{]*\{ flex-wrap: wrap/, "the Draft chat no longer wraps the row");
  const emoji = read("emoji.js");
  assert.match(emoji, /class="ch-icon em-open"[^>]*aria-label="Emoji"[^>]*>😊<\/button>/, "an icon-sized emoji button");
  assert.doesNotMatch(emoji, /😊 Emoji</, "no big EMOJI box");
  assert.match(emoji, /host\.insertAdjacentHTML\("afterend", btn\)/, "inside the row, right after the text box");
});
