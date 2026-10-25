/* Email notifications: rendering (escaping, previews without images, footer, unsubscribe headers)
   and the Edge Function handler (nonce auth, claim -> Resend -> done, retry reporting, unsubscribe). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { content, renderEmail, type NotifyItem } from "./email.ts";
import { FROM, handle } from "./handler.ts";

const O = { site: "https://b5football.win", functionsUrl: "https://ref.supabase.co/functions/v1" };
const TOKEN = "00000000-0000-0000-0000-00000000000b.dm." + "a".repeat(32);
const item = (kind: NotifyItem["kind"], data: Record<string, unknown>): NotifyItem => ({ id: 1, user_id: "u", kind, email: "bob@example.com", token: TOKEN, data });

test("DM email: sender with team, count, text preview, Reply on B5 button, no reply-by-email, one-click unsubscribe", () => {
  const e = renderEmail(item("dm", { count: 3, senders: [{ name: "Adam", team: "NSFW" }], preview: "Want <b>Gibbs</b>? 📷", link: "#dm/7" }), O);
  assert.equal(e.subject, "3 new messages from Adam (NSFW)");
  assert.match(e.html, /Want &lt;b&gt;Gibbs&lt;\/b&gt;\? 📷/, "escaped");
  assert.doesNotMatch(e.html, /<img/i, "no images");
  assert.match(e.html, /href="https:\/\/b5football.win\/#dm\/7"[^>]*>Reply on B5</);
  assert.match(e.html, /Replying to this email isn&#39;t supported/);
  assert.match(e.html, new RegExp(`href="https://b5football.win/#unsubscribe/${TOKEN.replace(/\./g, "\\.")}"[^>]*>Turn off these emails`));
  assert.match(e.text, /Reply on B5: https:\/\/b5football.win\/#dm\/7/);
  assert.deepEqual(e.headers, { "List-Unsubscribe": `<https://ref.supabase.co/functions/v1/notify?u=${TOKEN}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
  assert.equal(content(item("dm", { count: 1, senders: [{ name: "Bob", team: null }] })).subject, "New message from Bob");
  assert.equal(content(item("dm", { count: 2, senders: [{ name: "Bob" }, { name: "Carol" }] })).subject, "2 new messages from Bob and Carol");
});

test("other email types: subjects and lines", () => {
  assert.equal(content(item("mentions", { where: "Chat", from: { name: "Adam", team: "Mac Daddies" } })).subject, "Adam (Mac Daddies) mentioned you in Chat");
  const t = content(item("trades", { status: "proposed", test: true, from_team: "Stealers", to_team: "NSFW", summary: "Stealers get X; NSFW get Y", note: "fair", expires_at: "2026-10-29T17:00:00Z" }));
  assert.equal(t.subject, "[TEST] Trade proposal from Stealers");
  assert.deepEqual(t.lines.slice(0, 3), ["Stealers get X; NSFW get Y.", 'Note: "fair"', "Answer by Thu 1:00 PM ET."]);
  assert.equal(content(item("trades", { status: "approved", test: false, summary: "s", decision_note: "ok" })).lines[1], 'Commissioner: "ok"');
  assert.equal(content(item("waivers", { claims: [{ player: "A", status: "won", result: "Round 1" }, { player: "B", status: "lost", result: "Claimed by NSFW" }] })).subject, "Waiver results: 1 of 2 claims won");
  assert.equal(content(item("announcements", { title: "Draft date" })).subject, "B5: Draft date");
  const l = content(item("lineup", { week: 3, team: "Stealers", players: [{ name: "Bye Guy", pos: "WR", problem: "bye", deadline: "2028-09-24T17:00:00Z" }, { name: "Hurt", pos: "RB", problem: "out", deadline: "2028-09-24T17:00:00Z" }] }));
  assert.equal(l.subject, "Lineup check: 2 starters on bye or out (week 3)");
  assert.deepEqual(l.lines, ["WR Bye Guy: on bye (swap by Sun 1:00 PM ET)", "RB Hurt: OUT (swap by Sun 1:00 PM ET)"]);
});

// A fake Supabase + Resend for the handler.
function fakes(opts: { resendFails?: number; nonceOk?: boolean } = {}) {
  const calls: { url: string; body: any }[] = [];   // eslint-disable-line @typescript-eslint/no-explicit-any
  let resendFails = opts.resendFails ?? 0;
  const fetchImpl = (async (u: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url: String(u), body });
    const J = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });
    if (String(u).includes("live_nonces")) return J(opts.nonceOk === false ? [] : [{ nonce: "x" }]);
    if (String(u).endsWith("rpc/notify_claim")) return J([item("dm", { count: 1, senders: [{ name: "Adam", team: "NSFW" }], preview: "hi", link: "#dm/7" })]);
    if (String(u).endsWith("rpc/notify_done")) return J(null);
    if (String(u).endsWith("rpc/notify_unsubscribe")) return body.p_token === TOKEN ? J("dm") : J({ message: "That link isn't valid" }, 400);
    if (String(u) === "https://api.resend.com/emails") { if (resendFails-- > 0) return J({ message: "boom" }, 500); return J({ id: "re_123" }); }
    return J({}, 404);
  }) as typeof fetch;
  return { calls, fetchImpl };
}
const env = { SUPABASE_URL: "https://ref.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service", RESEND_API_KEY: "re_key" };
const post = (body: unknown, q = "") => new Request("https://ref.supabase.co/functions/v1/notify" + q, { method: "POST", body: JSON.stringify(body) });
const NONCE = "11111111-1111-1111-1111-111111111111";

test("handler: only with a fresh nonce; claims, sends through Resend from B5 Fantasy, reports each result", async () => {
  const f = fakes({ nonceOk: false });
  assert.equal((await handle(post({ nonce: NONCE }), env, f.fetchImpl)).status, 401);
  assert.ok(!f.calls.some(c => c.url.includes("resend")), "no email without a valid nonce");
  const g = fakes();
  const r = await (await handle(post({ nonce: NONCE }), env, g.fetchImpl)).json();
  assert.deepEqual(r, { claimed: 1, sent: 1, failed: 0 });
  const mail = g.calls.find(c => c.url === "https://api.resend.com/emails")!.body;
  assert.equal(mail.from, FROM);
  assert.deepEqual(mail.to, ["bob@example.com"]);
  assert.equal(mail.subject, "New message from Adam (NSFW)");
  assert.ok(mail.headers["List-Unsubscribe"]);
  assert.deepEqual(g.calls.find(c => c.url.endsWith("notify_done"))!.body, { p_id: 1, p_ok: true, p_provider_id: "re_123", p_error: null });
});

test("handler: a Resend failure is reported (the database retries once); no key = nothing sent", async () => {
  const f = fakes({ resendFails: 1 });
  const r = await (await handle(post({ nonce: NONCE }), env, f.fetchImpl)).json();
  assert.deepEqual(r, { claimed: 1, sent: 0, failed: 1 });
  assert.deepEqual(f.calls.find(c => c.url.endsWith("notify_done"))!.body, { p_id: 1, p_ok: false, p_provider_id: null, p_error: "Resend HTTP 500" });
  const g = fakes();
  const s = await (await handle(post({ nonce: NONCE }), { ...env, RESEND_API_KEY: "" }, g.fetchImpl)).json();
  assert.deepEqual(s, { skipped: "RESEND_API_KEY is not set" });
  assert.ok(!g.calls.some(c => c.url.endsWith("notify_claim")), "nothing claimed, so nothing is lost");
});

test("handler: unsubscribe link (GET page) and one-click POST, without signing in", async () => {
  const f = fakes();
  const ok = await handle(new Request(`https://ref.supabase.co/functions/v1/notify?u=${TOKEN}`), env, f.fetchImpl);
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /You won't get direct message emails/);
  const one = await handle(post({}, `?u=${TOKEN}`), env, f.fetchImpl);
  assert.deepEqual(await one.json(), { ok: true });
  const bad = await handle(new Request("https://ref.supabase.co/functions/v1/notify?u=nope"), env, f.fetchImpl);
  assert.equal(bad.status, 400);
});

test("every email says why it was sent and links to that setting", () => {
  const e = renderEmail(item("scoring", { day: "2026-10-25", week: 7, unofficial: true, link: "#live/7" }), O);
  assert.match(e.html, /Why you got this: &quot;Daily scoring update&quot; is on in your B5 email settings\. <a href="https:\/\/b5football.win\/#account\/email"[^>]*>Change this setting/);
  assert.match(e.text, /Change this setting: https:\/\/b5football.win\/#account\/email/);
});

test("waiver results in plain words", () => {
  const w = content(item("waivers", { claims: [
    { player: "A", status: "won", result: "Round 2" }, { player: "B", status: "lost", result: "Claimed by NSFW" },
    { player: "C", status: "skipped", result: "Roster full (18) and no drop" }, { player: "D", status: "lost", result: "Not reached in 8 rounds" },
    { player: "E", status: "skipped", result: "Player locked" }] }));
  assert.deepEqual(w.lines, ["✅ A: won in round 2", "❌ B: outbid on priority: NSFW had a higher waiver priority", "⏭ C: roster full and no player to drop",
    "❌ D: not reached: the rounds ran out first", "⏭ E: player locked (his game had started)"]);
});

test("new types: lineup confirmation, other teams' lineups, league waivers and moves, scoring, commissioner lineup emails", () => {
  const lineup = { team: "Mac Daddies", week: 7, saved_by: "Mike", saved_at: "2026-10-24T01:14:00Z",
    starters: [{ slot: "QB", name: "Joe Burrow", nfl: "CIN" }], bench: [{ name: "Bo Nix" }], warnings: [{ name: "Bye Guy", problem: "bye" }] };
  const s = content(item("lineup_saved", lineup));
  assert.equal(s.subject, "Lineup saved: Mac Daddies, week 7");
  assert.deepEqual(s.lines, ["Saved by Mike, Fri 9:14 PM ET.", "QB Joe Burrow (CIN)", "Bench: Bo Nix", "⚠ Bye Guy: on bye"]);
  const t = content(item("lineup_saved", { ...lineup, test: true }));   // 2026 test lineups
  assert.equal(t.subject, "TEST lineup saved: Mac Daddies, week 7");
  assert.equal(t.lines[0], "TEST lineup: MFL is official for 2026.");
  assert.equal(content(item("announcements", { ...lineup, commissioner: "lineup" })).subject, "From the commissioner: your week 7 lineup");
  assert.equal(content(item("announcements", { commissioner: "reminder", team: "NSFW", week: 7 })).subject, "Reminder: set your week 7 lineup");
  const dg = content(item("league_lineups", { mode: "digest", teams: [{ team: "NSFW", week: 7, by: "Alice", starters: [{ slot: "QB", name: "Goff" }] }, { team: "H.N.I.C", week: 7, starters: [] }] }));
  assert.equal(dg.subject, "Lineup changes: 2 teams");
  assert.deepEqual(dg.lines.slice(0, 2), ["NSFW (week 7, by Alice):", "QB Goff"]);
  assert.equal(content(item("league_lineups", { mode: "instant", teams: [{ team: "NSFW", week: 7 }] })).subject, "NSFW changed their lineup");
  assert.equal(content(item("league_waivers", { won: [{ team: "NSFW", player: "X", drop: "Y" }], claims: 3 })).lines[0], "NSFW: + X, − Y");
  assert.equal(content(item("league_moves", { moves: [{ team: "NSFW", added: "X", dropped: null }] })).lines[0], "NSFW: + X");
  const sc = content(item("scoring", { day: "2026-10-25", week: 7, unofficial: true, mine: { team: "Stealers", us: 80, opp: "NSFW", them: 90 },
    matchups: [{ away: "Stealers", away_score: 80, home: "NSFW", home_score: 90 }], high: { team: "NSFW", points: 90 }, danger: { team: "Stealers", points: 80 },
    corrections: [{ was: "NSFW", now: "Stealers" }] }));
  assert.equal(sc.subject, "Week 7 scores after Sunday (unofficial)");
  assert.deepEqual(sc.lines, ["Your matchup: Stealers 80.0, NSFW 90.0", "Stealers 80.0 @ NSFW 90.0", "Weekly high ($35 race): NSFW, 90.0",
    "Guillotine danger (lowest so far): Stealers, 80.0", "Stat correction changed a result: NSFW → Stealers now wins.", "Scores are unofficial until the week is finalized."]);
  assert.equal(content(item("league_trades", { status: "approved", from_team: "A", to_team: "B", summary: "A get X; B get Y" })).subject, "League trade completed: A and B");
});

test("account notices (role changes, test email): always sent, no unsubscribe link or header", () => {
  const g = renderEmail(item("account", { type: "role", role: "commissioner", action: "grant", by: "Adam", link: "#account" }), O);
  assert.equal(g.subject, "You're now a B5 commissioner");
  assert.match(g.text, /Adam gave you the commissioner role\./);
  assert.doesNotMatch(g.html, /Turn off these emails|Change this setting/);
  assert.deepEqual(g.headers, {});
  assert.match(g.html, /a notice about your B5 account/);
  assert.equal(content(item("account", { type: "role", role: "admin", action: "revoke", by: "Cy" })).subject, "Your B5 administrator role was removed");
  assert.equal(content(item("account", { type: "test" })).subject, "B5 test email");
});
