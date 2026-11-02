/* Every UPDATE and DELETE inside a database function has a WHERE clause (2026-11-02).
   Supabase runs pg-safeupdate for API requests: an UPDATE/DELETE without WHERE fails ("UPDATE
   requires a WHERE clause"), also inside functions called from the site (Start the draft broke on
   the one-row draft_state header). PGlite has no pg-safeupdate, so this checks the SQL itself: the
   LATEST definition of each function across the migrations (top-level one-time migration statements
   run as the owner, outside the API, and aren't checked). Also the REST helpers refuse an empty filter. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const dir = path.resolve(import.meta.dirname, "../../supabase/migrations");

/** UPDATE/DELETE statements without a WHERE (a WHERE inside a subquery doesn't count). */
export function unscoped(sql: string): string[] {
  const s = sql.replace(/--[^\n]*/g, m => " ".repeat(m.length));
  const out: string[] = [];
  const re = /\b(update\s+(?:only\s+)?[a-z_."]+\s+(?:as\s+)?[a-z_]*\s*set\b|delete\s+from\s+[a-z_."]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    let i = m.index, depth = 0, q = false, end = s.length;
    for (; i < s.length; i++) {
      const c = s[i];
      if (c === "'") q = !q;
      if (q) continue;
      if (c === "(") depth++;
      else if (c === ")") { if (depth === 0) { end = i; break; } depth--; }
      else if (c === ";" && depth === 0) { end = i; break; }
    }
    let flat = s.slice(m.index, end);
    for (let k = 0; k < 8; k++) flat = flat.replace(/\([^()]*\)/g, "");
    if (!/\bwhere\b/i.test(flat)) out.push(s.slice(m.index, end).replace(/\s+/g, " ").slice(0, 100));
  }
  return out;
}

/** The latest body of every function, by name (later migrations replace earlier ones). */
function latestFunctions(): Map<string, { file: string; body: string }> {
  const fns = new Map<string, { file: string; body: string }>();
  for (const f of fs.readdirSync(dir).sort()) {
    const sql = fs.readFileSync(path.join(dir, f), "utf8");
    const re = /create\s+(?:or\s+replace\s+)?function\s+([a-z_]+\.[a-z_]+)\s*\(/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql))) {
      const start = sql.indexOf("$$", m.index), stop = sql.indexOf("$$", start + 2);
      if (start < 0 || stop < 0) continue;
      fns.set(m[1]!.toLowerCase(), { file: f, body: sql.slice(start + 2, stop) });
    }
    for (const d of sql.matchAll(/drop function (?:if exists )?([a-z_]+\.[a-z_]+)/gi)) fns.delete(d[1]!.toLowerCase());
  }
  return fns;
}

test("no database function runs an UPDATE or DELETE without a WHERE (pg-safeupdate refuses them)", () => {
  const bad: string[] = [];
  for (const [name, f] of latestFunctions()) for (const st of unscoped(f.body)) bad.push(`${name} (${f.file}): ${st}`);
  assert.deepEqual(bad, []);
  assert.ok(latestFunctions().size > 150, "the scan sees the functions");
});

test("the scan itself: catches a bare UPDATE/DELETE, ignores a WHERE inside a subquery, accepts a scoped one", () => {
  assert.equal(unscoped("update public.draft_state set status = 'live';").length, 1);
  assert.equal(unscoped("update public.draft_state set x = (select 1 from t where t.id = 1);").length, 1);
  assert.equal(unscoped("delete from public.notify_queue;").length, 1);
  assert.equal(unscoped("update public.draft_state set status = 'live' where id;").length, 0);
  assert.equal(unscoped("delete from public.x where id = 1;").length, 0);
});

test("the REST helpers refuse an empty filter (a server job can't update or delete a whole table)", async () => {
  const { deleteWhere, updateWhere } = await import("../league/supabaseRest.ts");
  const f = (async () => new Response("[]")) as unknown as typeof fetch;
  const cfg = { url: "https://x.supabase.co", serviceKey: "k" };
  await assert.rejects(deleteWhere(cfg, "t", "", f), /needs a filter/);
  await assert.rejects(updateWhere(cfg, "t", " ", {}, f), /needs a filter/);
});
