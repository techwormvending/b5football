/* RLS tests: run the real migrations in Postgres (PGlite) and act as anonymous
   visitors, managers, the commissioner and server jobs, the way Supabase's
   Data API does (role + JWT claims). Each test gets a fresh database. */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { as, freshDb, type Who } from "./testdb.ts";

const COMMISH = "00000000-0000-0000-0000-00000000000c";
const ALICE = "00000000-0000-0000-0000-00000000000a";   // manages team 0001
const BOB = "00000000-0000-0000-0000-00000000000b";     // manages team 0002
const anon: Who = { role: "anon" };
const service: Who = { role: "service_role" };
const user = (uid: string): Who => ({ role: "authenticated", uid });
const S = 2026, W = 6;

/** Seed as the migration owner (bypasses RLS), like the commissioner setting up a season. */
async function seed(db: PGlite) {
  await db.exec(`
    insert into auth.users (id, email, raw_user_meta_data) values
      ('${COMMISH}', 'commish@example.com', '{"display_name":"Commish"}'),
      ('${ALICE}', 'alice@example.com', '{}'),
      ('${BOB}', 'bob@example.com', '{}');
    update public.profiles set is_commissioner = true, is_admin = true where id = '${COMMISH}';   -- like the league's real account: both roles
    insert into public.teams (id, name, division) values ('0001', 'NSFW', 'Black'), ('0002', 'Stealers', 'Gold');
    insert into public.team_managers values ('0001', '${ALICE}'), ('0002', '${BOB}');
    insert into public.nfl_players (id, name, position, nfl_team) values
      ('QB-DET', 'Jared Goff', 'QB', 'DET'),        -- game later this week
      ('QB-KC', 'Patrick Mahomes', 'QB', 'KC'),     -- game already kicked off
      ('RB-DET', 'Jahmyr Gibbs', 'RB', 'DET'),
      ('QB-ARI', 'Kyler Murray', 'QB', 'ARI'),
      ('QB-FA', 'Free Agent', 'QB', 'DET');
    insert into public.nfl_games (season, week, game_key, home, away, kickoff) values
      (${S}, ${W}, 'DET@ARI', 'ARI', 'DET', now() + interval '2 days'),
      (${S}, ${W}, 'KC@LV', 'LV', 'KC', now() - interval '1 hour');
    insert into public.roster_entries (season, team_id, player_id) values
      (${S}, '0001', 'QB-DET'), (${S}, '0001', 'QB-KC'), (${S}, '0001', 'RB-DET'), (${S}, '0002', 'QB-ARI');
    insert into public.lineup_slots (season, week, team_id, slot, player_id) values
      (${S}, ${W}, '0002', 0, 'QB-ARI'),          -- Bob's QB (game not started)
      (${S}, ${W}, '0001', 1, 'RB-DET');
    insert into public.transactions (season, team_id, type, players_in, created_by) values
      (${S}, '0002', 'add', '{QB-FA}', '${BOB}');  -- Bob's pending pickup (id 1)
    insert into public.standings (season, team_id, wins) values (${S}, '0001', 4), (${S}, '0002', 2);
    insert into public.player_scores (season, week, player_id, points, source) values (${S}, ${W}, 'QB-DET', 21.5, 'live');
    insert into public.announcements (title, published_at) values ('Live', now() - interval '1 day'), ('Draft', null);
    insert into public.score_overrides (season, week, target_key, type, points, reason) values (${S}, ${W}, 'DEF:ARI', 'points', 0, 'test');
    insert into public.audit_log (actor_label, action) values ('system', 'seed');
  `);
}

const rows = async (db: PGlite, who: Who, sql: string, params: unknown[] = []) =>
  (await as(db, who, tx => tx.query(sql, params))).rows;
// Rows as plain records (the newer test blocks read fields directly).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rowsT = async (db: PGlite, who: Who, sql: string, params: unknown[] = []) => (await rows(db, who, sql, params)) as Record<string, any>[];
const affected = async (db: PGlite, who: Who, sql: string, params: unknown[] = []) =>
  (await as(db, who, tx => tx.query(sql, params))).affectedRows ?? 0;
const denied = (db: PGlite, who: Who, sql: string, re: RegExp = /row-level security|permission denied|only the commissioner|locked|not on team|cannot play|must be pending/i) =>
  assert.rejects(as(db, who, (tx: Transaction) => tx.query(sql)), re);

let db: PGlite;
beforeEach(async () => { db = await freshDb(); await seed(db); });

describe("every table is protected", () => {
  // Service-only tables: RLS on, deliberately no policies and no grants to anon/authenticated.
  const SERVICE_ONLY = new Set(["heartbeats", "live_nonces", "live_games", "board_bot_keys", "notify_queue", "treasury_notices"]);
  test("RLS is enabled on every public table, and every table but the service-only ones has policies", async () => {
    const t = (await db.query<{ relname: string; rls: boolean; policies: number }>(`
      select c.relname, c.relrowsecurity as rls,
             (select count(*)::int from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'`)).rows;
    assert.ok(t.length >= 17);
    for (const r of t) {
      assert.equal(r.rls, true, `${r.relname} must have RLS enabled`);
      if (!SERVICE_ONLY.has(r.relname)) assert.ok(r.policies > 0, `${r.relname} needs explicit policies`);
    }
  });
});

test("no default grants leak: anon only ever has SELECT, and only on public-data tables", async () => {
  const PUBLIC = new Set(["teams", "nfl_players", "nfl_games", "roster_entries", "score_weeks", "player_scores", "matchups", "standings", "announcements",
    "season_settings", "team_scores", "awards", "guillotine", "survivor_status", "confidence_scores", "score_events", "player_injuries", "league_settings", "draft_picks", "lineup_slots", "test_lineups", "nfl_game_info", "league_defaults"]);
  const g = (await db.query<{ table_name: string; privilege_type: string }>(`
    select table_name, privilege_type from information_schema.role_table_grants
    where table_schema = 'public' and grantee = 'anon'`)).rows;
  for (const r of g) {
    assert.equal(r.privilege_type, "SELECT", `anon must not have ${r.privilege_type} on ${r.table_name}`);
    assert.ok(PUBLIC.has(r.table_name), `anon must not have access to ${r.table_name}`);
  }
  const hb = (await db.query(`select 1 from information_schema.role_table_grants where table_name = 'heartbeats' and grantee in ('anon', 'authenticated')`)).rows;
  assert.equal(hb.length, 0, "heartbeats is service_role only");
});

describe("a manager can't touch another team (the core rule)", () => {
  test("can't add to another team's lineup", () =>
    denied(db, user(ALICE), `insert into public.lineup_slots (season, week, team_id, slot, player_id) values (${S}, ${W}, '0002', 1, 'QB-ARI')`));

  test("can't change or delete another team's lineup (no rows match)", async () => {
    assert.equal(await affected(db, user(ALICE), `update public.lineup_slots set player_id = 'QB-DET' where team_id = '0002'`), 0);
    assert.equal(await affected(db, user(ALICE), `delete from public.lineup_slots where team_id = '0002'`), 0);
    const [r] = (await db.query<{ player_id: string }>(`select player_id from public.lineup_slots where team_id = '0002' and slot = 0`)).rows;
    assert.equal(r!.player_id, "QB-ARI", "Bob's lineup untouched");
  });

  test("can't move his own lineup row onto another team", () =>
    denied(db, user(ALICE), `update public.lineup_slots set team_id = '0002' where team_id = '0001' and slot = 1`));

  test("lineups are open: every team's lineup is visible to everyone, before kickoff too (B5 doesn't hide lineups)", async () => {
    assert.deepEqual(await rows(db, user(ALICE), `select player_id from public.lineup_slots where team_id = '0002'`), [{ player_id: "QB-ARI" }], "Bob's QB plays later this week: Alice sees him now");
    assert.deepEqual(await rows(db, anon, `select team_id, player_id from public.lineup_slots order by team_id, slot`), [{ team_id: "0001", player_id: "RB-DET" }, { team_id: "0002", player_id: "QB-ARI" }], "visitors too");
    await denied(db, anon, `insert into public.lineup_slots (season, week, team_id, slot, player_id) values (${S}, ${W}, '0001', 0, 'QB-DET')`, /permission denied/);
  });

  test("can't create a transaction for another team", () =>
    denied(db, user(ALICE), `insert into public.transactions (season, team_id, type, players_in) values (${S}, '0002', 'drop', '{}')`));

  test("can't edit, cancel or delete another team's transaction", async () => {
    assert.equal(await affected(db, user(ALICE), `update public.transactions set status = 'cancelled' where id = 1`), 0);
    assert.equal(await affected(db, user(ALICE), `delete from public.transactions where id = 1`), 0);
    const [r] = (await db.query<{ status: string }>(`select status from public.transactions where id = 1`)).rows;
    assert.equal(r!.status, "pending");
  });

  test("can't edit another manager's profile", async () => {
    assert.equal(await affected(db, user(ALICE), `update public.profiles set display_name = 'hacked' where id = '${BOB}'`), 0);
  });
});

describe("a manager's own team", () => {
  test("can set his own lineup", async () => {
    assert.equal(await affected(db, user(ALICE), `insert into public.lineup_slots (season, week, team_id, slot, player_id) values (${S}, ${W}, '0001', 0, 'QB-DET')`), 1);
    const [r] = (await db.query<{ set_by: string }>(`select set_by from public.lineup_slots where team_id = '0001' and slot = 0`)).rows;
    assert.equal(r!.set_by, ALICE);
  });

  test("lineup rules: roster, slot position and kickoff lock are enforced", async () => {
    await denied(db, user(ALICE), `insert into public.lineup_slots (season, week, team_id, slot, player_id) values (${S}, ${W}, '0001', 0, 'QB-FA')`, /not on team/);
    await denied(db, user(ALICE), `insert into public.lineup_slots (season, week, team_id, slot, player_id) values (${S}, ${W}, '0001', 2, 'QB-DET')`, /cannot play the RB slot/);
    await denied(db, user(ALICE), `insert into public.lineup_slots (season, week, team_id, slot, player_id) values (${S}, ${W}, '0001', 0, 'QB-KC')`, /locked/);
  });

  test("a started player can't be benched", async () => {
    await db.exec(`insert into public.lineup_slots (season, week, team_id, slot, player_id) values (${S}, ${W}, '0001', 0, 'QB-KC')`);
    await denied(db, user(ALICE), `delete from public.lineup_slots where team_id = '0001' and slot = 0`, /locked/);
    await denied(db, user(ALICE), `update public.lineup_slots set player_id = 'QB-DET' where team_id = '0001' and slot = 0`, /locked/);
  });

  test("other teams' players become visible once their game kicks off", async () => {
    await db.exec(`update public.nfl_games set kickoff = now() - interval '5 minutes' where game_key = 'DET@ARI'`);
    assert.deepEqual(await rows(db, user(ALICE), `select player_id from public.lineup_slots where team_id = '0002'`), [{ player_id: "QB-ARI" }]);
  });

  test("transactions: create pending, edit and cancel his own; never approve", async () => {
    assert.equal(await affected(db, user(ALICE), `insert into public.transactions (season, team_id, type, players_in) values (${S}, '0001', 'add', '{QB-FA}')`), 1);
    const [t] = (await db.query<{ id: number; created_by: string }>(`select id, created_by from public.transactions where team_id = '0001'`)).rows;
    assert.equal(t!.created_by, ALICE);
    await denied(db, user(ALICE), `insert into public.transactions (season, team_id, type, status) values (${S}, '0001', 'drop', 'approved')`, /must be pending/);
    await denied(db, user(ALICE), `update public.transactions set status = 'approved' where id = ${t!.id}`, /only the commissioner/i);
    await denied(db, user(ALICE), `update public.transactions set decided_by = '${ALICE}' where id = ${t!.id}`, /only be changed by the commissioner/);
    assert.equal(await affected(db, user(ALICE), `update public.transactions set note = 'changed my mind' where id = ${t!.id}`), 1);
    assert.equal(await affected(db, user(ALICE), `update public.transactions set status = 'cancelled' where id = ${t!.id}`), 1);
    assert.equal(await affected(db, user(ALICE), `update public.transactions set status = 'pending' where id = ${t!.id}`), 0, "a cancelled one is no longer editable");
    assert.equal(await affected(db, user(ALICE), `delete from public.transactions where id = ${t!.id}`), 0, "managers cancel, they don't delete");
  });

  test("can rename himself but can't make himself commissioner", async () => {
    assert.equal(await affected(db, user(ALICE), `update public.profiles set display_name = 'Alice' where id = '${ALICE}'`), 1);
    await denied(db, user(ALICE), `update public.profiles set is_commissioner = true where id = '${ALICE}'`, /Only the commissioner/);
  });

  test("can't write league data or read commissioner tables", async () => {
    assert.equal(await affected(db, user(ALICE), `update public.standings set wins = 99`), 0);
    await denied(db, user(ALICE), `insert into public.standings (season, team_id) values (2027, '0001')`);
    await denied(db, user(ALICE), `insert into public.team_managers values ('0002', '${ALICE}')`, /row-level security|already owns/);
    await denied(db, user(ALICE), `insert into public.roster_entries (season, team_id, player_id) values (${S}, '0001', 'QB-FA')`);
    assert.deepEqual(await rows(db, user(ALICE), `select * from public.score_overrides`), []);
    assert.deepEqual(await rows(db, user(ALICE), `select * from public.audit_log`), []);
    assert.deepEqual(await rows(db, user(ALICE), `select * from public.review_queue`), []);
    await denied(db, user(ALICE), `insert into public.audit_log (action) values ('fake')`);
  });
});

describe("anonymous visitors", () => {
  test("read public data: teams, rosters, standings, scores, published announcements", async () => {
    assert.equal((await rows(db, anon, `select * from public.teams`)).length, 2);
    assert.equal((await rows(db, anon, `select * from public.roster_entries`)).length, 4);
    assert.equal((await rows(db, anon, `select * from public.standings`)).length, 2);
    assert.equal((await rows(db, anon, `select * from public.player_scores`)).length, 1);
    assert.deepEqual(await rows(db, anon, `select title from public.announcements`), [{ title: "Live" }]);
  });

  test("can't read private data", async () => {
    for (const t of ["profiles", "team_managers", "transactions", "score_overrides", "audit_log", "review_queue", "heartbeats"]) {
      await denied(db, anon, `select * from public.${t}`, /permission denied/);
    }
  });

  test("can't write anything", async () => {
    await denied(db, anon, `insert into public.teams (id, name, division) values ('0003', 'X', 'Black')`, /permission denied/);
    await denied(db, anon, `update public.standings set wins = 0`, /permission denied/);
    await denied(db, anon, `insert into public.lineup_slots (season, week, team_id, slot, player_id) values (${S}, ${W}, '0001', 0, 'QB-DET')`, /permission denied/);
  });
});

describe("commissioner", () => {
  test("can do everything: other teams' lineups (even locked), decide transactions, league data, overrides, audit", async () => {
    assert.equal(await affected(db, user(COMMISH), `update public.lineup_slots set player_id = 'QB-ARI' where team_id = '0002' and slot = 0`), 1);
    assert.equal(await affected(db, user(COMMISH), `insert into public.lineup_slots (season, week, team_id, slot, player_id) values (${S}, ${W}, '0001', 0, 'QB-KC')`), 1, "lock doesn't apply");
    assert.equal(await affected(db, user(COMMISH), `update public.transactions set status = 'approved', decided_by = '${COMMISH}', decided_at = now() where id = 1`), 1);
    assert.equal(await affected(db, user(COMMISH), `update public.standings set wins = 5 where team_id = '0001'`), 1);
    assert.equal(await affected(db, user(COMMISH), `insert into public.score_overrides (season, week, target_key, type, points, reason) values (${S}, ${W}, 'DEF:PHI', 'points', 10, 'Forfeit')`), 1);
    assert.equal((await rows(db, user(COMMISH), `select * from public.audit_log where action = 'seed'`)).length, 1, "(he's also an administrator, who reads the audit log)");
    assert.deepEqual(await rows(db, user(COMMISH), `select title from public.announcements order by id`), [{ title: "Live" }, { title: "Draft" }]);
    assert.equal(await affected(db, user(COMMISH), `update public.profiles set is_commissioner = true where id = '${BOB}'`), 1);
  });

  test("an approved trade is visible league-wide; pending ones only to the teams involved", async () => {
    await db.exec(`insert into public.transactions (season, team_id, type, partner_team_id, status) values (${S}, '0002', 'trade', '0001', 'pending')`);
    await db.exec(`insert into public.teams (id, name, division) values ('0003', 'Third', 'Gold')`);
    const CAROL = "00000000-0000-0000-0000-0000000000cc";
    await db.exec(`insert into auth.users (id, email) values ('${CAROL}', 'carol@example.com'); insert into public.team_managers values ('0003', '${CAROL}')`);
    assert.equal((await rows(db, user(ALICE), `select id from public.transactions where type = 'trade'`)).length, 1, "partner sees it");
    assert.equal((await rows(db, user(CAROL), `select id from public.transactions`)).length, 0, "uninvolved manager doesn't");
    await db.exec(`update public.transactions set status = 'approved' where type = 'trade'`);
    assert.equal((await rows(db, user(CAROL), `select id from public.transactions`)).length, 1);
  });
});

describe("keep-alive status (commissioner banner)", () => {
  test("only the commissioner sees heartbeat times; managers get null; anon can't call it", async () => {
    await db.exec(`insert into public.heartbeats (name, at) values ('cloudflare-cron', now() - interval '4 days'), ('nightly', now() - interval '1 hour')`);
    const [c] = await rows(db, user(COMMISH), `select public.keepalive_status() as s`);
    const s = (c as { s: { heartbeats: { name: string }[] } }).s;
    assert.deepEqual(s.heartbeats.map(h => h.name), ["nightly", "cloudflare-cron"], "newest first");
    const [m] = await rows(db, user(ALICE), `select public.keepalive_status() as s`);
    assert.equal((m as { s: unknown }).s, null);
    await denied(db, anon, `select public.keepalive_status()`, /permission denied/);
  });
});

describe("invite-only accounts", () => {
  const hook = (email: string) =>
    db.query<{ r: unknown }>(`select public.hook_before_user_created($1::jsonb) as r`, [JSON.stringify({ user: { email }, metadata: {} })]).then(x => x.rows[0]!.r);

  test("the sign-up hook allows invited emails (any case) and rejects everyone else", async () => {
    await db.exec(`insert into public.invites (email, team_id) values ('newguy@example.com', '0002')`);
    assert.deepEqual(await hook("NewGuy@Example.com "), {});
    assert.deepEqual(await hook("stranger@example.com"), { error: { http_code: 403, message: "The B5 league is invite-only. Ask the commissioner for an invite." } });
    assert.deepEqual(await hook(""), { error: { http_code: 403, message: "The B5 league is invite-only. Ask the commissioner for an invite." } });
  });

  test("only Supabase Auth can run the hook", async () => {
    await denied(db, anon, `select public.hook_before_user_created('{}'::jsonb)`, /permission denied/);
    await denied(db, user(COMMISH), `select public.hook_before_user_created('{}'::jsonb)`, /permission denied/);
    const r = await db.transaction(async tx => { await tx.exec("set local role supabase_auth_admin"); return tx.query(`select public.hook_before_user_created('{"user":{"email":"x@y.z"}}'::jsonb) as r`); });
    assert.equal((r.rows[0] as { r: { error: { http_code: number } } }).r.error.http_code, 403);
  });

  test("account creation applies the invite (team, commissioner flag); joined only after signing in", async () => {
    assert.equal(await affected(db, user(COMMISH), `insert into public.invites (email, team_id) values ('newguy@example.com', '0002')`), 1);
    assert.equal(await affected(db, user(COMMISH), `insert into public.invites (email, is_commissioner) values ('cocommish@example.com', true)`), 1);
    const NEW = "00000000-0000-0000-0000-0000000000ee", CO = "00000000-0000-0000-0000-0000000000ef";
    await db.exec(`insert into auth.users (id, email) values ('${NEW}', 'NewGuy@example.com'), ('${CO}', 'cocommish@example.com')`);
    assert.deepEqual((await db.query(`select team_id from public.team_managers where user_id = '${NEW}'`)).rows, [{ team_id: "0002" }]);
    const inv = (await db.query<{ user_id: string; accepted_at: unknown }>(`select user_id, accepted_at from public.invites where email = 'newguy@example.com'`)).rows[0]!;
    assert.equal(inv.user_id, NEW);
    assert.equal(inv.accepted_at, null, "requesting a link creates the account, but he hasn't signed in yet");
    await db.exec(`update auth.users set last_sign_in_at = '2026-10-19T20:00:00Z' where id = '${NEW}'`);
    await db.exec(`update auth.users set last_sign_in_at = '2026-10-20T20:00:00Z' where id = '${NEW}'`);
    const joined = (await db.query<{ accepted_at: Date }>(`select accepted_at from public.invites where email = 'newguy@example.com'`)).rows[0]!;
    assert.equal(joined.accepted_at.toISOString(), "2026-10-19T20:00:00.000Z", "joined = first sign-in, later sign-ins don't move it");
    assert.equal((await db.query<{ c: boolean }>(`select is_commissioner as c from public.profiles where id = '${CO}'`)).rows[0]!.c, true);
    // The new manager can now set Bob's team's lineup (co-manager of 0002)
    assert.equal(await affected(db, user(NEW), `update public.lineup_slots set week = ${W} where team_id = '0002'`), 1);
  });

  test("an invite for an account that already exists (e.g. the commissioner's) links it, shows joined, applies the team", async () => {
    const OLD = "00000000-0000-0000-0000-0000000000dd";
    await db.exec(`insert into auth.users (id, email, last_sign_in_at) values ('${OLD}', 'Early@Example.com', '2026-10-15T12:00:00Z')`);
    await as(db, user(COMMISH), tx => tx.query(`insert into public.invites (email, team_id) values ('early@example.com', '0002')`));
    const inv = (await db.query<{ user_id: string; accepted_at: Date }>(`select user_id, accepted_at from public.invites where email = 'early@example.com'`)).rows[0]!;
    assert.equal(inv.user_id, OLD);
    assert.equal(inv.accepted_at.toISOString(), "2026-10-15T12:00:00.000Z");
    assert.deepEqual((await db.query(`select team_id from public.team_managers where user_id = '${OLD}'`)).rows, [{ team_id: "0002" }]);
    assert.equal((await db.query<{ c: boolean }>(`select is_commissioner as c from public.profiles where id = '${OLD}'`)).rows[0]!.c, false);
  });

  test("invites are commissioner-only; emails must be lower-case and valid", async () => {
    await db.exec(`insert into public.invites (email) values ('someone@example.com')`);
    assert.deepEqual(await rows(db, user(ALICE), `select * from public.invites`), []);
    await denied(db, user(ALICE), `insert into public.invites (email) values ('friend@example.com')`);
    await denied(db, anon, `select * from public.invites`, /permission denied/);
    await denied(db, user(COMMISH), `insert into public.invites (email) values ('Mixed@Example.com')`, /check constraint/);
    await denied(db, user(COMMISH), `insert into public.invites (email) values ('not-an-email')`, /check constraint/);
  });

  test("an account that got past the hook (no invite, no team) sees only public data and its own profile", async () => {
    const GHOST = "00000000-0000-0000-0000-0000000000dd";
    await db.exec(`insert into auth.users (id, email) values ('${GHOST}', 'ghost@example.com');
      update public.transactions set status = 'approved' where id = 1;
      update public.nfl_games set kickoff = now() - interval '5 minutes'`);
    assert.deepEqual(await rows(db, user(GHOST), `select id from public.profiles`), [{ id: GHOST }]);
    assert.deepEqual(await rows(db, user(GHOST), `select * from public.team_managers`), []);
    assert.deepEqual(await rows(db, user(GHOST), `select id from public.transactions`), [], "decided transactions are members-only");
    assert.equal((await rows(db, user(GHOST), `select * from public.lineup_slots`)).length, 2, "lineups are public (B5 doesn't hide them)");
    assert.equal((await rows(db, user(GHOST), `select * from public.teams`)).length, 2, "public data still readable");
    assert.equal(await affected(db, user(GHOST), `update public.profiles set is_commissioner = false where id = '${ALICE}'`), 0);
    // A real member still sees the decided transaction and kicked-off lineups
    assert.equal((await rows(db, user(ALICE), `select id from public.transactions where id = 1`)).length, 1);
    assert.equal((await rows(db, user(ALICE), `select * from public.lineup_slots where team_id = '0002'`)).length, 1);
  });
});

describe("save_lineup (the My Team page's Save button)", () => {
  // Alice's starters: QB slot 0, RB slots 1-2, WR slots 3-5.
  const save = (who: Who, team: string, players: (string | null)[]) =>
    as(db, who, tx => tx.query<{ slot: number; player_id: string }>(
      `select slot, player_id from public.save_lineup($1, $2, $3, $4::text[])`, [S, W, team, players])).then(r => r.rows);
  const lineup = (...p: (string | null)[]) => [...p, ...Array(9 - p.length).fill(null)];
  beforeEach(async () => {
    await db.exec(`
      insert into public.nfl_players (id, name, position, nfl_team) values ('WR-DET', 'Amon-Ra St. Brown', 'WR', 'DET'), ('WR-KC', 'Rashee Rice', 'WR', 'KC');
      insert into public.roster_entries (season, team_id, player_id) values (${S}, '0001', 'WR-DET'), (${S}, '0001', 'WR-KC');`);
  });

  test("saves a whole lineup, empties slots, and swaps two players between slots", async () => {
    assert.deepEqual(await save(user(ALICE), "0001", lineup("QB-DET", null, "RB-DET", "WR-DET")),
      [{ slot: 0, player_id: "QB-DET" }, { slot: 2, player_id: "RB-DET" }, { slot: 3, player_id: "WR-DET" }]);
    await db.exec(`update public.nfl_games set kickoff = now() + interval '1 day' where game_key = 'KC@LV'`);
    await save(user(ALICE), "0001", lineup("QB-DET", null, "RB-DET", "WR-DET", "WR-KC"));
    assert.deepEqual(await save(user(ALICE), "0001", lineup("QB-DET", null, "RB-DET", "WR-KC", "WR-DET")),
      [{ slot: 0, player_id: "QB-DET" }, { slot: 2, player_id: "RB-DET" }, { slot: 3, player_id: "WR-KC" }, { slot: 4, player_id: "WR-DET" }]);
  });

  test("a kicked-off starter stays put while the rest changes; moving him or starting one fails and saves nothing", async () => {
    await db.exec(`insert into public.lineup_slots (season, week, team_id, slot, player_id) values (${S}, ${W}, '0001', 0, 'QB-KC')`);
    assert.deepEqual((await save(user(ALICE), "0001", lineup("QB-KC", "RB-DET", null, "WR-DET"))).map(r => r.player_id), ["QB-KC", "RB-DET", "WR-DET"]);
    await assert.rejects(save(user(ALICE), "0001", lineup("QB-DET", "RB-DET")), /locked/);
    await assert.rejects(save(user(ALICE), "0001", lineup("QB-KC", "RB-DET", null, "WR-KC")), /locked/);
    assert.deepEqual((await rows(db, user(ALICE), `select player_id from public.lineup_slots where team_id = '0001' order by slot`)).map(r => (r as { player_id: string }).player_id),
      ["QB-KC", "RB-DET", "WR-DET"], "a refused save changes nothing");
  });

  test("roster, position, duplicate and slot-count rules", async () => {
    await assert.rejects(save(user(ALICE), "0001", lineup("QB-FA")), /not on team/);
    await assert.rejects(save(user(ALICE), "0001", lineup(null, "QB-DET")), /cannot play the RB slot/);
    await assert.rejects(save(user(ALICE), "0001", lineup(null, null, null, "WR-DET", "WR-DET")), /only start once/);
    await assert.rejects(save(user(ALICE), "0001", ["QB-DET"]), /9 slots/);
  });

  test("only your own team; the commissioner can set any team, even locked players; anon can't call it", async () => {
    await assert.rejects(save(user(BOB), "0001", lineup("QB-DET")), /own team/);
    assert.equal((await rows(db, user(ALICE), `select * from public.lineup_slots where team_id = '0001' and slot = 0`)).length, 0);
    assert.deepEqual((await save(user(COMMISH), "0001", lineup("QB-KC"))).map(r => r.player_id), ["QB-KC"]);
    await assert.rejects(save(anon, "0001", lineup("QB-DET")), /permission denied/);
  });
});

