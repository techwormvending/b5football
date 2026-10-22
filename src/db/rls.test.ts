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
  const SERVICE_ONLY = new Set(["heartbeats", "live_nonces", "live_games", "board_bot_keys"]);
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
    "season_settings", "team_scores", "awards", "guillotine", "survivor_status", "confidence_scores", "score_events", "player_injuries", "league_settings"]);
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
    assert.equal(await tick("2026-10-20T12:00:00Z"), "already imported today");
    await db.exec(`update public.season_settings set pools = '{"mode": "official"}'`);
    assert.equal(await tick("2026-12-08T11:00:00Z"), "not in test mode", "2027: no MFL import");
  });

  test("Run import now: commissioner only; the import log is commissioner only", async () => {
    await db.exec(`insert into public.nfl_games (season, week, game_key, home, away, kickoff) values (${S}, 5, 'A@B', 'B', 'A', now() - interval '2 days')`);
    await assert.rejects(as(db, user(ALICE), tx => tx.query(`select public.run_pool_import()`)), /Only the commissioner/);
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
  test("lineups: everyone sees a starter from his kickoff on; before that only his team's managers and the commissioner", async () => {
    await db.exec(`insert into public.lineup_slots (season, week, team_id, slot, player_id) values (${S}, ${W}, '0001', 0, 'QB-KC')`);
    const hidden = [{ team_id: "0001", slot: 0, player_id: "QB-KC", revealed: true }, { team_id: "0001", slot: 1, player_id: null, revealed: false },
      { team_id: "0002", slot: 0, player_id: null, revealed: false }];
    assert.deepEqual(await lineup(anon), hidden, "signed out: the kicked-off QB only");
    assert.deepEqual(await lineup(user(BOB)), [hidden[0], hidden[1], { team_id: "0002", slot: 0, player_id: "QB-ARI", revealed: true }], "Bob sees his own lineup in full");
    assert.deepEqual((await lineup(user(COMMISH)) as { player_id: string }[]).map(r => r.player_id), ["QB-KC", "RB-DET", "QB-ARI"]);
    await denied(db, anon, `select * from public.lineup_slots`, /permission denied/);
  });

  test("a starter on bye: flagged at once for everyone, named only to his team until the week's last kickoff", async () => {
    await db.exec(`insert into public.nfl_players (id, name, position, nfl_team) values ('WR-PIT', 'Bye Receiver', 'WR', 'PIT');
      insert into public.roster_entries (season, team_id, player_id) values (${S}, '0002', 'WR-PIT');
      insert into public.lineup_slots (season, week, team_id, slot, player_id) values (${S}, ${W}, '0002', 3, 'WR-PIT')`);
    const bye = (who: Who) => rows(db, who, `select player_id, revealed, bye from public.live_lineups(${S}, ${W}) where slot = 3`);
    assert.deepEqual(await bye(anon), [{ player_id: null, revealed: false, bye: true }], "anon: on bye, but not who");
    assert.deepEqual(await bye(user(BOB)), [{ player_id: "WR-PIT", revealed: true, bye: true }]);
    assert.deepEqual((await rows(db, anon, `select bye from public.live_lineups(${S}, ${W}) where team_id = '0002' and slot = 0`)), [{ bye: false }], "a player with a game later isn't a bye");
    await db.exec(`update public.nfl_games set kickoff = now() - interval '2 hours'`);
    assert.deepEqual(await bye(anon), [{ player_id: "WR-PIT", revealed: true, bye: true }], "named once every game this week has kicked off");
    await db.exec(`delete from public.nfl_games where week = ${W}`);
    assert.deepEqual((await rows(db, user(BOB), `select bye from public.live_lineups(${S}, ${W}) where slot = 3`)), [{ bye: false }], "no games loaded for the week: nobody is on bye");
  });

  test("injury statuses: public read (hidden starters flagged, not named); only server jobs replace them, all at once", async () => {
    const put = (rows: unknown[], from = W) => db.query(`select public.replace_injuries(${S}, ${from}, $1::jsonb) as n`, [JSON.stringify(rows)]);
    await put([{ week: W, player_id: "QB-ARI", status: "Out", injury: "Ankle", practice: null, source: "report" },
      { week: W, player_id: "QB-KC", status: "Questionable", injury: "Knee", practice: null, source: "report" },
      { week: W - 1, player_id: "QB-DET", status: "Doubtful", injury: "Hand", practice: null, source: "report" }], W - 1);
    await db.exec(`insert into public.lineup_slots (season, week, team_id, slot, player_id) values (${S}, ${W}, '0001', 0, 'QB-KC')`);
    assert.deepEqual(await rows(db, anon, `select team_id, slot, player_id, injury from public.live_lineups(${S}, ${W}) order by team_id, slot`), [
      { team_id: "0001", slot: 0, player_id: "QB-KC", injury: "Questionable" }, { team_id: "0001", slot: 1, player_id: null, injury: null },
      { team_id: "0002", slot: 0, player_id: null, injury: "Out" }], "Bob's hidden QB is flagged Out without his name");
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
    await denied(db, user(MIKE), `select public.run_pool_import()`, /Only the commissioner|permission denied/);
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

describe("server jobs (service_role)", () => {
  test("bypass RLS and can touch the heartbeat; nobody else can", async () => {
    assert.equal(await affected(db, service, `insert into public.heartbeats (name) values ('nightly') on conflict (name) do update set at = now()`), 1);
    assert.equal(await affected(db, service, `update public.standings set wins = 1`), 2);
    await denied(db, user(COMMISH), `select * from public.heartbeats`, /permission denied/);
  });
});
