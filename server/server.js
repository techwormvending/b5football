#!/usr/bin/env node
/* B5 league server: serves the static site and the weekly lineup API.
   No dependencies (Node 18+). Data lives in ../data as JSON files.

   Usage:  node server/server.js          (http://localhost:8737)
   Env:    PORT (default 8737), HOST (default 127.0.0.1; use 0.0.0.0 on a host),
           DATA_DIR (default ./data), B5_FAKE_NOW (ISO time; testing only)

   Lineup rules
   - Owners set lineups for the current week only, with their team PIN
     (see server/pins.js). The commissioner PIN works for any team.
   - Each player locks at his NFL game's kickoff. Locked starters can't be
     benched, and locked bench players can't be started.
   - No lineup saved for a week = last saved lineup carries over (minus anyone
     no longer on the roster). It's frozen once the week's first game starts.
   - Other teams' starters stay hidden until each player's game kicks off. */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");
const LEAGUE_FILE = path.join(ROOT, "league-data.js");
const LINEUPS_FILE = path.join(DATA_DIR, "lineups.json");
const PINS_FILE = path.join(DATA_DIR, "pins.json");
const NFL_CACHE_FILE = path.join(DATA_DIR, "nfl-schedule.json");
const PORT = Number(process.env.PORT) || 8737;
const HOST = process.env.HOST || "127.0.0.1";
const LAST_WEEK = 17;                    // fantasy season runs NFL weeks 1-17
const WEEK_GRACE_MS = 5 * 3600 * 1000;   // week is over 5h after its last kickoff
const NFL_TTL_MS = 30 * 60 * 1000;       // re-pull kickoff times every 30 min
const FAKE_NOW = process.env.B5_FAKE_NOW ? Date.parse(process.env.B5_FAKE_NOW) - Date.now() : 0;
const clock = () => Date.now() + FAKE_NOW;

// ---- Small file helpers ----------------------------------------------------

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

// ---- League data (re-read when league-data.js changes) --------------------

let leagueCache = { mtime: 0, L: null };
function league() {
  const mtime = fs.statSync(LEAGUE_FILE).mtimeMs;
  if (mtime !== leagueCache.mtime) {
    const sandbox = { window: {} };
    vm.runInNewContext(fs.readFileSync(LEAGUE_FILE, "utf8"), sandbox, { filename: "league-data.js" });
    leagueCache = { mtime, L: sandbox.window.LEAGUE };
  }
  return leagueCache.L;
}
const slots = () => league().lineupSlots || ["QB", "RB", "RB", "WR", "WR", "WR", "TE", "K", "DEF"];
// Roster for a team as a map: playerId -> { id, name, pos, nfl }
function roster(teamId) {
  const list = (league().rosters && league().rosters.teams[teamId]) || [];
  return new Map(list.filter(p => p[4]).map(([name, pos, nfl, , id]) => [id, { id, name, pos, nfl }]));
}

// ---- NFL kickoffs (from MFL) ----------------------------------------------

let nfl = { fetchedAt: 0, weeks: readJson(NFL_CACHE_FILE, {}).weeks || {} };
async function nflWeeks() {
  if (Date.now() - nfl.fetchedAt < NFL_TTL_MS && Object.keys(nfl.weeks).length) return nfl.weeks;
  try {
    const season = league().season;
    const res = await fetch(`https://api.myfantasyleague.com/${season}/export?TYPE=nflSchedule&W=ALL&JSON=1`);
    const json = await res.json();
    const weeks = {};
    for (const w of [].concat(json.fullNflSchedule.nflSchedule)) {
      const games = {};
      for (const m of [].concat(w.matchup || [])) {
        const [a, b] = m.team, at = Number(m.kickoff) * 1000;
        games[a.id] = { at, opp: b.id, home: a.isHome === "1" };
        games[b.id] = { at, opp: a.id, home: b.isHome === "1" };
      }
      weeks[w.week] = games;
    }
    nfl = { fetchedAt: Date.now(), weeks };
    writeJson(NFL_CACHE_FILE, { fetchedAt: new Date().toISOString(), weeks });
  } catch (err) {
    console.warn("NFL schedule refresh failed, using cached copy:", err.message);
    nfl.fetchedAt = Date.now() - NFL_TTL_MS + 60 * 1000; // retry in a minute
  }
  return nfl.weeks;
}

