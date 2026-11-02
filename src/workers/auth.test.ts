/* Tests for auth.js (classic browser script, loaded into a VM context). */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<Response>;
interface Auth {
  storageKey(cfg: unknown): string;
  fromFragment(hash: string, now: number): null | { error?: string; session?: { access_token: string; refresh_token: string; expires_at: number; user: { id: string; email: string } } };
  requestLink(cfg: unknown, email: string, redirectTo: string, f: Fetch): Promise<{ ok: boolean; error?: string }>;
  current(cfg: unknown, opts: { storage: Storage; now: number; fetchImpl: Fetch }): Promise<null | { access_token: string; expires_at: number }>;
  signOut(cfg: unknown, opts: { storage: Storage; fetchImpl: Fetch }): Promise<void>;
  api(cfg: unknown, session: unknown, path: string, init: unknown, f: Fetch): Promise<{ ok: boolean; status: number; data: unknown; error?: string }>;
  saveSession(cfg: unknown, storage: Storage, s: unknown): void;
  getSession(cfg: unknown, storage: Storage): unknown;
}
const ctx: Record<string, unknown> = { Buffer };
vm.runInNewContext(fs.readFileSync(path.resolve(import.meta.dirname, "../../auth.js"), "utf8"), ctx);
const A = ctx.B5Auth as Auth;

const CFG = { url: "https://kngwdttpbpezlvjrkrrg.supabase.co", publishableKey: "sb_publishable_x", configured: true };
const NOW = Date.parse("2026-10-15T20:00:00Z");
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const JWT = `${b64({ alg: "HS256" })}.${b64({ sub: "user-1", email: "manager@example.com", role: "authenticated" })}.sig`;

