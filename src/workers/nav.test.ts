/* Navigation (nav.js, route.js, style.css): the simplified nav for older members (2026-11-01).
   Top bar for logged-out / manager / each role, menus, the phone bottom bar, More tiles, page titles
   and tabs, old routes redirecting, and the readability rules (18px base, nothing under 15px,
   48px tap targets). */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const read = (f: string) => fs.readFileSync(path.resolve(import.meta.dirname, "../..", f), "utf8");
const ctx: Record<string, unknown> = {};
vm.runInNewContext(read("nav.js"), ctx);
vm.runInNewContext(read("route.js"), ctx);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const N = ctx.B5Nav as any;
const R = ctx.B5Route as { parse(h: string, k: (x: string) => boolean): Record<string, unknown> };
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const PAGES = new Set(["home", "myteam", "live", "board", "chat", "dm", "players", "trades", "trade", "team", "survivor", "confidence", "schedule", "teams",
  "payouts", "history", "rules", "traditions", "account", "commish", "commish-payouts", "treasury", "admin", "unsubscribe", "more"]);
const known = (k: string) => PAGES.has(k);

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
/** The top bar's items in order: links and menu buttons (not the links inside menus). */
const topItems = (html: string) => {
  const noLists = html.replace(/<div class="menu-list"[\s\S]*?<\/div><\/div>/g, "</div>");
  return [...noLists.matchAll(/<(a|button)\b[^>]*>([\s\S]*?)<\/\1>/g)].map(m => text(m[2]!).replace(/\s*\d+$/, "").replace(" ▾", ""));
};
const menuLinks = (html: string, id: string) => {
  const m = new RegExp(`<div class="menu-list" id="menu-${id}"[^>]*>([\\s\\S]*?)</div></div>`).exec(html);
  return m ? [...m[1]!.matchAll(/<(a|button)\b([^>]*)>([\s\S]*?)<\/\1>/g)].map(x => text(x[3]!)) : null;
};
const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map(m => m[1]);

const OUT = { signedIn: false, name: "", roles: [] };
const MANAGER = { signedIn: true, name: "Mike", roles: [] };
const as = (...roles: string[]) => ({ signedIn: true, name: "Adam", roles });

test("top bar: exactly Home · My Team · Scores · Pools · Messages · League ▾ · [name] ▾ (or Sign in)", () => {
  assert.deepEqual(topItems(N.topHtml(MANAGER, { sec: "home" })), ["Home", "My Team", "Scores", "Pools", "Messages", "League", "Mike"]);
  assert.deepEqual(topItems(N.topHtml(OUT, { sec: "home" })), ["Home", "My Team", "Scores", "Pools", "Messages", "League", "Sign in"]);
  const html = N.topHtml(MANAGER, { sec: "scores" });
  assert.deepEqual(hrefs(html).slice(0, 5), ["#home", "#myteam", "#scores", "#pools", "#messages"]);
  assert.match(html, /<a href="#scores" class="active" aria-current="page" data-sec="scores">Scores<\/a>/, "the page you're on is filled");
  assert.deepEqual(menuLinks(html, "league"), ["Standings & Schedule", "Teams", "Players", "Payouts", "History", "Rules", "Traditions"]);
  // Menus are buttons (click/tap), closed until clicked, with aria
  assert.match(html, /<button type="button" class="menu-btn" aria-haspopup="true" aria-expanded="false" aria-controls="menu-league">/);
  assert.match(html, /id="menu-league" hidden/);
  assert.doesNotMatch(html, /onmouseover|:hover/);
  // A League page fills the League button; an account page the name
  assert.match(N.topHtml(MANAGER, { sec: "league" }), /class="menu-btn active"[^>]*aria-controls="menu-league" aria-current="page"/);
  assert.match(N.topHtml(MANAGER, { sec: "user" }), /class="menu-btn active"[^>]*aria-controls="menu-user"/);
});

