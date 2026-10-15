/* nflverse adapter: play-by-play CSV -> GameData.
   Free, updated nightly (not live). Our source for final Tuesday scores,
   stat corrections and historical tests. Column docs:
   https://nflreadr.nflverse.com/articles/dictionary_pbp.html */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { parseCsv } from "./csv.ts";
import { team } from "./teams.ts";
import type { FinalStatsSource, GameData, PlayerRef, ScoringEvent, TdKind, TeamBox } from "./types.ts";

type Row = Record<string, string>;

const PROVIDER = "nflverse";
const num = (x: string | undefined) => (x === undefined || x === "" || x === "NA" ? 0 : Number(x));
const yes = (x: string | undefined) => num(x) === 1;
const has = (x: string | undefined): x is string => !!x && x !== "NA";

function ref(id: string | undefined, name: string | undefined, t?: string): PlayerRef | undefined {
  if (!has(id)) return undefined;
  return { provider: PROVIDER, id, name: has(name) ? name : id, ...(t ? { team: t } : {}) };
}

/** Classify a TD that isn't a passing or rushing TD. */
function specialTd(r: Row, scoringTeam: string, pos: string, def: string): { kind: TdKind; warn?: string } {
  const pt = r.play_type;
  if (scoringTeam === pos) {
    // nflverse: on kickoffs `posteam` is the RECEIVING team; on punts it's the punting team.
    if (pt === "kickoff") return { kind: "kickReturn" };
    if (pt === "punt") return { kind: "defFumbleReturn" };     // punting team recovers a muffed punt
    return { kind: "offFumbleRecovery" };                        // e.g. INT, fumbled back, offense scores
  }
  if (scoringTeam === def) {
    if (pt === "punt") return { kind: yes(r.punt_blocked) ? "blockedPuntReturn" : "puntReturn" };
    if (pt === "kickoff") return { kind: yes(r.fumble_lost) ? "defFumbleReturn" : "otherDefST" };
    if (pt === "field_goal") {
      if (r.field_goal_result === "blocked") return { kind: "blockedFgReturn" };
      return { kind: "otherDefST", warn: "missed field goal returned for a TD" };
    }
    if (yes(r.interception)) return { kind: "intReturn" };
    if (yes(r.fumble_lost)) return { kind: "defFumbleReturn" };
  }
  return { kind: "otherDefST", warn: `unclassified TD: ${r.desc?.slice(0, 120)}` };
}

