/* Nightly finalization (run from cron / the host's scheduler, e.g. 4 AM ET daily
   in season). Pulls nflverse, rescores every unlocked week through the current
   one, logs live-vs-final differences and stat corrections, and auto-finalizes
   weeks past their deadline.

   Usage:  node scripts/finalize.mts                     current season/week from ESPN
           node scripts/finalize.mts <season> <throughWeek>
   Env:    B5_DATA (default data/league), B5_CACHE (default .cache/),
           AUTO_FINALIZE=off | "<weekday 0-6>@<hour 0-23>" (US Eastern; default 2@23 = Tue 11 PM) */

import path from "node:path";
import { nflverseProvider } from "../src/ingest/nflverse.ts";
import { espnLiveSource } from "../src/ingest/espn.ts";
import { loadCrosswalk } from "../src/ingest/crosswalk.ts";
import { jsonFileStore } from "../src/league/store.ts";
import { createFinalizer, type FinalizeConfig } from "../src/league/finalizer.ts";

const DATA = path.resolve(process.env.B5_DATA || "data/league");
const CACHE = path.resolve(process.env.B5_CACHE || ".cache");
const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

let season = Number(process.argv[2]), through = Number(process.argv[3]);
if (!season || !through) {
  const cur = await espnLiveSource({ cacheDir: path.join(CACHE, "espn") }).currentWeek();
  if (!cur) { log("No current regular-season week (offseason?). Pass <season> <throughWeek> to run anyway."); process.exit(0); }
  ({ season, week: through } = cur);
}

const af = process.env.AUTO_FINALIZE;
const autoFinalize: FinalizeConfig["autoFinalize"] = af === "off" ? { enabled: false, weekday: 2, hour: 23 }
  : af && /^\d@\d{1,2}$/.test(af) ? { enabled: true, weekday: Number(af.split("@")[0]), hour: Number(af.split("@")[1]) }
  : { enabled: true, weekday: 2, hour: 23 };

const finalizer = createFinalizer({
  // Always re-download: a nightly run exists to pick up nflverse's latest data and stat corrections.
  final: nflverseProvider({ cacheDir: path.join(CACHE, "nflverse"), maxAgeHours: 1 }),
  crosswalk: await loadCrosswalk({ cacheDir: path.join(CACHE, "nflverse") }),
  store: jsonFileStore(DATA),
  log
}, { autoFinalize });

const results = await finalizer.runNightly(season, through);
const errors = results.filter(r => r.action === "error");
for (const e of errors) log(`ERROR ${e.season} wk ${e.week}: ${e.message}`);
log(`done: ${results.map(r => `wk${r.week}=${r.action}`).join(" ")}`);
process.exit(errors.length ? 1 : 0);
