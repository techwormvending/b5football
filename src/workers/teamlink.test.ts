/* TeamLink: the component (teamlink.js) and a lint over every page script that fails when a team
   name could render without it. Rules for page scripts:
     1. Team data only through B5Team: no LEAGUE.teams / L.teams, no PostgREST "teams(name)" embeds,
        no teams.name from the database.
     2. B5Team.name() is plain text only: never inside esc(...), never on a line that builds markup,
        never passed around uncalled (no aliases, no .map(B5Team.name)).
     3. No local logo/initials helpers that take team objects (B5Team.logo / link instead).
   A line can opt out with a trailing "// teamlink-ok: <reason>"; each one is listed below so the
   exceptions stay visible. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");
const NOT_PAGES = new Set(["teamlink.js", "league-data.js", "supabase-config.js", "route.js", "auth.js", "realtime.js", "keepalive-check.js"]);
const PAGES = fs.readdirSync(ROOT).filter(f => f.endsWith(".js") && !NOT_PAGES.has(f)).sort();

const ctx: Record<string, unknown> = { LEAGUE: { teams: [
  { id: "0011", name: "Mac Daddies", division: "Black", logo: "https://example.com/m.png" },
  { id: "0003", name: "H.N.I.C", division: "Gold" },
  { id: "0009", name: "Bad <Name>", division: "Gold" }] } };
vm.runInNewContext(read("teamlink.js"), ctx);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const T = ctx.B5Team as any;

test("link: logo + name to the team profile, escaped; unknown ids aren't links", () => {
  assert.equal(T.link("0003"), '<a class="team-link" href="#team/0003"><div class="logo sm">H</div><span class="tl-name">H.N.I.C</span></a>');
  assert.match(T.link("0011", { logo: false, bold: true }), /^<a class="team-link" href="#team\/0011"><span class="tl-name"><b>Mac Daddies<\/b><\/span><\/a>$/);
  assert.match(T.link("0011"), /<img class="logo sm" src="https:\/\/example.com\/m.png"/);
  assert.match(T.link("0009"), /Bad &lt;Name&gt;/);
  assert.equal(T.link("<x>"), '<span class="team-link unknown">&lt;x&gt;</span>');
  assert.equal(T.option("0003", true, " (your team)"), '<option value="0003" selected>H.N.I.C (your team)</option>');
  assert.match(T.linkName("mac daddies"), /href="#team\/0011"/);
  assert.equal(T.linkName("Old Name <FC>"), "Old Name &lt;FC&gt;");
  assert.equal(T.name("0003"), "H.N.I.C");
});

test("page scripts exist and load TeamLink first", () => {
  assert.ok(PAGES.length >= 10, PAGES.join(", "));
  const html = read("index.html"), tl = html.indexOf('src="teamlink.js');
  assert.ok(tl > 0, "index.html loads teamlink.js");
  for (const p of PAGES) { const i = html.indexOf(`src="${p}`); assert.ok(i < 0 || i > tl, `${p} loads after teamlink.js`); }
});

const RULES: [RegExp, string][] = [
  [/\bL(EAGUE)?\.teams\b/, "read teams through B5Team (ids/name/link), not LEAGUE.teams"],
  [/teams\(name/, "don't embed teams(name) from the database; use team_id + B5Team"],
  [/esc\([^;]*(B5Team|TL\(\)|\bT)\.name\(/, "B5Team.name() inside esc(): render team names with B5Team.link()"],
  [/(B5Team|TL\(\)|\bT)\.name(?!\()/, "call B5Team.name(id) directly (no aliases)"],
  [/function\s*\([^)]*\)\s*\{\s*return\s+(B5Team|TL\(\)|T)\.name\(/, "no wrappers around B5Team.name (they hide it from this check)"],
  [/function\s+\w*\s*\(\s*t\b[^)]*\)\s*\{[^}]*t\.logo/, "no local logo helpers: use B5Team.logo / B5Team.link"],
  [/\b(teamById|teamName)\s*[=(:]/, "no local team lookups (teamById/teamName): use B5Team"]
];
const MARKUP = /(['"`]\s*<\/?[a-z]|<\/?(b|span|td|li|h[1-6]|p|div|strong|em|a)\b[^>]*>)/i;

test("lint: every team name on every page goes through TeamLink", () => {
  const problems: string[] = [], exceptions: string[] = [];
  for (const f of PAGES) {
    read(f).split("\n").forEach((line, i) => {
      const at = `${f}:${i + 1}`;
      if (/\/\/ teamlink-ok: \S/.test(line)) { exceptions.push(`${at} ${line.split("// teamlink-ok:")[1]!.trim()}`); return; }
      for (const [re, why] of RULES) if (re.test(line)) problems.push(`${at}: ${why}\n    ${line.trim().slice(0, 160)}`);
      if (/(B5Team|TL\(\)|\bT)\.name\(/.test(line) && MARKUP.test(line)) problems.push(`${at}: B5Team.name() on a line that builds markup: use B5Team.link()\n    ${line.trim().slice(0, 160)}`);
    });
  }
  assert.deepEqual(problems, [], "\n" + problems.join("\n"));
  assert.ok(exceptions.length <= 6, "keep the exceptions few:\n" + exceptions.join("\n"));
});
