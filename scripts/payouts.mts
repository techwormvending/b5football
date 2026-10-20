/* Recompute the season's payouts (auto awards, guillotine, flags) from the database.
   Run nightly after shadow scoring (finalize.yml); the live scorer also refreshes them during games.

   Usage:  node scripts/payouts.mts [season]        default: 2026
   Env:    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (server only) */

import { refreshPayouts } from "../src/league/payoutsSync.ts";

const url = process.env.SUPABASE_URL, serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) { console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."); process.exit(1); }
const season = Number(process.argv[2]) || 2026;
const r = await refreshPayouts({ url, serviceKey }, season);
if (r.skipped) { console.log(`Payouts ${season}: skipped (${r.skipped}).`); process.exit(0); }
console.log(`Payouts ${season}: ${r.awards} auto awards, ${r.eliminations} guillotine eliminations, ${r.flags.length} flag(s).`);
for (const f of r.flags) console.log(`  FLAG ${f.kind}: ${f.message}`);
