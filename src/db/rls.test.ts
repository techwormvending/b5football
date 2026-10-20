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
    update public.profiles set is_commissioner = true where id = '${COMMISH}';
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
const affected = async (db: PGlite, who: Who, sql: string, params: unknown[] = []) =>
  (await as(db, who, tx => tx.query(sql, params))).affectedRows ?? 0;
const denied = (db: PGlite, who: Who, sql: string, re: RegExp = /row-level security|permission denied|only the commissioner|locked|not on team|cannot play|must be pending/i) =>
  assert.rejects(as(db, who, (tx: Transaction) => tx.query(sql)), re);

let db: PGlite;
beforeEach(async () => { db = await freshDb(); await seed(db); });

describe("every table is protected", () => {
  // Service-only tables: RLS on, deliberately no policies and no grants to anon/authenticated.
  const SERVICE_ONLY = new Set(["heartbeats", "live_nonces", "live_games"]);
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
    "season_settings", "team_scores", "awards", "guillotine"]);
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

  test("can't see another team's lineup before kickoff", async () => {
    assert.deepEqual(await rows(db, user(ALICE), `select player_id from public.lineup_slots where team_id = '0002'`), []);
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
    await denied(db, user(ALICE), `insert into public.team_managers values ('0002', '${ALICE}')`);
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
    for (const t of ["profiles", "team_managers", "lineup_slots", "transactions", "score_overrides", "audit_log", "review_queue", "heartbeats"]) {
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
    assert.equal((await rows(db, user(COMMISH), `select * from public.audit_log`)).length, 1);
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
    assert.deepEqual(await rows(db, user(GHOST), `select * from public.lineup_slots`), [], "kicked-off lineups are members-only");
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
    await as(db, user(COMMISH), tx => tx.query(`insert into public.team_managers values ('0002', '${COMMISH}')`));
    await as(db, user(COMMISH), tx => tx.query(`delete from public.team_managers where team_id = '0002' and user_id = '${COMMISH}'`));
    await as(db, user(COMMISH), tx => tx.query(`insert into public.team_managers values ('0002', '${ALICE}')`));
    assert.deepEqual((await audit()).map(a => a.action), ["own_team:team_managers:insert", "own_team:team_managers:delete"]);
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

describe("server jobs (service_role)", () => {
  test("bypass RLS and can touch the heartbeat; nobody else can", async () => {
    assert.equal(await affected(db, service, `insert into public.heartbeats (name) values ('nightly') on conflict (name) do update set at = now()`), 1);
    assert.equal(await affected(db, service, `update public.standings set wins = 1`), 2);
    await denied(db, user(COMMISH), `select * from public.heartbeats`, /permission denied/);
  });
});
