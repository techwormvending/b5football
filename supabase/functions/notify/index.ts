/* Supabase Edge Function "notify": email notifications through Resend, and the one-click
   unsubscribe endpoint. Called every minute by pg_cron + pg_net only when an email is due
   (migration email_notify). The logic and its tests live in src/notify/; the deploy workflow
   copies src/ to ./_src before deploying, so this runs exactly the tested code.
   Env: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (provided by Supabase), RESEND_API_KEY
   (Supabase secret, set from the GitHub secret by the deploy workflow). Nothing secret in the repo. */

import { handle } from "./_src/notify/handler.ts";

Deno.serve(req => handle(req, {
  SUPABASE_URL: Deno.env.get("SUPABASE_URL"),
  SUPABASE_SERVICE_ROLE_KEY: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
  RESEND_API_KEY: Deno.env.get("RESEND_API_KEY"),
  SITE_URL: Deno.env.get("SITE_URL") ?? "https://b5football.win"
}));