function memStorage(): Storage {
  const m = new Map<string, string>();
  return { getItem: k => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: k => void m.delete(k), clear: () => m.clear(), key: () => null, length: 0 } as Storage;
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

describe("auth.js", () => {
  test("storage key matches supabase-js (sb-<ref>-auth-token)", () => {
    assert.equal(A.storageKey(CFG), "sb-kngwdttpbpezlvjrkrrg-auth-token");
  });

  test("parses the magic-link return fragment into a session", () => {
    const r = A.fromFragment(`#access_token=${JWT}&expires_in=3600&refresh_token=rt1&token_type=bearer&type=magiclink`, NOW)!;
    assert.equal(r.session!.access_token, JWT);
    assert.equal(r.session!.refresh_token, "rt1");
    assert.equal(r.session!.expires_at, NOW / 1000 + 3600);
    assert.deepEqual({ ...r.session!.user }, { id: "user-1", email: "manager@example.com" });
  });

  test("parses an error return (expired link) and ignores normal routes", () => {
    assert.deepEqual({ ...A.fromFragment("#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired", NOW)! },
      { error: "Email link is invalid or has expired" });
    assert.equal(A.fromFragment("#lineups", NOW), null);
    assert.equal(A.fromFragment("", NOW), null);
  });

  test("requestLink posts to /auth/v1/otp with the redirect and a normalized email", async () => {
    let seen: { url: string; body: unknown; apikey: string } | undefined;
    const r = await A.requestLink(CFG, "  Manager@Example.com ", "https://b5football.win/", async (url, init) => {
      seen = { url, body: JSON.parse(init!.body!), apikey: init!.headers!.apikey! };
      return json({});
    });
    assert.equal(r.ok, true);
    assert.equal(seen!.url, "https://kngwdttpbpezlvjrkrrg.supabase.co/auth/v1/otp?redirect_to=https%3A%2F%2Fb5football.win%2F");
    assert.deepEqual(seen!.body, { email: "manager@example.com", create_user: true });
    assert.equal(seen!.apikey, "sb_publishable_x");
  });

  test("requestLink explains invite-only rejections, rate limits and bad emails", async () => {
    const hookReject = async () => json({ code: 403, msg: "The B5 league is invite-only. Ask the commissioner for an invite." }, 403);
    assert.match((await A.requestLink(CFG, "stranger@example.com", "", hookReject)).error!, /isn't on the league's invite list/);
    assert.match((await A.requestLink(CFG, "a@b.co", "", async () => json({ msg: "email rate limit exceeded" }, 429))).error!, /Wait a minute/);
    assert.match((await A.requestLink(CFG, "not-an-email", "", async () => { throw new Error("should not call"); })).error!, /valid email/);
    assert.match((await A.requestLink(CFG, "a@b.co", "", async () => { throw new Error("offline"); })).error!, /Couldn't reach/);
  });

  test("current(): returns a fresh session as is; refreshes one about to expire", async () => {
    const st = memStorage();
    A.saveSession(CFG, st, { access_token: "old", refresh_token: "rt1", expires_at: NOW / 1000 + 3000, user: { id: "u", email: "e" } });
    assert.equal((await A.current(CFG, { storage: st, now: NOW, fetchImpl: async () => { throw new Error("no refresh needed"); } }))!.access_token, "old");

    A.saveSession(CFG, st, { access_token: "old", refresh_token: "rt1", expires_at: NOW / 1000 + 30, user: { id: "u", email: "e" } });
    let body: unknown;
    const s = await A.current(CFG, { storage: st, now: NOW, fetchImpl: async (url, init) => {
      assert.match(url, /\/auth\/v1\/token\?grant_type=refresh_token$/);
      body = JSON.parse(init!.body!);
      return json({ access_token: "new", refresh_token: "rt2", expires_in: 3600 });
    } });
    assert.deepEqual(body, { refresh_token: "rt1" });
    assert.equal(s!.access_token, "new");
    assert.equal((A.getSession(CFG, st) as { refresh_token: string }).refresh_token, "rt2", "rotated refresh token saved");
  });

  test("current(): a revoked refresh token signs you out; a server outage keeps you signed in", async () => {
    const st = memStorage();
    const near = { access_token: "a", refresh_token: "rt", expires_at: NOW / 1000 + 30, user: { id: "u", email: "e" } };
    A.saveSession(CFG, st, near);
    assert.equal(await A.current(CFG, { storage: st, now: NOW, fetchImpl: async () => json({ msg: "Invalid Refresh Token" }, 400) }), null);
    assert.equal(A.getSession(CFG, st), null);
    A.saveSession(CFG, st, near);
    assert.equal((await A.current(CFG, { storage: st, now: NOW, fetchImpl: async () => json({}, 503) }))!.access_token, "a");
  });

  test("signOut clears the session and tells Supabase", async () => {
    const st = memStorage();
    A.saveSession(CFG, st, { access_token: "a", refresh_token: "r", expires_at: NOW / 1000 + 3000, user: { id: "u", email: "e" } });
    let called = "";
    await A.signOut(CFG, { storage: st, fetchImpl: async (url, init) => { called = `${url} ${init!.headers!.Authorization}`; return json({}, 204); } });
    assert.equal(A.getSession(CFG, st), null);
    assert.equal(called, "https://kngwdttpbpezlvjrkrrg.supabase.co/auth/v1/logout Bearer a");
  });

  test("api() sends the user's token and reports errors", async () => {
    let auth = "";
    const ok = await A.api(CFG, { access_token: "tok" }, "invites?select=*", {}, async (_u, init) => { auth = init!.headers!.Authorization!; return json([{ email: "x@y.z" }]); });
    assert.deepEqual([ok.ok, auth, (ok.data as unknown[]).length], [true, "Bearer tok", 1]);
    const bad = await A.api(CFG, null, "invites", { method: "POST", body: "{}" }, async () => json({ message: "permission denied for table invites" }, 401));
    assert.deepEqual([bad.ok, bad.error], [false, "permission denied for table invites"]);
  });
});

describe("passwords and 6-digit codes (2026-11-02)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const X = A as any;
  type Call = { url: string; method: string; body: Record<string, unknown> | null; auth: string | null };
  /** A fake Supabase Auth: routes by path; records every call. */
  function fakeAuth(routes: Record<string, (body: Record<string, unknown>) => [number, unknown]>) {
    const calls: Call[] = [];
    const f: Fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ url, method: init.method || "GET", body, auth: init.headers?.Authorization ?? null });
      const key = Object.keys(routes).find(k => url.includes("/auth/v1/" + k));
      const [status, out] = key ? routes[key]!(body || {}) : [404, { msg: "not found" }];
      return new Response(JSON.stringify(out), { status });
    };
    return { f, calls };
  }
  const TOKENS = { access_token: JWT, refresh_token: "r1", expires_in: 3600, user: { id: "user-1", email: "manager@example.com" } };
  const opts = (f: Fetch, storage = memStorage()) => ({ storage, fetchImpl: f, now: NOW });

  test("email + password signs in and keeps the session (refresh token: stays signed in)", async () => {
    const { f, calls } = fakeAuth({ "token?grant_type=password": b => b.password === "goodpass99" ? [200, TOKENS] : [400, { error_code: "invalid_credentials", msg: "Invalid login credentials" }] });
    const st = memStorage();
    const r = await X.signInPassword(CFG, " Manager@Example.com ", "goodpass99", opts(f, st));
    assert.equal(r.ok, true);
    assert.deepEqual(calls[0]!.body, { email: "manager@example.com", password: "goodpass99" });
    const saved = A.getSession(CFG, st) as { refresh_token: string; user: { id: string } };
    assert.equal(saved.refresh_token, "r1"); assert.equal(saved.user.id, "user-1");
  });

  test("wrong password: a plain message; 5 wrong in a row lock this email for 5 minutes (the server also rate-limits)", async () => {
    const { f, calls } = fakeAuth({ "token?grant_type=password": () => [400, { error_code: "invalid_credentials", msg: "Invalid login credentials" }] });
    const st = memStorage();
    const r1 = await X.signInPassword(CFG, "a@b.co", "nope1234", opts(f, st));
    assert.equal(r1.ok, false); assert.match(r1.error, /That password isn't right/);
    for (let i = 0; i < 4; i++) await X.signInPassword(CFG, "a@b.co", "nope1234", opts(f, st));
    const locked = await X.signInPassword(CFG, "a@b.co", "right-one", opts(f, st));
    assert.equal(locked.locked, true); assert.match(locked.error, /Wait 5 minutes/);
    assert.equal(calls.length, 5, "the 6th try never reaches the server");
    const later = await X.signInPassword(CFG, "a@b.co", "right-one", { storage: st, fetchImpl: f, now: NOW + 5 * 60 * 1000 + 1 });
    assert.equal(later.locked, undefined, "after 5 minutes it asks the server again");
    const rl = await X.signInPassword(CFG, "c@d.co", "x", opts(fakeAuth({ "token?grant_type=password": () => [429, { msg: "Request rate limit reached" }] }).f));
    assert.match(rl.error, /Too many tries/);
  });

  test("sign-in code: send, then type it (type email); expired and wrong codes say so", async () => {
    const { f, calls } = fakeAuth({ otp: () => [200, {}], verify: b => b.token === "123456" ? [200, TOKENS] : b.token === "000000" ? [403, { error_code: "otp_expired", msg: "Token has expired or is invalid" }] : [403, { msg: "Invalid OTP" }] });
    assert.equal((await X.sendCode(CFG, "M@x.com", f)).ok, true);
    assert.deepEqual(calls[0]!.body, { email: "m@x.com", create_user: true }, "no redirect link: a code");
    assert.match((await X.verifyCode(CFG, "m@x.com", "000000", "email", opts(f))).error, /expired or isn't right. Send a new one/);
    assert.match((await X.verifyCode(CFG, "m@x.com", "12", "email", opts(f))).error, /6-digit code/);
    const st = memStorage();
    const ok = await X.verifyCode(CFG, "m@x.com", "123 456", "email", opts(f, st));
    assert.equal(ok.ok, true);
    assert.deepEqual(calls.at(-1)!.body, { type: "email", email: "m@x.com", token: "123456" });
    assert.ok(A.getSession(CFG, st));
    const blocked = await X.sendCode(CFG, "stranger@x.com", fakeAuth({ otp: () => [403, { msg: "The B5 league is invite-only. Ask the commissioner for an invite." }] }).f);
    assert.match(blocked.error, /isn't on the league's invite list/, "sign-ups stay blocked by the invite-only hook");
  });

  test("forgot password: a reset code (recover, verify type recovery), then the new password; no links", async () => {
    const { f, calls } = fakeAuth({ recover: () => [200, {}], verify: b => b.type === "recovery" && b.token === "654321" ? [200, TOKENS] : [403, { error_code: "otp_expired" }], user: () => [200, { id: "user-1" }] });
    assert.equal((await X.sendResetCode(CFG, "manager@example.com", f)).ok, true);
    assert.deepEqual(calls[0]!.body, { email: "manager@example.com" });
    const v = await X.verifyCode(CFG, "manager@example.com", "654321", "recovery", opts(f));
    const r = await X.setPassword(CFG, v.session, "brand-new-pass", null, opts(f));
    assert.equal(r.ok, true);
    assert.deepEqual([calls.at(-1)!.method, calls.at(-1)!.body, calls.at(-1)!.auth], ["PUT", { password: "brand-new-pass" }, "Bearer " + JWT]);
  });

  test("set a password from an old session: Supabase asks for a fresh code (reauthenticate), sent as the nonce", async () => {
    const { f, calls } = fakeAuth({ "user": b => b.nonce === "112233" ? [200, {}] : [400, { error_code: "reauthentication_needed", msg: "Password update requires reauthentication" }], reauthenticate: () => [200, {}] });
    const sess = { access_token: JWT, user: { email: "manager@example.com" } };
    const first = await X.setPassword(CFG, sess, "my new password", null, opts(f));
    assert.equal(first.reauth, true);
    assert.equal((await X.reauthenticate(CFG, sess, f)).ok, true);
    assert.equal(calls.at(-1)!.method, "GET");
    assert.equal((await X.setPassword(CFG, sess, "my new password", "112 233", opts(f))).ok, true);
    assert.deepEqual(calls.at(-1)!.body, { password: "my new password", nonce: "112233" });
  });

  test("password rules: at least 8 characters, the most common blocked, nothing else", () => {
    assert.match(X.passwordProblem("short1", "a@b.co"), /at least 8/);
    for (const p of ["password", "Password1", "12345678", "qwerty123", "steelers", "iloveyou"]) assert.match(X.passwordProblem(p, "a@b.co"), /most common/, p);
    assert.match(X.passwordProblem("manager1", "manager1@example.com"), /email name/);
    assert.match(X.passwordProblem("aaaaaaaa", "a@b.co"), /less guessable/);
    for (const p of ["blitz on 3rd down", "Bridgeville5!", "terriblytowel"]) assert.equal(X.passwordProblem(p, "a@b.co"), null, p);
  });
});
