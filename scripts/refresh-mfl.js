#!/usr/bin/env node
/* Re-pulls standings, rosters and the schedule (with scores) from MFL and
   rewrites those blocks in league-data.js. Everything outside the
   "@mfl-begin / @mfl-end" markers is left alone.

   Usage:  node scripts/refresh-mfl.js
   Needs Node 18+ (built-in fetch). No dependencies. */

const fs = require("fs");
const path = require("path");

const LEAGUE_ID = "22689";
const YEAR = "2026";
const HOST = "https://www45.myfantasyleague.com";
const API_HOST = "https://api.myfantasyleague.com"; // MFL requires this host for TYPE=players
const ROOT = path.join(__dirname, "..");
const DATA_FILE = path.join(ROOT, "league-data.js");
const INDEX_FILE = path.join(ROOT, "index.html");

// Today's date in US Eastern, as YYYY-MM-DD
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
const list = (x) => (x == null ? [] : [].concat(x));

async function mfl(type, params = {}, host = HOST) {
  const qs = new URLSearchParams({ TYPE: type, L: LEAGUE_ID, JSON: "1", ...params });
  const url = `${host}/${YEAR}/export?${qs}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${type}: HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`${type}: ${json.error.$t || JSON.stringify(json.error)}`);
  return json;
}

// ---- Block builders (output format must match what app.js reads) ----------

function standingsBlock(data) {
  const rows = list(data.leagueStandings && data.leagueStandings.franchise);
  if (!rows.length) throw new Error("standings: no franchises returned");
  const lines = rows.map(f => "      " + JSON.stringify([f.id, +f.h2hw || 0, +f.h2hl || 0, +f.h2ht || 0, +f.pf || 0, +f.pa || 0]));
  return `  /* ---- Standings snapshot ---------------------------------------------- */
  // Static copy from MFL, in MFL's tiebreak order.
  standings: {
    asOf: "${today}",
    rows: [ // [franchiseId, W, L, T, PF, PA]
${lines.join(",\n")}
    ]
  },`;
}

function rostersBlock(rosterData, playerData) {
  const franchises = list(rosterData.rosters && rosterData.rosters.franchise);
  if (!franchises.length) throw new Error("rosters: no franchises returned");
  const byId = Object.fromEntries(list(playerData.players && playerData.players.player).map(p => [p.id, p]));
  const posMap = { QB: "QB", RB: "RB", WR: "WR", TE: "TE", PK: "K", Def: "DEF" };
  const order = ["QB", "RB", "WR", "TE", "K", "DEF"];
  const rank = (pos) => { const i = order.indexOf(pos); return i < 0 ? order.length : i; };
  const flip = (n) => { const [last, first] = n.split(", "); return first ? `${first} ${last}` : n; };
  const week = franchises[0].week || "";

  const teams = franchises.map(f => {
    const players = list(f.player).map(x => {
      const p = byId[x.id];
      if (!p) return [`Player #${x.id}`, "?", "", x.drafted || "", x.id];
      return [flip(p.name), posMap[p.position] || p.position, p.team, x.drafted || "", x.id];
    }).sort((a, b) => rank(a[1]) - rank(b[1]));
    return `      "${f.id}": [\n` + players.map(p => "        " + JSON.stringify(p)).join(",\n") + "\n      ]";
  });
  return `  /* ---- Rosters snapshot ------------------------------------------------ */
  // Static copy from MFL. MFL's API blocks browser calls from other sites,
  // so run scripts/refresh-mfl.js to update.
  // Each player: [name, position, NFL team, how acquired ("1.07" = round.pick, "Waiv" = waivers), MFL player ID]
  rosters: {
    asOf: "${today}",
    week: ${JSON.stringify(Number(week) || week)},
    teams: {
${teams.join(",\n")}
    }
  },`;
}

