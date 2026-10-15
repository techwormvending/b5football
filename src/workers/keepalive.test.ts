import { test, describe } from "node:test";
import assert from "node:assert/strict";
import worker, { beat, HEARTBEAT_NAME, type Env } from "../../workers/keepalive/index.ts";

const env = (key = "sb_secret_testtesttest"): Env => ({ SUPABASE_URL: "https://ref.supabase.co/", SUPABASE_SERVICE_ROLE_KEY: key });

function fakeFetch(status = 201) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return new Response(status < 300 ? null : "boom", { status });
  }) as typeof fetch;
  return { f, calls };
}

describe("keep-alive Worker", () => {
  test("upserts its heartbeat row with the secret key in apikey only (sb_secret_)", async () => {
    const { f, calls } = fakeFetch();
    const r = await beat(env(), f, new Date("2026-10-15T18:13:00Z"));
    assert.deepEqual(r, { ok: true, status: 201 });
    assert.equal(calls[0]!.url, "https://ref.supabase.co/rest/v1/heartbeats?on_conflict=name");
    const h = calls[0]!.init.headers as Record<string, string>;
    assert.equal(h.apikey, "sb_secret_testtesttest");
    assert.equal(h.Authorization, undefined);
    assert.match(h.Prefer!, /merge-duplicates/);
    assert.deepEqual(JSON.parse(calls[0]!.init.body as string), { name: HEARTBEAT_NAME, at: "2026-10-15T18:13:00.000Z" });
  });

  test("legacy JWT service_role keys also go in Authorization", async () => {
    const { f, calls } = fakeFetch();
    await beat(env("eyJhbGciOi.test.sig"), f);
    assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, "Bearer eyJhbGciOi.test.sig");
  });

  test("reports failures instead of hiding them", async () => {
    assert.deepEqual(await beat(env(), fakeFetch(401).f), { ok: false, status: 401, error: "boom" });
    assert.match((await beat({ SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "" })).error!, /not configured/);
    const throwing = (async () => { throw new Error("network down"); }) as typeof fetch;
    assert.deepEqual(await beat(env(), throwing), { ok: false, status: 0, error: "network down" });
  });

  test("a failed cron run is marked failed (the promise rejects)", async () => {
    let p: Promise<unknown> | undefined;
    await worker.scheduled({}, { SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "" }, { waitUntil: x => { p = x; } });
    await assert.rejects(p!, /heartbeat failed/);
  });
});
