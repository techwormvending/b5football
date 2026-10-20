/* Test database: real Postgres (PGlite, in-process, no Docker) with a minimal
   stand-in for Supabase's auth schema and roles, then every migration in
   supabase/migrations applied in order. Used to test RLS policies.

   The stand-in mirrors what Supabase provides: roles anon / authenticated /
   service_role (service_role bypasses RLS), auth.users, and auth.uid() reading
   the JWT "sub" claim from request.jwt.claims. */

import fs from "node:fs";
import path from "node:path";
import { PGlite, type Transaction } from "@electric-sql/pglite";

const MIGRATIONS = path.resolve(import.meta.dirname, "../../supabase/migrations");

const AUTH_STUB = `
  create role anon nologin noinherit;
  create role authenticated nologin noinherit;
  create role service_role nologin noinherit bypassrls;
  create role supabase_auth_admin nologin noinherit;   -- runs Auth hooks
  create schema auth;
  grant usage on schema auth to anon, authenticated, service_role;
  create table auth.users (
    id uuid primary key,
    email text,
    raw_user_meta_data jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    last_sign_in_at timestamptz             -- null until the magic link is used
  );
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ), '')::uuid
  $$;
  grant execute on function auth.uid() to anon, authenticated, service_role;

  -- pg_net stand-in (the real extension isn't in PGlite): records calls instead of sending them.
  create schema extensions;
  create schema net;
  create table net.calls (id bigserial primary key, url text, body jsonb, headers jsonb, at timestamptz default now());
  create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds int default 5000)
    returns bigint language sql as $$ insert into net.calls (url, body, headers) values (url, body, headers) returning id $$;

  -- Supabase's default privileges (as found on the hosted project, 2026-10-15): new tables,
  -- sequences and functions in public are granted to anon and authenticated automatically,
  -- even with "auto-expose new tables" off. Mirror them so tests catch over-broad access.
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`;

export function migrationFiles(): string[] {
  return fs.readdirSync(MIGRATIONS).filter(f => /^\d+_.+\.sql$/.test(f)).sort().map(f => path.join(MIGRATIONS, f));
}

export async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(AUTH_STUB);
  for (const f of migrationFiles()) {
    try { await db.exec(fs.readFileSync(f, "utf8")); }
    catch (err) { throw new Error(`Migration ${path.basename(f)} failed: ${(err as Error).message}`); }
  }
  return db;
}

export type Who = { role: "anon" } | { role: "service_role" } | { role: "authenticated"; uid: string };

/** Run `fn` inside a transaction as the given Supabase role / user (like a Data API request). */
export async function as<T>(db: PGlite, who: Who, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(async tx => {
    const claims = who.role === "authenticated" ? { sub: who.uid, role: "authenticated" } : { role: who.role };
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    await tx.exec(`set local role ${who.role}`);
    return fn(tx);
  });
}
