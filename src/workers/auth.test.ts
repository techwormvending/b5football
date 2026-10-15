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
