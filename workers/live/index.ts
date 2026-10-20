/* B5 live-scoring Worker (Cloudflare cron, every minute).
   Calls src/live/liveRun.ts: outside a live game window it makes one ESPN request and
   stops; during games it scores them with our engine and writes live player scores,
   matchup totals and (2026 only) MFL's mirrored starters to Supabase. Never throws.

   CPU: a Sunday slate needs far more than the Free plan's ~10 ms per run (parsing ESPN's
   play-by-play alone is ~3.5 ms per game), so this needs Workers Paid (30 s per run).

   Config (wrangler.toml): SUPABASE_URL and MFL_LEAGUE are plain vars (public).
   SUPABASE_SERVICE_ROLE_KEY is a Worker SECRET (set by the deploy workflow), never in a file. */

import { runLive } from "../../src/live/liveRun.ts";

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  /** TEMPORARY 2026: MFL league whose starters are mirrored into lineup_slots. Empty = off. */
  MFL_LEAGUE?: string;
}

export default {
  async scheduled(_controller: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) { console.error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not configured"); return; }
    ctx.waitUntil(runLive({
      fetch: (u, i) => fetch(u, i),
      sb: { url: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY },
      ...(env.MFL_LEAGUE ? { mflLeague: env.MFL_LEAGUE } : {}),
      log: m => console.log(m)
    }).then(r => { if (r.state !== "idle" && r.state !== "offseason") console.log(JSON.stringify(r)); }));
  },
  async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  }
};