const kickoffs = (games) => Object.values(games).map(g => g.at);
const weekStart = (games) => Math.min(...kickoffs(games));
const weekOver = (games, now) => now > Math.max(...kickoffs(games)) + WEEK_GRACE_MS;
function currentWeek(weeks, now = clock()) {
  for (let w = 1; w <= LAST_WEEK; w++) {
    const g = weeks[w];
    if (g && Object.keys(g).length && !weekOver(g, now)) return w;
  }
  return LAST_WEEK;
}
const isLocked = (player, games, now) => !!(player && games[player.nfl] && now >= games[player.nfl].at);

// ---- Lineup storage --------------------------------------------------------
// lineups.json: { "<season>": { "<week>": { "<teamId>": { starters: [id|null x9], savedAt, by, carried? } } } }

function store() { return readJson(LINEUPS_FILE, {}); }

// Saved lineup for a team/week, or the latest earlier one carried over.
function lineupFor(db, season, week, teamId) {
  const s = db[season] || {};
  const saved = s[week] && s[week][teamId];
  if (saved) return { ...saved, carried: saved.carried || null };
  for (let w = week - 1; w >= 1; w--) {
    const prev = s[w] && s[w][teamId];
    if (prev) {
      const ros = roster(teamId);
      return { starters: prev.starters.map(id => (id && ros.has(id) ? id : null)), savedAt: null, carried: w };
    }
  }
  return { starters: slots().map(() => null), savedAt: null, carried: null };
}

// Once a week starts, write carried-over lineups down so later roster moves can't change them.
function freezeCarryOvers(season, week, games, now) {
  if (now < weekStart(games)) return;
  const db = store();
  let changed = false;
  for (const t of league().teams) {
    if (db[season] && db[season][week] && db[season][week][t.id]) continue;
    const lu = lineupFor(db, season, week, t.id);
    if (!lu.carried) continue;
    db[season] = db[season] || {};
    db[season][week] = db[season][week] || {};
    db[season][week][t.id] = { starters: lu.starters, savedAt: null, by: "carry-over", carried: lu.carried };
    changed = true;
  }
  if (changed) writeJson(LINEUPS_FILE, db);
}

// ---- PINs ------------------------------------------------------------------

function pinMatches(hash, pin) {
  if (!hash || !pin) return false;
  const [, salt, want] = hash.split("$");
  const got = crypto.scryptSync(String(pin), salt, 32).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(want, "hex"));
}
// Returns "owner", "commish" or null.
function authorize(teamId, pin) {
  const pins = readJson(PINS_FILE, { teams: {} });
  if (teamId && pinMatches(pins.teams && pins.teams[teamId], pin)) return "owner";
  if (pinMatches(pins.commish, pin)) return "commish";
  return null;
}

// Throttle wrong PINs: 10 misses per IP per 15 minutes.
const misses = new Map();
function throttled(ip) {
  const now = Date.now(), list = (misses.get(ip) || []).filter(t => now - t < 15 * 60 * 1000);
  misses.set(ip, list);
  return list.length >= 10;
}
const recordMiss = (ip) => misses.set(ip, [...(misses.get(ip) || []), Date.now()]);

// ---- API -------------------------------------------------------------------

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function describe(starters, teamId) {
  const ros = roster(teamId);
  return starters.map(id => (id && ros.get(id)) || null);
}

