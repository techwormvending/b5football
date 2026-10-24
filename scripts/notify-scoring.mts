/* Daily scoring update emails: run by the nightly workflow after final scoring and payouts.
   public.enqueue_scoring_update() queues one email per subscriber when the Eastern day before this
   run had NFL games (Thursday, Sunday, Monday, plus international/Saturday games), once per game
   day; the "notify" Edge Function sends them (type "scoring", off by default).
   Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (Actions secret). */

import { sbBase, sbHeaders, type SbConfig } from "../src/league/supabaseRest.ts";

const url = process.env.SUPABASE_URL, serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) { console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."); process.exit(1); }
const sb: SbConfig = { url, serviceKey };
const r = await fetch(`${sbBase(sb)}rpc/enqueue_scoring_update`, { method: "POST", headers: sbHeaders(sb, { "Content-Type": "application/json" }), body: "{}" });
if (!r.ok) throw new Error(`enqueue_scoring_update: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
const n = Number(await r.json());
console.log(n ? `Daily scoring update queued for ${n} subscriber(s).` : "No daily scoring update (no games yesterday, already sent, or no subscribers).");