function scheduleBlock(data, regularSeasonWeeks) {
  const weeks = list(data.schedule && data.schedule.weeklySchedule);
  if (!weeks.length) throw new Error("schedule: no weeks returned");
  const num = (f) => (f.score != null && f.score !== "" ? Number(f.score) : null);
  const lines = weeks.map(w => {
    const games = list(w.matchup).map(m => {
      const fs = list(m.franchise);
      const away = fs.find(f => f.isHome === "0") || fs[0];
      const home = fs.find(f => f !== away) || {};
      return JSON.stringify([away.id, num(away), home.id, num(home)]);
    });
    return `      { week: ${Number(w.week)}, games: [` +
      (games.length ? "\n        " + games.join(",\n        ") + "\n      " : "") + "] }";
  });
  return `  /* ---- Schedule snapshot ----------------------------------------------- */
  // Static copy from MFL. Each game: [awayId, awayScore, homeId, homeScore];
  // scores are null until the week is played. Weeks with no games are playoffs (TBD).
  schedule: {
    asOf: "${today}",
    regularSeasonWeeks: ${regularSeasonWeeks},
    weeks: [
${lines.join(",\n")}
    ]
  },`;
}

// ---- File surgery ------------------------------------------------------------

function replaceBlock(src, name, body) {
  const begin = new RegExp(`^  // @mfl-begin ${name}\\b.*$`, "m");
  const end = new RegExp(`^  // @mfl-end ${name}\\s*$`, "m");
  const b = begin.exec(src), e = end.exec(src);
  if (!b || !e || e.index < b.index) throw new Error(`league-data.js: markers for "${name}" not found`);
  const start = b.index + b[0].length + 1; // keep the begin line
  return src.slice(0, start) + body + "\n" + src.slice(e.index);
}

async function main() {
  console.log(`Pulling MFL league ${LEAGUE_ID} (${YEAR})...`);
  const [standings, rosters, schedule] = await Promise.all([
    mfl("leagueStandings"), mfl("rosters"), mfl("schedule")
  ]);
  const ids = [...new Set(list(rosters.rosters && rosters.rosters.franchise)
    .flatMap(f => list(f.player).map(p => p.id)))];
  const players = await mfl("players", { PLAYERS: ids.join(",") }, API_HOST);

  // Keep the existing regular-season length if set; default 14.
  let src = fs.readFileSync(DATA_FILE, "utf8");
  const rsw = (src.match(/regularSeasonWeeks:\s*(\d+)/) || [])[1] || 14;

  src = replaceBlock(src, "standings", standingsBlock(standings));
  src = replaceBlock(src, "rosters", rostersBlock(rosters, players));
  src = replaceBlock(src, "schedule", scheduleBlock(schedule, rsw));

  // Sanity check: the new file must still load and have the data app.js needs.
  const sandbox = { window: {} };
  new Function("window", src)(sandbox.window);
  const L = sandbox.window.LEAGUE;
  if (!L || !L.standings.rows.length || !Object.keys(L.rosters.teams).length || !L.schedule.weeks.length) {
    throw new Error("generated league-data.js failed the sanity check; nothing written");
  }

  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, src);
  fs.renameSync(tmp, DATA_FILE);

  // Bust browser caches so visitors get the new data.
  const html = fs.readFileSync(INDEX_FILE, "utf8");
  const stamp = today.replace(/-/g, "") + "-" + Date.now().toString(36);
  const newHtml = html.replace(/league-data\.js(\?v=[^"']*)?(["'])/, `league-data.js?v=${stamp}$2`);
  if (newHtml !== html) fs.writeFileSync(INDEX_FILE, newHtml);

  const played = L.schedule.weeks.filter(w => w.games.length && w.games.every(g => g[1] != null)).length;
  const players_n = Object.values(L.rosters.teams).reduce((n, t) => n + t.length, 0);
  console.log(`Done (as of ${today}):`);
  console.log(`  standings  ${L.standings.rows.length} teams`);
  console.log(`  rosters    ${Object.keys(L.rosters.teams).length} teams, ${players_n} players (week ${L.rosters.week})`);
  console.log(`  schedule   ${L.schedule.weeks.length} weeks, ${played} with final scores`);
}

main().catch(err => { console.error("Refresh failed:", err.message); process.exit(1); });