test("account menu: My Account, then only the role tools you hold, then Sign out; logged out = a Sign in button", () => {
  assert.equal(menuLinks(N.topHtml(OUT, {}), "user"), null, "no account menu when signed out");
  assert.match(N.topHtml(OUT, {}), /<a href="#account" class="nav-signin">Sign in<\/a>/);
  assert.deepEqual(menuLinks(N.topHtml(MANAGER, {}), "user"), ["My Account", "Sign out"], "a manager: no officer tools");
  assert.deepEqual(menuLinks(N.topHtml(as("commissioner"), {}), "user"), ["My Account", "Commissioner", "Treasury", "Sign out"], "commissioners read the books");
  assert.deepEqual(menuLinks(N.topHtml(as("treasurer"), {}), "user"), ["My Account", "Treasury", "Sign out"]);
  assert.deepEqual(menuLinks(N.topHtml(as("admin"), {}), "user"), ["My Account", "Admin", "Sign out"]);
  assert.deepEqual(menuLinks(N.topHtml(as("admin", "treasurer"), {}), "user"), ["My Account", "Treasury", "Admin", "Sign out"]);
  assert.deepEqual(menuLinks(N.topHtml(as("admin", "commissioner", "treasurer"), {}), "user"), ["My Account", "Commissioner", "Treasury", "Admin", "Sign out"]);
  assert.match(N.topHtml(as("admin"), {}), /<p class="menu-h">Officer tools<\/p>/);
  assert.doesNotMatch(N.topHtml(MANAGER, {}), /Officer tools|#commish|#admin|#treasury/);
  // The name is escaped
  assert.match(N.topHtml({ signedIn: true, name: "<b>x</b>", roles: [] }, {}), /&lt;b&gt;x&lt;\/b&gt;/);
});

test("Messages: one combined unread badge on the bar, a count per tab", () => {
  assert.match(N.topHtml(MANAGER, {}, { messages: 3 }), /Messages<span class="nav-badge" id="msgBadge" aria-label="3 unread">3<\/span>/);
  assert.match(N.topHtml(MANAGER, {}, { messages: 0 }), /id="msgBadge" hidden/);
  assert.match(N.topHtml(MANAGER, {}, { messages: 120 }), />99\+</);
  const head = N.headHtml(N.sectionOf({ page: "dm" }), { board: 2, chat: 0, dm: 1 });
  assert.match(head, /Message Board<span class="nav-badge" data-badge="board" aria-label="2 unread">2<\/span>/);
  assert.match(head, /Chat<span class="nav-badge" data-badge="chat" hidden/);
  assert.match(head, /<a href="#messages\/private" class="active" aria-current="page">Private<span/);
  // No symbol-only items: every link and button has words
  for (const html of [N.topHtml(as("admin", "commissioner", "treasurer"), {}, { messages: 1 }), N.bottomHtml({ sec: "home" }, { messages: 1 }), N.moreHtml(as("admin"))]) {
    for (const m of html.matchAll(/<(a|button)\b[^>]*>([\s\S]*?)<\/\1>/g)) assert.match(text(m[2]!.replace(/<span class="bb-ic"[^>]*>[^<]*<\/span>|<span[^>]*aria-hidden="true">[^<]*<\/span>/g, "")), /[A-Za-z]{2,}/, m[0]);
  }
});

test("phones: a bottom bar of 5 (icon + word): Home · My Team · Scores · Messages · More; More has big tiles", () => {
  const bb = N.bottomHtml({ sec: "scores" }, { messages: 2 });
  assert.deepEqual([...bb.matchAll(/<span class="bb-label">([^<]+)<\/span>/g)].map(m => m[1]), ["Home", "My Team", "Scores", "Messages", "More"]);
  assert.equal((bb.match(/class="bb-ic" aria-hidden="true"/g) || []).length, 5, "every button has an icon AND a word");
  assert.match(bb, /<a href="#scores" class="active" aria-current="page" data-sec="scores">/);
  assert.match(bb, /id="msgBadgeBb"[^>]*>2</);
  assert.match(N.bottomHtml({ sec: "league" }), /<a href="#more" class="active"/, "League pages light up More");
  assert.match(N.bottomHtml({ sec: "pools" }), /<a href="#more" class="active"/);
  const tiles = (html: string) => [...html.matchAll(/class="tile[^"]*"[^>]*>([^<]+)</g)].map(m => text(m[1]!));
  assert.deepEqual(tiles(N.moreHtml(OUT)), ["Pools", "Standings & Schedule", "Teams", "Players", "Payouts", "History", "Rules", "Traditions", "Sign in"]);
  assert.deepEqual(tiles(N.moreHtml(MANAGER)), ["Pools", "Standings & Schedule", "Teams", "Players", "Payouts", "History", "Rules", "Traditions", "My Account", "Sign out"]);
  assert.deepEqual(tiles(N.moreHtml(as("commissioner", "admin"))).slice(-5), ["My Account", "Commissioner", "Treasury", "Admin", "Sign out"]);
  // No hamburger in the page any more
  assert.doesNotMatch(read("index.html"), /nav-toggle|☰<\/button>/);
  assert.match(read("index.html"), /<nav class="bottom-bar" id="bottomBar"/);
});

test("page title and tabs: Scores, Pools (Confidence Pool | Survivor), Messages (3 tabs), My Team (4 tabs)", () => {
  const tabs = (r: Record<string, unknown>) => {
    const h = N.headHtml(N.sectionOf(r));
    return { title: text(/<h1 class="page-title">([^<]+)</.exec(h)![1]!), tabs: [...h.matchAll(/<a href="([^"]+)"( class="active")?[^>]*>([^<]+)/g)].map(m => (m[2] ? "*" : "") + text(m[3]!)) };
  };
  assert.deepEqual(tabs({ page: "live" }), { title: "Scores", tabs: [] });
  assert.deepEqual(tabs({ page: "confidence" }), { title: "Pools", tabs: ["*Confidence Pool", "Survivor"] });
  assert.deepEqual(tabs({ page: "survivor" }), { title: "Pools", tabs: ["Confidence Pool", "*Survivor"] });
  assert.deepEqual(tabs({ page: "board" }), { title: "Messages", tabs: ["*Message Board", "Chat", "Private"] });
  assert.deepEqual(tabs({ page: "chat" }), { title: "Messages", tabs: ["Message Board", "*Chat", "Private"] });
  assert.deepEqual(tabs({ page: "myteam" }), { title: "My Team", tabs: ["*Lineup", "Roster", "Add / Drop", "Trades"] });
  assert.deepEqual(tabs({ page: "myteam", tab: "roster" }), { title: "My Team", tabs: ["Lineup", "*Roster", "Add / Drop", "Trades"] });
  assert.deepEqual(tabs({ page: "players" }).tabs, ["Lineup", "Roster", "*Add / Drop", "Trades"]);
  assert.deepEqual(tabs({ page: "trade" }).tabs, ["Lineup", "Roster", "Add / Drop", "*Trades"]);
  assert.deepEqual(tabs({ page: "schedule" }), { title: "Standings & Schedule", tabs: [] });
  assert.deepEqual(tabs({ page: "commish" }), { title: "Commissioner", tabs: [] });
  // Every page the router knows has a section, title and top-bar item
  for (const p of PAGES) { const s = N.sectionOf({ page: p }); assert.ok(s.title && ["home", "myteam", "scores", "pools", "messages", "league", "user", "more"].includes(s.sec), p); }
  // Every nav link lands on a real page (no dead links)
  const all = [N.topHtml(as("admin", "commissioner", "treasurer"), {}), N.bottomHtml({}), N.moreHtml(as("admin", "commissioner", "treasurer"))].join("") +
    Object.values(N.TABS as Record<string, string[][]>).flat().map(t => `href="${t[0]}"`).join("");
  for (const h of new Set(hrefs(all))) { const r = plain(R.parse(h!, known)); assert.ok(r.page !== "home" || h === "#home", h); assert.equal(r.redirect, undefined, h + " is a current link"); }
});

test("old routes redirect to their new homes", () => {
  const go = (h: string) => { const r = plain(R.parse(h, known)); return [r.page, r.redirect]; };
  assert.deepEqual(go("#live"), ["live", "#scores"]);
  assert.deepEqual(go("#live/9/0011"), ["live", "#scores/9/0011"]);
  assert.deepEqual(go("#board"), ["board", "#messages/board"]);
  assert.deepEqual(go("#board/7"), ["board", "#messages/board/7"]);
  assert.deepEqual(go("#chat/league"), ["chat", "#messages/chat/league"]);
  assert.deepEqual(go("#dm"), ["dm", "#messages/private"]);
  assert.deepEqual(go("#dm/12"), ["dm", "#messages/private/12"]);
  assert.deepEqual(go("#lineups"), ["myteam", "#myteam"]);
  assert.deepEqual(go("#standings"), ["schedule", "#schedule"]);
  assert.deepEqual(go("#pool"), ["confidence", "#confidence"]);
  // Current links don't redirect; deep links keep their parts
  for (const h of ["#scores", "#scores/9", "#messages", "#messages/board/7", "#messages/private/12", "#myteam/roster", "#pools", "#more", "#players/claims", "#team/0011", "#account/email"]) assert.equal(go(h)[1], undefined, h);
  // The page scripts link to the new routes (no old hashes in markup)
  for (const f of ["live.js", "board.js", "chat.js", "dm.js", "trades.js", "team.js", "myteam.js", "app.js", "account.js", "players.js"]) {
    const code = read(f).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    assert.doesNotMatch(code, /href="#(live|board|chat|dm)[/"]|["']#(live|board|chat|dm)(\/|["'])/, f);
  }
});

test("readability: 18px base, nothing under 15px, 48px tap targets, the active page filled", () => {
  const css = read("style.css");
  assert.match(css, /body \{[^}]*font: 18px\/1\.55 var\(--body\)/);
  const sizes = [...css.matchAll(/font-size:\s*([\d.]+)(px|em|rem)|font:\s*(?:\d{3}\s+)?([\d.]+)px/g)].map(m => m[3] ? Number(m[3]) : m[2] === "px" ? Number(m[1]) : Number(m[1]) * 15);   // em: the worst case is a 15px parent
  const tooSmall = sizes.filter(x => x < 15);
  assert.deepEqual(tooSmall, [], "no font size below 15px");
  // Every rule for exactly that selector (a later rule can add to an earlier one)
  const rule = (sel: string) => {
    const all = [...css.matchAll(new RegExp("(?:^|\\n|\\} |  )" + sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}", "g"))].map(m => m[1]);
    assert.ok(all.length, sel); return all.join(";");
  };
  const minH = (sel: string) => Number(/min-height:\s*(\d+)px/.exec(rule(sel))![1]);
  for (const sel of [".nav > a, .menu-btn, .nav-signin", ".menu-list a, .menu-out", ".page-tabs a", ".tile", ".btn"]) assert.ok(minH(sel) >= 48, sel + " min-height " + minH(sel));
  assert.ok(Number(/min-width:\s*(\d+)px/.exec(rule(".nav > a, .menu-btn, .nav-signin"))![1]) >= 48);
  assert.ok(Number(/min-height:\s*(\d+)px/.exec(/\.bottom-bar a \{([^}]*)\}/.exec(css)![1]!)![1]) >= 48, "bottom bar buttons");
  assert.ok(Number(/min-width:\s*(\d+)px/.exec(/\.bottom-bar a \{([^}]*)\}/.exec(css)![1]!)![1]) >= 48);
  assert.match(css, /\.wk \{ min-width: 48px; height: 48px; \}/, "week chips");
  // Active = filled background, not just a color
  assert.match(rule(".nav > a.active, .menu-btn.active"), /background: var\(--gold\); color: var\(--ink-deep\)/);
  assert.match(rule(".page-tabs a.active"), /background: var\(--gold\)/);
  assert.match(css, /\.bottom-bar a\.active \{ background: var\(--gold\); color: var\(--ink-deep\); \}/);
  // Phones: the bar replaces the top links; menus open on click (no :hover-only menus)
  assert.match(css, /@media \(max-width: 760px\) \{\n  \.nav \{ display: none; \}\n  \.bottom-bar \{ display: flex;/);
  assert.doesNotMatch(css, /\.menu:hover|:hover > \.menu-list/);
});

test("contrast: text and the gold fill meet WCAG AA", () => {
  const lum = (hex: string) => {
    const c = hex.replace("#", "").match(/../g)!.map(x => parseInt(x, 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  };
  const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
  assert.ok(ratio("#0b0b0b", "#ffb612") >= 4.5, "black on gold (active items)");
  assert.ok(ratio("#f5f5f2", "#0b0b0b") >= 4.5, "chalk on black");
  assert.ok(ratio("#f5f5f2", "#1e1e1e") >= 4.5, "chalk on cards (tabs, tiles)");
  assert.ok(ratio("#b5b5ae", "#151515") >= 4.5, "menu headings");
  assert.ok(ratio("#ffb3a6", "#151515") >= 4.5, "Sign out");
});
