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
