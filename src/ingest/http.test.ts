import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHttp } from "./http.ts";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("createHttp", () => {
  test("retries 429 using Retry-After, then succeeds", async () => {
    const sleeps: number[] = [];
    let n = 0;
    const http = createHttp({
      headers: {}, sleep: async ms => { sleeps.push(ms); },
      fetchImpl: (async () => (++n === 1 ? json({}, 429, { "retry-after": "3" }) : json({ ok: true }))) as typeof fetch
    });
    assert.deepEqual(await http.get("https://x/y"), { ok: true });
    assert.deepEqual(sleeps, [3000]);
  });

  test("gives up on 401 without retrying, and doesn't leak the query string", async () => {
    let n = 0;
    const http = createHttp({ headers: {}, fetchImpl: (async () => { n++; return json({ error: "bad key" }, 401); }) as typeof fetch });
    await assert.rejects(http.get("https://api.example/v1/stats?secret=1"), (e: Error) => /HTTP 401/.test(e.message) && !e.message.includes("secret"));
    assert.equal(n, 1);
  });

  test("spaces requests by minIntervalMs", async () => {
    const sleeps: number[] = [];
    const http = createHttp({ headers: {}, minIntervalMs: 1000, sleep: async ms => { sleeps.push(ms); }, fetchImpl: (async () => json({})) as typeof fetch });
    await http.get("https://x/1"); await http.get("https://x/2");
    assert.equal(sleeps.length, 1);
    assert.ok(sleeps[0]! > 900 && sleeps[0]! <= 1000);
  });

  test("caches responses on disk when asked", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b5-http-"));
    let n = 0;
    const http = createHttp({ headers: {}, cacheDir: dir, fetchImpl: (async () => { n++; return json({ v: n }); }) as typeof fetch });
    assert.deepEqual(await http.get("https://x/final", { cache: true }), { v: 1 });
    assert.deepEqual(await http.get("https://x/final", { cache: true }), { v: 1 });
    assert.deepEqual(await http.get("https://x/live"), { v: 2 });
    assert.equal(n, 2);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