/** Build one GameData per game from a week's play-by-play rows. */
export function gamesFromPbp(rows: Row[]): GameData[] {
  const byGame = new Map<string, Row[]>();
  for (const r of rows) {
    if (!has(r.game_id)) continue;
    let list = byGame.get(r.game_id);
    if (!list) { list = []; byGame.set(r.game_id, list); }
    list.push(r);
  }

  const games: GameData[] = [];
  for (const [gameId, plays] of byGame) {
    const first = plays[0]!;
    const home = team(first.home_team!), away = team(first.away_team!);
    const teams: Record<string, TeamBox> = { [home]: {}, [away]: {} };
    const boxes = new Map<string, Required<Omit<GameData["players"][number], "player">> & { player: PlayerRef }>();
    const events: ScoringEvent[] = [];
    const warnings: string[] = [];
    const tb = (t: string) => (teams[t] ??= {});
    const inc = (t: string, k: keyof TeamBox, v = 1) => { const b = tb(t); b[k] = (b[k] ?? 0) + v; };
    const box = (p: PlayerRef | undefined) => {
      if (!p) return undefined;
      let b = boxes.get(p.id);
      if (!b) { b = { player: p, passYds: 0, rushYds: 0, recYds: 0, receptions: 0, interceptionsThrown: 0 }; boxes.set(p.id, b); }
      return b;
    };
    tb(home).netPassYds = 0; tb(home).rushYds = 0;
    tb(away).netPassYds = 0; tb(away).rushYds = 0;

    for (const r of plays) {
      const pos = has(r.posteam) ? team(r.posteam) : "";
      const def = has(r.defteam) ? team(r.defteam) : "";
      const passer = ref(r.passer_player_id, r.passer_player_name, pos);
      const receiver = ref(r.receiver_player_id, r.receiver_player_name, pos);
      const rusher = ref(r.rusher_player_id, r.rusher_player_name, pos);
      const twoPt = yes(r.two_point_attempt);
      const scrimmage = ["pass", "run", "qb_kneel", "qb_spike"].includes(r.play_type ?? "");

      if (!twoPt) {
        const pb = box(passer), rb = box(receiver), ub = box(rusher);
        if (pb) { pb.passYds += num(r.passing_yards); if (yes(r.interception)) pb.interceptionsThrown++; }
        if (rb) { rb.recYds += num(r.receiving_yards); if (yes(r.complete_pass)) rb.receptions++; }
        if (ub) ub.rushYds += num(r.rushing_yards);
        const lr = box(ref(r.lateral_receiver_player_id, r.lateral_receiver_player_name, pos));
        if (lr) lr.recYds += num(r.lateral_receiving_yards);
        const lu = box(ref(r.lateral_rusher_player_id, r.lateral_rusher_player_name, pos));
        if (lu) lu.rushYds += num(r.lateral_rushing_yards);

        if (scrimmage && pos) {
          // Net passing = passing yards minus sack yardage (sacks have negative yards_gained).
          inc(pos, "netPassYds", num(r.passing_yards) + (yes(r.sack) ? num(r.yards_gained) : 0));
          inc(pos, "rushYds", num(r.rushing_yards) + num(r.lateral_rushing_yards));
        }
      }

      // Defensive counting stats
      if (def && yes(r.sack)) inc(def, "sacks");
      if (def && yes(r.interception)) inc(def, "interceptions");
      // Every fumble on the play that the other team recovered (handles INT -> fumble -> fumble chains).
      // nflverse keeps only two fumble slots, so in a longer chain the recovery that
      // changed possession can be missing; `fumble_lost` still says the ball was lost.
      const firstFumbler = r.fumbled_1_team;
      let byOpponent = 0;
      for (const i of ["1", "2"]) {
        const lost = r[`fumbled_${i}_team`], rec = r[`fumble_recovery_${i}_team`];
        if (has(lost) && has(rec) && lost !== rec) {
          inc(team(rec), "fumbleRecoveries");
          if (has(firstFumbler) && rec !== firstFumbler) byOpponent++;
        }
      }
      // Only for recorded chains: a fumble out of the end zone (touchback) is "lost" but nobody recovers it.
      const recorded = has(r.fumble_recovery_1_team) || has(r.fumble_recovery_2_team);
      if (yes(r.fumble_lost) && recorded && has(firstFumbler) && byOpponent === 0) {
        const fumbler = team(firstFumbler);
        inc(fumbler === home ? away : home, "fumbleRecoveries");
      }
      if (def && r.field_goal_result === "blocked") inc(def, "blockedFgs");
      if (def && yes(r.punt_blocked)) inc(def, "blockedPunts");

      // Scoring
      if (yes(r.touchdown) && has(r.td_team)) {
        const st = team(r.td_team);
        const scorer = ref(r.td_player_id, r.td_player_name, st);
        const length = num(r.yards_gained);
        if (yes(r.pass_touchdown)) events.push({ kind: "td", td: "pass", team: st, length, ...(scorer ? { scorer } : {}), ...(passer ? { passer } : {}) });
        else if (yes(r.rush_touchdown)) events.push({ kind: "td", td: "rush", team: st, length, ...(scorer ? { scorer } : {}) });
        else {
          const { kind, warn } = specialTd(r, st, pos, def);
          if (warn) warnings.push(warn);
          events.push({ kind: "td", td: kind, team: st, length: num(r.return_yards), ...(scorer ? { scorer } : {}) });
        }
      }
      const kicker = ref(r.kicker_player_id, r.kicker_player_name, pos);
      if (r.field_goal_result === "made" && pos) events.push({ kind: "fg", team: pos, distance: num(r.kick_distance), ...(kicker ? { kicker } : {}) });
      if (r.extra_point_result === "good" && pos) events.push({ kind: "xp", team: pos, ...(kicker ? { kicker } : {}) });
      if (twoPt && r.two_point_conv_result === "success" && pos) {
        if (yes(r.pass_attempt)) events.push({ kind: "twoPt", team: pos, method: "pass", ...(passer ? { passer } : {}), ...(receiver ? { receiver } : {}) });
        else events.push({ kind: "twoPt", team: pos, method: "rush", ...(rusher ? { rusher } : {}) });
      }
      if (yes(r.defensive_two_point_conv) && def) events.push({ kind: "defTwoPt", team: def });
      if (yes(r.safety) && def) events.push({ kind: "safety", team: def });
    }

    const last = plays[plays.length - 1]!;
    games.push({
      provider: PROVIDER, gameId,
      season: num(first.season), week: num(first.week),
      home, away, homeScore: num(last.home_score), awayScore: num(last.away_score),
      status: "final",
      ...(has(first.game_date) ? { gameDate: first.game_date } : {}),
      players: [...boxes.values()],
      teams, events, warnings
    });
  }
  return games;
}

const pbpUrl = (season: number) =>
  `https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_${season}.csv.gz`;

/** nflverse provider. Downloads a season's play-by-play once per `maxAgeHours` and caches it. */
export function nflverseProvider(opts: { cacheDir: string; maxAgeHours?: number; fetchImpl?: typeof fetch }): FinalStatsSource {
  const maxAge = (opts.maxAgeHours ?? 6) * 3600 * 1000;
  const doFetch = opts.fetchImpl ?? fetch;
  const seasons = new Map<number, Row[]>();

  async function seasonRows(season: number): Promise<Row[]> {
    const cached = seasons.get(season);
    if (cached) return cached;
    const file = path.join(opts.cacheDir, `pbp_${season}.csv.gz`);
    const fresh = fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < maxAge;
    if (!fresh) {
      const res = await doFetch(pbpUrl(season));
      if (!res.ok) throw new Error(`nflverse pbp ${season}: HTTP ${res.status}`);
      fs.mkdirSync(opts.cacheDir, { recursive: true });
      fs.writeFileSync(file + ".tmp", Buffer.from(await res.arrayBuffer()));
      fs.renameSync(file + ".tmp", file);
    }
    const rows = parseCsv(zlib.gunzipSync(fs.readFileSync(file)).toString("utf8"));
    seasons.set(season, rows);
    return rows;
  }

  return {
    name: PROVIDER,
    async week(season, week) {
      const rows = (await seasonRows(season)).filter(r => r.season_type === "REG" && num(r.week) === week);
      return gamesFromPbp(rows);
    }
  };
}
