/* Message board page helpers (board.js, a classic browser script loaded into a VM context):
   sanitization of post text, upload and image-link checks, mentions, unread. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const read = (f: string) => fs.readFileSync(path.resolve(import.meta.dirname, "../..", f), "utf8");
const ctx: Record<string, unknown> = { LEAGUE: { season: 2026, teams: [] } };
vm.runInNewContext(read("teamlink.js"), ctx);
vm.runInNewContext(read("route.js"), ctx);
vm.runInNewContext(read("board.js"), ctx);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const B = ctx.B5Board as any;
const R = ctx.B5Route as { parse(h: string, k: (x: string) => boolean): Record<string, unknown> };
const fmt = (s: string, mentions: { label: string; me?: boolean }[] = []) => B.formatBody(s, { mentions });

test("light formatting: bold, italics, links, line breaks", () => {
  assert.equal(fmt("**Big** win, *barely*"), "<strong>Big</strong> win, <em>barely</em>");
  assert.equal(fmt("line one\nline two"), "line one<br>line two");
  assert.equal(fmt("see [the rules](https://b5football.win/#rules)"),
    'see <a href="https://b5football.win/#rules" target="_blank" rel="noopener noreferrer nofollow ugc">the rules</a>');
  assert.equal(fmt("[My Team](#myteam)"), '<a href="#myteam">My Team</a>', "in-site links stay in the tab");
  assert.equal(fmt("https://espn.com/nfl/story?id=1&x=2."),
    '<a href="https://espn.com/nfl/story?id=1&amp;x=2" target="_blank" rel="noopener noreferrer nofollow ugc">https://espn.com/nfl/story?id=1&amp;x=2</a>.', "a trailing period isn't part of the link");
  assert.equal(fmt("2 * 3 * 4"), "2 * 3 * 4", "lone asterisks stay text");
});

test("no raw HTML, ever: tags, attributes and script URLs come out as text", () => {
  const attacks = [
    "<script>alert(1)</script>", "<img src=x onerror=alert(1)>", '"><svg onload=alert(1)>',
    "[click](javascript:alert(1))", "[x](data:text/html;base64,PHNjcmlwdD4=)", "[x](https://a.com\" onmouseover=\"alert(1))",
    "**<b>bold</b>**", "https://x.com/<script>", "[<img src=x>](https://a.com)", "*<i onclick=alert(1)>*"];
  for (const a of attacks) {
    const html = fmt(a);
    const tags = [...html.matchAll(/<([a-z]+)\b([^>]*)>/gi)];
    for (const [, tag, attrs] of tags) {
      assert.ok(["a", "strong", "em", "br", "span"].includes(tag!.toLowerCase()), `${a} -> unexpected <${tag}>`);
      assert.doesNotMatch(attrs!, /\son\w+=/i, `${a} -> event handler`);
      assert.doesNotMatch(attrs!, /javascript:|data:/i, `${a} -> script URL`);
    }
    assert.doesNotMatch(html, /<script|<img|<svg|<iframe/i, a);
  }
  assert.equal(fmt("<b>hi</b>"), "&lt;b&gt;hi&lt;/b&gt;");
  assert.equal(fmt("[x](javascript:alert(1))"), "[x](javascript:alert(1))");
});

test("@mentions: longest name first, case-insensitive, yours highlighted; plain @ and emails untouched", () => {
  const m = [{ label: "Mac Daddies", me: true }, { label: "Mac" }, { label: "NSFW" }];
  assert.equal(fmt("@mac daddies vs @NSFW", m), '<span class="mention me">@mac daddies</span> vs <span class="mention">@NSFW</span>');
  assert.equal(fmt("mail me@NSFW.com or @nobody", m), "mail me@NSFW.com or @nobody");
  assert.equal(fmt("@<b>", [{ label: "<b>" }]), '<span class="mention">@&lt;b&gt;</span>', "names are escaped too");
});

test("mention autocomplete matches team or manager name", () => {
  const people = [{ team: "Mac Daddies", name: "Adam" }, { team: "NSFW", name: "Chris" }, { team: "Stealers", name: "" }];
  assert.deepEqual(B.mentionMatches("ad", people).map((p: { team: string }) => p.team), ["Mac Daddies"]);
  assert.deepEqual(B.mentionMatches("chr", people).map((p: { team: string }) => p.team), ["NSFW"]);
  assert.equal(B.mentionMatches("", people).length, 3);
});

test("uploads: images and GIFs only, 5 MB max; image links https only", () => {
  const file = (type: string, size: number) => ({ type, size });
  assert.equal(B.checkUpload(file("image/gif", 4_900_000)), null);
  assert.equal(B.checkUpload(file("image/jpeg", 200_000)), null);
  assert.equal(B.checkUpload(file("image/webp", 1)), null);
  assert.match(B.checkUpload(file("image/png", 5 * 1024 * 1024 + 1)), /over 5 MB/);
  assert.match(B.checkUpload(file("image/svg+xml", 100)), /Images only/, "SVG can carry script");
  assert.match(B.checkUpload(file("text/html", 100)), /Images only/);
  assert.match(B.checkUpload(file("video/mp4", 100)), /Images only/);
  assert.match(B.checkUpload(null), /No file/);
  assert.equal(B.checkImageUrl("https://media.giphy.com/media/abc/giphy.gif"), null);
  assert.match(B.checkImageUrl("http://example.com/a.gif"), /https/);
  assert.match(B.checkImageUrl("javascript:alert(1)"), /https/);
  assert.match(B.checkImageUrl('https://a.com/x.gif" onerror="alert(1)'), /doesn't look/);
  assert.deepEqual({ ...B.fitSize(4032, 3024, 1600) }, { w: 1600, h: 1200 }, "phone photos shrink before upload");
  assert.deepEqual({ ...B.fitSize(800, 600, 1600) }, { w: 800, h: 600 });
});

test("unread: others' activity after your last read, or in the week before your first visit", () => {
  const now = Date.parse("2026-10-22T12:00:00Z");
  const t = (minAgo: number, by = "bob") => ({ last_author_id: by, last_activity_at: new Date(now - minAgo * 60000).toISOString() });
  assert.equal(B.isUnread(t(5), new Date(now - 10 * 60000).toISOString(), now - 86400000, "me"), true);
  assert.equal(B.isUnread(t(15), new Date(now - 10 * 60000).toISOString(), now - 86400000, "me"), false);
  assert.equal(B.isUnread(t(5, "me"), null, now, "me"), false, "your own post");
  assert.equal(B.isUnread(t(60 * 24 * 3), null, now, "me"), true, "never opened, within the week before your first visit");
  assert.equal(B.isUnread(t(60 * 24 * 10), null, now, "me"), false);
});

test("home-page announcements become board text: links kept, tags dropped", () => {
  assert.equal(B.htmlToText('<p>Sign in on the <a href="#myteam">My Team</a> page.</p>\n  <p>GIFs &amp; more.</p>'), "Sign in on the [My Team](#myteam) page.\n\nGIFs & more.");
  assert.equal(B.htmlToText("<script>x</script>hi"), "xhi", "then rendered as escaped text anyway");
});

test("routes: #board and #board/<thread>", () => {
  const known = (k: string) => ["home", "board"].includes(k);
  assert.deepEqual({ ...R.parse("#board", known) }, { page: "board", week: null });
  assert.deepEqual({ ...R.parse("#board/42", known) }, { page: "board", week: null, thread: 42 });
});
