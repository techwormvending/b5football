/* The live practice-draft check (scripts/verify-practice.sql, run on the real database by
   .github/workflows/verify-practice.yml) must pass on the migrations and leave nothing behind. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { freshDb } from "./testdb.ts";

test("live practice-draft check: every item passes and everything is rolled back", async () => {
  const db = await freshDb();
  // Supabase's auth.users has these too
  await db.exec(`alter table auth.users add column aud text, add column role text, add column updated_at timestamptz`);
  const teams = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(4, "0"));
  await db.exec(`
    insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-00000000000c', 'commish@example.com', '{"display_name":"Commish"}');
    update public.profiles set is_commissioner = true, is_admin = true;
    insert into public.teams (id, name, division) values ${teams.map(t => `('${t}', 'Team ${t}', 'Black')`).join(", ")};
    insert into public.team_managers values ('0011', '00000000-0000-0000-0000-00000000000c');
    insert into public.nfl_players (id, name, position, nfl_team) values
      ${Array.from({ length: 90 }, (_, i) => `('P${String(i).padStart(3, "0")}', 'Player ${i}', '${["QB", "RB", "WR", "TE"][i % 4]}', 'DET')`).join(", ")};
    insert into public.league_settings (id) values (true) on conflict do nothing;
    update public.league_settings set practice_video_url = 'https://scribehow.com/embed/How_to_Create_a_New_Practice_Draft_on_B5_Football__iD_l2TKMREOYcfUsx13N8w?as=video' where true;
  `);
  const before = (await db.query<{ n: number }>(`select (select count(*) from public.drafts) + (select count(*) from auth.users) + (select count(*) from public.invites) as n`)).rows[0].n;
  let msg = "";
  try { await db.exec(readFileSync("scripts/verify-practice.sql", "utf8")); } catch (e) { msg = (e as Error).message; }
  assert.match(msg, /B5VERIFY[\s\S]*B5VERIFY-END/, msg);
  if (process.env.B5_SHOW) console.log(msg);
  const lines = msg.split("\n").filter(l => /^(PASS|FAIL)/.test(l));
  assert.ok(lines.length >= 40, `${lines.length} checks:\n${msg}`);
  assert.deepEqual(lines.filter(l => l.startsWith("FAIL")), [], msg);
  for (const item of ["1", "2", "3", "4", "5", "6", "7", "8"]) assert.ok(lines.some(l => l.includes(`[${item}]`)), `item ${item}`);
  const after = (await db.query<{ n: number }>(`select (select count(*) from public.drafts) + (select count(*) from auth.users) + (select count(*) from public.invites) as n`)).rows[0].n;
  assert.equal(after, before, "nothing kept");
});
