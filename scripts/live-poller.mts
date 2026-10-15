/* Live scoring poller (long-running). Polls ESPN during live game windows only
   and writes live snapshots to the league data dir.

   Usage:  node scripts/live-poller.mts            run until Ctrl+C / SIGTERM
           node scripts/live-poller.mts --once     one poll, print the result
   Env:    B5_DATA (default data/league), B5_CACHE (default .cache/),
           POLL_MIN_SEC / POLL_MAX_SEC (default 30 / 60) */

import path from "node:path";
import { espnLiveSource } from "../src/ingest/espn.ts";
import { loadCrosswalk } from "../src/ingest/crosswalk.ts";
import { jsonFileStore } from "../src/league/store.ts";
import { createLivePoller } from "../src/league/livePoller.ts";

const DATA = path.resolve(process.env.B5_DATA || "data/league");
const CACHE = path.resolve(process.env.B5_CACHE || ".cache");
const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

const poller = createLivePoller({
  live: espnLiveSource({ cacheDir: path.join(CACHE, "espn") }),
  crosswalk: await loadCrosswalk({ cacheDir: path.join(CACHE, "nflverse") }),
  store: jsonFileStore(DATA),
  log
}, {
  ...(process.env.POLL_MIN_SEC ? { minIntervalSec: Number(process.env.POLL_MIN_SEC) } : {}),
  ...(process.env.POLL_MAX_SEC ? { maxIntervalSec: Number(process.env.POLL_MAX_SEC) } : {})
});

if (process.argv.includes("--once")) {
  const r = await poller.tick();
  console.log(JSON.stringify(r, null, 2));
} else {
  const ac = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { log(`${sig}: stopping`); ac.abort(); });
  log(`live poller started; data in ${DATA}`);
  await poller.run(ac.signal);
}
