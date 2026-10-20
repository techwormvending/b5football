/* TEMPORARY (2026: MFL is official; delete after the migration): mirror MFL's Survivor and
   Confidence pool picks into Supabase, read-only. Nightly (finalize.yml, before payouts);
   the live scorer also imports the current week during games.

   Usage:  node scripts/import-mfl-pools.mts [season]        default 2026
   Env:    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (server only) */

import { syncMflPools } from "../src/league/mflPools.ts";

const url = process.env.SUPABASE_URL, serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) { console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."); process.exit(1); }
const season = Number(process.argv[2]) || 2026;
const r = await syncMflPools({ url, serviceKey }, season, "22689");
console.log(`MFL pools ${season}: ${r.survivor} survivor picks, ${r.confidence} confidence picks imported; ${r.keptCommissionerFixes} commissioner fix(es) kept.`);
for (const p of r.problems) console.log(`  PROBLEM ${p}`);
