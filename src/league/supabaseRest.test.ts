import { test } from "node:test";
import assert from "node:assert/strict";
import { deleteWhere, sbBase, sbHeaders, selectAll } from "./supabaseRest.ts";

const cfg = { url: "https://x.supabase.co/rest/v1/", serviceKey: "sb_secret_test" };

test("base URL accepts the dashboard's /rest/v1/ suffix; sb_secret_ keys only go in apikey", () => {
  assert.equal(sbBase(cfg), "https://x.supabase.co/rest/v1/");
  assert.equal(sbBase({ ...cfg, url: "https://x.supabase.co" }), "https://x.supabase.co/rest/v1/");
  assert.equal(sbHeaders(cfg).Authorization, undefined);
  assert.equal(sbHeaders({ ...cfg, serviceKey: "eyJabc" }).Authorization, "Bearer eyJabc");
});

test("selectAll pages past the 1,000-row cap until a short page", async () => {
  const ranges: string[] = [];
  const f = (async (_u: string, init: RequestInit) => {
    const r = (init.headers as Record<string, string>).Range!; ranges.push(r);
    const from = Number(r.split("-")[0]);
    const n = from < 4 ? 2 : 1;
    return new Response(JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: from + i }))));
  }) as unknown as typeof fetch;
  const rows = await selectAll<{ id: number }>(cfg, "nfl_players", "select=id", f, 2);
  assert.deepEqual(rows.map(r => r.id), [0, 1, 2, 3, 4]);
  assert.deepEqual(ranges, ["0-1", "2-3", "4-5"]);
});

test("errors carry the table and status", async () => {
  const bad = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(selectAll(cfg, "nfl_players", "select=id", bad), /nfl_players: HTTP 401/);
  await assert.rejects(deleteWhere(cfg, "roster_entries", "season=eq.2026", bad), /roster_entries delete: HTTP 401/);
});