describe("commissioner who also manages a team (Mac Daddies, 0011)", () => {
  const MINE = "0011";
  const audit = () => db.query<{ action: string; actor: string | null }>(`select action, actor from public.audit_log where action like 'own_team:%' order by id`).then(r => r.rows);
  beforeEach(async () => {
    await db.exec(`
      insert into public.teams (id, name, division) values ('${MINE}', 'Mac Daddies', 'Gold');
      insert into public.team_managers values ('${MINE}', '${COMMISH}');
      insert into public.nfl_players (id, name, position, nfl_team) values
        ('QB-LV', 'Geno Smith', 'QB', 'LV'),          -- KC@LV already kicked off: locked
        ('RB-ARI', 'James Conner', 'RB', 'ARI');      -- DET@ARI later this week
      insert into public.roster_entries (season, team_id, player_id) values (${S}, '${MINE}', 'QB-LV'), (${S}, '${MINE}', 'RB-ARI');
      insert into public.standings (season, team_id, wins) values (${S}, '${MINE}', 3);`);
  });

  test("his own lineup follows every manager rule: kickoff lock, roster, position", async () => {
    await denied(db, user(COMMISH), `insert into public.lineup_slots (season, week, team_id, slot, player_id) values (${S}, ${W}, '${MINE}', 0, 'QB-LV')`, /locked/);
    await denied(db, user(COMMISH), `insert into public.lineup_slots (season, week, team_id, slot, player_id) values (${S}, ${W}, '${MINE}', 0, 'QB-DET')`, /not on team/);
    await denied(db, user(COMMISH), `insert into public.lineup_slots (season, week, team_id, slot, player_id) values (${S}, ${W}, '${MINE}', 0, 'RB-ARI')`, /cannot play the QB slot/);
    await assert.rejects(as(db, user(COMMISH), tx => tx.query(`select public.save_lineup(${S}, ${W}, '${MINE}', array['QB-LV',null,null,null,null,null,null,null,null])`)), /locked/);
    // A starter whose game has kicked off can't be benched, even by the commissioner
    await db.exec(`insert into public.lineup_slots (season, week, team_id, slot, player_id) values (${S}, ${W}, '${MINE}', 0, 'QB-LV')`);
    await denied(db, user(COMMISH), `delete from public.lineup_slots where team_id = '${MINE}' and slot = 0`, /locked/);
    await denied(db, user(COMMISH), `update public.lineup_slots set player_id = 'RB-ARI', slot = 1 where team_id = '${MINE}' and slot = 0`, /locked/);
    // Normal moves before kickoff work, and aren't logged (that's just managing his team)
    assert.equal(await affected(db, user(COMMISH), `insert into public.lineup_slots (season, week, team_id, slot, player_id) values (${S}, ${W}, '${MINE}', 1, 'RB-ARI')`), 1);
    assert.deepEqual(await audit(), []);
  });

  test("he can't move a player from another team's lineup onto his own to dodge the rules", () =>
    denied(db, user(COMMISH), `update public.lineup_slots set team_id = '${MINE}' where team_id = '0002' and slot = 0`, /not on team/));

  test("other teams' lineups: commissioner powers still apply (even locked players), not logged", async () => {
    assert.equal(await affected(db, user(COMMISH), `insert into public.lineup_slots (season, week, team_id, slot, player_id) values (${S}, ${W}, '0001', 0, 'QB-KC')`), 1);
    assert.deepEqual(await audit(), []);
  });

  test("own-team transactions start as pending; deciding one is allowed but logged", async () => {
    await denied(db, user(COMMISH), `insert into public.transactions (season, team_id, type, players_in, status) values (${S}, '${MINE}', 'add', '{QB-FA}', 'processed')`, /start as pending/);
    await denied(db, user(COMMISH), `insert into public.transactions (season, team_id, type, partner_team_id, status) values (${S}, '0002', 'trade', '${MINE}', 'approved')`, /start as pending/);
    await as(db, user(COMMISH), tx => tx.query(`insert into public.transactions (season, team_id, type, players_in) values (${S}, '${MINE}', 'add', '{QB-FA}')`));
    await as(db, user(COMMISH), tx => tx.query(`update public.transactions set note = 'changed my mind' where team_id = '${MINE}'`));
    assert.deepEqual(await audit(), [], "creating and editing his own pending request is a manager action");
    await as(db, user(COMMISH), tx => tx.query(`update public.transactions set status = 'approved', decided_by = '${COMMISH}', decided_at = now() where team_id = '${MINE}'`));
    await as(db, user(COMMISH), tx => tx.query(`update public.transactions set status = 'approved' where id = 1`));   // Bob's, not his team
    assert.deepEqual((await audit()).map(a => a.action), ["own_team:transactions:update"]);
    assert.equal((await audit())[0]!.actor, COMMISH);
  });

  test("roster, standings, matchup and score-override changes on his team are logged; other teams' aren't", async () => {
    const c = (sql: string) => as(db, user(COMMISH), tx => tx.query(sql));
    await c(`insert into public.roster_entries (season, team_id, player_id) values (${S}, '${MINE}', 'QB-FA')`);
    await c(`update public.standings set wins = 4 where team_id = '${MINE}'`);
    await c(`insert into public.matchups (season, week, home_team, away_team, home_score) values (${S}, ${W}, '0001', '${MINE}', 100)`);
    await c(`insert into public.score_overrides (season, week, target_key, type, points, reason) values (${S}, ${W}, 'nflverse:RB-ARI', 'points', 30, 'test')`);
    await c(`delete from public.roster_entries where team_id = '${MINE}' and player_id = 'QB-FA'`);
    // Other teams: no entries
    await c(`update public.standings set wins = 9 where team_id = '0001'`);
    await c(`insert into public.score_overrides (season, week, target_key, type, points, reason) values (${S}, ${W}, 'nflverse:QB-DET', 'points', 1, 'test')`);
    assert.deepEqual((await audit()).map(a => a.action), [
      "own_team:roster_entries:insert", "own_team:standings:update", "own_team:matchups:insert",
      "own_team:score_overrides:insert", "own_team:roster_entries:delete"]);
    const [m] = (await db.query<{ season: number; week: number; details: { new: { away_team: string } } }>(
      `select season, week, details from public.audit_log where action = 'own_team:matchups:insert'`)).rows;
    assert.equal(m!.details.new.away_team, MINE);
    assert.equal(m!.week, W);
  });

  test("assigning or removing himself as a team's manager is logged; assigning others isn't", async () => {
    // (An account owns one team, so he leaves his own team and rejoins it.)
    await as(db, user(COMMISH), tx => tx.query(`delete from public.team_managers where team_id = '${MINE}' and user_id = '${COMMISH}'`));
    await as(db, user(COMMISH), tx => tx.query(`insert into public.team_managers values ('${MINE}', '${COMMISH}')`));
    await db.exec(`insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000d1', 'dan@example.com')`);
    await as(db, user(COMMISH), tx => tx.query(`insert into public.team_managers values ('0002', '00000000-0000-0000-0000-0000000000d1')`));
    assert.deepEqual((await audit()).map(a => a.action), ["own_team:team_managers:delete", "own_team:team_managers:insert"]);
  });

  test("server jobs touching his team aren't logged as commissioner actions", async () => {
    await as(db, service, tx => tx.query(`update public.standings set wins = 5 where team_id = '${MINE}'`));
    assert.deepEqual(await audit(), []);
  });
});

describe("shadow results (2026 comparison with MFL)", () => {
  test("server jobs write; only the commissioner reads; managers and anon can't read or write", async () => {
    assert.equal(await affected(db, service, `insert into public.shadow_results (season, week, team_id, mfl_score, our_score, matched) values (${S}, 1, '0001', 100.5, 100.5, true)`), 1);
    assert.equal((await rows(db, user(COMMISH), `select * from public.shadow_results`)).length, 1);
    assert.deepEqual(await rows(db, user(ALICE), `select * from public.shadow_results`), []);
    await denied(db, anon, `select * from public.shadow_results`, /permission denied/);
    await denied(db, user(ALICE), `insert into public.shadow_results (season, week, team_id, mfl_score, our_score, matched) values (${S}, 2, '0001', 1, 1, true)`, /permission denied/);
    await denied(db, user(COMMISH), `update public.shadow_results set matched = false`, /permission denied/);
  });
});

describe("MFL player map (2026 live mirror)", () => {
  test("server jobs write; only the commissioner reads; managers and anon can't", async () => {
    assert.equal(await affected(db, service, `insert into public.mfl_player_map (mfl_id, player_id) values ('14802', 'QB-DET')`), 1);
    assert.equal((await rows(db, user(COMMISH), `select * from public.mfl_player_map`)).length, 1);
    assert.deepEqual(await rows(db, user(ALICE), `select * from public.mfl_player_map`), []);
    await denied(db, anon, `select * from public.mfl_player_map`, /permission denied/);
    await denied(db, user(COMMISH), `insert into public.mfl_player_map (mfl_id, player_id) values ('1', 'QB-DET')`, /permission denied/);
  });
});

describe("live scoring tick (pg_cron every minute -> Edge Function)", () => {
  const tick = () => db.query<{ r: string }>(`select private.live_tick() as r`).then(x => x.rows[0]!.r);
  const calls = () => db.query<{ url: string; body: { nonce: string } }>(`select url, body from net.calls order by id`).then(x => x.rows);

  test("no NFL game near: does nothing (no HTTP call, no nonce)", async () => {
    await db.exec(`delete from public.nfl_games; insert into public.nfl_games (season, week, game_key, home, away, kickoff) values (${S}, 7, 'A@B', 'B', 'A', now() + interval '2 hours'), (${S}, 6, 'C@D', 'D', 'C', now() - interval '5 hours')`);
    assert.equal(await tick(), "idle");
    assert.deepEqual(await calls(), []);
    assert.equal((await db.query(`select * from public.live_nonces`)).rows.length, 0);
  });

  test("a game kicking off within 5 minutes or started under 4.5 h ago: posts a fresh one-time nonce to b5-live", async () => {
    await db.exec(`delete from public.nfl_games; insert into public.nfl_games (season, week, game_key, home, away, kickoff) values (${S}, 7, 'A@B', 'B', 'A', now() + interval '3 minutes')`);
    assert.equal(await tick(), "called");
    await db.exec(`update public.nfl_games set kickoff = now() - interval '4 hours'`);
    await db.exec(`insert into public.live_nonces (created_at) values (now() - interval '11 minutes')`);
    assert.equal(await tick(), "called");
    const c = await calls();
    assert.equal(c.length, 2);
    assert.equal(c[0]!.url, "https://kngwdttpbpezlvjrkrrg.supabase.co/functions/v1/b5-live");
    const nonces = (await db.query<{ nonce: string }>(`select nonce from public.live_nonces order by created_at`)).rows.map(r => r.nonce);
    assert.deepEqual(nonces.sort(), c.map(x => x.body.nonce).sort(), "each call carries its own stored nonce; stale ones are swept");
  });

  test("nobody but server jobs can read or forge nonces, see captured games, or run the tick", async () => {
    await db.exec(`insert into public.live_nonces default values`);
    for (const who of [anon, user(ALICE), user(COMMISH)]) {
      await denied(db, who, `select * from public.live_nonces`, /permission denied/);
      await denied(db, who, `insert into public.live_nonces default values`, /permission denied/);
      await denied(db, who, `select * from public.live_games`, /permission denied/);
      await denied(db, who, `select private.live_tick()`, /permission denied/);
    }
    assert.equal((await rows(db, service, `select * from public.live_nonces`)).length, 1);
  });
});

describe("payouts (ledger only)", () => {
  beforeEach(async () => {
    await db.exec(`
      insert into public.season_settings (season, team_count, buy_in, prizes) values (${S}, 12, 360, '{}');
      insert into public.team_fees (season, team_id, amount_due, paid) values (${S}, '0001', 360, true), (${S}, '0002', 360, false);
      insert into public.payout_payments (season, team_id, amount, paid_at) values (${S}, '0001', 35, '2026-10-01'), (${S}, '0002', 70, '2026-10-02');
      insert into public.awards (season, kind, week, label, team_id, amount, status, source) values (${S}, 'weekly_high', 1, 'Week 1 high score', '0001', 35, 'final', 'auto');
      insert into public.payout_flags (season, flags) values (${S}, '[{"kind":"tie"}]');`);
  });

  test("anyone reads settings, awards, eliminations and team scores; nobody but the commissioner writes them", async () => {
    for (const t of ["season_settings", "awards", "guillotine", "team_scores"]) await rows(db, anon, `select * from public.${t}`);
    assert.equal((await rows(db, anon, `select * from public.awards`)).length, 1);
    await denied(db, anon, `insert into public.awards (season, kind, label, team_id, amount, status, source) values (${S}, 'manual', 'x', '0001', 1, 'final', 'manual')`, /permission denied/);
    await denied(db, user(ALICE), `insert into public.awards (season, kind, label, team_id, amount, status, source) values (${S}, 'manual', 'x', '0001', 1, 'final', 'manual')`);
    assert.equal(await affected(db, user(ALICE), `update public.awards set amount = 1000`), 0);
  });

  test("the money ledger: a manager sees only his own team's rows; anon sees nothing; flags are commissioner-only", async () => {
    await denied(db, anon, `select * from public.team_fees`, /permission denied/);
    await denied(db, anon, `select * from public.payout_payments`, /permission denied/);
    await denied(db, anon, `select * from public.payout_flags`, /permission denied/);
    assert.deepEqual((await rows(db, user(ALICE), `select team_id, paid from public.team_fees`)), [{ team_id: "0001", paid: true }]);
    assert.deepEqual((await rows(db, user(ALICE), `select team_id from public.payout_payments`)), [{ team_id: "0001" }]);
    assert.deepEqual(await rows(db, user(ALICE), `select * from public.payout_flags`), []);
    assert.equal(await affected(db, user(ALICE), `update public.team_fees set paid = true`), 0, "can't mark himself paid");
    assert.equal((await rows(db, user(COMMISH), `select * from public.team_fees`)).length, 2);
  });

  test("league totals: members get sums only; anon can't call it", async () => {
    const [r] = await rows(db, user(ALICE), `select public.payout_league_totals(${S}) as t`);
    assert.deepEqual((r as { t: unknown }).t, { fees_due: 720, fees_paid: 360, teams_paid: 1, teams_unpaid: 1, paid_out: 105 });
    await denied(db, anon, `select public.payout_league_totals(${S})`, /permission denied/);
  });

  test("commissioner changes are audited; an override needs a reason", async () => {
    await as(db, user(COMMISH), tx => tx.query(`update public.team_fees set paid = true, paid_at = '2026-10-20' where team_id = '0002'`));
    await as(db, user(COMMISH), tx => tx.query(`insert into public.payout_payments (season, team_id, amount, paid_at) values (${S}, '0002', 35, '2026-10-20')`));
    await denied(db, user(COMMISH), `insert into public.awards (season, kind, week, label, team_id, amount, status, source) values (${S}, 'weekly_high', 2, 'Week 2 high score', '0002', 35, 'final', 'override')`, /check constraint/);
    await as(db, user(COMMISH), tx => tx.query(`insert into public.awards (season, kind, week, label, team_id, amount, status, source, note) values (${S}, 'weekly_high', 2, 'Week 2 high score', '0002', 35, 'final', 'override', 'stat correction after lock')`));
    const a = (await db.query<{ action: string }>(`select action from public.audit_log where action like 'payouts:%' order by id`)).rows.map(r => r.action);
    assert.deepEqual(a, ["payouts:team_fees:update", "payouts:payout_payments:insert", "payouts:awards:insert"]);
  });

  test("the job replaces auto awards and eliminations atomically, never touching manual awards or overrides; only server jobs may call it", async () => {
    await db.exec(`
      insert into public.awards (season, kind, label, team_id, amount, status, source) values (${S}, 'manual', 'Survivor', '0002', 240, 'final', 'manual');
      insert into public.guillotine (season, week, team_id, status, source, note) values (${S}, 3, '0002', 'final', 'override', 'tie broken by bench points');`);
    const call = `select public.replace_auto_payouts(${S},
      '[{"kind":"weekly_high","week":1,"label":"Week 1 high score","team_id":"0002","amount":35,"status":"projected"}]',
      '[{"week":2,"team_id":"0001","points":50,"status":"final"},{"week":3,"team_id":"0001","points":40,"status":"final"}]',
      '[{"kind":"seed_mismatch"}]')`;
    await denied(db, user(COMMISH), call, /permission denied/);
    await as(db, service, tx => tx.query(call));
    const aw = (await db.query<{ kind: string; team_id: string; source: string }>(`select kind, team_id, source from public.awards order by id`)).rows;
    assert.deepEqual(aw.map(x => [x.kind, x.team_id, x.source]), [["manual", "0002", "manual"], ["weekly_high", "0002", "auto"]]);
    const g = (await db.query<{ week: number; team_id: string; source: string }>(`select week, team_id, source from public.guillotine order by week`)).rows;
    assert.deepEqual(g.map(x => [x.week, x.team_id, x.source]), [[2, "0001", "auto"], [3, "0002", "override"]], "an overridden week keeps the commissioner's pick");
    assert.equal((await db.query<{ n: number }>(`select count(*)::int as n from public.audit_log where action like 'payouts:%'`)).rows[0]!.n, 0, "server jobs aren't logged as commissioner actions");
  });
});

