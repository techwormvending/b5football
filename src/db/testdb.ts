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
  create schema auth;
  grant usage on schema auth to anon, authenticated, service_role;
  create table auth.users (
    id uuid primary key,
    email text,
    raw_user_meta_data jsonb not null default '{}'::jsonb
  );
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ), '')::uuid
  $$;
  grant execute on function auth.uid() to anon, authenticated, service_role;
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
