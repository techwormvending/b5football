/* TEMPORARY (2026): run the official Confidence import for given weeks (backfill, or by hand).
   The weekly run is scheduled in the database (Tuesdays 6 AM ET); the commissioner also has
   "Run import now" on the Commish page.

   Usage:  node scripts/pool-import.mts <season> <weeks...>       e.g. 2026 1 2 3 4 5 6
   Env:    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (server only) */

import { runPoolImport } from "../src/league/poolImport.ts";

const url = process.env.SUPABASE_URL, serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) { console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."); process.exit(1); }
const [season, ...weeks] = process.argv.slice(2).map(Number);
if (!season || !weeks.length) { console.error("Usage: node scripts/pool-import.mts <season> <weeks...>"); process.exit(1); }
let failed = 0;
for (const week of weeks) {
  const r = await runPoolImport({ url, serviceKey }, season, week, { by: "backfill" });
  console.log(`Week ${week}: ${r.status.toUpperCase()} - ${r.message}`);
  const c = r.compare as { checked?: boolean; mismatches?: { team_id: string; what: string; ours: number; mfl: number }[] };
  for (const m of c.mismatches ?? []) console.log(`  MISMATCH ${m.team_id} ${m.what}: ours ${m.ours}, MFL ${m.mfl}`);
  if (r.status !== "ok") failed++;
}
process.exit(failed ? 1 : 0);
