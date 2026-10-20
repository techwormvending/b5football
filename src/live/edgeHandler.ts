/* HTTP handler for the "b5-live" Supabase Edge Function (supabase/functions/b5-live).

   Only the database's own scheduler may run it. The function is deployed without JWT
   verification (the project's new API keys aren't JWTs), so it authenticates the caller
   itself: every minute pg_cron (private.live_tick) inserts a one-time nonce into
   public.live_nonces, a table only service_role can touch, and posts it here. A call is
   accepted only if that nonce exists, is under 2 minutes old, and is consumed now
   (deleted). Anyone else calling the URL gets 401 and costs one tiny DB request.
   No secret is stored in the repo. */

import { runLive, type LiveDeps } from "./liveRun.ts";
import { sbBase, sbHeaders, type SbConfig } from "../league/supabaseRest.ts";

export interface EdgeEnv { SUPABASE_URL?: string; SUPABASE_SERVICE_ROLE_KEY?: string; MFL_LEAGUE?: string }

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Consume a fresh nonce; true if it existed. */
export async function consumeNonce(sb: SbConfig, nonce: string, fetchImpl: typeof fetch, now: number): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(nonce)) return false;
  const since = new Date(now - 2 * 60_000).toISOString();
  const r = await fetchImpl(`${sbBase(sb)}live_nonces?nonce=eq.${nonce}&created_at=gte.${encodeURIComponent(since)}`, {
    method: "DELETE", headers: sbHeaders(sb, { Prefer: "return=representation" })
  });
  if (!r.ok) return false;
  return ((await r.json()) as unknown[]).length === 1;
}

export async function handle(req: Request, env: EdgeEnv, fetchImpl: typeof fetch = fetch, now: () => number = Date.now): Promise<Response> {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: "not configured" }, 500);
  const sb: SbConfig = { url: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY };
  let nonce = "";
  try { nonce = String(((await req.json()) as { nonce?: unknown }).nonce ?? ""); } catch { /* no body */ }
  if (!nonce || !(await consumeNonce(sb, nonce, fetchImpl, now()))) return json({ error: "unauthorized" }, 401);
  const deps: LiveDeps = { fetch: fetchImpl, sb, now, log: m => console.log(m), ...(env.MFL_LEAGUE ? { mflLeague: env.MFL_LEAGUE } : {}) };
  const result = await runLive(deps);   // never throws
  return json(result);
}