async function api(req, url, body, ip) {
  const L = league();
  const season = String(L.season);
  const weeks = await nflWeeks();
  const now = clock();
  const cur = currentWeek(weeks, now);

  // Public: week info, kickoffs, and each team's status with only locked starters revealed.
  if (req.method === "GET" && url.pathname === "/api/lineups") {
    const week = Number(url.searchParams.get("week")) || cur;
    if (week < 1 || week > LAST_WEEK) throw new HttpError(400, "Bad week");
    const games = weeks[week] || {};
    if (Object.keys(games).length) freezeCarryOvers(season, week, games, now);
    const db = store();
    const over = Object.keys(games).length ? weekOver(games, now) : week < cur;
    const teams = {};
    for (const t of L.teams) {
      const lu = lineupFor(db, season, week, t.id);
      const saved = !!(db[season] && db[season][week] && db[season][week][t.id]);
      teams[t.id] = {
        submitted: saved && lu.by !== "carry-over",
        savedAt: lu.savedAt,
        carried: lu.carried,
        starters: describe(lu.starters, t.id).map(p => (p && (over || isLocked(p, games, now)) ? p : p ? "hidden" : null))
      };
    }
    return { season, week, currentWeek: cur, now, open: week === cur && !over, slots: slots(), games, teams };
  }

  if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
  if (throttled(ip)) throw new HttpError(429, "Too many wrong PINs. Try again in 15 minutes.");
  const { team, pin } = body;
  const role = authorize(team, pin);
  if (!role) { recordMiss(ip); throw new HttpError(401, "Wrong team or PIN."); }

  // Owner (or commish): your full lineup for the current week, plus your roster.
  if (url.pathname === "/api/lineups/mine") {
    if (!roster(team).size) throw new HttpError(400, "Unknown team");
    const lu = lineupFor(store(), season, cur, team);
    return { week: cur, role, starters: lu.starters, savedAt: lu.savedAt, carried: lu.carried, games: weeks[cur] || {} };
  }

  // Save a lineup for the current week.
  if (url.pathname === "/api/lineups/save") {
    const games = weeks[cur] || {};
    if (Number(body.week) !== cur) throw new HttpError(409, `Only week ${cur} lineups can be set right now.`);
    if (Object.keys(games).length && weekOver(games, now)) throw new HttpError(409, "This week is over.");
    const ros = roster(team);
    if (!ros.size) throw new HttpError(400, "Unknown team");
    const S = slots();
    const next = Array.isArray(body.starters) ? body.starters.map(x => (x ? String(x) : null)) : null;
    if (!next || next.length !== S.length) throw new HttpError(400, `Lineup must have ${S.length} slots.`);

    const seen = new Set();
    next.forEach((id, i) => {
      if (!id) return;
      const p = ros.get(id);
      if (!p) throw new HttpError(400, `Slot ${i + 1}: that player isn't on your roster.`);
      if (p.pos !== S[i]) throw new HttpError(400, `${p.name} can't play ${S[i]}.`);
      if (seen.has(id)) throw new HttpError(400, `${p.name} is in the lineup twice.`);
      seen.add(id);
    });

    // Locked players: whoever was starting stays, nobody locked gets added.
    const db = store();
    const prev = lineupFor(db, season, cur, team).starters.filter(Boolean);
    for (const id of prev) {
      const p = ros.get(id);
      if (isLocked(p, games, now) && !seen.has(id)) throw new HttpError(409, `${p.name}'s game has started. He has to stay in your lineup.`);
    }
    for (const id of seen) {
      const p = ros.get(id);
      if (isLocked(p, games, now) && !prev.includes(id)) throw new HttpError(409, `${p.name}'s game has started. He can't be added now.`);
    }

    db[season] = db[season] || {};
    db[season][cur] = db[season][cur] || {};
    db[season][cur][team] = { starters: next, savedAt: new Date(now).toISOString(), by: role };
    writeJson(LINEUPS_FILE, db);
    return { ok: true, week: cur, savedAt: db[season][cur][team].savedAt };
  }

  // Commissioner: every team's full lineup for a week (for entering into MFL).
  if (url.pathname === "/api/lineups/all") {
    if (role !== "commish") { recordMiss(ip); throw new HttpError(401, "Commissioner PIN required."); }
    const week = Number(body.week) || cur;
    const db = store();
    const teams = {};
    for (const t of L.teams) {
      const lu = lineupFor(db, season, week, t.id);
      teams[t.id] = { ...lu, starters: describe(lu.starters, t.id) };
    }
    return { week, slots: slots(), teams };
  }

  throw new HttpError(404, "Not found");
}

// ---- Static files ----------------------------------------------------------
// Only top-level site files are served; data/, server/ and scripts/ never are.

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

function serveStatic(url, res) {
  const name = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  const type = TYPES[path.extname(name).toLowerCase()];
  if (!type || name.includes("/") || name.includes("\\") || name.startsWith(".")) { res.writeHead(404); return res.end("Not found"); }
  fs.readFile(path.join(ROOT, name), (err, buf) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
    res.end(buf);
  });
}

// ---- Server ----------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", c => { data += c; if (data.length > 20000) { reject(new HttpError(413, "Too large")); req.destroy(); } });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new HttpError(400, "Bad JSON")); } });
    req.on("error", reject);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (!url.pathname.startsWith("/api/")) return serveStatic(url, res);
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress;
  try {
    const body = req.method === "POST" ? await readBody(req) : {};
    const out = await api(req, url, body, ip);
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(out));
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: status === 500 ? "Server error" : err.message }));
  }
}).listen(PORT, HOST, () => {
  console.log(`B5 site + lineups on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  if (!fs.existsSync(PINS_FILE)) console.log("No PINs yet. Run: node server/pins.js");
});
