/* Supabase Edge Function "b5-live": live NFL scoring, one pass per call.
   Called every minute by pg_cron + pg_net only while an NFL game is near
   (migration live_scoring_cron). The logic and its tests live in src/live/
   (edgeHandler.ts -> liveRun.ts); the deploy workflow copies src/ to ./_src before
   deploying, so this function runs exactly the tested code. ./_src is not committed.

   Env: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase to every
   Edge Function. No secret is stored in the repo. */

import { handle } from "./_src/live/edgeHandler.ts";

Deno.serve(req => handle(req, {
  SUPABASE_URL: Deno.env.get("SUPABASE_URL"),
  SUPABASE_SERVICE_ROLE_KEY: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
  // TEMPORARY (2026 shadow season): mirror MFL's current-week starters. Remove after the migration.
  MFL_LEAGUE: Deno.env.get("MFL_LEAGUE") ?? "22689"
}));