describe("pools: survivor and confidence picks", () => {
  // Week 6: DET@ARI later this week, KC@LV already kicked off (seed). Picking open for the test season.
  beforeEach(async () => {
    await db.exec(`insert into public.season_settings (season, team_count, buy_in, prizes, pools) values (${S}, 12, 360, '{}', '{"mode": "official"}');
      insert into public.nfl_games (season, week, game_key, home, away, kickoff) values (${S}, 7, 'DET@ARI', 'ARI', 'DET', now() + interval '9 days');`);
  });
  const sv = (who: Who, team: string, week: number, nfl: string) => as(db, who, tx => tx.query(`insert into public.survivor_picks (season, week, team_id, nfl_team) values (${S}, ${week}, '${team}', '${nfl}') on conflict (season, week, team_id) do update set nfl_team = excluded.nfl_team`));
  const conf = (who: Who, team: string, picks: { game_key: string; pick: string; points: number }[], week = W) =>
    as(db, who, tx => tx.query(`select * from public.save_confidence(${S}, ${week}, '${team}', $1::jsonb)`, [JSON.stringify(picks)]));

  test("survivor: pick a team whose game hasn't started; change it until kickoff; never reuse a team", async () => {
    await sv(user(ALICE), "0001", W, "DET");
    await sv(user(ALICE), "0001", W, "ARI");
    await assert.rejects(sv(user(ALICE), "0001", W, "KC"), /locked: that game has kicked off/);
    await assert.rejects(sv(user(ALICE), "0001", W, "PIT"), /doesn't play in week/);
    await assert.rejects(sv(user(ALICE), "0001", 7, "ARI"), /duplicate key|unique/, "ARI already used this season");
    await sv(user(ALICE), "0001", 7, "DET");
  });

  test("picks belong to the team: each save goes in the team's activity log, with who made it", async () => {
    await sv(user(ALICE), "0001", W, "DET");
    await sv(user(ALICE), "0001", W, "ARI");
    await conf(user(ALICE), "0001", [{ game_key: "DET@ARI", pick: "DET", points: 2 }]);
    const act = await rows(db, user(ALICE), `select actor, kind, week, details from public.team_activity where team_id = '0001' order by id`) as { actor: string; kind: string; details: { picks: { nfl_team?: string; game?: string }[] } }[];
    assert.deepEqual(act.map(a => [a.actor, a.kind, a.details.picks.map(p => p.nfl_team ?? p.game).join(",")]),
      [[ALICE, "survivor", "DET"], [ALICE, "survivor", "ARI"], [ALICE, "confidence", "DET@ARI"]]);
  });

  test("survivor: a pick whose game has started can't be changed or deleted", async () => {
    await db.exec(`insert into public.survivor_picks (season, week, team_id, nfl_team) values (${S}, ${W}, '0001', 'KC')`);
    await assert.rejects(sv(user(ALICE), "0001", W, "DET"), /locked/);
    await denied(db, user(ALICE), `delete from public.survivor_picks where team_id = '0001'`, /locked/);
  });

  test("confidence: unique values 1..N, pick must play in the game, swaps save atomically, kicked-off games locked", async () => {
    // Week 6 has 2 games, so points run 1..2
    await conf(user(ALICE), "0001", [{ game_key: "DET@ARI", pick: "DET", points: 2 }]);
    await assert.rejects(conf(user(ALICE), "0001", [{ game_key: "DET@ARI", pick: "DET", points: 3 }]), /run 1 to 2/);
    await assert.rejects(conf(user(ALICE), "0001", [{ game_key: "DET@ARI", pick: "PIT", points: 1 }]), /doesn't play/);
    await assert.rejects(conf(user(ALICE), "0001", [{ game_key: "KC@LV", pick: "KC", points: 1 }]), /locked/);
    // A duplicate value is refused at commit
    await db.exec(`insert into public.confidence_picks (season, week, team_id, game_key, pick, points) values (${S}, 7, '0002', 'DET@ARI', 'ARI', 1)`);
    await db.exec(`insert into public.nfl_games (season, week, game_key, home, away, kickoff) values (${S}, 7, 'NE@BUF', 'BUF', 'NE', now() + interval '9 days')`);
    await assert.rejects(conf(user(BOB), "0002", [{ game_key: "NE@BUF", pick: "NE", points: 1 }], 7), /confidence_points_unique|duplicate/);
    // Swapping two values in one save works (the unique key is deferred)
    await conf(user(BOB), "0002", [{ game_key: "NE@BUF", pick: "NE", points: 2 }], 7);
    const swapped = await conf(user(BOB), "0002", [{ game_key: "DET@ARI", pick: "ARI", points: 2 }, { game_key: "NE@BUF", pick: "NE", points: 1 }], 7);
    assert.deepEqual(swapped.rows.map(r => [(r as { game_key: string }).game_key, (r as { points: number }).points]), [["DET@ARI", 2], ["NE@BUF", 1]]);
  });

  test("hidden until kickoff: others' picks appear once that game starts; anon never sees picks", async () => {
    await db.exec(`insert into public.survivor_picks (season, week, team_id, nfl_team) values (${S}, ${W}, '0002', 'DET');
      insert into public.confidence_picks (season, week, team_id, game_key, pick, points) values (${S}, ${W}, '0002', 'DET@ARI', 'DET', 2);`);
    assert.deepEqual(await rows(db, user(ALICE), `select * from public.survivor_picks where team_id = '0002'`), []);
    assert.deepEqual(await rows(db, user(ALICE), `select * from public.confidence_picks where team_id = '0002'`), []);
    assert.equal((await rows(db, user(BOB), `select * from public.survivor_picks`)).length, 1, "his own, any time");
    await db.exec(`update public.nfl_games set kickoff = now() - interval '1 minute' where game_key = 'DET@ARI'`);
    assert.equal((await rows(db, user(ALICE), `select * from public.survivor_picks where team_id = '0002'`)).length, 1);
    assert.equal((await rows(db, user(ALICE), `select * from public.confidence_picks where team_id = '0002'`)).length, 1);
    await denied(db, anon, `select * from public.survivor_picks`, /permission denied/);
    await denied(db, anon, `select * from public.confidence_picks`, /permission denied/);
  });

  test("managers pick only for their own team; official mode = source site; closed = nothing", async () => {
    await assert.rejects(sv(user(ALICE), "0002", W, "DET"), /row-level security/);
    await sv(user(ALICE), "0001", W, "DET");
    assert.equal(((await rows(db, user(ALICE), `select source from public.survivor_picks`))[0] as { source: string }).source, "site");
    await db.exec(`update public.season_settings set pools = '{}'`);
    await assert.rejects(sv(user(ALICE), "0001", 7, "ARI"), /made on MFL this season/);
    await assert.rejects(conf(user(ALICE), "0001", [{ game_key: "DET@ARI", pick: "DET", points: 1 }]), /aren't open/);
  });

  test("test mode (2026): members enter TEST confidence picks; Survivor stays read-only", async () => {
    await db.exec(`update public.season_settings set pools = '{"mode": "test"}'`);
    await conf(user(ALICE), "0001", [{ game_key: "DET@ARI", pick: "DET", points: 2 }]);
    assert.deepEqual(await rows(db, user(ALICE), `select source from public.confidence_picks where team_id = '0001'`), [{ source: "test" }]);
    await assert.rejects(sv(user(ALICE), "0001", W, "DET"), /made on MFL this season/);
  });

  test("official MFL picks are read-only for everyone but the import; no test picks once a week has them", async () => {
    await db.exec(`update public.season_settings set pools = '{"mode": "test"}'`);
    await as(db, service, async tx => {
      await tx.query(`insert into public.confidence_picks (season, week, team_id, game_key, pick, points, source) values (${S}, ${W}, '0001', 'DET@ARI', 'ARI', 1, 'mfl')`);
      await tx.query(`insert into public.survivor_picks (season, week, team_id, nfl_team, source) values (${S}, ${W}, '0001', 'KC', 'mfl')`);
    });
    for (const who of [user(ALICE), user(COMMISH)]) {
      await assert.rejects(as(db, who, tx => tx.query(`update public.confidence_picks set points = 2 where team_id = '0001'`)), /official MFL pick/);
      await assert.rejects(as(db, who, tx => tx.query(`delete from public.survivor_picks where team_id = '0001'`)), /official MFL pick/);
    }
    await db.exec(`insert into public.nfl_games (season, week, game_key, home, away, kickoff) values (${S}, ${W}, 'NE@BUF', 'BUF', 'NE', now() + interval '1 day')`);
    await assert.rejects(conf(user(ALICE), "0001", [{ game_key: "NE@BUF", pick: "NE", points: 3 }]), /official MFL picks/);
  });

  test("the commissioner can enter or fix anyone's site pick (even after kickoff), audited; server jobs aren't logged", async () => {
    await as(db, service, tx => tx.query(`insert into public.survivor_picks (season, week, team_id, nfl_team, source) values (${S}, ${W}, '0001', 'KC', 'site')`));
    await as(db, user(COMMISH), tx => tx.query(`update public.survivor_picks set nfl_team = 'LV' where team_id = '0001'`));
    const [p] = await rows(db, user(COMMISH), `select nfl_team, source from public.survivor_picks where team_id = '0001'`);
    assert.deepEqual(p, { nfl_team: "LV", source: "site" });
    const a = (await db.query<{ action: string }>(`select action from public.audit_log where action like 'pools:%'`)).rows.map(r => r.action);
    assert.deepEqual(a, ["pools:survivor_picks:update"]);
  });

  test("the weekly import replaces a week's test (and site) picks with MFL's in one call; only server jobs may", async () => {
    await db.exec(`update public.season_settings set pools = '{"mode": "test"}'`);
    await conf(user(ALICE), "0001", [{ game_key: "DET@ARI", pick: "DET", points: 2 }]);
    const call = `select public.replace_week_confidence(${S}, ${W}, '[{"team_id":"0001","game_key":"DET@ARI","pick":"ARI","points":1},{"team_id":"0002","game_key":"KC@LV","pick":"KC","points":2}]') as removed`;
    await denied(db, user(COMMISH), call, /permission denied/);
    const [r] = (await as(db, service, tx => tx.query<{ removed: number }>(call))).rows;
    assert.equal(r!.removed, 1, "one test pick replaced");
    const picks = (await db.query<{ team_id: string; pick: string; source: string }>(`select team_id, pick, source from public.confidence_picks order by team_id`)).rows;
    assert.deepEqual(picks.map(p => [p.team_id, p.pick, p.source]), [["0001", "ARI", "mfl"], ["0002", "KC", "mfl"]]);
  });

  test("Tuesday 6:00 AM ET import schedule handles EDT and EST; retries until it succeeds that day", async () => {
    await db.exec(`update public.season_settings set pools = '{"mode": "test"}'`);
    await db.exec(`delete from public.nfl_games; insert into public.nfl_games (season, week, game_key, home, away, kickoff) values
      (${S}, 6, 'WAS@SF', 'SF', 'WAS', '2026-10-20T00:15:00Z'), (${S}, 7, 'NE@CHI', 'CHI', 'NE', '2026-10-23T00:15:00Z'),
      (${S}, 14, 'A@B', 'B', 'A', '2026-12-08T01:15:00Z')`);
    const tick = (at: string) => db.query<{ r: string }>(`select private.pool_import_tick('${at}'::timestamptz) as r`).then(x => x.rows[0]!.r);
    assert.match(await tick("2026-10-20T09:59:00Z"), /not Tuesday 6 AM/, "5:59 AM EDT");
    assert.equal(await tick("2026-10-20T10:00:00Z"), "requested 2026 week 6", "6:00 AM EDT = 10:00 UTC");
    assert.match(await tick("2026-10-19T12:00:00Z"), /not Tuesday/, "Monday");
    assert.match(await tick("2026-12-08T10:00:00Z"), /not Tuesday 6 AM/, "5:00 AM EST");
    assert.equal(await tick("2026-12-08T11:00:00Z"), "requested 2026 week 14", "6:00 AM EST = 11:00 UTC");
    const calls = (await db.query<{ body: { job: string; week: number; nonce: string } }>(`select body from net.calls order by id`)).rows;
    assert.deepEqual(calls.map(c => [c.body.job, c.body.week]), [["pool_import", 6], ["pool_import", 14]]);
    // A failed attempt is retried next hour; a success that day stops it
    await db.exec(`insert into public.pool_imports (season, week, status, attempted_at) values (${S}, 6, 'failed', '2026-10-20T10:00:05Z')`);
    assert.equal(await tick("2026-10-20T11:00:00Z"), "requested 2026 week 6");
    await db.exec(`update public.pool_imports set status = 'ok', succeeded_at = '2026-10-20T11:00:30Z'`);
    assert.equal(await tick("2026-10-20T12:00:00Z"), "requested 2026 week 6", "the lineups aren't in yet");
    await db.exec(`insert into public.lineup_imports (season, week, status, succeeded_at) values (${S}, 6, 'ok', '2026-10-20T12:00:40Z')`);
    assert.equal(await tick("2026-10-20T13:00:00Z"), "already imported today");
    await db.exec(`update public.season_settings set pools = '{"mode": "official"}'`);
    assert.equal(await tick("2026-12-08T11:00:00Z"), "not in test mode", "2027: no MFL import");
  });

  test("Run import now: administrators only; the import log is for officers", async () => {
    await db.exec(`insert into public.nfl_games (season, week, game_key, home, away, kickoff) values (${S}, 5, 'A@B', 'B', 'A', now() - interval '2 days')`);
    await assert.rejects(as(db, user(ALICE), tx => tx.query(`select public.run_pool_import()`)), /Only an administrator/);
    await denied(db, anon, `select public.run_pool_import()`, /permission denied/);
    const [r] = await rows(db, user(COMMISH), `select public.run_pool_import(5) as r`);
    assert.match((r as { r: string }).r, /Import requested for 2026 week 5/);
    await as(db, service, tx => tx.query(`insert into public.pool_imports (season, week, status) values (${S}, 5, 'failed')`));
    assert.deepEqual(await rows(db, user(ALICE), `select * from public.pool_imports`), []);
    assert.equal((await rows(db, user(COMMISH), `select * from public.pool_imports`)).length, 1);
    await denied(db, anon, `select * from public.pool_imports`, /permission denied/);
  });

  test("standings tables are public read; only the commissioner and server jobs write", async () => {
    await as(db, service, tx => tx.query(`insert into public.survivor_status (season, team_id, alive, winner) values (${S}, '0002', true, true)`));
    assert.equal((await rows(db, anon, `select * from public.survivor_status`)).length, 1);
    await denied(db, anon, `insert into public.confidence_scores (season, week, team_id, points, correct, decided, games) values (${S}, 1, '0001', 1, 1, 1, 1)`, /permission denied/);
    assert.equal(await affected(db, user(ALICE), `update public.survivor_status set winner = false`), 0);
  });
});

describe("Live page (public read)", () => {
  const lineup = (who: Who) => rows(db, who, `select team_id, slot, player_id, revealed from public.live_lineups(${S}, ${W}) order by team_id, slot`);
  test("lineups: everyone sees every starter, before kickoff too", async () => {
    await db.exec(`insert into public.lineup_slots (season, week, team_id, slot, player_id) values (${S}, ${W}, '0001', 0, 'QB-KC')`);
    const all = [{ team_id: "0001", slot: 0, player_id: "QB-KC", revealed: true }, { team_id: "0001", slot: 1, player_id: "RB-DET", revealed: true },
      { team_id: "0002", slot: 0, player_id: "QB-ARI", revealed: true }];
    assert.deepEqual(await lineup(anon), all, "signed out: every starter, even those who play later");
    assert.deepEqual(await lineup(user(BOB)), all);
    assert.deepEqual(await lineup(user(ALICE)), all);
  });

  test("a starter on bye: flagged and named for everyone at once", async () => {
    await db.exec(`insert into public.nfl_players (id, name, position, nfl_team) values ('WR-PIT', 'Bye Receiver', 'WR', 'PIT');
      insert into public.roster_entries (season, team_id, player_id) values (${S}, '0002', 'WR-PIT');
      insert into public.lineup_slots (season, week, team_id, slot, player_id) values (${S}, ${W}, '0002', 3, 'WR-PIT')`);
    const bye = (who: Who) => rows(db, who, `select player_id, revealed, bye from public.live_lineups(${S}, ${W}) where slot = 3`);
    assert.deepEqual(await bye(anon), [{ player_id: "WR-PIT", revealed: true, bye: true }], "anon: on bye, and who");
    assert.deepEqual(await bye(user(BOB)), [{ player_id: "WR-PIT", revealed: true, bye: true }]);
    assert.deepEqual((await rows(db, anon, `select bye from public.live_lineups(${S}, ${W}) where team_id = '0002' and slot = 0`)), [{ bye: false }], "a player with a game later isn't a bye");
    await db.exec(`update public.nfl_games set kickoff = now() - interval '2 hours'`);
    assert.deepEqual(await bye(anon), [{ player_id: "WR-PIT", revealed: true, bye: true }], "named once every game this week has kicked off");
    await db.exec(`delete from public.nfl_games where week = ${W}`);
    assert.deepEqual((await rows(db, user(BOB), `select bye from public.live_lineups(${S}, ${W}) where slot = 3`)), [{ bye: false }], "no games loaded for the week: nobody is on bye");
  });

  test("injury statuses: public read with every starter named; only server jobs replace them, all at once", async () => {
    const put = (rows: unknown[], from = W) => db.query(`select public.replace_injuries(${S}, ${from}, $1::jsonb) as n`, [JSON.stringify(rows)]);
    await put([{ week: W, player_id: "QB-ARI", status: "Out", injury: "Ankle", practice: null, source: "report" },
      { week: W, player_id: "QB-KC", status: "Questionable", injury: "Knee", practice: null, source: "report" },
      { week: W - 1, player_id: "QB-DET", status: "Doubtful", injury: "Hand", practice: null, source: "report" }], W - 1);
    await db.exec(`insert into public.lineup_slots (season, week, team_id, slot, player_id) values (${S}, ${W}, '0001', 0, 'QB-KC')`);
    assert.deepEqual(await rows(db, anon, `select team_id, slot, player_id, injury from public.live_lineups(${S}, ${W}) order by team_id, slot`), [
      { team_id: "0001", slot: 0, player_id: "QB-KC", injury: "Questionable" }, { team_id: "0001", slot: 1, player_id: "RB-DET", injury: null },
      { team_id: "0002", slot: 0, player_id: "QB-ARI", injury: "Out" }], "Bob's QB is named and flagged Out");
    assert.equal((await rows(db, anon, `select * from public.player_injuries`)).length, 3);
    // Next night: QB-ARI is off the report (healthy); week W-1 is before p_from_week, so it stays.
    await put([{ week: W, player_id: "QB-KC", status: "IR", injury: "Knee", practice: null, source: "roster" }]);
    assert.deepEqual(await rows(db, anon, `select week, player_id, status from public.player_injuries order by week, player_id`),
      [{ week: W - 1, player_id: "QB-DET", status: "Doubtful" }, { week: W, player_id: "QB-KC", status: "IR" }]);
    for (const who of [anon, user(COMMISH)]) {
      await denied(db, who, `select public.replace_injuries(${S}, 1, '[]')`, /permission denied/);
      await denied(db, who, `insert into public.player_injuries (season, week, player_id, status, source) values (${S}, ${W}, 'QB-DET', 'Out', 'report')`, /permission denied/);
    }
  });

  test("scoring plays: every live change in a player's points is logged with the changed lines and the game clock", async () => {
    const L = (stat: string, value: number, points: number, text: string) => ({ stat, value, points, text });
    await db.exec(`update public.nfl_games set period = 2, clock = '4:12', status_detail = '2nd 4:12' where game_key = 'KC@LV'`);
    const up = (pts: number, lines: unknown[], source = "live") => db.query(`insert into public.player_scores (season, week, player_id, game_key, points, lines, source)
      values (${S}, ${W}, 'QB-KC', 'KC@LV', $1, $2, $3) on conflict (season, week, player_id) do update set points = excluded.points, lines = excluded.lines, source = excluded.source`,
      [pts, JSON.stringify(lines), source]);
    const yds98 = L("scrimmageYds", 98, 1, "98 total yards (50–99)"), yds112 = L("scrimmageYds", 112, 2, "112 total yards (100–149)");
    await up(1, [yds98]);
    await up(1, [yds98]);                                                    // unchanged pass: no event
    await up(11, [L("passTdLength", 52, 10, "52-yd passing TD (51–75)"), yds98]);
    await up(12, [L("passTdLength", 52, 10, "52-yd passing TD (51–75)"), yds112]);
    await up(2, [yds112]);                                                   // stat correction: TD taken away
    await up(2.5, [yds112], "final");                                        // nflverse rewrite: not a play
    const ev = await rows(db, anon, `select delta::float, points::float, period, clock, lines from public.score_events where player_id = 'QB-KC' order by id`) as { delta: number; points: number; clock: string; lines: unknown }[];
    assert.deepEqual(ev.map(e => [e.delta, e.points]), [[1, 1], [10, 11], [1, 12], [-10, 2]]);
    assert.deepEqual(ev[1]!.lines, [{ stat: "passTdLength", delta: 10, text: "52-yd passing TD (51–75)" }]);
    assert.deepEqual(ev[2]!.lines, [{ stat: "scrimmageYds", delta: 1, text: "112 total yards (100–149)" }]);
    assert.deepEqual(ev[3]!.lines, [{ stat: "passTdLength", delta: -10, text: "Taken away: 52-yd passing TD (51–75)" }]);
    assert.equal(ev[1]!.clock, "4:12");
    await denied(db, anon, `insert into public.score_events (season, week, player_id, delta, points) values (${S}, ${W}, 'QB-KC', 1, 1)`, /permission denied/);
    await denied(db, user(COMMISH), `delete from public.score_events`, /permission denied/);
  });

  test("MFL live comparison (2026): server jobs write; only the commissioner reads", async () => {
    await db.exec(`insert into public.live_compare (season, week, team_id, our_points, mfl_points) values (${S}, ${W}, '0001', 50, 48)`);
    assert.equal((await rows(db, user(COMMISH), `select * from public.live_compare`)).length, 1);
    assert.equal((await rows(db, user(ALICE), `select * from public.live_compare`)).length, 0);
    await denied(db, anon, `select * from public.live_compare`, /permission denied/);
    await denied(db, user(COMMISH), `insert into public.live_compare (season, week, team_id, our_points) values (${S}, ${W}, '0002', 1)`, /permission denied/);
    assert.equal(await affected(db, service, `update public.live_compare set mfl_points = 50`), 1);
  });

  test("MFL starters refresh (2026): every 15 minutes, every minute in the half hour before a kickoff, never once all games started", async () => {
    const tick = (at: string) => db.query<{ r: string }>(`select private.mfl_lineups_tick('${at}'::timestamptz) as r`).then(x => x.rows[0]!.r);
    await db.exec(`delete from public.nfl_games; insert into public.nfl_games (season, week, game_key, home, away, kickoff) values
      (${S}, 7, 'A@B', 'B', 'A', '2026-10-25 17:00Z'), (${S}, 7, 'C@D', 'D', 'C', '2026-10-25 20:25Z'), (${S}, 6, 'E@F', 'F', 'E', '2026-10-20 00:15Z')`);
    assert.equal(await tick("2026-10-23 12:07Z"), "waiting");
    assert.equal(await tick("2026-10-23 12:15Z"), "requested 2026 week 7");
    assert.equal(await tick("2026-10-25 16:41Z"), "requested 2026 week 7", "30 minutes before kickoff: every minute");
    assert.equal(await tick("2026-10-25 18:07Z"), "waiting", "between kickoffs: back to every 15 minutes");
    assert.equal(await tick("2026-10-25 20:01Z"), "requested 2026 week 7");
    assert.equal(await tick("2026-10-25 21:00Z"), "every game has kicked off");
    const c = (await db.query<{ body: { job: string; season: number; week: number; nonce: string } }>(`select body from net.calls`)).rows;
    assert.equal(c.length, 3);
    assert.deepEqual({ ...c[0]!.body, nonce: undefined }, { job: "mfl_lineups", season: S, week: 7, nonce: undefined });
    await db.exec(`update public.nfl_games set season = 2027`);
    assert.equal(await tick("2026-10-23 12:15Z"), "not the 2026 shadow season");
    for (const who of [anon, user(COMMISH)]) await denied(db, who, `select private.mfl_lineups_tick()`, /permission denied/);
  });
});

describe("co-owners (up to 2 per team)", () => {
  const AL = "00000000-0000-0000-0000-0000000000a2";     // Alice's co-owner (NSFW, 0001)
  const MIKE = "00000000-0000-0000-0000-0000000000a3";   // the commissioner's co-owner (Mac Daddies, 0011)
  const NEW = "00000000-0000-0000-0000-0000000000a4";
  beforeEach(async () => {
    await db.exec(`
      update public.profiles set display_name = 'Alice' where id = '${ALICE}';
      update public.profiles set display_name = 'Adam' where id = '${COMMISH}';
      insert into auth.users (id, email, raw_user_meta_data) values ('${AL}', 'al@example.com', '{"display_name":"Al"}'),
        ('${MIKE}', 'mike@example.com', '{"display_name":"Mike"}'), ('${NEW}', 'new@example.com', '{"display_name":"Nate"}');
      insert into public.teams (id, name, division) values ('0011', 'Mac Daddies', 'Gold');
      insert into public.team_managers values ('0011', '${COMMISH}'), ('0011', '${MIKE}'), ('0001', '${AL}');`);
  });
  const owners = (team: string) => db.query<{ user_id: string }>(`select user_id from public.team_managers where team_id = '${team}' order by user_id`).then(r => r.rows.map(x => x.user_id));

  test("at most 2 owners per team (a league setting), one team per account; enforced by the database", async () => {
    await assert.rejects(db.query(`insert into public.team_managers values ('0001', '${NEW}')`), /NSFW already has 2 owners \((Al & Alice|Alice & Al)\)\. Remove one first/);
    await assert.rejects(db.query(`insert into public.team_managers values ('0002', '${AL}')`), /already owns NSFW/);
    await assert.rejects(as(db, user(COMMISH), tx => tx.query(`insert into public.team_managers values ('0001', '${NEW}')`)), /already has 2 owners/, "the commissioner can't go over it either");
    assert.equal(await affected(db, user(ALICE), `update public.league_settings set max_owners_per_team = 3`), 0, "managers can't change the limit");
    assert.equal(await affected(db, user(COMMISH), `update public.league_settings set max_owners_per_team = 3`), 1);
    await db.query(`insert into public.team_managers values ('0001', '${NEW}')`);
    assert.equal((await owners("0001")).length, 3);
    assert.equal((await rows(db, anon, `select max_owners_per_team from public.league_settings`)).length, 1);
  });

  test("removing one owner leaves the other", async () => {
    assert.equal(await affected(db, user(COMMISH), `delete from public.team_managers where team_id = '0001' and user_id = '${AL}'`), 1);
    assert.deepEqual(await owners("0001"), [ALICE]);
    await db.query(`insert into public.team_managers values ('0001', '${NEW}')`);
    assert.equal((await owners("0001")).length, 2, "the freed spot can be filled");
  });

  test("invites: inviting to a team with one owner adds a co-owner; a 3rd is refused with a clear message", async () => {
    const invite = (email: string, team: string) => as(db, user(COMMISH), tx => tx.query(`insert into public.invites (email, team_id) values ($1, $2)`, [email, team]));
    await invite("new@example.com", "0002");                    // existing account: linked to Stealers at once
    assert.deepEqual((await owners("0002")).sort(), [BOB, NEW].sort());
    await assert.rejects(invite("someone@example.com", "0002"), /Stealers already has 2 owners \(.+\)\. Remove one first/);
    await assert.rejects(invite("al@example.com", "0002"), /al@example.com already owns NSFW/);
    // Invites not yet accepted hold a spot too.
    await db.exec(`delete from public.team_managers where user_id = '${NEW}'`);
    await invite("future@example.com", "0002");
    await assert.rejects(invite("another@example.com", "0002"), /already has 2 owners \(counting invites not yet accepted\)|already has 2 owners/);
    // If a team fills up before an invited person's first sign-in, the account is still created (just not linked).
    await db.exec(`insert into public.team_managers values ('0002', '${NEW}')`);
    await db.exec(`insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000f1', 'future@example.com')`);
    assert.equal((await db.query(`select 1 from public.profiles where id = '00000000-0000-0000-0000-0000000000f1'`)).rows.length, 1);
    assert.equal((await owners("0002")).length, 2);
  });

  test("both owners can set the lineup; the last save wins; a save over the other owner's newer change is refused until forced", async () => {
    const save = (who: Who, players: (string | null)[], expected: number | null) =>
      as(db, who, tx => tx.query(`select slot, player_id from public.save_lineup($1, $2, '0001', $3::text[], $4)`, [S, W, players, expected]));
    const meta = () => db.query<{ version: number; changed_by: string }>(`select version, changed_by from public.lineup_meta where team_id = '0001'`).then(r => r.rows[0]);
    const lineup = (qb: string | null, rb: string | null) => [qb, rb, null, null, null, null, null, null, null];
    await save(user(ALICE), lineup("QB-DET", null), 0);               // Alice loaded version 0: QB in, RB (seeded) out
    assert.deepEqual(await meta(), { version: 1, changed_by: ALICE });
    await assert.rejects(save(user(AL), lineup(null, "RB-DET"), 0), /Lineup changed by Alice at \d{1,2}:\d{2} [AP]M since you opened it/,
      "Al's page still shows version 0: warned, nothing saved");
    assert.deepEqual((await db.query(`select player_id from public.lineup_slots where team_id = '0001' and week = ${W} order by slot`)).rows, [{ player_id: "QB-DET" }]);
    await save(user(AL), lineup(null, "RB-DET"), null);               // "Save anyway": last save wins
    assert.deepEqual(await meta(), { version: 2, changed_by: AL });
    await save(user(AL), lineup(null, null), 1);                      // his own newer change isn't a conflict
    assert.deepEqual(await meta(), { version: 3, changed_by: AL });
    const act = await rows(db, user(ALICE), `select actor, kind, details from public.team_activity where team_id = '0001' order by id`) as { actor: string; kind: string; details: { in?: unknown[]; out?: unknown[] } }[];
    assert.deepEqual(act.map(a => [a.actor, a.kind, (a.details.in ?? []).length, (a.details.out ?? []).length]),
      [[ALICE, "lineup", 1, 1], [AL, "lineup", 1, 1], [AL, "lineup", 0, 1]], "one entry per save, with what came in and went out");
    assert.equal((await rows(db, user(BOB), `select * from public.team_activity where team_id = '0001'`)).length, 0, "another team's log is private");
    assert.equal((await rows(db, user(COMMISH), `select * from public.team_activity where team_id = '0001'`)).length, 3);
    assert.equal((await rows(db, user(BOB), `select * from public.lineup_meta where team_id = '0001'`)).length, 0);
  });

  test("server jobs (the 2026 MFL mirror) don't write the activity log", async () => {
    await as(db, service, tx => tx.query(`insert into public.lineup_slots (season, week, team_id, slot, player_id) values (${S}, ${W}, '0001', 0, 'QB-DET')`));
    assert.equal((await db.query(`select * from public.team_activity`)).rows.length, 0);
  });

  test("the commissioner flag is per person: his co-owner gets no commissioner powers but runs their team", async () => {
    await db.exec(`insert into public.nfl_players (id, name, position, nfl_team) values ('QB-MD', 'Mac QB', 'QB', 'DET');
      insert into public.roster_entries (season, team_id, player_id) values (${S}, '0011', 'QB-MD')`);
    assert.deepEqual(await rows(db, user(MIKE), `select is_commissioner from public.profiles where id = '${MIKE}'`), [{ is_commissioner: false }]);
    assert.equal((await rows(db, user(MIKE), `select * from public.invites`)).length, 0);
    await denied(db, user(MIKE), `insert into public.invites (email) values ('x@example.com')`, /row-level security/);
    await denied(db, user(MIKE), `insert into public.team_managers values ('0002', '${NEW}')`, /row-level security/);
    assert.equal(await affected(db, user(MIKE), `update public.league_settings set max_owners_per_team = 4`), 0);
    assert.equal(await affected(db, user(MIKE), `update public.standings set wins = 9`), 0);
    assert.equal((await rows(db, user(MIKE), `select * from public.audit_log`)).length, 0);
    await denied(db, user(MIKE), `update public.profiles set is_commissioner = true where id = '${MIKE}'`, /commissioner|row-level/).catch(async () =>
      assert.deepEqual(await rows(db, user(MIKE), `select is_commissioner from public.profiles where id = '${MIKE}'`), [{ is_commissioner: false }]));
    await denied(db, user(MIKE), `select public.run_pool_import()`, /Only an administrator|permission denied/);
    // ...but the team is theirs too: Mike sets Mac Daddies' lineup like Adam does.
    await as(db, user(MIKE), tx => tx.query(`select public.save_lineup(${S}, ${W}, '0011', array['QB-MD',null,null,null,null,null,null,null,null])`));
    assert.deepEqual(await rows(db, user(COMMISH), `select actor, kind from public.team_activity where team_id = '0011'`), [{ actor: MIKE, kind: "lineup" }]);
  });

  test("league votes: one vote per team; either owner casts or changes it; nobody votes for another team", async () => {
    const poll = Number(((await rows(db, user(COMMISH), `insert into public.league_polls (title, options) values ('Add a 2nd flex?', '{Yes,No}') returning id`)) as { id: number }[])[0]!.id);
    await rows(db, user(ALICE), `insert into public.league_votes (poll_id, team_id, choice) values (${poll}, '0001', 1)`);
    await denied(db, user(AL), `insert into public.league_votes (poll_id, team_id, choice) values (${poll}, '0001', 2)`, /duplicate/);
    assert.equal(await affected(db, user(AL), `update public.league_votes set choice = 2 where poll_id = ${poll} and team_id = '0001'`), 1, "Al changes the team's vote");
    await denied(db, user(BOB), `insert into public.league_votes (poll_id, team_id, choice) values (${poll}, '0001', 1)`, /row-level security/);
    await rows(db, user(BOB), `insert into public.league_votes (poll_id, team_id, choice) values (${poll}, '0002', 1)`);
    await denied(db, user(BOB), `update public.league_votes set choice = 3 where team_id = '0002'`, /Not one of the options/);
    const v = await rows(db, user(COMMISH), `select team_id, choice, voted_by from public.league_votes where poll_id = ${poll} order by team_id`);
    assert.deepEqual(v, [{ team_id: "0001", choice: 2, voted_by: AL }, { team_id: "0002", choice: 1, voted_by: BOB }], "2 teams, 2 votes");
    await denied(db, user(ALICE), `insert into public.league_polls (title, options) values ('x', '{a,b}')`, /row-level security/);
    await db.exec(`update public.league_polls set closes_at = now() - interval '1 minute'`);
    await denied(db, user(BOB), `update public.league_votes set choice = 2 where team_id = '0002'`, /closed/);
    await denied(db, anon, `select * from public.league_votes`, /permission denied/);
  });
});

describe("chat (members only)", () => {
  const ERIN = "00000000-0000-0000-0000-0000000000e2";   // signed in, no team: not a member
  const say = (who: Who, body: string, room = "league", images = "[]") =>
    rows(db, who, `insert into public.chat_messages (room_id, body, images) values ($1, $2, $3::jsonb) returning id`, [room, body, images]).then(r => Number((r[0] as { id: number }).id));
  beforeEach(async () => { await db.exec(`insert into auth.users (id, email) values ('${ERIN}', 'erin2@example.com'); insert into public.teams (id, name, division) values ('0011', 'Mac Daddies', 'Gold')`); });

  test("logged out: no access; a non-member sees nothing and can't post; members read and post", async () => {
    await say(user(ALICE), "Morning");
    for (const t of ["chat_rooms", "chat_messages", "chat_reactions", "chat_reads", "draft_state"]) await denied(db, anon, `select * from public.${t}`, /permission denied/);
    await denied(db, anon, `insert into public.chat_messages (room_id, body) values ('league', 'hi')`, /permission denied/);
    assert.equal((await rows(db, user(ERIN), `select * from public.chat_messages`)).length, 0);
    assert.equal((await rows(db, user(ERIN), `select * from public.chat_rooms`)).length, 0);
    await denied(db, user(ERIN), `insert into public.chat_messages (room_id, body) values ('league', 'hi')`, /row-level security/);
    assert.deepEqual((await rows(db, user(BOB), `select id from public.chat_rooms order by sort`)).map(r => (r as { id: string }).id), ["league", "draft"]);
    assert.deepEqual(await rows(db, user(BOB), `select body, author_id, author_team, is_bot from public.chat_messages`), [{ body: "Morning", author_id: ALICE, author_team: "0001", is_bot: false }]);
  });

  test("the database sets author, team and bot flag; you edit only your own (\"edited\"); the commissioner deletes anyone's, audited", async () => {
    const m = Number((await rows(db, user(BOB), `insert into public.chat_messages (room_id, body, author_id, author_team, is_bot) values ('league', 'fake', '${ALICE}', '0001', true) returning id`) as { id: number }[])[0]!.id);
    assert.deepEqual(await rows(db, user(BOB), `select author_id, author_team, is_bot from public.chat_messages where id = ${m}`), [{ author_id: BOB, author_team: "0002", is_bot: false }]);
    assert.equal(await affected(db, user(ALICE), `update public.chat_messages set body = 'hacked' where id = ${m}`), 0);
    assert.equal(await affected(db, user(ALICE), `delete from public.chat_messages where id = ${m}`), 0);
    assert.equal(await affected(db, user(BOB), `update public.chat_messages set body = 'real' where id = ${m}`), 1);
    assert.ok((await rows(db, user(BOB), `select edited_at from public.chat_messages where id = ${m}`) as { edited_at: unknown }[])[0]!.edited_at);
    await denied(db, user(BOB), `update public.chat_messages set room_id = 'draft' where id = ${m}`, /Only the text/);
    const mine = await say(user(BOB), "oops");
    assert.equal(await affected(db, user(BOB), `delete from public.chat_messages where id = ${mine}`), 1, "your own: no audit");
    assert.equal(await affected(db, user(COMMISH), `delete from public.chat_messages where id = ${m}`), 1);
    assert.deepEqual((await db.query<{ action: string }>(`select action from public.audit_log where action like 'chat:%'`)).rows.map(r => r.action), ["chat:message:delete"]);
  });

  test("rate limit: 20 messages per 10 seconds per member", async () => {
    for (let i = 0; i < 20; i++) await say(user(ALICE), `msg ${i}`);
    await denied(db, user(ALICE), `insert into public.chat_messages (room_id, body) values ('league', '21st')`, /Slow down: 20 messages per 10 seconds/);
    await say(user(BOB), "Bob's fine");
    await db.exec(`update public.chat_messages set created_at = now() - interval '11 seconds'`);
    await say(user(ALICE), "after the window");
  });

  test("moderation: mute (until a time), clear a room, pin a message, rooms as a setting; all audited", async () => {
    await rows(db, user(COMMISH), `insert into public.chat_mutes (user_id, until, reason) values ('${BOB}', now() + interval '10 minutes', 'cool off')`);
    await denied(db, user(BOB), `insert into public.chat_messages (room_id, body) values ('league', 'let me talk')`, /You're muted until/);
    assert.equal((await rows(db, user(BOB), `select reason from public.chat_mutes`)).length, 1, "he sees his own mute");
    assert.equal((await rows(db, user(ALICE), `select * from public.chat_mutes`)).length, 0);
    await denied(db, user(ALICE), `insert into public.chat_mutes (user_id, until) values ('${BOB}', now() + interval '1 day')`, /row-level security/);
    await db.exec(`update public.chat_mutes set until = now() - interval '1 second'`);
    const keep = await say(user(BOB), "back");
    assert.equal(await affected(db, user(COMMISH), `update public.chat_rooms set pinned_message_id = ${keep} where id = 'league'`), 1);
    assert.equal(await affected(db, user(ALICE), `update public.chat_rooms set pinned_message_id = null where id = 'league'`), 0, "only the commissioner pins");
    await denied(db, user(COMMISH), `update public.chat_rooms set pinned_message_id = ${keep} where id = 'draft'`, /Pin a message from this room/);
    await say(user(ALICE), "one more");
    assert.deepEqual(await rows(db, user(COMMISH), `select public.chat_clear_room('league') as n`), [{ n: 2 }]);
    await denied(db, user(ALICE), `select public.chat_clear_room('league')`, /Only the commissioner/);
    await rows(db, user(COMMISH), `insert into public.chat_rooms (id, name, kind) values ('trash-talk', 'Trash Talk', 'league')`);
    assert.deepEqual(await rows(db, user(BOB), `select kind from public.chat_rooms where id = 'trash-talk'`), [{ kind: "custom" }]);
    await denied(db, user(ALICE), `insert into public.chat_rooms (id, name) values ('mine', 'Mine')`, /row-level security/);
    await denied(db, user(COMMISH), `update public.chat_rooms set archived = true where id = 'draft'`, /always open/);
    await rows(db, user(COMMISH), `update public.chat_rooms set archived = true where id = 'trash-talk'`);
    await denied(db, user(BOB), `insert into public.chat_messages (room_id, body) values ('trash-talk', 'x')`, /closed/);
    const log = (await db.query<{ action: string }>(`select action from public.audit_log where action like 'chat:%' order by id`)).rows.map(r => r.action);
    assert.deepEqual(log, ["chat:mute:insert", "chat:room:pin", "chat:room:clear", "chat:room:create", "chat:room:update"], "the mute expiring (a direct database change) isn't a commissioner action");
  });

  test("images, reactions and unread work like the board's", async () => {
    await say(user(ALICE), "", "league", JSON.stringify(["https://media.giphy.com/x.gif"]));
    await denied(db, user(ALICE), `insert into public.chat_messages (room_id, body, images) values ('league', 'x', '["javascript:alert(1)"]')`, /Images must be/);
    const m = await say(user(ALICE), "react to this");
    await rows(db, user(BOB), `insert into public.chat_reactions (message_id, emoji) values (${m}, '😂')`);
    await denied(db, user(BOB), `insert into public.chat_reactions (message_id, emoji) values (${m}, '😂')`, /duplicate/);
    const unread = (who: Who) => rows(db, who, `select room_id, unread from public.chat_unread()`);
    assert.deepEqual(await unread(user(BOB)), [{ room_id: "league", unread: 2 }]);
    assert.deepEqual(await unread(user(ALICE)), [], "your own messages don't count");
    await rows(db, user(BOB), `insert into public.chat_reads (room_id) values ('league')`);
    assert.deepEqual(await unread(user(BOB)), []);
  });

  test("draft hook: events update the clock and post B5 Bot messages in the Draft room; only the commissioner or server jobs", async () => {
    const ev = (who: Who, kind: string, payload: object = {}) => rows(db, who, `select public.draft_event($1, $2::jsonb) as id`, [kind, JSON.stringify(payload)]);
    await denied(db, user(ALICE), `select public.draft_event('pick', '{}')`, /Only the commissioner/);
    await denied(db, anon, `select public.draft_event('pick', '{}')`, /permission denied/);
    await ev(user(COMMISH), "start", { season: 2027, round: 1, pick: 1, overall: 1, team: "0001", seconds: 120 });
    await ev(user(COMMISH), "timer", { team: "0001", seconds: 30 });
    await ev(user(COMMISH), "pick", { team: "0001", player: "Joe Burrow", pos: "QB", nfl: "CIN" });
    await ev(service, "on_clock", { round: 3, pick: 7, overall: 31, team: "0011", seconds: 90 });
    await ev(user(COMMISH), "paused");
    const paused = (await rows(db, user(BOB), `select status, team_id, round, pick, paused_remaining, clock_ends_at from public.draft_state`) as { status: string; team_id: string; round: number; pick: number; paused_remaining: number; clock_ends_at: unknown }[])[0]!;
    assert.deepEqual([paused.status, paused.team_id, paused.round, paused.pick, paused.clock_ends_at], ["paused", "0011", 3, 7, null]);
    assert.ok(paused.paused_remaining > 85 && paused.paused_remaining <= 90, "time left is kept while paused");
    await ev(user(COMMISH), "resumed");
    await ev(user(COMMISH), "end");
    const msgs = (await rows(db, user(BOB), `select body, is_bot, author_id, room_id from public.chat_messages order by id`) as { body: string; is_bot: boolean; author_id: null; room_id: string }[]);
    assert.ok(msgs.every(m => m.is_bot && m.author_id === null && m.room_id === "draft"));
    assert.deepEqual(msgs.map(m => m.body), [
      "🏈 The draft is live! ⏰ On the clock: NSFW (Round 1, Pick 1)",
      "⏳ 30 seconds left for NSFW",
      "✅ NSFW select Joe Burrow, QB CIN",
      "⏰ On the clock: Mac Daddies (Round 3, Pick 7)",
      "⏸️ The commissioner paused the draft",
      "▶️ The draft resumed: Mac Daddies is on the clock",
      "🏁 The draft is complete"]);
    await denied(db, user(COMMISH), `select public.draft_event('nope')`, /Unknown draft event/);
    await denied(db, user(BOB), `update public.draft_state set status = 'live'`, /permission denied/);
  });

  test("presence and typing: only members may join, listen or send on the private channel b5-chat", async () => {
    const onTopic = (who: Who, sql: string) => as(db, who, async tx => { await tx.query(`select set_config('realtime.topic', 'b5-chat', true)`); return tx.query(sql); });
    await onTopic(user(ALICE), `insert into realtime.messages (topic, extension, event) values ('b5-chat', 'presence', 'track')`);
    assert.equal((await onTopic(user(BOB), `select * from realtime.messages`)).rows.length, 1);
    await assert.rejects(onTopic(user(ERIN), `insert into realtime.messages (topic, extension, event) values ('b5-chat', 'broadcast', 'typing')`), /row-level security/);
    assert.equal((await onTopic(user(ERIN), `select * from realtime.messages`)).rows.length, 0);
    assert.equal((await onTopic(anon, `select * from realtime.messages`)).rows.length, 0);
    assert.equal((await as(db, user(BOB), async tx => { await tx.query(`select set_config('realtime.topic', 'other', true)`); return tx.query(`select * from realtime.messages`); })).rows.length, 0, "other channels aren't opened up");
  });
});

describe("message board (members only)", () => {
  const ERIN = "00000000-0000-0000-0000-0000000000e1";   // signed in, but manages no team: not a member
  const newThread = (who: Who, title = "Trash talk", body = "Week 7 is ours", images = "[]") =>
    rows(db, who, `select public.board_new_thread($1, $2, $3::jsonb) as id`, [title, body, images]).then(r => Number((r[0] as { id: number }).id));
  const reply = (who: Who, thread: number, body = "No chance", images = "[]") =>
    rows(db, who, `insert into public.board_posts (thread_id, body, images) values ($1, $2, $3::jsonb) returning id`, [thread, body, images]).then(r => Number((r[0] as { id: number }).id));
  beforeEach(async () => { await db.exec(`insert into auth.users (id, email) values ('${ERIN}', 'erin@example.com')`); });

  test("logged out: no access at all; a signed-in non-member sees nothing and can't post", async () => {
    const t = await newThread(user(ALICE));
    for (const table of ["board_threads", "board_posts", "board_reactions", "board_settings"]) await denied(db, anon, `select * from public.${table}`, /permission denied/);
    await denied(db, anon, `select public.board_new_thread('x', 'y')`, /permission denied/);
    assert.equal((await rows(db, user(ERIN), `select * from public.board_threads`)).length, 0);
    assert.equal((await rows(db, user(ERIN), `select * from public.board_posts`)).length, 0);
    await denied(db, user(ERIN), `insert into public.board_posts (thread_id, body) values (${t}, 'hi')`, /row-level security/);
    await denied(db, user(ERIN), `select public.board_new_thread('x', 'y')`, /row-level security/);
  });

  test("a new thread: the database sets author, team and activity; replies move it up and count", async () => {
    const t = await newThread(user(ALICE));
    await denied(db, user(BOB), `insert into public.board_threads (title, author_id) values ('fake', '${ALICE}')`, /new row violates|row-level security/).catch(() => {});
    const [th] = await rows(db, user(BOB), `select title, author_id, author_team, reply_count, pinned from public.board_threads where id = ${t}`);
    assert.deepEqual(th, { title: "Trash talk", author_id: ALICE, author_team: "0001", reply_count: 0, pinned: false });
    const p = Number((await rows(db, user(BOB), `insert into public.board_posts (thread_id, body, author_id, author_team, is_bot) values (${t}, 'Nope', '${ALICE}', '0001', true) returning id`) as { id: number }[])[0]!.id);
    const [post] = await rows(db, user(BOB), `select author_id, author_team, is_bot from public.board_posts where id = ${p}`);
    assert.deepEqual(post, { author_id: BOB, author_team: "0002", is_bot: false }, "forged author, team and bot flag are replaced");
    const [after] = await rows(db, user(ALICE), `select reply_count, last_author_id from public.board_threads where id = ${t}`);
    assert.deepEqual(after, { reply_count: 1, last_author_id: BOB });
    await denied(db, user(BOB), `insert into public.board_posts (thread_id, body, is_opener) values (${t}, 'mine now', true)`, /first post|duplicate/);
  });

  test("you edit only your own posts (\"edited\" stamped by the database); you can't change who wrote it", async () => {
    const t = await newThread(user(ALICE));
    const p = await reply(user(BOB), t);
    assert.equal(await affected(db, user(ALICE), `update public.board_posts set body = 'hacked' where id = ${p}`), 0, "Alice can't edit Bob's post");
    assert.equal(await affected(db, user(COMMISH), `update public.board_posts set body = 'hacked' where id = ${p}`), 0, "nor can the commissioner (he deletes)");
    assert.equal(await affected(db, user(BOB), `update public.board_posts set edited_at = null where id = ${p}`), 1);
    assert.equal((await rows(db, user(BOB), `select edited_at from public.board_posts where id = ${p}`) as { edited_at: unknown }[])[0]!.edited_at, null, "no change, no stamp");
    assert.equal(await affected(db, user(BOB), `update public.board_posts set body = 'Fine, maybe' where id = ${p}`), 1);
    assert.ok((await rows(db, user(BOB), `select edited_at from public.board_posts where id = ${p}`) as { edited_at: unknown }[])[0]!.edited_at);
    await denied(db, user(BOB), `update public.board_posts set author_id = '${ALICE}' where id = ${p}`, /row-level security|Only the text/);
    await denied(db, user(BOB), `update public.board_threads set title = 'mine' where id = ${t}`, /own thread|row-level security/).catch(async () =>
      assert.equal(await affected(db, user(BOB), `update public.board_threads set title = 'mine' where id = ${t}`), 0));
    assert.equal(await affected(db, user(ALICE), `update public.board_threads set title = 'Trash talk (week 7)' where id = ${t}`), 1);
  });

  test("delete: your own replies; your thread only while it has no replies; the commissioner deletes anything, audited", async () => {
    const t = await newThread(user(ALICE));
    const p = await reply(user(BOB), t);
    assert.equal(await affected(db, user(ALICE), `delete from public.board_posts where id = ${p}`), 0, "not someone else's");
    await denied(db, user(ALICE), `delete from public.board_threads where id = ${t}`, /has replies/);
    await denied(db, user(ALICE), `delete from public.board_posts where thread_id = ${t} and is_opener`, /Delete the thread/);
    const mine = await reply(user(ALICE), t);
    assert.equal(await affected(db, user(ALICE), `delete from public.board_posts where id = ${mine}`), 1);
    assert.equal(await affected(db, user(COMMISH), `delete from public.board_posts where id = ${p}`), 1);
    assert.equal(await affected(db, user(COMMISH), `delete from public.board_threads where id = ${t}`), 1);
    assert.equal((await db.query(`select * from public.board_posts where thread_id = ${t}`)).rows.length, 0, "the thread's posts go with it");
    const log = (await db.query<{ action: string }>(`select action from public.audit_log where action like 'board:%' order by id`)).rows.map(r => r.action);
    assert.deepEqual(log, ["board:board_posts:delete", "board:board_threads:delete"]);
    const solo = await newThread(user(BOB), "Solo");
    assert.equal(await affected(db, user(BOB), `delete from public.board_threads where id = ${solo}`), 1, "no replies: the author can delete it");
  });

  test("only the commissioner pins and locks (audited); a locked thread takes only his replies", async () => {
    const t = await newThread(user(ALICE));
    await denied(db, user(ALICE), `update public.board_threads set pinned = true where id = ${t}`, /Only the commissioner/);
    await denied(db, user(ALICE), `insert into public.board_threads (title, pinned) values ('pinned', true)`, /Only the commissioner/);
    assert.equal(await affected(db, user(COMMISH), `update public.board_threads set pinned = true, locked = true where id = ${t}`), 1);
    await denied(db, user(BOB), `insert into public.board_posts (thread_id, body) values (${t}, 'one more')`, /locked/);
    await reply(user(COMMISH), t, "Thread closed.");
    const log = (await db.query<{ action: string }>(`select action from public.audit_log where action like 'board:threads:%'`)).rows.map(r => r.action);
    assert.deepEqual(log, ["board:threads:pin"]);
    await denied(db, user(ALICE), `select public.board_new_thread('Announcement', 'x', '[]', 'announcement:1')`, /Only the commissioner can cross-post/);
    await rows(db, user(COMMISH), `select public.board_new_thread('Announcement', 'x', '[]', 'announcement:1')`);
    await denied(db, user(COMMISH), `select public.board_new_thread('Again', 'x', '[]', 'announcement:1')`, /duplicate/);
  });

  test("rate limit: 10 posts a minute per member", async () => {
    const t = await newThread(user(ALICE));    // the opener is post 1
    for (let i = 0; i < 9; i++) await reply(user(ALICE), t, `post ${i}`);
    await denied(db, user(ALICE), `insert into public.board_posts (thread_id, body) values (${t}, 'eleventh')`, /Slow down/);
    await reply(user(BOB), t, "Bob isn't limited by Alice");
  });

  test("images: https links or board uploads only, at most 4", async () => {
    const t = await newThread(user(ALICE));
    const up = `storage:${ALICE}/0b4e7c1a-1111-4222-8333-944445555666.gif`;
    await reply(user(BOB), t, "", JSON.stringify(["https://media.giphy.com/x.gif", up]));
    for (const bad of [["http://example.com/a.gif"], ["javascript:alert(1)"], ["https://x.com/a.gif\" onerror=\"alert(1)"], ["storage:../etc/passwd"], [{ url: "https://a" }], ["https://a.com/1.png", "https://a.com/2.png", "https://a.com/3.png", "https://a.com/4.png", "https://a.com/5.png"]])
      await denied(db, user(BOB), `insert into public.board_posts (thread_id, body, images) values (${t}, 'x', '${JSON.stringify(bad).replace(/'/g, "''")}'::jsonb)`, /Images must be|check constraint/);
    await denied(db, user(BOB), `insert into public.board_posts (thread_id, body) values (${t}, '')`, /check constraint/);
  });

  test("reactions: one of each per person; only your own; only the five", async () => {
    const t = await newThread(user(ALICE));
    const p = await reply(user(BOB), t);
    await rows(db, user(ALICE), `insert into public.board_reactions (post_id, emoji) values (${p}, '🔥'), (${p}, '💀')`);
    await denied(db, user(ALICE), `insert into public.board_reactions (post_id, emoji) values (${p}, '🔥')`, /duplicate/);
    await denied(db, user(ALICE), `insert into public.board_reactions (post_id, emoji) values (${p}, '❤️')`, /check constraint/);
    await denied(db, user(ALICE), `insert into public.board_reactions (post_id, user_id, emoji) values (${p}, '${BOB}', '👍')`, /row-level security/);
    assert.equal(await affected(db, user(BOB), `delete from public.board_reactions where post_id = ${p}`), 0, "can't remove Alice's");
    assert.equal(await affected(db, user(ALICE), `delete from public.board_reactions where post_id = ${p} and emoji = '💀'`), 1);
  });

  test("unread: threads with others' activity since you last read them; your own posts don't count", async () => {
    const unread = (who: Who) => rows(db, who, `select public.board_unread() as n`).then(r => (r[0] as { n: number }).n);
    const t = await newThread(user(ALICE));
    assert.equal(await unread(user(ALICE)), 0, "your own thread");
    assert.equal(await unread(user(BOB)), 1);
    await rows(db, user(BOB), `insert into public.board_reads (thread_id) values (${t})`);
    assert.equal(await unread(user(BOB)), 0);
    await db.exec(`update public.board_reads set read_at = now() - interval '1 minute'`);
    await reply(user(ALICE), t, "Still here?");
    assert.equal(await unread(user(BOB)), 1, "new activity after his read");
    assert.equal(await unread(user(ERIN)), 0, "non-members see no threads");
    await denied(db, user(BOB), `insert into public.board_reads (user_id, thread_id) values ('${ALICE}', ${t})`, /row-level security/);
  });

  test("settings: members read, only the commissioner toggles the bot; bot keys are for server jobs", async () => {
    assert.equal((await rows(db, user(BOB), `select auto_recap from public.board_settings`)).length, 1);
    assert.equal(await affected(db, user(BOB), `update public.board_settings set auto_recap = false`), 0);
    assert.equal(await affected(db, user(COMMISH), `update public.board_settings set auto_recap = false`), 1);
    for (const who of [anon, user(BOB), user(COMMISH)]) await denied(db, who, `select * from public.board_bot_keys`, /permission denied/);
    assert.equal(await affected(db, service, `insert into public.board_bot_keys (key, posted) values ('recap:2026:7', true)`), 1);
  });

  test("B5 Bot (server jobs) posts with no author; members read it", async () => {
    await db.exec(`set role service_role`);
    const t = (await db.query<{ id: number }>(`insert into public.board_threads (title, is_bot, source_key) values ('Week 7 recap', true, 'recap:2026:7') returning id`)).rows[0]!.id;
    await db.query(`insert into public.board_posts (thread_id, is_bot, is_opener, body) values ($1, true, true, '**High score:** Stealers')`, [t]);
    await db.exec(`reset role`);
    assert.deepEqual(await rows(db, user(BOB), `select is_bot, author_id from public.board_posts where thread_id = ${t}`), [{ is_bot: true, author_id: null }]);
  });

  test("image uploads: private 5 MB images-only bucket; members upload to their own folder and read; uploader or commissioner deletes", async () => {
    const [b] = (await db.query(`select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'board-images'`)).rows;
    assert.deepEqual(b, { public: false, file_size_limit: 5242880, allowed_mime_types: ["image/png", "image/jpeg", "image/gif", "image/webp"] });
    const up = (who: Who, name: string) => as(db, who, tx => tx.query(`insert into storage.objects (bucket_id, name) values ('board-images', $1)`, [name]));
    await up(user(ALICE), `${ALICE}/a.gif`);
    await assert.rejects(up(user(ALICE), `${BOB}/b.png`), /row-level security/, "not into someone else's folder");
    await assert.rejects(up(user(ALICE), `${ALICE}/x.html`), /row-level security/, "images only");
    await assert.rejects(up(user(ERIN), `${ERIN}/e.png`), /row-level security/, "members only");
    await assert.rejects(up(anon, `x/a.png`), /row-level security/);
    assert.equal((await rows(db, user(BOB), `select name from storage.objects`)).length, 1, "members read");
    assert.equal((await rows(db, anon, `select name from storage.objects`)).length, 0, "visitors don't");
    assert.equal((await rows(db, user(ERIN), `select name from storage.objects`)).length, 0);
    assert.equal(await affected(db, user(BOB), `delete from storage.objects`), 0);
    assert.equal(await affected(db, user(COMMISH), `delete from storage.objects`), 1);
  });
});

describe("add/drop and waivers", () => {
  const CAROL = "00000000-0000-0000-0000-0000000000c3";   // owns H.N.I.C (0003)
  const AL = "00000000-0000-0000-0000-0000000000a2";      // Alice's co-owner
  const status = (season: number, player: string, at: string) =>
    db.query<{ status: string; until: string | null; reason: string | null }>(`select status, until, reason from private.move_status($1, $2, $3::timestamptz)`, [season, player, at]).then(r => r.rows[0]!);
  const iso = (s: string | null) => (s ? new Date(s).toISOString() : null);
  beforeEach(async () => {
    await db.exec(`
      insert into auth.users (id, email, raw_user_meta_data) values ('${CAROL}', 'carol@example.com', '{"display_name":"Carol"}'), ('${AL}', 'al2@example.com', '{"display_name":"Al"}');
      insert into public.teams (id, name, division) values ('0003', 'H.N.I.C', 'Gold');
      insert into public.team_managers values ('0003', '${CAROL}'), ('0001', '${AL}');
      insert into public.nfl_players (id, name, position, nfl_team) values
        ('WR-BUF', 'Buf WR', 'WR', 'BUF'), ('WR-MIA', 'Mia WR', 'WR', 'MIA'), ('WR-KC1', 'KC WR 1', 'WR', 'KC'), ('WR-KC2', 'KC WR 2', 'WR', 'KC'),
        ('WR-LV1', 'LV WR', 'WR', 'LV'), ('RB-NYG', 'NYG RB', 'RB', 'NYG'), ('TE-NYG', 'NYG TE', 'TE', 'NYG');`);
  });

  test("lock timing (ET): preseason FCFS from 2 days before the first game; each player locks at his own kickoff until the week's last game; Monday 10 PM waivers until Wednesday 5 PM; then FCFS; closed after the season", async () => {
    await db.exec(`insert into public.season_settings (season, team_count, buy_in, prizes, waivers) values (2027, 12, 360, '{}', '{"live": true, "closeAt": "2028-01-02T13:00:00-05:00"}');
      insert into public.nfl_games (season, week, game_key, home, away, kickoff) values
        (2027, 1, 'BUF@NYJ', 'NYJ', 'BUF', '2027-09-10T00:15:00Z'),   -- Thursday 8:15 PM ET
        (2027, 1, 'DET@MIA', 'MIA', 'DET', '2027-09-12T17:00:00Z'),   -- Sunday 1:00 PM ET
        (2027, 1, 'KC@LV', 'LV', 'KC', '2027-09-14T00:15:00Z'),       -- Monday 8:15 PM ET (last game)
        (2027, 2, 'NYG@MIA', 'MIA', 'NYG', '2027-09-21T17:00:00Z')`);
    assert.equal((await status(2027, "WR-BUF", "2027-09-07T16:00:00Z")).status, "closed", "Tuesday before: not open yet");
    assert.deepEqual(await status(2027, "WR-BUF", "2027-09-08T12:00:00Z"), { status: "fcfs", until: null, reason: null }, "2 days before: first-come-first-served (no preseason waivers)");
    const thu = await status(2027, "WR-BUF", "2027-09-10T00:16:00Z");
    assert.deepEqual([thu.status, iso(thu.until)], ["claims", "2027-09-14T04:15:00.000Z"], "Buffalo kicked off Thursday: locked until the week's last game is over");
    assert.equal((await status(2027, "WR-MIA", "2027-09-10T00:16:00Z")).status, "fcfs", "Miami plays Sunday: still free");
    assert.equal((await status(2027, "WR-MIA", "2027-09-12T17:01:00Z")).status, "claims", "...until his own kickoff");
    const mon = await status(2027, "RB-NYG", "2027-09-14T02:00:00Z");   // Monday 10:00 PM ET
    assert.deepEqual([mon.status, iso(mon.until)], ["claims", "2027-09-15T21:00:00.000Z"], "Monday 10 PM: everyone on waivers until Wednesday 5 PM");
    assert.match(mon.reason!, /On waivers: claims process Wed 5:00 PM/);
    assert.equal((await status(2027, "RB-NYG", "2027-09-14T01:59:00Z")).status, "fcfs", "a minute before Monday 10 PM (NYG on bye in week 1)");
    assert.equal((await status(2027, "WR-BUF", "2027-09-15T21:00:00Z")).status, "fcfs", "Wednesday 5 PM: first-come-first-served");
    assert.equal((await status(2027, "WR-BUF", "2028-01-02T18:01:00Z")).status, "closed", "after the season's close");
    // Dropped players: claims only for 24 hours.
    await db.exec(`insert into public.transactions (season, team_id, type, status, players_out) values (2027, '0001', 'drop', 'processed', '{WR-MIA}')`);
    const ts = (await db.query<{ created_at: string }>(`select created_at from public.transactions where 'WR-MIA' = any(players_out)`)).rows[0]!.created_at;
    const later = new Date(Date.parse(ts) + 23 * 3600e3).toISOString(), after = new Date(Date.parse(ts) + 25 * 3600e3).toISOString();
    await db.exec(`update public.nfl_games set kickoff = '2026-01-01' where season = 2027 and week = 1`);   // move week 1 out of the way of now
    await db.exec(`delete from public.nfl_games where season = 2027 and week = 2; insert into public.nfl_games (season, week, game_key, home, away, kickoff) values (2027, 2, 'NYG@MIA', 'MIA', 'NYG', '${new Date(Date.parse(ts) + 30 * 86400e3).toISOString()}')`);
    const d23 = await status(2027, "WR-MIA", later), d25 = await status(2027, "WR-MIA", after);
    assert.equal(d23.status === "claims" && d23.reason === "Dropped in the last 24 hours" || d23.reason?.startsWith("On waivers"), true, "within 24 hours of the drop: claims only");
    assert.notEqual(d25.reason, "Dropped in the last 24 hours");
  });

  // A live season whose weekly waiver window is moved away from "now", so moves are FCFS today.
  const liveSeason = async (extra = {}) => {
    const d = Number((await db.query<{ d: number }>(`select extract(isodow from now() at time zone 'America/New_York')::int as d`)).rows[0]!.d);
    const settings = { live: true, rosterMax: 3, waiversStart: { isodow: ((d + 1) % 7) + 1, time: "00:00" }, process: { isodow: ((d + 2) % 7) + 1, time: "00:00" }, ...extra };
    await db.query(`insert into public.season_settings (season, team_count, buy_in, prizes, waivers) values (2028, 12, 360, '{}', $1::jsonb)`, [JSON.stringify(settings)]);
    await db.exec(`insert into public.nfl_games (season, week, game_key, home, away, kickoff) values
        (2028, 1, 'KC@LV', 'LV', 'KC', now() - interval '1 hour'),        -- kicked off: KC and LV players are locked
        (2028, 1, 'NYG@MIA', 'MIA', 'NYG', now() + interval '2 days'),
        (2028, 1, 'BUF@DET', 'DET', 'BUF', now() + interval '2 days')`);
  };
  const move = (who: Who, team: string, add: string | null, drop: string | null = null) => rows(db, who, `select public.roster_move(2028, $1, $2, $3) as id`, [team, add, drop]);
  const roster = (team: string) => db.query<{ player_id: string }>(`select player_id from public.roster_entries where season = 2028 and team_id = '${team}' order by player_id`).then(r => r.rows.map(x => x.player_id));

  test("first-come-first-served: add, drop, add+drop, drop-only; roster max; 24-hour drop lock; locked players; 2026 is MFL's", async () => {
    await liveSeason();
    await move(user(ALICE), "0001", "WR-MIA");
    assert.deepEqual(await roster("0001"), ["WR-MIA"]);
    assert.deepEqual(await rows(db, user(BOB), `select type, via, created_by, players_in from public.transactions where season = 2028`), [{ type: "add", via: "free_agent", created_by: ALICE, players_in: ["WR-MIA"] }]);
    await assert.rejects(move(user(BOB), "0001", "RB-NYG"), /only move players on your own team/);
    await move(user(AL), "0001", "RB-NYG");                                  // the co-owner, same rights
    await move(user(ALICE), "0001", "TE-NYG");
    await assert.rejects(move(user(ALICE), "0001", "WR-BUF"), /roster is full \(3 players\)/);
    await move(user(ALICE), "0001", "WR-BUF", "TE-NYG");                     // add + drop
    await move(user(ALICE), "0001", null, "WR-BUF");                         // a newly acquired player can be dropped at once; drop-only
    assert.deepEqual(await roster("0001"), ["RB-NYG", "WR-MIA"]);
    await assert.rejects(move(user(BOB), "0002", "TE-NYG"), /Dropped in the last 24 hours \(claims only until/);
    await assert.rejects(move(user(BOB), "0002", "WR-KC1"), /Locked: his game has kicked off \(claims only/);
    await assert.rejects(move(user(BOB), "0002", "WR-MIA"), /already on a roster/);
    await db.exec(`insert into public.roster_entries (season, team_id, player_id) values (2028, '0002', 'WR-KC2')`);
    await assert.rejects(move(user(BOB), "0002", null, "WR-KC2"), /Locked: his game has kicked off/);
    await move(user(COMMISH), "0002", null, "WR-KC2");                       // the commissioner fixing another team isn't bound by timing
    assert.equal(((await rows(db, user(BOB), `select via from public.transactions where 'WR-KC2' = any(players_out)`))[0] as { via?: string }).via ?? null, "commissioner");
    await assert.rejects(rows(db, user(ALICE), `select public.roster_move(${S}, '0001', 'QB-FA')`), /made on MFL/);
    await denied(db, anon, `select public.roster_move(2028, '0001', 'WR-BUF')`, /permission denied/);
    await denied(db, user(ALICE), `insert into public.roster_entries (season, team_id, player_id) values (2028, '0001', 'WR-BUF')`, /row-level security/);
  });

  test("waiver order: ascending points; ties by head-to-head, then win %, division win %", async () => {
    await liveSeason();
    await db.exec(`insert into public.standings (season, team_id, wins, losses, points_for) values (2028, '0001', 1, 0, 100), (2028, '0002', 0, 1, 100), (2028, '0003', 1, 0, 80);
      insert into public.score_weeks (season, week, status) values (2028, 1, 'final');
      insert into public.matchups (season, week, home_team, away_team, home_score, away_score) values (2028, 1, '0001', '0002', 100, 90)`);
    const order = await rows(db, user(BOB), `select place, team_id, h2h_pct::float as h2h from public.waiver_order(2028)`);
    assert.deepEqual(order.map(o => (o as { team_id: string }).team_id), ["0003", "0002", "0001"], "fewest points first; 0002 lost the tied head-to-head");
  });

  test("claims: secret until processed; either owner ranks them; rounds in the same order; roster-full skips; lost when claimed first; not reached; undo; audit", async () => {
    await liveSeason({ rounds: 2 });
    await db.exec(`insert into public.standings (season, team_id, points_for) values (2028, '0001', 300), (2028, '0002', 100), (2028, '0003', 200);
      insert into public.roster_entries (season, team_id, player_id) values (2028, '0003', 'WR-MIA'), (2028, '0003', 'RB-NYG'), (2028, '0003', 'TE-NYG')`);
    const claim = (who: Who, team: string, add: string, drop: string | null = null) =>
      rows(db, who, `select public.waiver_claim(2028, $1, $2, $3) as id`, [team, add, drop]).then(r => Number((r[0] as { id: number }).id));
    await assert.rejects(claim(user(ALICE), "0001", "WR-BUF"), /free agent right now: add him directly/);
    const a1 = await claim(user(ALICE), "0001", "WR-KC1"), a2 = await claim(user(ALICE), "0001", "WR-LV1");
    await claim(user(BOB), "0002", "WR-KC1"); await claim(user(BOB), "0002", "WR-KC2");
    const c1 = await claim(user(CAROL), "0003", "WR-LV1");                       // roster full, no drop: skipped
    await claim(user(CAROL), "0003", "WR-KC2", "TE-NYG");
    await claim(user(BOB), "0002", "WR-BUF").catch(() => {});                    // FCFS player: refused (see above)
    await assert.rejects(claim(user(BOB), "0001", "WR-LV1"), /only claim for your own team/);
    assert.equal((await rows(db, user(BOB), `select * from public.waiver_claims where team_id = '0001'`)).length, 0, "others' pending claims are secret");
    await rows(db, user(AL), `select public.waiver_reorder(2028, '0001', array[${a2}, ${a1}]::bigint[])`);   // Al moves LV1 first
    assert.deepEqual(await rows(db, user(ALICE), `select id::int, rank, updated_by from public.waiver_claims where team_id = '0001' order by rank`),
      [{ id: a2, rank: 1, updated_by: AL }, { id: a1, rank: 2, updated_by: AL }]);
    await denied(db, user(ALICE), `select public.run_waivers_now(2028)`, /Only the commissioner/);
    const run = Number(((await rows(db, user(COMMISH), `select public.run_waivers_now(2028) as id`)) as { id: number }[])[0]!.id);
    // Order: 0002 (100), 0003 (200), 0001 (300). Round 1: Bob gets KC1; Carol's LV1 skipped (full), KC2 (with drop) wins; Alice gets LV1.
    // Round 2: Bob's KC2 is gone (lost); Alice's KC1 is gone (lost).
    const res = await rows(db, user(BOB), `select team_id, add_player, status, result from public.waiver_claims order by team_id, rank`);
    assert.deepEqual(res, [
      { team_id: "0001", add_player: "WR-LV1", status: "won", result: "Round 1" },
      { team_id: "0001", add_player: "WR-KC1", status: "lost", result: "Claimed by Stealers" },
      { team_id: "0002", add_player: "WR-KC1", status: "won", result: "Round 1" },
      { team_id: "0002", add_player: "WR-KC2", status: "lost", result: "Claimed by H.N.I.C" },
      { team_id: "0003", add_player: "WR-LV1", status: "skipped", result: "Roster full (3) and no drop" },
      { team_id: "0003", add_player: "WR-KC2", status: "won", result: "Round 1" }]);
    assert.deepEqual(await roster("0003"), ["RB-NYG", "WR-KC2", "WR-MIA"]);
    assert.deepEqual(await rows(db, user(BOB), `select team_order, kind, won from public.waiver_runs`), [{ team_order: ["0002", "0003", "0001"], kind: "forced", won: 3 }]);
    assert.equal((await rows(db, user(BOB), `select * from public.transactions where via = 'waiver'`)).length, 3, "the log shows waiver moves");
    // Undo: rosters back, claims pending again.
    assert.match(String(((await rows(db, user(COMMISH), `select public.undo_waiver_run(${run}) as r`)) as { r: string }[])[0]!.r), /Undone/);
    assert.deepEqual(await roster("0003"), ["RB-NYG", "TE-NYG", "WR-MIA"]);
    assert.equal((await rows(db, user(COMMISH), `select * from public.waiver_claims where status = 'pending'`)).length, 6);
    assert.deepEqual((await db.query<{ action: string }>(`select action from public.audit_log where action like 'waivers:%' order by id`)).rows.map(r => r.action), ["waivers:run", "waivers:undo"]);
  });

  test("claim rounds are capped; extra claims aren't reached", async () => {
    await liveSeason({ rounds: 1 });
    const claim = (team: string, add: string, who: Who) => rows(db, who, `select public.waiver_claim(2028, '${team}', '${add}')`);
    await claim("0002", "WR-KC1", user(BOB)); await claim("0002", "WR-KC2", user(BOB));
    await rows(db, user(COMMISH), `select public.run_waivers_now(2028)`);
    assert.deepEqual(await rows(db, user(BOB), `select add_player, status, result from public.waiver_claims order by rank`),
      [{ add_player: "WR-KC1", status: "won", result: "Round 1" }, { add_player: "WR-KC2", status: "lost", result: "Not reached in 1 rounds" }]);
  });

  test("reversing a drop: only when reported within 30 minutes; audited; the 24-hour drop lock goes away", async () => {
    await liveSeason();
    await move(user(ALICE), "0001", "WR-MIA");
    const drop = Number(((await move(user(ALICE), "0001", null, "WR-MIA")) as { id: number }[])[0]!.id);
    await denied(db, user(ALICE), `select public.reverse_drop(${drop})`, /Only the commissioner/);
    await denied(db, user(COMMISH), `select public.reverse_drop(${drop}, now() + interval '31 minutes')`, /within 30 minutes/);
    await rows(db, user(COMMISH), `select public.reverse_drop(${drop}, now() + interval '20 minutes')`);
    assert.deepEqual(await roster("0001"), ["WR-MIA"]);
    assert.deepEqual((await db.query<{ action: string }>(`select action from public.audit_log where action like 'waivers:%'`)).rows.map(r => r.action), ["waivers:reverse_drop"]);
    assert.equal(((await rows(db, user(ALICE), `select status from public.transactions where id = ${drop}`))[0] as { status?: string }).status ?? null, "reversed");
  });

  test("the schedule processes once per week after Wednesday 5 PM ET, only for live seasons", async () => {
    await db.exec(`insert into public.season_settings (season, team_count, buy_in, prizes, waivers) values (2027, 12, 360, '{}', '{"live": true}');
      insert into public.nfl_games (season, week, game_key, home, away, kickoff) values (2027, 1, 'KC@LV', 'LV', 'KC', '2027-09-10T00:15:00Z'), (2027, 2, 'NYG@MIA', 'MIA', 'NYG', '2027-09-19T17:00:00Z')`);
    const tick = (at: string) => db.query<{ r: string }>(`select private.waivers_tick('${at}'::timestamptz) as r`).then(r => r.rows[0]!.r);
    assert.equal(await tick("2027-09-15T20:05:00Z"), "nothing to do", "Wednesday 4:05 PM ET: not yet");
    assert.equal(await tick("2027-09-15T21:05:00Z"), "2027 ", "Wednesday 5:05 PM ET: runs");
    assert.equal(await tick("2027-09-15T22:05:00Z"), "nothing to do", "once per week");
    assert.deepEqual((await db.query(`select kind, cycle from public.waiver_runs`)).rows.map(r => (r as { kind: string }).kind), ["scheduled"]);
    assert.equal(await tick("2027-12-15T22:05:00Z"), "2027 ", "EST (December): Wednesday 5 PM ET = 22:00 UTC");
    await denied(db, user(COMMISH), `select private.waivers_tick()`, /permission denied/);
  });
});

describe("team profiles: owner contact info (private)", () => {
  const CAROL = "00000000-0000-0000-0000-0000000000c3";   // owns 0003
  const AL = "00000000-0000-0000-0000-0000000000a2";      // Alice's co-owner
  const NOBODY = "00000000-0000-0000-0000-0000000000e0";  // signed in, no team
  beforeEach(async () => {
    await db.exec(`
      insert into auth.users (id, email, raw_user_meta_data) values ('${CAROL}', 'carol@example.com', '{"display_name":"Carol"}'),
        ('${AL}', 'al2@example.com', '{"display_name":"Al"}'), ('${NOBODY}', 'x@example.com', '{}');
      insert into public.teams (id, name, division) values ('0003', 'H.N.I.C', 'Gold');
      insert into public.team_managers values ('0003', '${CAROL}'), ('0001', '${AL}');`);
  });
  const save = (who: Who, f: Record<string, unknown>) =>
    as(db, who, tx => tx.query(`insert into public.owner_contacts (email, email_visible, phone, phone_visible, website, website_visible)
      values ($1, coalesce($2, true), $3, coalesce($4, true), $5, coalesce($6, true))`,
      [f.email ?? null, f.email_visible ?? null, f.phone ?? null, f.phone_visible ?? null, f.website ?? null, f.website_visible ?? null]));
  const contacts = (who: Who, team: string) => rowsT(db, who, `select user_id, email, phone, website, hidden from public.team_contacts($1) order by user_id`, [team]);

  test("validated: US phone formatted to 10 digits, https websites only, real-looking emails", async () => {
    await save(user(ALICE), { email: " alice@example.com ", phone: "+1 (412) 555-0123", website: "https://alice.example.com/me" });
    assert.deepEqual(await rowsT(db, user(ALICE), `select email, phone, website from public.owner_contacts`), [{ email: "alice@example.com", phone: "4125550123", website: "https://alice.example.com/me" }]);
    await assert.rejects(save(user(BOB), { phone: "555-0123" }), /10-digit US phone/);
    await assert.rejects(save(user(BOB), { phone: "(112) 555-0123" }), /10-digit US phone/);
    await assert.rejects(save(user(BOB), { website: "http://bob.example.com" }), /https/);
    await assert.rejects(save(user(BOB), { website: "javascript:alert(1)" }), /https/);
    await assert.rejects(save(user(BOB), { website: 'https://x.com/"><script>' }), /https|check constraint/);
    await assert.rejects(save(user(BOB), { email: "not-an-email" }), /email/);
  });

  test("logged out: nothing at all; signed-in non-members: nothing", async () => {
    await save(user(ALICE), { email: "alice@example.com", phone: "4125550123" });
    await denied(db, anon, `select * from public.owner_contacts`, /permission denied/);
    await assert.rejects(as(db, anon, tx => tx.query(`select * from public.team_contacts('0001')`)), /permission denied/);
    assert.deepEqual(await rowsT(db, user(NOBODY), `select * from public.owner_contacts`), []);
    assert.deepEqual(await contacts(user(NOBODY), "0001"), []);
  });

  test("members see only the fields marked visible; the owner and the commissioner see everything", async () => {
    await save(user(ALICE), { email: "alice@example.com", phone: "4125550123", phone_visible: false, website: "https://alice.example.com" });
    const bob = await contacts(user(BOB), "0001");
    assert.deepEqual(bob.map(r => [r.user_id, r.email, r.phone, r.website, r.hidden]),
      [[ALICE, "alice@example.com", null, "https://alice.example.com", []], [AL, null, null, null, []]], "both owners listed; the hidden phone is null");
    assert.deepEqual(await rowsT(db, user(BOB), `select * from public.owner_contacts`), [], "the table itself: only your own row");
    const commish = await contacts(user(COMMISH), "0001");
    assert.deepEqual([commish[0]!.phone, commish[0]!.hidden], ["4125550123", ["phone"]], "the commissioner always sees everything (with what's hidden)");
    assert.equal((await rowsT(db, user(COMMISH), `select user_id from public.owner_contacts`)).length, 1);
    assert.equal((await contacts(user(ALICE), "0001"))[0]!.phone, "4125550123", "you see your own hidden fields");
    assert.equal((await contacts(user(AL), "0001"))[0]!.phone, null, "...but your co-owner doesn't");
  });

  test("you can only edit your own row", async () => {
    await save(user(ALICE), { email: "alice@example.com" });
    assert.equal(await affected(db, user(BOB), `update public.owner_contacts set email = 'evil@example.com'`), 0);
    assert.equal(await affected(db, user(BOB), `delete from public.owner_contacts`), 0);
    await as(db, user(BOB), tx => tx.query(`insert into public.owner_contacts (user_id, email) values ('${ALICE}', 'bob@example.com')`));
    const all = (await db.query<{ user_id: string; email: string }>(`select user_id, email from public.owner_contacts order by email`)).rows;
    assert.deepEqual(all.map(r => [r.user_id, r.email]), [[ALICE, "alice@example.com"], [BOB, "bob@example.com"]], "a forged user_id becomes your own");
    await as(db, user(BOB), tx => tx.query(`update public.owner_contacts set user_id = '${ALICE}', email = 'b2@example.com'`));
    assert.deepEqual((await db.query<{ user_id: string }>(`select user_id from public.owner_contacts where email = 'b2@example.com'`)).rows.map(r => r.user_id), [BOB], "a row can't be moved to someone else");
    assert.equal(await affected(db, user(ALICE), `update public.owner_contacts set email_visible = false`), 1);
  });
});

describe("direct messages (participants only)", () => {
  const CAROL = "00000000-0000-0000-0000-0000000000c3";
  const AL = "00000000-0000-0000-0000-0000000000a2";
  beforeEach(async () => {
    await db.exec(`
      insert into auth.users (id, email, raw_user_meta_data) values ('${CAROL}', 'carol@example.com', '{"display_name":"Carol"}'), ('${AL}', 'al2@example.com', '{"display_name":"Al"}');
      insert into public.teams (id, name, division) values ('0003', 'H.N.I.C', 'Gold');
      insert into public.team_managers values ('0003', '${CAROL}'), ('0001', '${AL}');`);
  });
  const open = async (who: Who, to: { user?: string; team?: string }) =>
    Number((await rowsT(db, who, `select public.dm_open($1::uuid, $2) as id`, [to.user ?? null, to.team ?? null]))[0]!.id);
  const say = (who: Who, conv: number, body: string, images = "[]") =>
    as(db, who, tx => tx.query(`insert into public.dm_messages (conversation_id, body, images) values ($1, $2, $3::jsonb)`, [conv, body, images]));
  const read = (who: Who, conv: number) => rowsT(db, who, `select body from public.dm_messages where conversation_id = $1 order by id`, [conv]).then(r => r.map(x => x.body));

  test("1-to-1: only the two people read it; the commissioner can't; one conversation per pair", async () => {
    const c = await open(user(ALICE), { user: BOB });
    assert.equal(await open(user(BOB), { user: ALICE }), c, "the same conversation from either side");
    await say(user(ALICE), c, "Want Gibbs?");
    await say(user(BOB), c, "Maybe");
    assert.deepEqual(await read(user(BOB), c), ["Want Gibbs?", "Maybe"]);
    assert.deepEqual(await read(user(CAROL), c), [], "another member: nothing");
    assert.deepEqual(await read(user(AL), c), [], "not even Alice's co-owner");
    assert.deepEqual(await read(user(COMMISH), c), [], "the commissioner: nothing");
    assert.deepEqual(await rowsT(db, user(COMMISH), `select id from public.dm_conversations`), []);
    await assert.rejects(say(user(CAROL), c, "hi"), /row-level security/);
    await assert.rejects(say(user(COMMISH), c, "hi"), /row-level security/);
    await denied(db, anon, `select * from public.dm_messages`, /permission denied/);
    await assert.rejects(as(db, anon, tx => tx.query(`select public.dm_open('${ALICE}', null)`)), /permission denied/);
  });

  test("1-to-team: both co-owners take part; author and team set by the database; edit only your own", async () => {
    const c = await open(user(CAROL), { team: "0001" });
    await as(db, user(CAROL), tx => tx.query(`insert into public.dm_messages (conversation_id, body, author_id, is_bot) values ($1, 'Trade?', '${ALICE}', true)`, [c]));
    const [m] = await rowsT(db, user(ALICE), `select id, author_id, author_team, is_bot from public.dm_messages where conversation_id = ${c}`);
    assert.deepEqual([m!.author_id, m!.author_team, m!.is_bot], [CAROL, "0003", false], "forged author/bot overwritten");
    assert.deepEqual(await read(user(AL), c), ["Trade?"], "the co-owner sees it too");
    await say(user(AL), c, "Sure");
    assert.deepEqual(await read(user(BOB), c), []);
    assert.equal(await affected(db, user(ALICE), `update public.dm_messages set body = 'x' where id = ${m!.id}`), 0, "not your message");
    assert.equal(await affected(db, user(CAROL), `update public.dm_messages set body = 'Trade??' where id = ${m!.id}`), 1);
    await assert.rejects(as(db, user(ALICE), tx => tx.query(`select public.dm_open(null, '0001')`)), /your own team/);
  });

  test("report shares it with the commissioner (audited) until he resolves it", async () => {
    const c = await open(user(ALICE), { user: BOB });
    await say(user(ALICE), c, "something bad");
    await assert.rejects(as(db, user(CAROL), tx => tx.query(`select public.dm_report(${c}, 'x')`)), /not in that conversation/);
    await as(db, user(BOB), tx => tx.query(`select public.dm_report(${c}, 'harassment')`));
    assert.deepEqual((await read(user(COMMISH), c))[0], "something bad", "reported: the commissioner can read it");
    assert.match((await read(user(ALICE), c)).at(-1)!, /reported to the commissioner/, "both sides are told");
    assert.equal(await affected(db, user(COMMISH), `delete from public.dm_messages where conversation_id = ${c} and body = 'something bad'`), 1, "and moderate it");
    await assert.rejects(as(db, user(ALICE), tx => tx.query(`select public.dm_resolve(${c})`)), /Only the commissioner/);
    await as(db, user(COMMISH), tx => tx.query(`select public.dm_resolve(${c})`));
    assert.deepEqual(await read(user(COMMISH), c), [], "private again");
    const audit = (await db.query<{ action: string }>(`select action from public.audit_log where action like 'dm:%' order by id`)).rows.map(r => r.action);
    assert.deepEqual(audit, ["dm:report", "dm:resolve"]);
  });

  test("unread counts and rate limit", async () => {
    const c = await open(user(ALICE), { user: BOB });
    await say(user(ALICE), c, "1"); await say(user(ALICE), c, "2");
    assert.deepEqual(await rowsT(db, user(BOB), `select conversation_id, unread from public.dm_unread()`), [{ conversation_id: String(c), unread: 2 }].map(x => ({ ...x, conversation_id: c })));
    await as(db, user(BOB), tx => tx.query(`insert into public.dm_reads (conversation_id) values (${c})`));
    assert.equal((await rowsT(db, user(BOB), `select unread from public.dm_unread()`))[0]!.unread, 0);
    await assert.rejects(as(db, user(CAROL), tx => tx.query(`insert into public.dm_reads (conversation_id) values (${c})`)), /row-level security/);
    for (let i = 0; i < 18; i++) await say(user(ALICE), c, "x" + i);
    await assert.rejects(say(user(ALICE), c, "too many"), /Slow down/);
  });

  test("images: uploads in dm-images are readable only by the conversation", async () => {
    const c = await open(user(ALICE), { user: BOB });
    const name = `${ALICE}/11111111-1111-1111-1111-111111111111.png`;
    await as(db, user(ALICE), tx => tx.query(`insert into storage.objects (bucket_id, name) values ('dm-images', $1)`, [name]));
    await assert.rejects(as(db, user(BOB), tx => tx.query(`insert into storage.objects (bucket_id, name) values ('dm-images', '${ALICE}/x.png')`)), /row-level security/, "only into your own folder");
    const sees = (who: Who) => rowsT(db, who, `select name from storage.objects where bucket_id = 'dm-images'`).then(r => r.length);
    assert.equal(await sees(user(BOB)), 0, "not before it's in a message");
    await say(user(ALICE), c, "", JSON.stringify([`storage:${name}`]));
    assert.equal(await sees(user(ALICE)), 1);
    assert.equal(await sees(user(BOB)), 1, "the other participant");
    assert.equal(await sees(user(CAROL)), 0, "anyone else: no");
    assert.equal(await sees(user(COMMISH)), 0, "the commissioner: no (not reported)");
    assert.equal(await sees(anon), 0);
  });
});

describe("trades", () => {
  const CAROL = "00000000-0000-0000-0000-0000000000c3";   // owns 0003
  const AL = "00000000-0000-0000-0000-0000000000a2";      // Alice's co-owner
  const T = 2028;
  beforeEach(async () => {
    await db.exec(`
      insert into auth.users (id, email, raw_user_meta_data) values ('${CAROL}', 'carol@example.com', '{"display_name":"Carol"}'), ('${AL}', 'al2@example.com', '{"display_name":"Al"}');
      insert into public.teams (id, name, division) values ('0003', 'H.N.I.C', 'Gold'), ('0004', 'Mac Daddies', 'Black');
      insert into public.team_managers values ('0003', '${CAROL}'), ('0001', '${AL}'), ('0004', '${COMMISH}');
      insert into public.nfl_players (id, name, position, nfl_team) values
        ('WR-BUF', 'Buf WR', 'WR', 'BUF'), ('WR-MIA', 'Mia WR', 'WR', 'MIA'), ('WR-KC1', 'KC WR', 'WR', 'KC'), ('RB-NYG', 'NYG RB', 'RB', 'NYG'), ('TE-NYG', 'NYG TE', 'TE', 'NYG'), ('RB-MIA', 'Mia RB', 'RB', 'MIA');
      insert into public.season_settings (season, team_count, buy_in, prizes, waivers, trades) values (${T}, 12, 360, '{}', '{"live": true, "rosterMax": 3}', '{"live": true}');
      insert into public.nfl_games (season, week, game_key, home, away, kickoff) values
        (${T}, 1, 'KC@LV', 'LV', 'KC', now() - interval '1 hour'),
        (${T}, 1, 'NYG@MIA', 'MIA', 'NYG', now() + interval '2 days'),
        (${T}, 1, 'BUF@DET', 'DET', 'BUF', now() + interval '2 days'),
        (${T}, 12, 'BUF@MIA', 'MIA', 'BUF', now() + interval '60 days');
      insert into public.roster_entries (season, team_id, player_id) values
        (${T}, '0001', 'WR-BUF'), (${T}, '0001', 'WR-KC1'), (${T}, '0001', 'RB-NYG'),
        (${T}, '0002', 'WR-MIA'), (${T}, '0002', 'TE-NYG'), (${T}, '0004', 'RB-MIA');
      select private.ensure_draft_picks(${T + 1}, 2);`);
  });
  const pick = async (team: string, round: number) => Number((await db.query<{ id: number }>(`select id from public.draft_picks where season = ${T + 1} and original_team = '${team}' and round = ${round}`)).rows[0]!.id);
  const propose = (who: Who, from: string, to: string, give: string[], get: string[], extra: { givePicks?: number[]; getPicks?: number[]; drops?: string[]; season?: number } = {}) =>
    rowsT(db, who, `select public.trade_propose($1, $2, $3, $4, $5, $6, $7, $8, 'let''s deal') as id`,
      [extra.season ?? T, from, to, give, get, extra.givePicks ?? [], extra.getPicks ?? [], extra.drops ?? []]).then(r => Number(r[0]!.id));
  const roster = (team: string, season = T) => db.query<{ player_id: string }>(`select player_id from public.roster_entries where season = ${season} and team_id = '${team}' order by player_id`).then(r => r.rows.map(x => x.player_id));
  const status = (id: number) => db.query<{ status: string }>(`select status from public.trades where id = ${id}`).then(r => r.rows[0]!.status);
  const notices = (id: number) => db.query<{ body: string }>(`select m.body from public.dm_messages m join public.trades t on t.conversation_id = m.conversation_id where t.id = ${id} order by m.id`).then(r => r.rows.map(x => x.body));

  test("full flow: propose, the other team accepts with a drop, the commissioner approves; rosters, picks, transactions, notices, board post", async () => {
    const p1 = await pick("0001", 1);
    // Alice gives Buf WR + her 1st for Bob's Mia WR and Nyg TE: Alice goes 3 -> 4 (needs a drop), Bob 2 -> 1.
    await assert.rejects(propose(user(ALICE), "0001", "0002", ["WR-BUF"], ["WR-MIA", "TE-NYG"], { givePicks: [p1] }), /NSFW would have 4 players \(max 3\): add 1 drop/);
    const id = await propose(user(ALICE), "0001", "0002", ["WR-BUF"], ["WR-MIA", "TE-NYG"], { givePicks: [p1], drops: ["RB-NYG"] });
    assert.equal(await status(id), "proposed");
    assert.match((await notices(id))[0]!, /Trade proposed by .*NSFW get Mia WR \(WR\), NYG TE \(TE\); Stealers get Buf WR \(WR\), 2029 round 1 pick\. NSFW drop NYG RB/);
    await assert.rejects(as(db, user(ALICE), tx => tx.query(`select public.trade_respond(${id}, true)`)), /other team's owners/, "the proposer can't accept his own");
    await assert.rejects(as(db, user(COMMISH), tx => tx.query(`select public.trade_decide(${id}, true)`)), /Only accepted trades/, "not before it's accepted");
    await as(db, user(BOB), tx => tx.query(`select public.trade_respond(${id}, true)`));
    assert.equal(await status(id), "accepted");
    assert.deepEqual(await roster("0001"), ["RB-NYG", "WR-BUF", "WR-KC1"], "nothing moves before the commissioner approves");
    await assert.rejects(as(db, user(BOB), tx => tx.query(`select public.trade_decide(${id}, true)`)), /Only the commissioner/);
    await as(db, user(COMMISH), tx => tx.query(`select public.trade_decide(${id}, true, 'Fair')`));
    assert.equal(await status(id), "approved");
    assert.deepEqual(await roster("0001"), ["TE-NYG", "WR-KC1", "WR-MIA"]);
    assert.deepEqual(await roster("0002"), ["WR-BUF"]);
    assert.equal((await db.query<{ owner_team: string }>(`select owner_team from public.draft_picks where id = ${p1}`)).rows[0]!.owner_team, "0002");
    const tx = (await db.query<{ type: string; team_id: string; via: string; players_in: string[]; players_out: string[] }>(`select type, team_id, via, players_in, players_out from public.transactions where trade_id = ${id} order by id`)).rows;
    assert.deepEqual(tx.map(x => [x.type, x.team_id, x.via, x.players_in, x.players_out]),
      [["trade", "0001", "trade", ["WR-MIA", "TE-NYG"], ["WR-BUF"]], ["drop", "0001", "trade", [], ["RB-NYG"]]], "a trade isn't a roster move (via trade)");
    assert.equal((await db.query(`select 1 from public.board_threads where source_key = 'trade:${id}' and is_bot`)).rows.length, 1, "posted to the Board");
    const n = await notices(id);
    assert.match(n.at(-1)!, /Approved by the commissioner.*Note: Fair.*Rosters are updated/);
    assert.ok(n.some(x => /Stealers accepted/.test(x)));
    assert.match((await rowsT(db, user(BOB), `select body from public.dm_messages`)).map(r => r.body).join("|"), /Approved/, "both teams get the notices");
    assert.equal((await rowsT(db, user(CAROL), `select body from public.dm_messages`)).length, 0, "no one else does");
    const [a] = (await db.query<{ action: string; details: { commissioner_party: boolean } }>(`select action, details from public.audit_log where action like '%trades:%'`)).rows;
    assert.deepEqual([a!.action, a!.details.commissioner_party], ["trades:approve", false]);
  });

  test("the receiving team adds drops when it would go over the max; the dropped player is claims-only for 24 hours", async () => {
    await db.exec(`delete from public.roster_entries where season = ${T} and team_id = '0004'`);
    await db.exec(`insert into public.roster_entries (season, team_id, player_id) values (${T}, '0002', 'RB-MIA')`);
    const id = await propose(user(ALICE), "0001", "0002", ["WR-BUF"], []);
    await assert.rejects(as(db, user(BOB), tx => tx.query(`select public.trade_respond(${id}, true)`)), /Stealers would have 4 players \(max 3\): add 1 drop/);
    await as(db, user(BOB), tx => tx.query(`select public.trade_respond(${id}, true, '{RB-MIA}')`));
    await as(db, user(COMMISH), tx => tx.query(`select public.trade_decide(${id}, true)`));
    assert.deepEqual(await roster("0002"), ["TE-NYG", "WR-BUF", "WR-MIA"]);
    const s = (await db.query<{ reason: string }>(`select reason from private.move_status(${T}, 'RB-MIA', now())`)).rows[0]!;
    assert.match(s.reason, /Dropped in the last 24 hours/);
  });

  test("locks, deadline, ownership and who may act", async () => {
    await assert.rejects(propose(user(ALICE), "0001", "0002", ["WR-KC1"], ["WR-MIA"]), /KC WR is locked: his game has started/);
    await assert.rejects(propose(user(ALICE), "0001", "0002", ["WR-MIA"], []), /Mia WR isn't on NSFW/);
    await assert.rejects(propose(user(BOB), "0001", "0002", ["WR-BUF"], []), /your own team/);
    await assert.rejects(propose(user(ALICE), "0001", "0002", [], ["WR-MIA"], { getPicks: [await pick("0003", 1)] }), /isn't owned by Stealers/);
    // Pending trades are private to the two teams (and the commissioner).
    const id = await propose(user(AL), "0001", "0002", ["WR-BUF"], ["WR-MIA"]);
    assert.equal((await rowsT(db, user(CAROL), `select id from public.trades`)).length, 0);
    assert.equal((await rowsT(db, user(ALICE), `select id from public.trades`)).length, 1, "the co-owner who didn't propose sees it");
    await denied(db, anon, `select * from public.trades`, /permission denied/);
    await denied(db, user(ALICE), `update public.trades set status = 'approved'`, /permission denied/);
    // A player locked after the proposal: accepting fails until the week is over.
    await db.exec(`update public.nfl_games set kickoff = now() - interval '5 minutes' where season = ${T} and game_key = 'NYG@MIA'`);
    await assert.rejects(as(db, user(BOB), tx => tx.query(`select public.trade_respond(${id}, true)`)), /Mia WR is locked/);
    await db.exec(`update public.nfl_games set kickoff = now() + interval '2 days' where season = ${T} and game_key = 'NYG@MIA'`);
    // Deadline: the kickoff of week 12's first game.
    await db.exec(`update public.nfl_games set kickoff = now() - interval '1 minute' where season = ${T} and week = 12`);
    await assert.rejects(as(db, user(BOB), tx => tx.query(`select public.trade_respond(${id}, true)`)), /trade deadline has passed/);
    await assert.rejects(propose(user(ALICE), "0001", "0002", ["WR-BUF"], []), /trade deadline has passed/);
    await db.exec(`update public.nfl_games set kickoff = now() + interval '60 days' where season = ${T} and week = 12`);
    // Either co-owner of the receiving team answers; only the proposing team withdraws.
    await assert.rejects(as(db, user(BOB), tx => tx.query(`select public.trade_withdraw(${id})`)), /proposing team/);
    await as(db, user(ALICE), tx => tx.query(`select public.trade_withdraw(${id})`));
    assert.equal(await status(id), "withdrawn");
    await assert.rejects(as(db, user(BOB), tx => tx.query(`select public.trade_respond(${id}, true)`)), /This trade is withdrawn/);
  });

  test("decline, reject with a note, expiry after 7 days", async () => {
    const a = await propose(user(ALICE), "0001", "0002", ["WR-BUF"], ["WR-MIA"]);
    await as(db, user(BOB), tx => tx.query(`select public.trade_respond(${a}, false)`));
    assert.equal(await status(a), "declined");
    const b = await propose(user(ALICE), "0001", "0002", ["WR-BUF"], ["WR-MIA"]);
    await as(db, user(BOB), tx => tx.query(`select public.trade_respond(${b}, true)`));
    await as(db, user(COMMISH), tx => tx.query(`select public.trade_decide(${b}, false, 'Lopsided')`));
    assert.equal(await status(b), "rejected");
    assert.match((await notices(b)).at(-1)!, /Rejected by the commissioner\. Note: Lopsided/);
    assert.deepEqual(await roster("0001"), ["RB-NYG", "WR-BUF", "WR-KC1"]);
    const c = await propose(user(ALICE), "0001", "0002", ["WR-BUF"], ["WR-MIA"]);
    const exp = (await db.query<{ d: number }>(`select extract(epoch from expires_at - proposed_at) / 86400 as d from public.trades where id = ${c}`)).rows[0]!.d;
    assert.equal(Math.round(Number(exp)), 7);
    await db.exec(`update public.trades set expires_at = now() - interval '1 minute' where id = ${c}`);
    await assert.rejects(as(db, user(BOB), tx => tx.query(`select public.trade_respond(${c}, true)`)), /This trade is expired/, "refused at once");
    assert.equal(Number((await rowsT(db, service, `select private.expire_trades() as n`))[0]!.n), 1, "the hourly job expires it and tells both teams");
    assert.equal(await status(c), "expired");
    assert.match((await notices(c)).at(-1)!, /expired/);
  });

  test("the commissioner's own team: flagged and audited as his own", async () => {
    const id = await propose(user(COMMISH), "0004", "0002", ["RB-MIA"], ["WR-MIA"]);
    assert.equal((await db.query<{ commissioner_party: boolean }>(`select commissioner_party from public.trades where id = ${id}`)).rows[0]!.commissioner_party, true);
    await as(db, user(BOB), tx => tx.query(`select public.trade_respond(${id}, true)`));
    assert.match((await notices(id)).at(-1)!, /commissioner is a party/);
    await as(db, user(COMMISH), tx => tx.query(`select public.trade_decide(${id}, true)`));
    const [a] = (await db.query<{ action: string; details: { commissioner_party: boolean } }>(`select action, details from public.audit_log where action like '%trades:%'`)).rows;
    assert.deepEqual([a!.action, a!.details.commissioner_party], ["own_team:trades:approve", true]);
  });

  test("2026 (MFL is official): test trades, labelled, and approval changes nothing", async () => {
    await db.exec(`insert into public.season_settings (season, team_count, buy_in, prizes) values (${S}, 12, 360, '{}') on conflict (season) do nothing;
      update public.season_settings set trades = '{"live": false}' where season = ${S}`);
    const id = await propose(user(ALICE), "0001", "0002", ["QB-DET"], ["QB-ARI"], { season: S });
    assert.equal((await db.query<{ test: boolean }>(`select test from public.trades where id = ${id}`)).rows[0]!.test, true);
    await as(db, user(BOB), tx => tx.query(`select public.trade_respond(${id}, true)`));
    await as(db, user(COMMISH), tx => tx.query(`select public.trade_decide(${id}, true)`));
    assert.equal(await status(id), "approved");
    assert.deepEqual(await roster("0001", S), ["QB-DET", "QB-KC", "RB-DET"], "rosters untouched");
    const n = await notices(id);
    assert.ok(n.every(x => x.startsWith("[TEST trade: MFL is official for 2026]")), "every notice is labelled TEST");
    assert.equal((await db.query(`select 1 from public.board_threads where source_key = 'trade:${id}'`)).rows.length, 0, "not posted to the Board");
    assert.equal((await db.query(`select 1 from public.transactions where trade_id = ${id}`)).rows.length, 0);
  });

  test("tradable assets: a team's players with lock status and its future picks (members only)", async () => {
    const a = await rowsT(db, user(BOB), `select kind, id, locked_until is not null as locked, label from public.trade_assets(${T}, '0001')`);
    assert.deepEqual(a.filter(x => x.kind === "player").map(x => [x.id, x.locked]).sort(), [["RB-NYG", false], ["WR-BUF", false], ["WR-KC1", true]]);
    assert.deepEqual(a.filter(x => x.kind === "pick").map(x => x.label), ["2029 round 1", "2029 round 2"]);
    await assert.rejects(as(db, anon, tx => tx.query(`select * from public.trade_assets(${T}, '0001')`)), /permission denied/);
    assert.equal((await rowsT(db, anon, `select id from public.draft_picks`)).length, 8, "pick ownership is public, like rosters");
  });
});

describe("email notifications", () => {
  const CAROL = "00000000-0000-0000-0000-0000000000c3";
  beforeEach(async () => {
    await db.exec(`
      insert into auth.users (id, email, raw_user_meta_data) values ('${CAROL}', 'carol@example.com', '{"display_name":"Carol"}');
      insert into public.teams (id, name, division) values ('0003', 'H.N.I.C', 'Gold');
      insert into public.team_managers values ('0003', '${CAROL}');
      update public.profiles set display_name = 'Alice' where id = '${ALICE}';
      update public.profiles set display_name = 'Bob' where id = '${BOB}';
      delete from public.notify_queue;   -- the seed's published announcement`);
  });
  const later = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
  const claim = (min: number) => rowsT(db, service, `select id, user_id, kind, email, token, data from public.notify_claim(25, $1::timestamptz)`, [later(min)]);
  const queue = () => db.query<{ user_id: string; kind: string; ref: string; status: string; reason: string | null; due_at: string }>(`select user_id, kind, ref, status, reason, due_at from public.notify_queue order by id`).then(r => r.rows);
  const dm = async () => Number((await rowsT(db, user(ALICE), `select public.dm_open($1::uuid, null) as id`, [BOB]))[0]!.id);
  const say = (who: Who, conv: number, body: string) => as(db, who, tx => tx.query(`insert into public.dm_messages (conversation_id, body) values ($1, $2)`, [conv, body]));
  const done = (id: number, ok: boolean, err: string | null = null) => rowsT(db, service, `select public.notify_done($1, $2, 'msg_1', $3)`, [id, ok, err]);

  test("settings: your own row only (RLS); logged out nothing; defaults DM/trades/announcements on", async () => {
    await denied(db, anon, `select * from public.notify_settings`, /permission denied/);
    await as(db, user(ALICE), tx => tx.query(`insert into public.notify_settings (user_id, mentions) values ('${BOB}', true)`));
    assert.deepEqual((await db.query<{ user_id: string }>(`select user_id from public.notify_settings`)).rows.map(r => r.user_id), [ALICE], "a forged user_id becomes your own");
    assert.deepEqual(await rowsT(db, user(BOB), `select * from public.notify_settings`), []);
    assert.equal(await affected(db, user(BOB), `update public.notify_settings set dm = false`), 0, "can't change someone else's");
    assert.equal(await affected(db, user(ALICE), `update public.notify_settings set paused = true`), 1);
    const on = async (u: string, k: string) => (await db.query<{ v: boolean }>(`select private.notify_on($1, $2) as v`, [u, k])).rows[0]!.v;
    assert.deepEqual([await on(BOB, "dm"), await on(BOB, "trades"), await on(BOB, "announcements"), await on(BOB, "mentions"), await on(BOB, "waivers"), await on(BOB, "lineup")],
      [true, true, true, false, true, false], "defaults (waiver results on since 2026-10-24)");
    assert.equal(await on(ALICE, "dm"), false, "pause turns everything off");
    await denied(db, user(ALICE), `select * from public.notify_queue`, /permission denied/);
    await denied(db, user(ALICE), `select * from public.email_log`, /row-level security|permission denied/).catch(async () => {
      assert.deepEqual(await rowsT(db, user(ALICE), `select * from public.email_log`), [], "managers see no email log");
    });
  });

  test("DM: waits 5 minutes, one email per conversation summarizing what's unread; never to the sender", async () => {
    const c = await dm();
    await say(user(ALICE), c, "Want **Gibbs**?");
    await say(user(ALICE), c, "Offer stands till Sunday");
    const q = await queue();
    assert.deepEqual(q.map(x => [x.user_id, x.kind, x.ref, x.status]), [[BOB, "dm", `conv:${c}`, "pending"]], "one pending email for Bob, none for Alice");
    assert.equal(Math.round((Date.parse(q[0]!.due_at) - Date.now()) / 60000), 5);
    assert.deepEqual(await claim(1), [], "not before 5 minutes");
    const [item] = await claim(6);
    assert.equal(item!.email, "bob@example.com");
    assert.equal(item!.data.count, 2);
    assert.deepEqual(item!.data.senders, [{ name: "Alice", team: "NSFW" }]);
    assert.equal(item!.data.preview, "Offer stands till Sunday");
    assert.equal(item!.data.link, `#dm/${c}`);
    await done(Number(item!.id), true);
    const log = (await db.query<{ user_id: string; kind: string; status: string }>(`select user_id, kind, status from public.email_log`)).rows;
    assert.deepEqual(log, [{ user_id: BOB, kind: "dm", status: "sent" }], "logged: type, recipient, status (no contents)");
    const cols = (await db.query<{ column_name: string }>(`select column_name from information_schema.columns where table_name = 'email_log'`)).rows.map(r => r.column_name);
    assert.ok(!cols.some(x => /body|subject|preview|email/.test(x)), "the log has no message contents or addresses");
    assert.equal((await rowsT(db, user(COMMISH), `select * from public.email_log`)).length, 1, "the commissioner reads the log");
  });

  test("DM: no email once it's read, or while you're on the site; bot notices never email", async () => {
    const c = await dm();
    await say(user(ALICE), c, "hi");
    await as(db, user(BOB), tx => tx.query(`insert into public.dm_reads (conversation_id, read_at) values (${c}, now() + interval '1 minute')`));
    assert.deepEqual(await claim(6), [], "read within the 5 minutes: no email");
    assert.deepEqual((await queue()).map(x => [x.status, x.reason]), [["skipped", "already read"]]);
    await say(user(BOB), c, "hey");          // Alice's turn
    await as(db, user(ALICE), tx => tx.query(`select public.notify_seen()`));
    await db.exec(`update public.user_presence set seen_at = now() + interval '5 minutes'`);
    assert.deepEqual(await claim(6), [], "Alice was active a minute before it was due");
    assert.equal((await queue()).at(-1)!.reason, "active on the site");
    await db.exec(`select private.dm_bot_post(${c}, 'B5 Bot notice')`);
    assert.equal((await queue()).filter(x => x.status === "pending").length, 0);
    await denied(db, anon, `select public.notify_seen()`, /permission denied/);
  });

  test("DM throttle: at most one email per conversation per 30 minutes; the next one summarizes everything unread", async () => {
    const c = await dm();
    await say(user(ALICE), c, "one");
    const [a] = await claim(6);
    await done(Number(a!.id), true);
    await say(user(ALICE), c, "two");
    await say(user(ALICE), c, "three");
    assert.deepEqual(await claim(11), [], "10 minutes after the first email: held back");
    const held = (await queue()).at(-1)!;
    assert.equal(held.status, "pending");
    assert.equal(Math.round((Date.parse(held.due_at) - Date.now()) / 60000), 30, "until 30 minutes after the last one");
    const [b] = await claim(31);
    assert.equal(b!.data.count, 3, "summarizes all 3 unread");
  });

  test("toggle off or paused: nothing is sent", async () => {
    await as(db, user(BOB), tx => tx.query(`insert into public.notify_settings (dm) values (false)`));
    const c = await dm();
    await say(user(ALICE), c, "hello?");
    assert.deepEqual(await queue(), [], "not even queued");
    await as(db, user(BOB), tx => tx.query(`update public.notify_settings set dm = true`));
    await say(user(ALICE), c, "hello again");
    await as(db, user(BOB), tx => tx.query(`update public.notify_settings set paused = true`));
    assert.deepEqual(await claim(6), [], "paused after it was queued: skipped at send time");
    assert.equal((await queue()).at(-1)!.reason, "turned off");
  });

  test("unsubscribe link: signed token turns that type off without signing in; tampered tokens fail", async () => {
    const c = await dm();
    await say(user(ALICE), c, "x");
    const [item] = await claim(6);
    const token = String(item!.token);
    assert.match(token, new RegExp(`^${BOB}\\.dm\\.[0-9a-f]{32}$`));
    await assert.rejects(as(db, anon, tx => tx.query(`select public.notify_unsubscribe($1)`, [token.slice(0, -1) + (token.endsWith("0") ? "1" : "0")])), /isn't valid/);
    await assert.rejects(as(db, anon, tx => tx.query(`select public.notify_unsubscribe($1)`, [token.replace(".dm.", ".trades.")])), /isn't valid/, "a token is for one type");
    await assert.rejects(as(db, anon, tx => tx.query(`select public.notify_unsubscribe($1)`, [token.replace(BOB, ALICE)])), /isn't valid/, "or one person");
    assert.equal((await rowsT(db, anon, `select public.notify_unsubscribe($1) as k`, [token]))[0]!.k, "dm");
    const s = (await db.query<{ dm: boolean; trades: boolean }>(`select dm, trades from public.notify_settings where user_id = '${BOB}'`)).rows[0]!;
    assert.deepEqual([s.dm, s.trades], [false, true], "only that type");
  });

  test("a failed send is retried once, then given up quietly", async () => {
    const c = await dm();
    await say(user(ALICE), c, "x");
    const [a] = await claim(6);
    await done(Number(a!.id), false, "HTTP 500");
    assert.deepEqual((await queue()).map(x => x.status), ["pending"]);
    assert.deepEqual(await claim(1), [], "retry waits 2 minutes");
    const [b] = await claim(3);
    await done(Number(b!.id), false, "HTTP 500");
    assert.deepEqual((await queue()).map(x => x.status), ["failed"]);
    assert.deepEqual((await db.query<{ status: string; attempt: number }>(`select status, attempt from public.email_log order by id`)).rows, [{ status: "failed", attempt: 1 }, { status: "failed", attempt: 2 }]);
  });

  test("free-tier cap: no more than 95 a day", async () => {
    await db.exec(`insert into public.email_log (user_id, kind, status, at) select '${CAROL}', 'trades', 'sent', '${later(5)}' from generate_series(1, 95)`);   // same day as the claim, whatever the clock
    const c = await dm();
    await say(user(ALICE), c, "x");
    assert.deepEqual(await claim(6), []);
    assert.equal((await queue())[0]!.reason, "free-tier limit");
  });

  test("other types: @mentions (off by default), trades (on), announcements (on), waiver results (off)", async () => {
    await as(db, user(ALICE), tx => tx.query(`insert into public.chat_messages (room_id, body) values ('league', '@Stealers you up?')`));
    assert.deepEqual(await queue(), [], "mentions are off by default");
    await as(db, user(BOB), tx => tx.query(`insert into public.notify_settings (mentions, waivers) values (true, true)`));
    await as(db, user(ALICE), tx => tx.query(`insert into public.chat_messages (room_id, body) values ('league', 'hey @bob, and @Alice is me')`));
    const m = (await queue()).filter(x => x.kind === "mentions");
    assert.deepEqual(m.map(x => x.user_id), [BOB], "Bob by display name; never yourself");
    const [mi] = await claim(2);
    assert.deepEqual([mi!.data.where, mi!.data.from.name, mi!.data.preview], ["Chat", "Alice", "hey @bob, and @Alice is me"]);
    // Trades: the other team's owners on a proposal.
    await db.exec(`insert into public.nfl_players (id, name, position, nfl_team) values ('WR-X', 'X', 'WR', 'NYG');
      insert into public.roster_entries (season, team_id, player_id) values (${S}, '0001', 'WR-X');`);
    await as(db, user(ALICE), tx => tx.query(`select public.trade_propose(${S}, '0001', '0002', '{WR-X}', '{}')`));
    const t = (await queue()).filter(x => x.kind === "trades");
    assert.deepEqual(t.map(x => [x.user_id, x.ref.replace(/\d+/, "N")]), [[BOB, "trade:N:proposed"]]);
    const [ti] = (await claim(2)).filter(x => x.kind === "trades");
    assert.match(ti!.data.summary, /NSFW get nothing; Stealers get X \(WR\)/);
    // Announcements: a commissioner's board cross-post reaches every member but him.
    await as(db, user(COMMISH), tx => tx.query(`select public.board_new_thread('Draft date set', 'Aug 29 at the Legion', '[]', 'announcement:2027-08-01:draft')`));
    assert.deepEqual((await queue()).filter(x => x.kind === "announcements").map(x => x.user_id).sort(), [ALICE, BOB, CAROL].sort());
  });

  test("lineup reminders: starters on bye or out, from 3 hours before the deadline; off unless turned on; not for 2026", async () => {
    await db.exec(`insert into public.season_settings (season, team_count, buy_in, prizes) values (2028, 12, 360, '{}');
      insert into public.nfl_players (id, name, position, nfl_team) values ('WR-BYE', 'Bye Guy', 'WR', 'SEA'), ('RB-OUT', 'Hurt Guy', 'RB', 'NYG');
      insert into public.nfl_games (season, week, game_key, home, away, kickoff) values (2028, 3, 'NYG@MIA', 'MIA', 'NYG', now() + interval '2 hours');
      insert into public.roster_entries (season, team_id, player_id) values (2028, '0002', 'WR-BYE'), (2028, '0002', 'RB-OUT');
      insert into public.lineup_slots (season, week, team_id, slot, player_id) values (2028, 3, '0002', 3, 'WR-BYE'), (2028, 3, '0002', 1, 'RB-OUT');
      insert into public.player_injuries (season, week, player_id, status, source) values (2028, 3, 'RB-OUT', 'Out', 'report');`);
    const run = () => rowsT(db, service, `select private.enqueue_lineup_reminders() as n`).then(r => Number(r[0]!.n));
    assert.equal(await run(), 0, "off by default");
    await as(db, user(BOB), tx => tx.query(`insert into public.notify_settings (lineup) values (true)`));
    assert.equal(await run(), 1);
    assert.equal(await run(), 0, "once per deadline");
    const [item] = await claim(1);
    assert.deepEqual(item!.data.players.map((p: { name: string; problem: string }) => [p.name, p.problem]).sort(), [["Bye Guy", "bye"], ["Hurt Guy", "out"]]);
    await db.exec(`update public.season_settings set notify = '{"lineupReminders": false}' where season = 2028; delete from public.notify_queue`);
    assert.equal(await run(), 0, "the season setting turns them off (2026)");
  });

  test("schedule: the tick calls the function only when something is due", async () => {
    assert.equal((await db.query<{ t: string }>(`select private.notify_tick() as t`)).rows[0]!.t, "idle");
    const c = await dm();
    await say(user(ALICE), c, "x");
    assert.equal((await db.query<{ t: string }>(`select private.notify_tick() as t`)).rows[0]!.t, "idle", "not due for 5 minutes");
    await db.exec(`update public.notify_queue set due_at = now() - interval '1 second'`);
    assert.equal((await db.query<{ t: string }>(`select private.notify_tick() as t`)).rows[0]!.t, "called");
    const call = (await db.query<{ url: string }>(`select url from net.calls order by id desc limit 1`)).rows[0]!;
    assert.match(call.url, /\/functions\/v1\/notify$/);
    await assert.rejects(as(db, user(COMMISH), tx => tx.query(`select * from public.notify_claim()`)), /permission denied/, "only server jobs claim");
  });
});

describe("open lineups and more email types", () => {
  const CAROL = "00000000-0000-0000-0000-0000000000c3";
  const AL = "00000000-0000-0000-0000-0000000000a2";      // Alice's co-owner
  beforeEach(async () => {
    await db.exec(`
      insert into auth.users (id, email, raw_user_meta_data) values ('${CAROL}', 'carol@example.com', '{"display_name":"Carol"}'), ('${AL}', 'al@example.com', '{"display_name":"Al"}');
      insert into public.teams (id, name, division) values ('0003', 'H.N.I.C', 'Gold');
      insert into public.team_managers values ('0003', '${CAROL}'), ('0001', '${AL}');
      update public.profiles set display_name = 'Alice' where id = '${ALICE}';
      update public.profiles set display_name = 'Bob' where id = '${BOB}';
      delete from public.notify_queue;`);
  });
  const later = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
  const claim = (min: number) => rowsT(db, service, `select id, user_id, kind, data from public.notify_claim(25, $1::timestamptz)`, [later(min)]);
  const queue = () => db.query<{ user_id: string; kind: string; ref: string; status: string; reason: string | null; due_at: string }>(`select user_id, kind, ref, status, reason, due_at from public.notify_queue order by id`).then(r => r.rows);
  const settings = (who: Who, cols: string) => as(db, who, async tx => {
    await tx.query(`insert into public.notify_settings (user_id) values (auth.uid()) on conflict (user_id) do nothing`);
    return tx.query(`update public.notify_settings set ${cols}`);
  });
  // Alice's team saves its lineup on the site (one transaction = one save).
  const save = (who: Who, slot: number, player: string) => as(db, who, async tx => {
    await tx.query(`delete from public.lineup_slots where season = ${S} and week = ${W} and team_id = '0001' and slot = ${slot}`);
    return tx.query(`insert into public.lineup_slots (season, week, team_id, slot, player_id) values (${S}, ${W}, '0001', ${slot}, '${player}')`);
  });

  test("lineup status: when each team's lineup was submitted and by whom (names for members only)", async () => {
    await save(user(ALICE), 0, "QB-DET");
    const st = async (who: Who) => (await rowsT(db, who, `select team_id, submitted_at is not null as submitted, submitted_by, starters from public.lineup_status(${S}, ${W}) order by team_id`));
    assert.deepEqual(await st(user(BOB)), [{ team_id: "0001", submitted: true, submitted_by: "Alice", starters: 2 }, { team_id: "0002", submitted: false, submitted_by: null, starters: 1 },
      { team_id: "0003", submitted: false, submitted_by: null, starters: 0 }], "the seeded slots weren't saved on the site: not submitted");
    assert.equal((await st(anon))[0]!.submitted_by, null, "visitors see when, not who");
    assert.equal((await st(anon))[0]!.submitted, true);
  });

  test("my lineup confirmation: both owners, debounced 10 minutes, starters + bench + who saved + warnings", async () => {
    await save(user(ALICE), 0, "QB-DET");
    let q = await queue();
    assert.deepEqual(q.map(x => [x.user_id, x.kind]).sort(), [[ALICE, "lineup_saved"], [AL, "lineup_saved"]], "both owners, the saver too");
    assert.equal(Math.round((Date.parse(q[0]!.due_at) - Date.now()) / 60000), 10);
    await db.exec(`update public.notify_queue set due_at = now() + interval '3 minutes'`);   // as if 7 minutes passed
    await save(user(AL), 0, "QB-DET");
    q = await queue();
    assert.equal(q.length, 2, "another save: still one email each");
    assert.equal(Math.round((Date.parse(q[0]!.due_at) - Date.now()) / 60000), 10, "the 10 minutes start again");
    assert.deepEqual(await claim(5), [], "not while changes keep coming");
    const [item] = (await claim(11)).filter(x => x.user_id === ALICE);
    assert.deepEqual(item!.data.starters.map((s: { slot: string; name: string }) => [s.slot, s.name]), [["QB", "Jared Goff"], ["RB", "Jahmyr Gibbs"]]);
    assert.deepEqual(item!.data.bench.map((b: { name: string }) => b.name), ["Patrick Mahomes"]);
    assert.equal(item!.data.saved_by, "Al");
    // MFL mirror / server jobs never send these.
    await db.exec(`delete from public.notify_queue; insert into public.lineup_slots (season, week, team_id, slot, player_id) values (${S}, ${W}, '0002', 1, 'QB-ARI') on conflict do nothing`);
    assert.deepEqual(await queue(), []);
  });

  test("other teams' lineups: instant (debounced, opponent filter) and digest (9 AM ET on game days, grouped)", async () => {
    await settings(user(BOB), `league_lineups = 'instant'`);
    await settings(user(CAROL), `league_lineups = 'instant', league_lineups_opponent = true`);
    await save(user(ALICE), 0, "QB-DET");
    assert.deepEqual((await queue()).filter(x => x.kind === "league_lineups").map(x => [x.user_id, x.ref]), [[BOB, `linst:${S}:${W}:0001`]], "Carol only wants her opponent (NSFW isn't)");
    const [inst] = (await claim(11)).filter(x => x.kind === "league_lineups");
    assert.equal(inst!.data.mode, "instant");
    assert.deepEqual(inst!.data.teams.map((t: { team: string; by: string }) => [t.team, t.by]), [["NSFW", "Alice"]]);
    // Digest: Bob switches; two teams change; one email at 9 AM ET on the next game day.
    await db.exec(`delete from public.notify_queue`);
    await settings(user(BOB), `league_lineups = 'digest'`);
    await save(user(ALICE), 1, "RB-DET");
    await db.exec(`insert into public.nfl_players (id, name, position, nfl_team) values ('TE-C', 'Carol TE', 'TE', 'DET'); insert into public.roster_entries (season, team_id, player_id) values (${S}, '0003', 'TE-C')`);
    await as(db, user(CAROL), tx => tx.query(`insert into public.lineup_slots (season, week, team_id, slot, player_id) values (${S}, ${W}, '0003', 6, 'TE-C')`));
    assert.deepEqual((await queue()).filter(x => x.kind === "league_lineups"), [], "digest mode: nothing per change");
    const tomorrow9 = (await db.query<{ t: string }>(`select (((now() at time zone 'America/New_York')::date + 1) + time '09:05') at time zone 'America/New_York' as t`)).rows[0]!.t;
    await db.exec(`insert into public.nfl_games (season, week, game_key, home, away, kickoff) values (${S}, ${W + 1}, 'SEA@SF', 'SF', 'SEA', ((((now() at time zone 'America/New_York')::date + 1) + time '13:00') at time zone 'America/New_York'))`);
    const run = (t: string) => rowsT(db, service, `select private.enqueue_lineup_digests($1::timestamptz) as n`, [t]).then(r => Number(r[0]!.n));
    assert.equal(await run(new Date(Date.parse(tomorrow9) - 3 * 3600e3).toISOString()), 0, "6 AM: not yet");
    assert.equal(await run(tomorrow9), 1);
    assert.equal(await run(tomorrow9), 0, "once per digest time");
    const [dg] = await rowsT(db, service, `select data from public.notify_claim(25, $1::timestamptz) where kind = 'league_lineups'`, [new Date(Date.parse(tomorrow9) + 60e3).toISOString()]);
    assert.deepEqual(dg!.data.teams.map((t: { team: string }) => t.team).sort(), ["H.N.I.C", "NSFW"], "both changed teams in one email");
    const at1230 = new Date(Date.parse(tomorrow9) + (3 * 60 + 25) * 60e3).toISOString();   // 12:30 ET = 30 minutes before the 1 PM kickoff
    assert.equal(await run(at1230), 1, "30 minutes before the day's first kickoff");
  });

  test("trades: completed trades league-wide (off by default); proposals stay private", async () => {
    await settings(user(CAROL), `league_trades = true`);
    await db.exec(`insert into public.nfl_players (id, name, position, nfl_team) values ('WR-X', 'X', 'WR', 'NYG');
      insert into public.roster_entries (season, team_id, player_id) values (${S}, '0001', 'WR-X');`);
    const id = Number((await rowsT(db, user(ALICE), `select public.trade_propose(${S}, '0001', '0002', '{WR-X}', '{}') as id`))[0]!.id);
    assert.deepEqual((await queue()).filter(x => x.kind === "league_trades"), [], "a proposal isn't league news");
    await as(db, user(BOB), tx => tx.query(`select public.trade_respond(${id}, true)`));
    await as(db, user(COMMISH), tx => tx.query(`select public.trade_decide(${id}, true)`));
    assert.deepEqual((await queue()).filter(x => x.kind === "league_trades").map(x => x.user_id), [CAROL]);
  });

  test("waivers: my results on by default; league-wide results and hourly first-come moves digests are opt-in", async () => {
    await settings(user(CAROL), `league_waivers = true, league_moves = true`);
    await db.exec(`insert into public.waiver_runs (season, cycle, kind, team_order) values (2028, now(), 'forced', '{0001}')`);
    assert.deepEqual((await queue()).map(x => [x.user_id, x.kind]), [[CAROL, "league_waivers"]]);
    await db.exec(`insert into public.transactions (season, team_id, type, status, players_in, via) values (2028, '0002', 'add', 'processed', '{QB-FA}', 'free_agent'),
      (2028, '0001', 'drop', 'processed', '{}', 'mfl')`);
    const mv = (await queue()).filter(x => x.kind === "league_moves");
    assert.equal(mv.length, 1, "one hourly digest; MFL imports never");
    assert.equal(new Date(mv[0]!.due_at).getUTCMinutes(), 0, "due at the top of the next hour");
    const [m] = (await rowsT(db, service, `select kind, data from public.notify_claim(25, now() + interval '61 minutes')`)).filter(x => x.kind === "league_moves");
    assert.deepEqual(m!.data.moves, [{ team: "Stealers", added: "Free Agent", dropped: null }]);
  });

  test("daily scoring update: only after a day with games, once per day, with matchups, leader and corrections", async () => {
    await settings(user(BOB), `scoring = true`);
    const enq = (t: string) => rowsT(db, service, `select public.enqueue_scoring_update($1::timestamptz) as n`, [t]).then(r => Number(r[0]!.n));
    const day = (offsetDays: number, hhmm: string) => db.query<{ t: string }>(`select (((now() at time zone 'America/New_York')::date + ${offsetDays}) + time '${hhmm}') at time zone 'America/New_York' as t`).then(r => r.rows[0]!.t);
    await db.exec(`delete from public.nfl_games; insert into public.nfl_games (season, week, game_key, home, away, kickoff) values
      (${S}, ${W}, 'KC@LV', 'LV', 'KC', ((((now() at time zone 'America/New_York')::date - 1) + time '20:15') at time zone 'America/New_York'));
      insert into public.matchups (season, week, home_team, away_team, home_score, away_score) values (${S}, ${W}, '0001', '0002', 90, 80);
      insert into public.team_scores (season, week, team_id, points, status) values (${S}, ${W}, '0001', 90, 'live'), (${S}, ${W}, '0002', 80, 'live');`);
    assert.equal(await enq(await day(1, "05:17")), 0, "the day before had no games");
    assert.equal(await enq(await day(0, "05:17")), 1, "yesterday had a game: Bob gets one");
    assert.equal(await enq(await day(0, "06:17")), 0, "once per game day");
    const [s] = await rowsT(db, service, `select data from public.notify_claim(25, $1::timestamptz) where kind = 'scoring'`, [await day(0, "05:18")]);
    assert.equal(s!.data.unofficial, true);
    assert.deepEqual(s!.data.mine, { team: "Stealers", us: 80, opp: "NSFW", them: 90 });
    assert.deepEqual(s!.data.high, { team: "NSFW", points: 90 });
    await db.exec(`update public.notify_queue set status = 'sent' where kind = 'scoring'`);
    // A stat correction flips the game: the next update says so.
    await db.exec(`update public.matchups set away_score = 95; insert into public.nfl_games (season, week, game_key, home, away, kickoff) values
      (${S}, ${W}, 'BUF@MIA', 'MIA', 'BUF', (((now() at time zone 'America/New_York')::date + time '13:00') at time zone 'America/New_York'))`);
    assert.equal(await enq(await day(1, "05:17")), 1);
    const [s2] = await rowsT(db, service, `select data from public.notify_claim(25, $1::timestamptz) where kind = 'scoring'`, [await day(1, "05:18")]);
    assert.deepEqual(s2!.data.corrections, [{ game: "0002-0001", was: "NSFW", now: "Stealers" }]);
  });

  test("priority under the daily cap: DMs, trades and commissioner messages first; lineup and scoring emails stop earlier", async () => {
    await settings(user(BOB), `scoring = true`);
    await db.exec(`insert into public.email_log (user_id, kind, status) select '${CAROL}', 'trades', 'sent' from generate_series(1, 75)`);
    await db.exec(`insert into public.notify_queue (user_id, kind, ref, due_at) values
      ('${BOB}', 'scoring', 'score:2026-10-25', now() - interval '3 minutes'),
      ('${BOB}', 'lineup_saved', 'lsaved:${S}:${W}:0002', now() - interval '2 minutes'),
      ('${BOB}', 'announcements', 'ann:1', now() - interval '1 minute')`);
    const got = await rowsT(db, service, `select kind from public.notify_claim(25, now())`);
    assert.deepEqual(got.map(x => x.kind), ["announcements"], "the newest item, but highest priority, goes first");
    assert.deepEqual((await queue()).map(x => [x.kind, x.status, x.reason]), [["scoring", "skipped", "free-tier limit"], ["lineup_saved", "skipped", "free-tier limit"], ["announcements", "sending", null]],
      "75 sent today: lineup emails (stop at 75) and scoring (stop at 60) are held back; commissioner messages may use up to 95");
  });

  test("commissioner: email a team its lineup; remind teams that haven't submitted (audited, commissioner only)", async () => {
    await save(user(ALICE), 0, "QB-DET");
    await db.exec(`delete from public.notify_queue`);
    await assert.rejects(as(db, user(ALICE), tx => tx.query(`select public.commish_email_lineup(${S}, ${W}, '0002')`)), /Only the commissioner/);
    assert.equal(Number((await rowsT(db, user(COMMISH), `select public.commish_email_lineup(${S}, ${W}, '0002') as n`))[0]!.n), 1);
    assert.equal(Number((await rowsT(db, user(COMMISH), `select public.commish_lineup_reminders(${S}, ${W}) as n`))[0]!.n), 2, "Stealers (Bob) and H.N.I.C (Carol); NSFW submitted");
    const q = await queue();
    assert.deepEqual(q.map(x => [x.user_id, x.ref.split(":")[0]]).sort(), [[BOB, "clineup"], [BOB, "cremind"], [CAROL, "cremind"]].sort());
    const items = await claim(1);
    assert.equal(items.find(x => x.data.commissioner === "lineup")!.data.starters[0].name, "Kyler Murray");
    assert.equal(items.find(x => x.data.commissioner === "reminder" && x.user_id === CAROL)!.data.team, "H.N.I.C");
    assert.deepEqual((await db.query<{ action: string }>(`select action from public.audit_log where action like 'notify:%' order by id`)).rows.map(r => r.action), ["notify:lineup_email", "notify:lineup_reminder"]);
  });

  test("unsubscribe works for the new types (other teams' lineups -> off)", async () => {
    await settings(user(BOB), `league_lineups = 'digest'`);
    const tok = (await db.query<{ t: string }>(`select private.notify_token('${BOB}', 'league_lineups') as t`)).rows[0]!.t;
    assert.equal((await rowsT(db, anon, `select public.notify_unsubscribe($1) as k`, [tok]))[0]!.k, "league_lineups");
    assert.equal((await db.query<{ v: string }>(`select league_lineups as v from public.notify_settings where user_id = '${BOB}'`)).rows[0]!.v, "off");
  });
});

describe("roles: administrator and commissioner", () => {
  const ADMIN = "00000000-0000-0000-0000-0000000000ad";   // administrator only, no team
  const COM2 = "00000000-0000-0000-0000-0000000000c2";    // commissioner only, no team
  const T = 2028;
  beforeEach(async () => {
    await db.exec(`
      insert into auth.users (id, email, raw_user_meta_data) values ('${ADMIN}', 'admin@example.com', '{"display_name":"Ada"}'), ('${COM2}', 'com2@example.com', '{"display_name":"Cy"}');
      update public.profiles set is_admin = true where id = '${ADMIN}';
      update public.profiles set is_commissioner = true where id = '${COM2}';
      delete from public.notify_queue;`);
  });
  const roles = (u: string) => db.query<{ role: string }>(`select role from public.user_roles where user_id = '${u}' order by role`).then(r => r.rows.map(x => x.role));
  const call = (who: Who, sql: string) => rowsT(db, who, sql);

  test("the league's account holds both roles; the profile flags mirror the roles", async () => {
    assert.deepEqual(await roles(COMMISH), ["admin", "commissioner"]);
    const p = (await db.query<{ is_commissioner: boolean; is_admin: boolean }>(`select is_commissioner, is_admin from public.profiles where id = '${COMMISH}'`)).rows[0]!;
    assert.deepEqual([p.is_commissioner, p.is_admin], [true, true]);
    assert.deepEqual(await roles(ALICE), [], "nobody else changed");
    assert.equal((await call(user(ALICE), `select user_id, role from public.user_roles`)).length, 4, "signed-in users see the officers (badges)");
    await denied(db, anon, `select * from public.user_roles`, /permission denied/);
  });

  test("an administrator keeps the site running but can't change scores, money, rosters or league settings", async () => {
    // Technical: health, audit log, email log, keep-alive, pool import, flags, modes.
    assert.ok((await call(user(ADMIN), `select public.admin_health() as h`))[0]!.h.flags.email_notifications);
    await db.exec(`insert into public.email_log (user_id, kind, ref, status) values ('${ALICE}', 'dm', 'conv:1', 'sent')`);
    assert.equal((await call(user(ADMIN), `select * from public.email_log`)).length, 1);
    assert.ok((await call(user(ADMIN), `select * from public.audit_log`)).length >= 1);
    assert.ok((await call(user(ADMIN), `select public.keepalive_status() as k`))[0]!.k);
    assert.equal((await call(user(ADMIN), `select user_id, email from public.admin_accounts() where user_id = '${ALICE}'`))[0]!.email, "alice@example.com");
    await db.exec(`insert into public.season_settings (season, team_count, buy_in, prizes, trades) values (${T}, 12, 360, '{}', '{"live": false}')`);
    assert.equal((await call(user(ADMIN), `select public.admin_set_mode(${T}, 'trades.live', 'true') as r`))[0]!.r, "trades.live = true");
    assert.equal((await db.query<{ v: boolean }>(`select (trades ->> 'live')::boolean as v from public.season_settings where season = ${T}`)).rows[0]!.v, true);
    assert.equal(await affected(db, user(ADMIN), `update public.feature_flags set enabled = false where key = 'email_notifications'`), 1);
    assert.equal((await db.query<{ t: string }>(`select private.notify_tick() as t`)).rows[0]!.t, "off", "the kill switch stops email");
    // League: nothing.
    assert.equal(await affected(db, user(ADMIN), `update public.standings set wins = 9`), 0);
    await denied(db, user(ADMIN), `insert into public.score_overrides (season, week, target_key, type, points, reason) values (${S}, ${W}, 'DEF:PHI', 'points', 10, 'x')`);
    await denied(db, user(ADMIN), `insert into public.team_fees (season, team_id, amount_due) values (${S}, '0001', 360)`);
    await denied(db, user(ADMIN), `insert into public.roster_entries (season, team_id, player_id) values (${S}, '0001', 'QB-FA')`, /row-level|permission/);
    assert.equal(await affected(db, user(ADMIN), `update public.season_settings set buy_in = 1 where season = ${T}`), 0, "league settings are the commissioner's");
    await assert.rejects(as(db, user(ADMIN), tx => tx.query(`select public.trade_decide(1, true)`)), /Only the commissioner/);
    await assert.rejects(as(db, user(ADMIN), tx => tx.query(`select public.grant_role('${BOB}', 'commissioner')`)), /Only a commissioner/);
    await denied(db, user(ADMIN), `insert into public.invites (email) values ('new@example.com')`);
  });

  test("a commissioner runs the league but sees only email status, not the log; can't flip season modes", async () => {
    await db.exec(`insert into public.email_log (user_id, kind, ref, status) values ('${ALICE}', 'dm', 'conv:1', 'sent');
      insert into public.season_settings (season, team_count, buy_in, prizes, trades) values (${T}, 12, 360, '{}', '{"live": false}')`);
    assert.deepEqual(await call(user(COM2), `select * from public.email_log`), [], "no log rows");
    assert.equal((await call(user(COM2), `select today from public.notify_usage() where priority = 1`))[0]!.today, 1, "but today's counts");
    await assert.rejects(as(db, user(COM2), tx => tx.query(`select public.admin_health()`)), /Administrators only/);
    assert.deepEqual(await call(user(COM2), `select * from public.audit_log`), []);
    await assert.rejects(as(db, user(COM2), tx => tx.query(`update public.season_settings set trades = '{"live": true}' where season = ${T}`)), /changed by an administrator/);
    assert.equal(await affected(db, user(COM2), `update public.season_settings set buy_in = 400 where season = ${T}`), 1, "league settings: yes");
    assert.equal(await affected(db, user(COM2), `update public.standings set wins = 9 where team_id = '0001'`), 1);
    await assert.rejects(as(db, user(COM2), tx => tx.query(`select public.run_pool_import()`)), /Only an administrator/);
  });

  test("neither role reads private DMs (only reported ones, and only commissioners)", async () => {
    const c = Number((await call(user(ALICE), `select public.dm_open('${BOB}'::uuid, null) as id`))[0]!.id);
    await as(db, user(ALICE), tx => tx.query(`insert into public.dm_messages (conversation_id, body) values (${c}, 'private')`));
    for (const u of [COMMISH, ADMIN, COM2]) assert.deepEqual(await call(user(u), `select body from public.dm_messages`), [], u);
    await as(db, user(BOB), tx => tx.query(`select public.dm_report(${c}, 'x')`));
    assert.equal((await call(user(COM2), `select body from public.dm_messages`)).length, 2, "reported: commissioners");
    assert.deepEqual(await call(user(ADMIN), `select body from public.dm_messages`), [], "administrators still don't");
  });

  test("granting and revoking: each role manages its own; always one of each; audited and emailed", async () => {
    assert.equal((await call(user(COM2), `select public.grant_role('${BOB}', 'commissioner') as r`))[0]!.r, "Granted");
    await assert.rejects(as(db, user(COM2), tx => tx.query(`select public.grant_role('${BOB}', 'admin')`)), /Only an administrator/);
    assert.equal((await call(user(ADMIN), `select public.grant_role('${BOB}', 'admin') as r`))[0]!.r, "Granted");
    assert.deepEqual(await roles(BOB), ["admin", "commissioner"]);
    const a = (await db.query<{ action: string }>(`select action from public.audit_log where action like 'roles:%' and details ->> 'user' = '${BOB}' order by id`)).rows.map(r => r.action);
    assert.deepEqual(a, ["roles:grant", "roles:grant"]);
    const q = (await db.query<{ kind: string; payload: { role: string; action: string; by: string } }>(`select kind, payload from public.notify_queue where user_id = '${BOB}' order by id`)).rows;
    assert.deepEqual(q.map(x => [x.kind, x.payload.role, x.payload.action, x.payload.by]), [["account", "commissioner", "grant", "Cy"], ["account", "admin", "grant", "Ada"]]);
    // Co-owners don't inherit roles.
    const AL = "00000000-0000-0000-0000-0000000000a2";
    await db.exec(`insert into auth.users (id, email) values ('${AL}', 'al@example.com'); insert into public.team_managers values ('0002', '${AL}')`);
    assert.deepEqual(await roles(AL), []);
    // Last of each: revoke down to one, then refused.
    await call(user(ADMIN), `select public.revoke_role('${BOB}', 'admin')`);
    await call(user(ADMIN), `select public.revoke_role('${COMMISH}', 'admin')`);
    await assert.rejects(as(db, user(ADMIN), tx => tx.query(`select public.revoke_role('${ADMIN}', 'admin')`)), /at least one administrator/);
    await call(user(COM2), `select public.revoke_role('${BOB}', 'commissioner')`);
    await call(user(COM2), `select public.revoke_role('${COMMISH}', 'commissioner')`);
    await assert.rejects(as(db, user(COM2), tx => tx.query(`select public.revoke_role('${COM2}', 'commissioner')`)), /at least one commissioner/);
    await assert.rejects(as(db, user(ADMIN), tx => tx.query(`select public.admin_set_disabled('${COM2}', true)`)), /last active commissioner/, "disabling the last one is refused too");
    // The old direct flag is now a grant with the same rules.
    await assert.rejects(as(db, user(COM2), tx => tx.query(`update public.profiles set is_commissioner = false where id = '${COM2}'`)), /at least one commissioner/);
    await denied(db, user(ALICE), `update public.profiles set is_admin = true where id = '${ALICE}'`, /Only an administrator/);
  });

  test("a disabled account keeps its data but loses its team rights and powers; admins re-enable it", async () => {
    await assert.rejects(as(db, user(COM2), tx => tx.query(`select public.admin_set_disabled('${ALICE}', true)`)), /Administrators only/);
    assert.equal((await call(user(ADMIN), `select public.admin_set_disabled('${ALICE}', true) as r`))[0]!.r, "Disabled");
    await denied(db, user(ALICE), `insert into public.lineup_slots (season, week, team_id, slot, player_id) values (${S}, ${W}, '0001', 0, 'QB-DET')`);
    assert.deepEqual(await call(user(ALICE), `select id from public.board_threads`), []);
    assert.equal((await db.query<{ m: boolean }>(`select '${ALICE}' in (select private.member_ids()) as m`)).rows[0]!.m, false, "no emails either");
    await call(user(ADMIN), `select public.admin_set_disabled('${ALICE}', false)`);
    assert.equal(await affected(db, user(ALICE), `insert into public.lineup_slots (season, week, team_id, slot, player_id) values (${S}, ${W}, '0001', 0, 'QB-DET')`), 1);
    assert.deepEqual((await db.query<{ action: string }>(`select action from public.audit_log where action in ('admin:disable', 'admin:enable') order by id`)).rows.map(r => r.action), ["admin:disable", "admin:enable"]);
    await denied(db, user(ALICE), `update public.profiles set disabled = true where id = '${ALICE}'`, /Admin page/);
  });

  describe("conflict of interest: actions on the commissioner's own team", () => {
    beforeEach(async () => {
      await db.exec(`
        insert into public.teams (id, name, division) values ('0004', 'Mac Daddies', 'Black');
        insert into public.team_managers values ('0004', '${COMMISH}');
        insert into public.nfl_players (id, name, position, nfl_team) values ('WR-MD', 'Mac WR', 'WR', 'NYG'), ('WR-ST', 'Steel WR', 'WR', 'NYG');
        insert into public.season_settings (season, team_count, buy_in, prizes, waivers, trades) values (${T}, 12, 360, '{}', '{"live": true}', '{"live": true}');
        insert into public.nfl_games (season, week, game_key, home, away, kickoff) values (${T}, 1, 'NYG@MIA', 'MIA', 'NYG', now() + interval '2 days');
        insert into public.roster_entries (season, team_id, player_id) values (${T}, '0004', 'WR-MD'), (${T}, '0002', 'WR-ST');`);
    });
    const acceptedTrade = async () => {
      const id = Number((await call(user(COMMISH), `select public.trade_propose(${T}, '0004', '0002', '{WR-MD}', '{WR-ST}') as id`))[0]!.id);
      await as(db, user(BOB), tx => tx.query(`select public.trade_respond(${id}, true)`));
      return id;
    };
    const status = (id: number) => db.query<{ status: string }>(`select status from public.trades where id = ${id}`).then(r => r.rows[0]!.status);

    test("trade approval: another commissioner must approve; the requester can't approve his own request", async () => {
      const id = await acceptedTrade();
      const msg = (await call(user(COMMISH), `select public.trade_decide(${id}, true, 'fair') as r`))[0]!.r;
      assert.match(msg, /sent to another commissioner for approval \(request #\d+\)/);
      assert.equal(await status(id), "accepted", "nothing happens yet");
      const [req] = await call(user(COM2), `select id, action, status, summary from public.officer_requests`);
      assert.equal(req!.action, "trade_decide");
      assert.deepEqual(await call(user(ALICE), `select id from public.officer_requests`), [], "commissioners only");
      await assert.rejects(as(db, user(COMMISH), tx => tx.query(`select public.decide_officer_request(${req!.id}, true)`)), /Another commissioner/);
      assert.equal((await call(user(COM2), `select public.decide_officer_request(${req!.id}, true, 'ok') as r`))[0]!.r, "Approved and done");
      assert.equal(await status(id), "approved");
      assert.deepEqual((await db.query<{ action: string }>(`select action from public.audit_log where action like 'coi:%' order by id`)).rows.map(r => r.action), ["coi:request", "coi:approved"]);
    });

    test("with no other commissioner: allowed, flagged in the audit log and on the Board", async () => {
      await db.exec(`delete from public.user_roles where user_id = '${COM2}'`);
      const id = await acceptedTrade();
      assert.match((await call(user(COMMISH), `select public.trade_decide(${id}, true) as r`))[0]!.r, /flagged in the audit log and on the Board/);
      assert.equal(await status(id), "approved");
      const [a] = (await db.query<{ id: number; details: { flag: string } }>(`select id, details from public.audit_log where action = 'coi:own_team_unreviewed'`)).rows;
      assert.match(a!.details.flag, /No other commissioner/);
      assert.equal((await db.query(`select 1 from public.board_threads where source_key = 'coi:${a!.id}' and is_bot`)).rows.length, 1);
    });

    test("score override and drop reversal on his own team wait for another commissioner", async () => {
      assert.equal(await affected(db, user(COMMISH), `insert into public.score_overrides (season, week, target_key, type, points, reason) values (${T}, 1, 'nflverse:WR-MD', 'points', 30, 'stat fix')`), 0, "held back");
      const [req] = await call(user(COM2), `select id, action from public.officer_requests where status = 'pending'`);
      assert.equal(req!.action, "score_override");
      await call(user(COM2), `select public.decide_officer_request(${req!.id}, true)`);
      assert.equal((await db.query(`select 1 from public.score_overrides where target_key = 'nflverse:WR-MD'`)).rows.length, 1, "written once approved");
      assert.equal(await affected(db, user(COMMISH), `insert into public.score_overrides (season, week, target_key, type, points, reason) values (${T}, 1, 'nflverse:WR-ST', 'points', 1, 'not his')`), 1, "other teams: as before");
      // Drop reversal of his own drop.
      await db.exec(`insert into public.transactions (season, team_id, type, status, players_out, via, created_by) values (${T}, '0004', 'drop', 'processed', '{WR-MD}', 'free_agent', '${COMMISH}');
        delete from public.roster_entries where player_id = 'WR-MD'`);
      const drop = Number((await db.query<{ id: number }>(`select id from public.transactions where '{WR-MD}' = players_out`)).rows[0]!.id);
      assert.match((await call(user(COMMISH), `select public.reverse_drop(${drop}) as r`))[0]!.r, /sent to another commissioner/);
      const [r2] = await call(user(COM2), `select id from public.officer_requests where action = 'reverse_drop' and status = 'pending'`);
      await call(user(COM2), `select public.decide_officer_request(${r2!.id}, true)`);
      assert.equal((await db.query<{ status: string }>(`select status from public.transactions where id = ${drop}`)).rows[0]!.status, "reversed");
    });
  });
});

describe("server jobs (service_role)", () => {
  test("bypass RLS and can touch the heartbeat; nobody else can", async () => {
    assert.equal(await affected(db, service, `insert into public.heartbeats (name) values ('nightly') on conflict (name) do update set at = now()`), 1);
    assert.equal(await affected(db, service, `update public.standings set wins = 1`), 2);
    await denied(db, user(COMMISH), `select * from public.heartbeats`, /permission denied/);
  });
});

describe("test lineups (2026 test mode)", () => {
  // NSFW (0001, Alice): DET plays later this week (DET@ARI), KC already kicked off (KC@LV).
  const save = (who: Who, players: (string | null)[], team = "0001", week = W) =>
    as(db, who, tx => tx.query<{ r: { saved_by: string } }>(`select public.save_test_lineup($1, $2, $3, $4::text[]) as r`, [S, week, team, players])).then(r => r.rows[0]!.r);
  // QB RB RB WR WR WR TE K DEF, everyone on DET (not started)
  const FULL = ["QB-DET", "RB-DET", "RB-DET2", "WR-DET", "WR-DET2", "WR-DET3", "TE-DET", "K-DET", "DEF:DET"];
  const stored = () => db.query<{ players: string[]; status: string }>(`select players, status from public.test_lineups where team_id = '0001'`).then(r => r.rows);
  beforeEach(async () => {
    await db.exec(`
      insert into public.season_settings (season, team_count, buy_in, prizes, pools) values (${S}, 12, 360, '{}', '{"mode": "test"}');
      update public.profiles set display_name = 'Mike' where id = '${ALICE}';
      insert into public.nfl_players (id, name, position, nfl_team) values
        ('RB-DET2', 'David Montgomery', 'RB', 'DET'), ('WR-DET', 'Amon-Ra St. Brown', 'WR', 'DET'), ('WR-DET2', 'Jameson Williams', 'WR', 'DET'),
        ('WR-DET3', 'Kalif Raymond', 'WR', 'DET'), ('TE-DET', 'Sam LaPorta', 'TE', 'DET'), ('K-DET', 'Jake Bates', 'K', 'DET'),
        ('DEF:DET', 'Lions', 'DEF', 'DET'), ('WR-KC', 'Rashee Rice', 'WR', 'KC'), ('RB-KC', 'Isiah Pacheco', 'RB', 'KC'), ('WR-BYE', 'Puka Nacua', 'WR', 'LAR');
      insert into public.roster_entries (season, team_id, player_id) values
        (${S}, '0001', 'RB-DET2'), (${S}, '0001', 'WR-DET'), (${S}, '0001', 'WR-DET2'), (${S}, '0001', 'WR-DET3'), (${S}, '0001', 'TE-DET'),
        (${S}, '0001', 'K-DET'), (${S}, '0001', 'DEF:DET'), (${S}, '0001', 'WR-KC'), (${S}, '0001', 'RB-KC'), (${S}, '0001', 'WR-BYE');`);
  });

  test("partial lineups are allowed by default (league setting): empty slots score 0", async () => {
    const partial = [...FULL.slice(0, 6), null, "K-DET", null];
    const r = await save(user(ALICE), partial);
    assert.equal(r.saved_by, "Mike");
    assert.deepEqual(await stored(), [{ players: partial, status: "test" }]);
    assert.equal((await rowsT(db, anon, `select public.lineup_rules(${S}) as r`))[0]!.r.allow_partial, true);
    await assert.rejects(save(user(ALICE), FULL.slice(0, 8)), /9 slots/, "still 9 slots, some may be empty");
    // Empty slots score 0: QB-DET's 21.5 (seed) + WR-DET 10; the empty TE and DEF add nothing
    await db.exec(`insert into public.player_scores (season, week, player_id, points, source) values (${S}, ${W}, 'WR-DET', 10, 'live')`);
    const sc = (await rowsT(db, anon, `select test_points::float as t from public.test_lineup_scores(${S}, ${W}) where team_id = '0001'`))[0]!;
    assert.equal(sc.t, 31.5);
    // The confirmation email names the empty slots
    const d = (await db.query<{ d: { empty: string[] } }>(`select private.test_lineup_payload(${S}, ${W}, '0001') as d`)).rows[0]!.d;
    assert.deepEqual(d.empty, ["TE", "DEF"]);
  });

  test("the commissioner can turn partial lineups off (audited); a season setting overrides the league's", async () => {
    await denied(db, user(ALICE), `update public.league_settings set allow_partial_lineups = false`, /.*/).catch(() => {});
    assert.equal(await affected(db, user(ALICE), `update public.league_settings set allow_partial_lineups = false`), 0, "managers can't change it");
    assert.equal(await affected(db, user(COMMISH), `update public.league_settings set allow_partial_lineups = false`), 1);
    assert.equal((await rowsT(db, anon, `select count(*)::int as n from public.audit_log where action = 'settings:allow_partial_lineups'`).catch(() => [{ n: -1 }]))[0]!.n !== 0, true);
    await assert.rejects(save(user(ALICE), [...FULL.slice(0, 6), null, "K-DET", null]), /Fill every slot before saving: missing TE, DEF/);
    await assert.rejects(as(db, user(ALICE), tx => tx.query(`select public.save_lineup(${S}, ${W}, '0001', array['QB-DET',null,null,null,null,null,null,null,null])`)),
      /Fill every slot before saving: missing RB, RB, WR, WR, WR, TE, K, DEF/, "2027's save_lineup follows the same setting");
    await db.exec(`update public.season_settings set lineups = '{"allowPartial": true}'`);
    await save(user(ALICE), [...FULL.slice(0, 8), null]);
  });

  test("with empty slots allowed, locks still hold: bench an unstarted starter; fill a slot only with an unstarted player", async () => {
    await db.exec(`insert into public.lineup_slots (season, week, team_id, slot, player_id) values (${S}, ${W}, '0001', 3, 'WR-KC')`);
    const withKC = [...FULL.slice(0, 3), "WR-KC", ...FULL.slice(4)];
    await save(user(ALICE), withKC);
    // An unstarted starter (TE-DET) goes to the bench, leaving the slot empty
    await save(user(ALICE), [...withKC.slice(0, 6), null, ...withKC.slice(7)]);
    // A started starter can't be emptied out
    await assert.rejects(save(user(ALICE), [...FULL.slice(0, 3), null, ...FULL.slice(4, 6), null, ...FULL.slice(7)]), /Rashee Rice is locked in the WR slot/);
    // An empty slot can't be filled with a player whose game has started; leaving it empty is fine
    await assert.rejects(save(user(ALICE), [FULL[0]!, "RB-KC", ...withKC.slice(2, 6), null, ...withKC.slice(7)]), /Isiah Pacheco can't move into the lineup/);
    // Every TE has kicked off (none unstarted): the slot stays empty and the save still works
    await db.exec(`update public.nfl_players set nfl_team = 'KC' where id = 'TE-DET'`);
    await assert.rejects(save(user(ALICE), withKC), /Sam LaPorta can't move into the lineup/);
    await save(user(ALICE), [...withKC.slice(0, 6), null, ...withKC.slice(7)]);
  });

  test("roster, position and duplicate rules", async () => {
    await assert.rejects(save(user(ALICE), ["QB-ARI", ...FULL.slice(1)]), /isn't on your roster/);
    await assert.rejects(save(user(ALICE), ["RB-KC", ...FULL.slice(1)]), /Isiah Pacheco \(RB\) can't play QB/);
    await assert.rejects(save(user(ALICE), [FULL[0]!, "RB-DET", "RB-DET", ...FULL.slice(3)]), /only start once/);
  });

  test("kickoff lock on the server: a started starter stays in his slot; a started bench player can't move in; others move until kickoff", async () => {
    // The official (MFL) lineup has WR-KC starting in slot 3; his game has started.
    await db.exec(`insert into public.lineup_slots (season, week, team_id, slot, player_id) values (${S}, ${W}, '0001', 3, 'WR-KC')`);
    const withKC = [...FULL.slice(0, 3), "WR-KC", ...FULL.slice(4)];
    await assert.rejects(save(user(ALICE), FULL), /Rashee Rice is locked in the WR slot: his game has started/, "benching him");
    await assert.rejects(save(user(ALICE), [...FULL.slice(0, 3), "WR-DET", "WR-KC", ...FULL.slice(5)]), /locked in the WR slot/, "moving him to another slot");
    await save(user(ALICE), withKC);                                   // he stays; everyone else changes freely
    const swapped = [FULL[0]!, "RB-DET2", "RB-DET", ...withKC.slice(3)];
    await save(user(ALICE), swapped);                                  // swap two players whose games haven't started
    // A bench player whose game has started can't come in (RB-KC)
    await assert.rejects(save(user(ALICE), [FULL[0]!, "RB-KC", ...withKC.slice(2)]), /Isiah Pacheco can't move into the lineup: his game has started/);
    // Once DET kicks off, the DET starters are locked too (a request after kickoff is refused)
    await db.exec(`update public.nfl_games set kickoff = now() - interval '1 minute' where game_key = 'DET@ARI'`);
    await assert.rejects(save(user(ALICE), withKC), /locked/);
    assert.deepEqual((await stored())[0]!.players, swapped, "refused saves change nothing");
    // Direct writes are impossible: the table is written only by the function
    await denied(db, user(ALICE), `update public.test_lineups set players = '{}'`, /permission denied/);
    await denied(db, user(ALICE), `insert into public.test_lineups (season, week, team_id, players) values (${S}, ${W}, '0001', '{a,b,c,d,e,f,g,h,i}')`, /permission denied/);
  });

  test("who may save; test mode only; the next week opens after Tuesday's import; lineups are public", async () => {
    await assert.rejects(save(user(BOB), FULL), /own team/);
    await denied(db, anon, `select public.save_test_lineup(${S}, ${W}, '0001', array['QB-DET'])`, /permission denied/);
    await save(user(COMMISH), FULL);                                   // a commissioner can set any team
    assert.equal((await rowsT(db, anon, `select * from public.test_lineups`)).length, 1, "lineups stay visible to everyone");
    const slots = await rowsT(db, anon, `select slot, player_id, status, saved_by from public.test_lineup_slots(${S}, ${W})`);
    assert.equal(slots.length, 9);
    assert.equal(slots[0]!.saved_by, null, "who saved it is for members");
    assert.equal((await rowsT(db, user(BOB), `select saved_by from public.test_lineup_slots(${S}, ${W})`))[0]!.saved_by, "Commish");
    // The previous week ended 30 hours ago and its official lineups aren't imported yet: closed
    await db.exec(`insert into public.nfl_games (season, week, game_key, home, away, kickoff) values (${S}, ${W - 1}, 'A@B', 'B', 'A', now() - interval '30 hours')`);
    await assert.rejects(save(user(ALICE), FULL), /opens after Tuesday's import of the official week 5 lineups/);
    assert.equal((await rowsT(db, anon, `select public.test_lineup_week(${S}) as w`))[0]!.w.open, false);
    await db.exec(`insert into public.lineup_imports (season, week, status, succeeded_at) values (${S}, ${W - 1}, 'ok', now())`);
    await save(user(ALICE), FULL);
    assert.deepEqual((await rowsT(db, anon, `select public.test_lineup_week(${S}) as w`))[0]!.w, { week: W, open: true, reason: null, test_mode: true });
    // 2027: test mode off
    await db.exec(`update public.season_settings set pools = '{"mode": "official"}'`);
    await assert.rejects(save(user(ALICE), FULL), /only for a test season/);
  });

  test("Tuesday swap: official lineups replace the test ones (server jobs only); scores use the official lineups; test vs official", async () => {
    await save(user(ALICE), FULL);
    await db.exec(`
      insert into public.matchups (season, week, home_team, away_team, home_score, away_score) values (${S}, ${W}, '0001', '0002', 0, 0);
      insert into public.score_weeks (season, week, status) values (${S}, ${W}, 'pending_review');
      insert into public.player_scores (season, week, player_id, points, source) values
        (${S}, ${W}, 'WR-DET', 10, 'final'), (${S}, ${W}, 'WR-KC', 4, 'final'), (${S}, ${W}, 'RB-DET', 7, 'final'), (${S}, ${W}, 'QB-ARI', 30, 'final')
        on conflict (season, week, player_id) do update set points = excluded.points;`);
    // QB-DET already scored 21.5 in the seed: test lineup = 21.5 + 7 + 10 = 38.5
    const official = JSON.stringify([{ team_id: "0001", slot: 0, player_id: "QB-KC" }, { team_id: "0001", slot: 1, player_id: "RB-DET" }, { team_id: "0001", slot: 3, player_id: "WR-KC" },
      { team_id: "0002", slot: 0, player_id: "QB-ARI" }]);
    await denied(db, user(COMMISH), `select public.replace_week_lineups(${S}, ${W}, '${official}'::jsonb)`, /permission denied/);
    await denied(db, user(ALICE), `select public.replace_week_lineups(${S}, ${W}, '${official}'::jsonb)`, /permission denied/);
    const r = (await rowsT(db, service, `select public.replace_week_lineups(${S}, ${W}, '${official}'::jsonb) as r`))[0]!.r;
    assert.equal(r.archived_test, 1);
    assert.deepEqual((await rowsT(db, anon, `select team_id, slot, player_id from public.lineup_slots where week = ${W} order by team_id, slot`)).map(x => `${x.team_id}:${x.slot}:${x.player_id}`),
      ["0001:0:QB-KC", "0001:1:RB-DET", "0001:3:WR-KC", "0002:0:QB-ARI"], "the official lineups replaced the mirror");
    assert.deepEqual(await stored(), [{ players: FULL, status: "archived" }], "the test lineup is kept next to the official one");
    // Official totals only: 0001 = 7 + 4 (QB-KC has no score) = 11; 0002 = 30
    const m = (await rowsT(db, anon, `select home_score, away_score from public.matchups where week = ${W}`))[0]!;
    assert.deepEqual([Number(m.home_score), Number(m.away_score)], [11, 30]);
    assert.deepEqual((await rowsT(db, anon, `select team_id, points::float as p from public.team_scores where week = ${W} order by team_id`)).map(x => [x.team_id, x.p]), [["0001", 11], ["0002", 30]]);
    const cmp = await rowsT(db, anon, `select team_id, test_points::float as t, official_points::float as o, has_test from public.test_lineup_scores(${S}, ${W})`);
    assert.deepEqual(cmp.map(x => [x.team_id, x.t, x.o, x.has_test]), [["0001", 38.5, 11, true], ["0002", null, 30, false]], "your test lineup would have scored 38.5");
    // The week is over for test lineups once it has ended
    await db.exec(`update public.nfl_games set kickoff = now() - interval '5 hours' where week = ${W}`);
    await assert.rejects(save(user(ALICE), FULL), /Week 6 is over/);
  });

  test("the lineup confirmation email works for test lineups (both owners, the user's setting)", async () => {
    await db.exec(`delete from public.notify_queue`);
    await save(user(ALICE), [FULL[0]!, FULL[1]!, FULL[2]!, "WR-BYE", ...FULL.slice(4)]);
    const q = await db.query<{ user_id: string; kind: string; ref: string }>(`select user_id, kind, ref from public.notify_queue`);
    assert.deepEqual(q.rows.map(x => [x.user_id, x.kind, x.ref]), [[ALICE, "lineup_saved", `tsaved:${S}:${W}:0001`]]);
    const d = (await db.query<{ d: Record<string, unknown> }>(`select private.test_lineup_payload(${S}, ${W}, '0001') as d`)).rows[0]!.d;
    assert.equal(d.test, true);
    assert.equal((d.starters as unknown[]).length, 9);
    assert.deepEqual(d.warnings, [{ name: "Puka Nacua", pos: "WR", problem: "bye" }]);
    assert.equal(d.saved_by, "Mike");
  });
});

describe("player schedule pop-up: points allowed", () => {
  test("points each team allows to each position per game, public read", async () => {
    await db.exec(`
      insert into public.nfl_players (id, name, position, nfl_team) values ('WR-DET', 'Amon-Ra St. Brown', 'WR', 'DET'), ('WR-ARI', 'Marvin Harrison Jr.', 'WR', 'ARI'), ('DEF:ARI', 'ARI Defense', 'DEF', 'ARI');
      insert into public.player_scores (season, week, player_id, game_key, points, source) values
        (${S}, 1, 'QB-DET', 'DET@ARI', 20, 'final'), (${S}, 1, 'WR-DET', 'DET@ARI', 10, 'final'),
        (${S}, 2, 'QB-DET', 'KC@DET', 30, 'final'), (${S}, 1, 'WR-ARI', 'DET@ARI', 7, 'final'), (${S}, 1, 'DEF:ARI', 'DET@ARI', 4, 'final'),
        (${S}, 3, 'QB-ARI', 'ARI@LV', 12, 'final')
      on conflict (season, week, player_id) do update set points = excluded.points, game_key = excluded.game_key;`);
    const r = await rowsT(db, anon, `select team, pos, games, avg::float as avg from public.points_allowed(${S}) order by team, pos`);
    assert.deepEqual(r.map(x => [x.team, x.pos, x.games, x.avg]), [
      ["ARI", "QB", 1, 20], ["ARI", "WR", 1, 10],           // DET's QB and WR against ARI in week 1
      ["DET", "DEF", 1, 4], ["DET", "WR", 1, 7],            // ARI's defense and WR against DET
      ["KC", "QB", 1, 30], ["LV", "QB", 1, 12]]);
  });
});

describe("treasurer (league money)", () => {
  // Bob (owns Stealers, 0002) becomes treasurer; the commissioner (no team in the seed) confirms.
  const grant = (who: Who, user: string, role = "treasurer") => as(db, who, tx => tx.query(`select public.grant_role($1::uuid, $2) as r`, [user, role]));
  const payout = (who: Who, team: string, amount = 35) => as(db, who, tx => tx.query<{ id: number; status: string }>(
    `insert into public.payout_payments (season, team_id, amount, paid_at, method, note) values (${S}, $1, $2, '2026-10-25', 'Venmo', 'week 7 high') returning id, status`, [team, amount])).then(r => r.rows[0]!);
  const fee = (who: Who, team: string, amount = 360) => as(db, who, tx => tx.query<{ id: number; status: string }>(
    `insert into public.fee_payments (season, team_id, amount, paid_at, method) values (${S}, $1, $2, '2026-09-01', 'cash') returning id, status`, [team, amount])).then(r => r.rows[0]!);
  beforeEach(async () => {
    await db.exec(`insert into public.season_settings (season, team_count, buy_in, prizes) values (${S}, 12, 360, '{}') on conflict (season) do nothing;
      delete from public.notify_queue`);
  });

  test("only commissioners grant or revoke treasurer; it's optional (the last one can go); audited and emailed", async () => {
    await assert.rejects(grant(user(ALICE), BOB), /Only a commissioner can grant the treasurer role/);
    await grant(user(COMMISH), BOB);
    assert.deepEqual((await rowsT(db, user(ALICE), `select role from public.user_roles where user_id = '${BOB}'`)).map(x => x.role), ["treasurer"]);
    assert.ok((await rowsT(db, service, `select 1 from public.audit_log where action = 'roles:grant' and details ->> 'role' = 'treasurer'`)).length);
    const q = await rowsT(db, service, `select kind, payload from public.notify_queue where user_id = '${BOB}'`);
    assert.deepEqual(q.map(x => [x.kind, x.payload.role, x.payload.action]), [["account", "treasurer", "grant"]]);
    assert.equal((await rowsT(db, user(COMMISH), `select public.revoke_role('${BOB}', 'treasurer') as r`))[0]!.r, "Revoked", "the only treasurer can be removed");
  });

  test("the treasurer keeps the ledger (fees, payouts, Empire pot) but can't decide awards or change settings", async () => {
    await grant(user(COMMISH), BOB);
    assert.equal((await payout(user(BOB), "0001")).status, "confirmed");
    assert.equal((await fee(user(BOB), "0001")).status, "confirmed");
    assert.deepEqual(await rowsT(db, user(BOB), `select paid, paid_at::text from public.team_fees where season = ${S} and team_id = '0001'`), [{ paid: true, paid_at: "2026-09-01" }],
      "the fee row follows the payments");
    await as(db, user(BOB), tx => tx.query(`insert into public.empire_ledger (season, kind, amount, note) values (${S}, 'carry_in', 240, 'from 2025')`));
    await denied(db, user(BOB), `insert into public.awards (season, kind, week, label, team_id, amount, status, source) values (${S}, 'manual', null, 'Survivor', '0001', 240, 'final', 'manual')`);
    assert.equal(await affected(db, user(BOB), `update public.awards set amount = 0`), 0);
    assert.equal(await affected(db, user(BOB), `update public.season_settings set buy_in = 1`), 0);
    assert.equal(await affected(db, user(BOB), `update public.standings set wins = 99`), 0);
    const b = await rowsT(db, user(BOB), `select team_id, fee_paid::float as f, paid_out::float as p from public.treasury_balances(${S})`);
    assert.deepEqual(b.filter(x => x.team_id === "0001").map(x => [x.f, x.p]), [[360, 35]], "the treasurer sees every team");
    assert.equal(b.length, 2);
    assert.ok((await rowsT(db, service, `select 1 from public.audit_log where actor = '${BOB}' and action = 'payouts:payout_payments:insert'`)).length, "audited");
  });

  test("commissioners read the ledger, and write it only while there's no treasurer", async () => {
    assert.equal((await payout(user(COMMISH), "0001")).status, "confirmed", "no treasurer: the commissioner keeps the books");
    await grant(user(COMMISH), BOB);
    await denied(db, user(COMMISH), `insert into public.payout_payments (season, team_id, amount, paid_at) values (${S}, '0001', 5, '2026-10-25')`);
    await denied(db, user(COMMISH), `insert into public.fee_payments (season, team_id, amount, paid_at) values (${S}, '0001', 5, '2026-10-25')`);
    assert.equal(await affected(db, user(COMMISH), `update public.payout_payments set amount = 1`), 0);
    assert.equal(await affected(db, user(COMMISH), `delete from public.payout_payments`), 0);
    assert.equal((await rowsT(db, user(COMMISH), `select * from public.payout_payments`)).length, 1, "still reads it");
    assert.equal((await rowsT(db, user(COMMISH), `select * from public.treasury_balances(${S})`)).length, 2);
    // Managers see only their own team; anon nothing
    assert.deepEqual((await rowsT(db, user(ALICE), `select team_id from public.treasury_balances(${S})`)).map(x => x.team_id), ["0001"]);
    await denied(db, anon, `select * from public.fee_payments`, /permission denied/);
    await rows(db, user(COMMISH), `select public.revoke_role('${BOB}', 'treasurer')`);
    assert.equal((await payout(user(COMMISH), "0001", 5)).status, "confirmed", "treasurer gone: fallback again");
  });

  test("payment preferences: the owner and treasurers only (not admins, not commissioners)", async () => {
    await as(db, user(ALICE), tx => tx.query(`insert into public.payment_prefs (venmo, mailing_address, in_person) values ('@alice-b5', '1 Main St, Bridgeville PA', false)`));
    assert.deepEqual((await rowsT(db, user(ALICE), `select venmo from public.payment_prefs`)).map(x => x.venmo), ["@alice-b5"]);
    assert.deepEqual(await rowsT(db, user(BOB), `select * from public.payment_prefs`), [], "another owner sees nothing");
    assert.deepEqual(await rowsT(db, user(COMMISH), `select * from public.payment_prefs`), [], "admin + commissioner sees nothing");
    await denied(db, anon, `select * from public.payment_prefs`, /permission denied/);
    await denied(db, user(ALICE), `insert into public.payment_prefs (user_id, venmo) values ('${BOB}', '@forged')`);
    assert.equal(await affected(db, user(COMMISH), `update public.payment_prefs set venmo = '@x'`), 0);
    await grant(user(COMMISH), BOB);
    assert.deepEqual((await rowsT(db, user(BOB), `select user_id, venmo from public.payment_prefs`)).map(x => x.venmo), ["@alice-b5"], "the treasurer sees everyone's");
    assert.equal(await affected(db, user(BOB), `update public.payment_prefs set in_person = true where user_id = '${ALICE}'`), 1);
    const a = await rowsT(db, service, `select details from public.audit_log where action = 'treasury:payment_prefs:update'`);
    assert.deepEqual(a.map(x => x.details), [{ user: ALICE }], "audited without the contents");
    await denied(db, user(ALICE), `insert into public.payment_prefs (venmo) values ('has space')`, /check constraint|violates/);
  });

  test("own-team payments need a commissioner's confirmation; pending ones don't count", async () => {
    await grant(user(COMMISH), BOB);
    const p = await payout(user(BOB), "0002", 70);
    assert.equal(p.status, "pending", "Bob paying his own team");
    assert.equal((await rowsT(db, user(BOB), `select paid_out::float as p, pending from public.treasury_balances(${S}) where team_id = '0002'`))[0]!.p, 0);
    await assert.rejects(as(db, user(BOB), tx => tx.query(`update public.payout_payments set amount = 700 where id = ${p.id}`)), /your own team's payment/);
    await assert.rejects(as(db, user(BOB), tx => tx.query(`select public.confirm_payment('payout_payments', ${p.id}, true)`)), /Only a commissioner/);
    assert.equal(await affected(db, user(BOB), `delete from public.payout_payments where id = ${p.id}`), 1, "he can withdraw his own pending entry");
    const p2 = await payout(user(BOB), "0002", 70);
    assert.equal((await rowsT(db, user(COMMISH), `select public.confirm_payment('payout_payments', ${p2.id}, true) as r`))[0]!.r, "Confirmed");
    assert.equal((await rowsT(db, user(BOB), `select paid_out::float as p from public.treasury_balances(${S}) where team_id = '0002'`))[0]!.p, 70);
    await assert.rejects(as(db, user(BOB), tx => tx.query(`delete from public.payout_payments where id = ${p2.id}`)), /your own team's payment/, "a confirmed own-team entry stays");
    // Fees too, and a rejection removes the entry
    const f = await fee(user(BOB), "0002");
    assert.equal(f.status, "pending");
    await rows(db, user(COMMISH), `select public.confirm_payment('fee_payments', ${f.id}, false)`);
    assert.deepEqual(await rowsT(db, user(BOB), `select * from public.fee_payments where team_id = '0002'`), []);
    assert.deepEqual((await rowsT(db, service, `select action from public.audit_log where action like 'coi:payment_%' order by id`)).map(x => x.action), ["coi:payment_confirmed", "coi:payment_rejected"]);
    // Nobody else could confirm (the only commissioner co-owns Stealers): recorded, flagged in the audit log
    await db.exec(`insert into public.team_managers values ('0002', '${COMMISH}')`).catch(() => {});
    if ((await rowsT(db, service, `select 1 from public.team_managers where user_id = '${COMMISH}' and team_id = '0002'`)).length) {
      assert.equal((await payout(user(BOB), "0002", 10)).status, "confirmed");
      assert.ok((await rowsT(db, service, `select 1 from public.audit_log where action = 'coi:own_team_unreviewed'`)).length);
    }
  });

  test("emails: an award becoming final tells the treasurer whom to pay (once); Monday's who's-owed summary", async () => {
    await grant(user(COMMISH), BOB);
    await db.exec(`delete from public.notify_queue`);
    await as(db, service, tx => tx.query(`insert into public.awards (season, kind, week, label, team_id, amount, status, source) values (${S}, 'weekly_high', 8, 'Week 8 high score', '0001', 35, 'projected', 'auto')`));
    assert.deepEqual(await rowsT(db, service, `select * from public.notify_queue`), [], "projected: nothing yet");
    await as(db, service, tx => tx.query(`update public.awards set status = 'final' where week = 8`));
    const q = await rowsT(db, service, `select user_id, kind, payload from public.notify_queue`);
    assert.deepEqual(q.map(x => [x.user_id, x.kind, x.payload.type, x.payload.team, Number(x.payload.amount), x.payload.label]), [[BOB, "account", "pay", "NSFW", 35, "Week 8 high score"]]);
    // The nightly job replaces auto awards: the same final award doesn't notify again
    await as(db, service, tx => tx.query(`select public.replace_auto_payouts(${S}, '[{"kind":"weekly_high","week":8,"place":null,"label":"Week 8 high score","team_id":"0001","amount":35,"status":"final","note":null}]'::jsonb, '[]'::jsonb, '[]'::jsonb)`));
    assert.equal((await rowsT(db, service, `select * from public.notify_queue`)).length, 1);
    // Monday 9 AM ET: who's owed (NSFW is owed $35; fees unpaid), once a week
    const tick = (at: string) => db.query<{ r: string }>(`select private.treasury_weekly_tick('${at}'::timestamptz) as r`).then(x => x.rows[0]!.r);
    assert.match(await tick("2026-10-26T12:00:00Z"), /not Monday 9 AM/, "8 AM EDT");
    assert.equal(await tick("2026-10-26T13:05:00Z"), "sent");
    assert.equal(await tick("2026-10-26T14:05:00Z"), "already sent");
    const w = (await rowsT(db, service, `select payload from public.notify_queue where payload ->> 'type' = 'owed'`))[0]!.payload;
    assert.deepEqual(w.teams.map((t: { team: string; owed: number }) => [t.team, Number(t.owed)]), [["NSFW", 35], ["Stealers", 0]]);
  });
});

describe("several roles per person (set_roles)", () => {
  const ADMIN = "00000000-0000-0000-0000-0000000000ad";   // administrator only, no team
  const COM2 = "00000000-0000-0000-0000-0000000000c2";    // commissioner only, no team
  beforeEach(async () => {
    await db.exec(`
      insert into auth.users (id, email, raw_user_meta_data) values ('${ADMIN}', 'admin@example.com', '{"display_name":"Ada"}'), ('${COM2}', 'com2@example.com', '{"display_name":"Cy"}');
      update public.profiles set is_admin = true where id = '${ADMIN}';
      update public.profiles set is_commissioner = true where id = '${COM2}';
      insert into public.season_settings (season, team_count, buy_in, prizes) values (${S}, 12, 360, '{}') on conflict (season) do nothing;
      delete from public.notify_queue; delete from public.audit_log where action like 'roles:%';`);
  });
  const roles = (u: string) => db.query<{ role: string }>(`select role from public.user_roles where user_id = '${u}' order by role`).then(r => r.rows.map(x => x.role));
  const setRoles = (who: Who, u: string, rs: string[]) => as(db, who, tx => tx.query<{ r: { added: string[]; removed: string[]; roles: string[] } }>(
    `select public.set_roles($1::uuid, $2::text[]) as r`, [u, rs])).then(x => x.rows[0]!.r);

  test("one call sets several roles: one audit entry per change, one summary email", async () => {
    // The league account (COMMISH) is admin + commissioner: it may grant all three
    const r = await setRoles(user(COMMISH), BOB, ["admin", "treasurer"]);
    assert.deepEqual(r, { added: ["admin", "treasurer"], removed: [], roles: ["admin", "treasurer"] });
    assert.deepEqual(await roles(BOB), ["admin", "treasurer"]);
    const audit = await rowsT(db, service, `select action, details ->> 'role' as role from public.audit_log where action like 'roles:%' order by id`);
    assert.deepEqual(audit.map(x => [x.action, x.role]), [["roles:grant", "admin"], ["roles:grant", "treasurer"]]);
    const mail = await rowsT(db, service, `select payload from public.notify_queue where user_id = '${BOB}'`);
    assert.equal(mail.length, 1, "one email for the whole change");
    assert.deepEqual(mail[0]!.payload, { type: "roles", added: ["admin", "treasurer"], removed: [], by: "Commish", roles: ["admin", "treasurer"] });
    assert.deepEqual(await setRoles(user(COMMISH), BOB, ["treasurer", "admin"]), { added: [], removed: [], roles: ["admin", "treasurer"] }, "no change, no email");
    assert.equal((await rowsT(db, service, `select * from public.notify_queue where user_id = '${BOB}'`)).length, 1);
  });

  test("Admin + Treasurer uses both toolsets; neither role blocks the other; commissioner tools stay out of reach", async () => {
    await setRoles(user(COMMISH), BOB, ["admin", "treasurer"]);
    // Admin tools
    assert.ok((await rowsT(db, user(BOB), `select public.admin_health() as h`))[0]!.h);
    assert.ok((await rowsT(db, user(BOB), `select * from public.audit_log`)).length > 0, "reads the audit log");
    // Treasurer tools
    const p = await as(db, user(BOB), tx => tx.query<{ status: string }>(`insert into public.payout_payments (season, team_id, amount, paid_at) values (${S}, '0001', 35, '2026-10-25') returning status`));
    assert.equal(p.rows[0]!.status, "confirmed");
    await as(db, user(ALICE), tx => tx.query(`insert into public.payment_prefs (venmo) values ('@alice')`));
    assert.equal((await rowsT(db, user(BOB), `select * from public.payment_prefs`)).length, 1, "admin + treasurer sees prefs through the treasurer role");
    assert.deepEqual(await rowsT(db, user(ADMIN), `select * from public.payment_prefs`), [], "an admin alone doesn't");
    // Not a commissioner: no awards, standings or commissioner grants
    assert.equal(await affected(db, user(BOB), `update public.standings set wins = 9`), 0);
    await assert.rejects(setRoles(user(BOB), ALICE, ["treasurer"]), /Only a commissioner can change the treasurer role/);
    // ...but as an admin he may grant admin
    assert.deepEqual((await setRoles(user(BOB), ALICE, ["admin"])).roles, ["admin"]);
  });

  test("removing one role leaves the others intact", async () => {
    await setRoles(user(COMMISH), BOB, ["admin", "commissioner", "treasurer"]);
    const r = await setRoles(user(COMMISH), BOB, ["admin", "commissioner"]);
    assert.deepEqual([r.added, r.removed], [[], ["treasurer"]]);
    assert.deepEqual(await roles(BOB), ["admin", "commissioner"]);
    assert.equal((await rowsT(db, user(BOB), `select public.admin_health() as h`)).length, 1, "still an admin");
    assert.equal(await affected(db, user(BOB), `update public.standings set wins = 7 where team_id = '0001'`), 1, "still a commissioner");
    await assert.rejects(as(db, user(BOB), tx => tx.query(`insert into public.payment_prefs (user_id, venmo) values ('${ALICE}', '@x')`)), /row-level security/, "no longer treasurer");
  });

  test("never the last administrator or commissioner; a refused call changes nothing", async () => {
    // Ada is the only other admin; Cy the only other commissioner. Take COMMISH down to treasurer: allowed (others remain)
    await setRoles(user(COMMISH), COMMISH, ["treasurer"]);
    assert.deepEqual(await roles(COMMISH), ["treasurer"]);
    // Now Ada is the last admin, Cy the last commissioner
    await assert.rejects(setRoles(user(ADMIN), ADMIN, []), /at least one administrator/);
    await assert.rejects(setRoles(user(COM2), COM2, ["treasurer"]), /at least one commissioner/);
    assert.deepEqual(await roles(COM2), ["commissioner"], "the treasurer grant in the refused call didn't happen either");
    assert.equal((await rowsT(db, service, `select * from public.notify_queue where user_id = '${COM2}'`)).length, 0);
  });

  test("grant rights per role: admins -> admin; commissioners -> commissioner and treasurer; checked before anything changes", async () => {
    await assert.rejects(setRoles(user(ADMIN), BOB, ["treasurer"]), /Only a commissioner can change the treasurer role/);
    await assert.rejects(setRoles(user(ADMIN), BOB, ["commissioner"]), /Only a commissioner/);
    assert.deepEqual((await setRoles(user(ADMIN), BOB, ["admin"])).roles, ["admin"]);
    await assert.rejects(setRoles(user(COM2), BOB, []), /Only an administrator can change the administrator role/, "a commissioner can't remove admin");
    await assert.rejects(setRoles(user(COM2), BOB, ["treasurer"]), /Only an administrator/, "adding treasurer while dropping admin: refused as a whole");
    assert.deepEqual(await roles(BOB), ["admin"], "nothing changed (the treasurer part wasn't applied)");
    // A commissioner changes only his roles, passing the admin role through unchanged
    assert.deepEqual((await setRoles(user(COM2), BOB, ["admin", "treasurer"])).roles, ["admin", "treasurer"]);
    await assert.rejects(setRoles(user(ALICE), BOB, ["admin"]), /Only/);
    await denied(db, anon, `select public.set_roles('${BOB}', array['admin'])`, /permission denied/);
    await assert.rejects(setRoles(user(COMMISH), BOB, ["owner"]), /Unknown role/);
  });
});

describe("game details for the pool's cards (nfl_game_info)", () => {
  test("public read; only server jobs write; the 3-hourly tick only calls in season", async () => {
    await as(db, service, tx => tx.query(`insert into public.nfl_game_info (season, week, game_key, away_record, home_record, spread, over_under, roof) values (${S}, ${W}, 'DET@ARI', '4-2', '2-5', 'DET -3.5', 47.5, 'retractable')`));
    assert.deepEqual((await rowsT(db, anon, `select spread, roof from public.nfl_game_info`)).map(x => [x.spread, x.roof]), [["DET -3.5", "retractable"]]);
    await denied(db, anon, `insert into public.nfl_game_info (season, week, game_key) values (${S}, 1, 'A@B')`, /permission denied/);
    await denied(db, user(COMMISH), `update public.nfl_game_info set spread = 'X'`, /permission denied/);
    await db.exec(`delete from net.calls`);
    const tick = (at: string) => db.query<{ r: string }>(`select private.game_info_tick('${at}'::timestamptz) as r`).then(x => x.rows[0]!.r);
    assert.equal(await tick("2027-04-01T12:00:00Z"), "not in season");
    assert.equal(await tick(new Date().toISOString()), `requested ${S}`, "the seed's games are this week");
    const calls = (await db.query<{ body: { job: string; season: number } }>(`select body from net.calls`)).rows;
    assert.deepEqual(calls.map(c => [c.body.job, c.body.season]), [["game_info", S]]);
    await denied(db, user(COMMISH), `select private.game_info_tick()`, /permission denied/);
  });
});

describe("league default settings (from an admin's own settings)", () => {
  const NEWBIE = "00000000-0000-0000-0000-0000000000e1";
  const settings = (u: string) => db.query<Record<string, unknown>>(`select * from public.notify_settings where user_id = '${u}'`).then(r => r.rows[0]);
  // The admin (COMMISH) sets his own preferences on the Account page, paused included.
  const mine = () => as(db, user(COMMISH), tx => tx.query(`insert into public.notify_settings (paused, dm, mentions, scoring, league_lineups, league_lineups_opponent, lineup)
    values (true, true, true, true, 'digest', true, true) on conflict (user_id) do update set paused = true, mentions = true, scoring = true, league_lineups = 'digest', league_lineups_opponent = true, lineup = true`));
  beforeEach(async () => { await db.exec(`insert into public.owner_contacts (user_id, email, phone) values ('${COMMISH}', 'admin@example.com', '4125550123') on conflict do nothing`).catch(() => {}); });

  test("saving copies notification choices only: never pause, contact info, names, payment prefs, roles or role notices; admins only; audited", async () => {
    await mine();
    await as(db, user(COMMISH), tx => tx.query(`insert into public.payment_prefs (venmo) values ('@admin')`));
    const r = (await rowsT(db, user(COMMISH), `select public.admin_save_defaults('{"liveShowOfficial": true, "email": "x@y.z", "phone": "1"}'::jsonb) as r`))[0]!.r;
    assert.deepEqual(Object.keys(r.notify).sort(), ["announcements", "dm", "league_lineups", "league_lineups_opponent", "league_moves", "league_trades", "league_waivers",
      "lineup", "lineup_saved", "mentions", "scoring", "trades", "waivers"], "only the notification choices");
    assert.equal(r.notify.mentions, true); assert.equal(r.notify.league_lineups, "digest"); assert.equal(r.notify.lineup, true);
    assert.equal("paused" in r.notify, false, "Pause all email is never copied");
    assert.deepEqual(r.display, { liveShowOfficial: true }, "display: only known keys");
    const stored = JSON.stringify((await rowsT(db, anon, `select notify, display from public.league_defaults`))[0]);
    for (const personal of ["admin@example.com", "4125550123", "@admin", "Commish", "commissioner", "admin\"", "treasurer", "account", COMMISH]) {
      assert.equal(stored.includes(personal), false, `the template never holds ${personal}`);
    }
    await assert.rejects(as(db, user(ALICE), tx => tx.query(`select public.admin_save_defaults()`)), /Only an administrator/);
    await denied(db, anon, `select public.admin_save_defaults()`, /permission denied/);
    await denied(db, user(COMMISH), `update public.league_defaults set notify = '{}'`, /permission denied/);
    assert.equal((await rowsT(db, service, `select 1 from public.audit_log where action = 'defaults:save'`)).length, 1);
  });

  test("a new account starts with the league defaults (not customized; not paused)", async () => {
    await mine();
    await rows(db, user(COMMISH), `select public.admin_save_defaults()`);
    await db.exec(`insert into auth.users (id, email, raw_user_meta_data) values ('${NEWBIE}', 'new@example.com', '{}')`);
    const s = (await settings(NEWBIE))!;
    assert.deepEqual([s.mentions, s.scoring, s.league_lineups, s.league_lineups_opponent, s.lineup, s.paused, s.customized], [true, true, "digest", true, true, false, false]);
  });

  test("apply to users who haven't customized: preview count first; customized users untouched; pause kept; audited", async () => {
    // Alice chose her own settings; Bob never did (no row); a third has an uncustomized row from earlier defaults.
    await as(db, user(ALICE), tx => tx.query(`insert into public.notify_settings (mentions, scoring) values (false, false)`));
    await db.exec(`insert into auth.users (id, email) values ('${NEWBIE}', 'new@example.com')`);   // no defaults saved yet: no row
    await mine();
    await rows(db, user(COMMISH), `select public.admin_save_defaults()`);
    const preview = (await rowsT(db, user(COMMISH), `select public.admin_apply_defaults(true) as r`))[0]!.r;
    assert.deepEqual(preview, { users: 2, applied: false }, "Bob and the new account; not Alice or the admin (both customized)");
    assert.equal(await settings(BOB), undefined, "a preview changes nothing");
    assert.deepEqual((await rowsT(db, user(COMMISH), `select public.admin_apply_defaults(false) as r`))[0]!.r, { users: 2, applied: true });
    assert.deepEqual([(await settings(BOB))!.mentions, (await settings(BOB))!.league_lineups, (await settings(BOB))!.customized], [true, "digest", false]);
    assert.deepEqual([(await settings(ALICE))!.mentions, (await settings(ALICE))!.scoring, (await settings(ALICE))!.customized], [false, false, true], "Alice's own choices stay");
    assert.equal((await settings(COMMISH))!.paused, true, "the admin's pause stays his");
    assert.ok((await rowsT(db, service, `select 1 from public.audit_log where action = 'defaults:apply' and (details ->> 'users')::int = 2`)).length);
    // Bob now changes a setting himself: from then on he's customized
    await as(db, user(BOB), tx => tx.query(`update public.notify_settings set scoring = false`));
    assert.equal((await settings(BOB))!.customized, true);
    assert.equal(((await rowsT(db, user(COMMISH), `select public.admin_apply_defaults(true) as r`))[0]!.r).users, 1, "only the new account is left");
    await assert.rejects(as(db, user(ALICE), tx => tx.query(`select public.admin_apply_defaults(false)`)), /Only an administrator/);
  });

  test("Reset to league defaults: your own row, back to the template, pause kept; unsubscribing counts as a choice", async () => {
    await mine();
    await rows(db, user(COMMISH), `select public.admin_save_defaults()`);
    await as(db, user(ALICE), tx => tx.query(`insert into public.notify_settings (paused, mentions, scoring) values (true, false, false)`));
    await as(db, user(ALICE), tx => tx.query(`select public.reset_my_notify_settings()`));
    const a = (await settings(ALICE))!;
    assert.deepEqual([a.mentions, a.scoring, a.paused, a.customized], [true, true, true, false]);
    await denied(db, anon, `select public.reset_my_notify_settings()`, /permission denied/);
    // An unsubscribe link is the person's own choice
    const tok = (await db.query<{ t: string }>(`select '${ALICE}.scoring.' || private.notify_sig('${ALICE}', 'scoring') as t`)).rows[0]!.t;
    await as(db, anon, tx => tx.query(`select public.notify_unsubscribe($1)`, [tok]));
    assert.deepEqual([(await settings(ALICE))!.scoring, (await settings(ALICE))!.customized], [false, true]);
  });
});
