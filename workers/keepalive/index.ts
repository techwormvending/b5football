/* B5 keep-alive Worker (Cloudflare cron trigger).
   Free-tier Supabase projects pause after ~7 days without activity. This Worker
   upserts a row in public.heartbeats twice a day, so the database stays awake
   all year. It replaces relying on GitHub Actions' schedule, which GitHub turns
   off after 60 days with no repo activity.

   Config (see wrangler.toml): SUPABASE_URL is a plain var (public).
   SUPABASE_SERVICE_ROLE_KEY is a Worker SECRET, set with
   `wrangler secret put SUPABASE_SERVICE_ROLE_KEY`, never in a file. */

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

export const HEARTBEAT_NAME = "cloudflare-cron";

export async function beat(env: Env, fetchImpl: typeof fetch = fetch, now: Date = new Date()): Promise<{ ok: boolean; status: number; error?: string }> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return { ok: false, status: 0, error: "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not configured" };
  }
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const headers: Record<string, string> = {
    apikey: key,
    "Content-Type": "application/json",
    Prefer: "resolution=merge-duplicates,return=minimal"
  };
  // Legacy service_role keys are JWTs and also go in Authorization; new sb_secret_ keys don't.
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  try {
    const res = await fetchImpl(`${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/heartbeats?on_conflict=name`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: HEARTBEAT_NAME, at: now.toISOString() })
    });
    if (res.ok) return { ok: true, status: res.status };
    return { ok: false, status: res.status, error: (await res.text().catch(() => "")).slice(0, 300) };
  } catch (err) {
    return { ok: false, status: 0, error: (err as Error).message };
  }
}

export default {
  async scheduled(_controller: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
    ctx.waitUntil(beat(env).then(r => {
      // Throwing marks the cron run as failed in the Cloudflare dashboard.
      if (!r.ok) throw new Error(`Supabase heartbeat failed: HTTP ${r.status} ${r.error ?? ""}`);
      console.log(`Supabase heartbeat ok (HTTP ${r.status})`);
    }));
  },
  // No public URL is configured (workers_dev = false); answer politely if one is ever added.
  async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  }
};
