/* Tests for keepalive-check.js (the commissioner's stale-heartbeat banner).
   It's a classic browser script, so it's loaded into a VM context here. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

interface Api {
  warning(status: unknown, now: number): string | null;
  sessionToken(cfg: unknown, storage: unknown, now: number): string | null;
  check(cfg: unknown, opts: unknown): Promise<string | null>;
  render(doc: unknown, msg: string | null): void;
}
const ctx: Record<string, unknown> = {};
vm.runInNewContext(fs.readFileSync(path.resolve(import.meta.dirname, "../../keepalive-check.js"), "utf8"), ctx);
const K = ctx.B5Keepalive as Api;

const NOW = Date.parse("2026-10-20T12:00:00Z");
const ago = (h: number) => new Date(NOW - h * 3600 * 1000).toISOString();
const CFG = { url: "https://kngwdttpbpezlvjrkrrg.supabase.co", publishableKey: "sb_publishable_x", configured: true };
const store = (v: unknown) => ({ getItem: (k: string) => (k === "sb-kngwdttpbpezlvjrkrrg-auth-token" ? JSON.stringify(v) : null) });

describe("keep-alive banner", () => {
  test("no warning while the Cloudflare heartbeat is fresh (under 3 days)", () => {
    assert.equal(K.warning({ heartbeats: [{ name: "cloudflare-cron", at: ago(71) }] }, NOW), null);
  });
  test("warns when the Cloudflare heartbeat is over 3 days old, even if the GitHub backup is fresh", () => {
    const m = K.warning({ heartbeats: [{ name: "nightly", at: ago(1) }, { name: "cloudflare-cron", at: ago(4 * 24 + 2) }] }, NOW)!;
    assert.match(m, /last checked in 4 days ago/);
    assert.match(m, /pauses after about 7 days/);
  });
  test("warns when the Worker has never checked in", () => {
    assert.match(K.warning({ heartbeats: [] }, NOW)!, /never checked in/);
  });
  test("nothing for non-commissioners (the database returns null)", () => {
    assert.equal(K.warning(null, NOW), null);
  });

  test("only asks the database when someone is signed in with an unexpired session", async () => {
    assert.equal(K.sessionToken(CFG, store({ access_token: "tok", expires_at: NOW / 1000 + 60 }), NOW), "tok");
    assert.equal(K.sessionToken(CFG, store({ access_token: "tok", expires_at: NOW / 1000 - 60 }), NOW), null);
    assert.equal(K.sessionToken(CFG, { getItem: () => null }, NOW), null);
    assert.equal(K.sessionToken(CFG, { getItem: () => "{not json" }, NOW), null);
    let called = 0;
    const r = await K.check(CFG, { now: NOW, storage: { getItem: () => null }, fetchImpl: async () => { called++; return new Response("null"); } });
    assert.deepEqual([r, called], [null, 0]);
  });

  test("calls keepalive_status with the user's token and returns the warning", async () => {
    let seen: { url: string; auth: string } | undefined;
    const r = await K.check(CFG, {
      now: NOW, storage: store({ access_token: "tok", expires_at: NOW / 1000 + 600 }),
      fetchImpl: async (url: string, init: { headers: Record<string, string> }) => {
        seen = { url, auth: init.headers.Authorization! };
        return new Response(JSON.stringify({ heartbeats: [{ name: "cloudflare-cron", at: ago(100) }] }), { status: 200 });
      }
    });
    assert.equal(seen!.url, "https://kngwdttpbpezlvjrkrrg.supabase.co/rest/v1/rpc/keepalive_status");
    assert.equal(seen!.auth, "Bearer tok");
    assert.match(r!, /4 days ago/);
  });

  test("never throws: network or API errors mean no banner", async () => {
    const opts = { now: NOW, storage: store({ access_token: "tok" }) };
    assert.equal(await K.check(CFG, { ...opts, fetchImpl: async () => { throw new Error("offline"); } }), null);
    assert.equal(await K.check(CFG, { ...opts, fetchImpl: async () => new Response("no", { status: 401 }) }), null);
    assert.equal(await K.check({ ...CFG, configured: false }, { ...opts, fetchImpl: async () => { throw new Error("should not be called"); } }), null);
  });
});
