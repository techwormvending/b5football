/* ESPN live stats adapter (LiveStatsSource). ESPN's JSON endpoints are public
   but UNOFFICIAL and undocumented: they can change without notice, so every
   field is read defensively, and the live source never throws. On trouble it
   keeps the last good numbers and reports `delayed`.

   Per game, two requests:
   - site summary  -> header (teams, score, status), box score (player yards,
     receptions, INTs thrown, XPs), team stats (net passing / rushing yards,
     sacks taken, INTs thrown).
   - core plays    -> every play with participants by ESPN athlete ID (passer,
     receiver, rusher, scorer, kicker, returner, patPasser, patScorer, ...),
     statYardage, scoreValue and the running score. Used for TDs (with
     length), FGs (distance), 2-pt, safeties, blocked kicks, fumble recoveries.

   Verified against nflverse for 2026 weeks 1-5 (scripts/verify-espn.mts). */

import { createHttp, type Http } from "./http.ts";
import { team } from "./teams.ts";
import { normalizeName } from "./names.ts";
import type { GameData, GameStatus, LiveStatsSource, LiveWeek, PlayerBox, PlayerRef, ScoringEvent, TdKind, TeamBox } from "./types.ts";

const PROVIDER = "espn";
const SITE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";
const CORE = "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl";

// ---- Raw shapes (only fields we read; all optional because ESPN guarantees nothing) ----
interface EspnAthleteStat { athlete?: { id?: string | number; displayName?: string }; stats?: string[] }
interface EspnStatCategory { name?: string; keys?: string[]; athletes?: EspnAthleteStat[] }
interface EspnCompetitor { homeAway?: string; score?: string; team?: { id?: string; abbreviation?: string } }
export interface EspnSummary {
  header?: {
    week?: number; season?: { year?: number };
    competitions?: { id?: string; status?: { type?: { state?: string; completed?: boolean } }; competitors?: EspnCompetitor[] }[];
  };
  boxscore?: {
    players?: { team?: { abbreviation?: string }; statistics?: EspnStatCategory[] }[];
    teams?: { team?: { abbreviation?: string }; statistics?: { name?: string; displayValue?: string }[] }[];
  };
  scoringPlays?: { id?: string; text?: string; type?: { text?: string }; team?: { abbreviation?: string }; homeScore?: number; awayScore?: number }[];
}
export interface EspnPlay {
  id?: string; sequenceNumber?: string;
  type?: { text?: string }; text?: string;
  awayScore?: number; homeScore?: number; scoreValue?: number; scoringPlay?: boolean;
  statYardage?: number; isPenalty?: boolean;
  team?: { $ref?: string };
  pointAfterAttempt?: { text?: string; value?: number };
  participants?: { type?: string; athlete?: { $ref?: string } }[];
}

class ShapeError extends Error {}

const athleteId = (ref?: string) => ref?.match(/athletes\/(\d+)/)?.[1];
const int = (s: string | undefined) => { const n = parseInt(s ?? "", 10); return Number.isFinite(n) ? n : 0; };

/** Build GameData from one game's summary and core plays. Throws ShapeError if the essentials are missing. */
export function gameFromEspn(summary: EspnSummary, plays: EspnPlay[]): GameData {
  const comp = summary.header?.competitions?.[0];
  const homeC = comp?.competitors?.find(c => c.homeAway === "home");
  const awayC = comp?.competitors?.find(c => c.homeAway === "away");
  if (!comp?.id || !homeC?.team?.abbreviation || !awayC?.team?.abbreviation) throw new ShapeError("summary header missing game id or teams");
  const home = team(homeC.team.abbreviation), away = team(awayC.team.abbreviation);
  const teamById = new Map<string, string>([[homeC.team.id ?? "", home], [awayC.team.id ?? "", away]]);
  const other = (t: string) => (t === home ? away : home);
  const state = comp.status?.type?.state;
  const status: GameStatus = state === "post" ? "final" : state === "in" ? "in_progress" : "scheduled";
  const warnings: string[] = [];

  // ---- Box score ----
  const refs = new Map<string, PlayerRef>();
  const boxes = new Map<string, PlayerBox>();
  const xps: { ref: PlayerRef; made: number }[] = [];
  for (const side of summary.boxscore?.players ?? []) {
    const t = side.team?.abbreviation ? team(side.team.abbreviation) : undefined;
    for (const cat of side.statistics ?? []) {
      const keys = cat.keys ?? [];
      const col = (k: string) => keys.indexOf(k);
      for (const a of cat.athletes ?? []) {
        const id = a.athlete?.id !== undefined ? String(a.athlete.id) : undefined;
        if (!id) continue;
        let ref = refs.get(id);
        if (!ref) { ref = { provider: PROVIDER, id, name: a.athlete?.displayName ?? id, ...(t ? { team: t } : {}) }; refs.set(id, ref); }
        const v = (k: string) => int(a.stats?.[col(k)]);
        const box = boxes.get(id) ?? { player: ref };
        switch (cat.name) {
          case "passing":
            box.passYds = (box.passYds ?? 0) + v("passingYards");
            box.interceptionsThrown = (box.interceptionsThrown ?? 0) + v("interceptions");
            break;
          case "rushing": box.rushYds = (box.rushYds ?? 0) + v("rushingYards"); break;
          case "receiving":
            box.recYds = (box.recYds ?? 0) + v("receivingYards");
            box.receptions = (box.receptions ?? 0) + v("receptions");
            break;
          case "kicking": {
            const made = int(a.stats?.[col("extraPointsMade/extraPointAttempts")]?.split("/")[0]);
            if (made) xps.push({ ref, made });
            break;
          }
        }
        if (["passing", "rushing", "receiving"].includes(cat.name ?? "")) boxes.set(id, box);
      }
    }
  }
  const refFor = (id: string | undefined, fallbackTeam?: string): PlayerRef | undefined => {
    if (!id) return undefined;
    return refs.get(id) ?? { provider: PROVIDER, id, name: `ESPN athlete ${id}`, ...(fallbackTeam ? { team: fallbackTeam } : {}) };
  };

  // ---- Team stats ----
  const teams: Record<string, TeamBox> = { [home]: {}, [away]: {} };
  const teamStat = new Map<string, Map<string, string>>();
  for (const ts of summary.boxscore?.teams ?? []) {
    if (!ts.team?.abbreviation) continue;
    teamStat.set(team(ts.team.abbreviation), new Map((ts.statistics ?? []).filter(s => s.name).map(s => [s.name!, s.displayValue ?? ""])));
  }
  for (const t of [home, away]) {
    const mine = teamStat.get(t), theirs = teamStat.get(other(t));
    const box = teams[t]!;
    if (mine?.has("netPassingYards")) box.netPassYds = int(mine.get("netPassingYards"));
    if (mine?.has("rushingYards")) box.rushYds = int(mine.get("rushingYards"));
    if (theirs) {
      box.sacks = int(theirs.get("sacksYardsLost")?.split("-")[0]);       // "3-22" = sacked 3 times
      box.interceptions = int(theirs.get("interceptions"));
    }
  }
  if (status !== "scheduled" && (!teamStat.get(home) || !teamStat.get(away))) warnings.push("team stats missing");

  // ---- Plays ----
  const events: ScoringEvent[] = xps.flatMap(x => Array.from({ length: x.made }, () => ({ kind: "xp" as const, team: x.ref.team ?? "", kicker: x.ref })));
  const teamOf = (id: string | undefined) => (id ? refs.get(id)?.team : undefined);
  const info = (p: EspnPlay) => {
    const rawText = p.text ?? "";
    // After a replay reversal, only the text after "REVERSED." describes what counted.
    const text = rawText.includes("REVERSED.") ? rawText.slice(rawText.lastIndexOf("REVERSED.") + 9) : rawText;
    const part = (type: string) => athleteId(p.participants?.find(x => x.type === type)?.athlete?.$ref);
    return {
      text, part, typeText: (p.type?.text ?? "").toLowerCase(),
      nullified: /NULLIFIED/i.test(text) || (!!p.isPenalty && /No Play/i.test(text)),
      offense: teamOf(part("passer")) ?? teamOf(part("rusher"))
    };
  };

  const scoringTeamById = new Map<string, string>();
  for (const sp of summary.scoringPlays ?? []) {
    try { if (sp.id && sp.team?.abbreviation) scoringTeamById.set(sp.id, team(sp.team.abbreviation)); } catch { /* reported below */ }
  }

  // Counting stats from every play (these don't depend on the score).
  for (const p of plays) {
    const { text, part, nullified } = info(p);
    if (nullified) continue;
    // Opponent fumble recoveries. NFL play-by-play capitalizes "RECOVERED by" only when
    // the other team recovers ("recovered by" = own recovery).
    let counted = 0;
    for (const m of text.matchAll(/RECOVERED by ([A-Z]{2,3})-/g)) {
      if (/FUMBLES|MUFFS/.test(text.slice(0, m.index))) {
        try { const t = team(m[1]!); const b = teams[t]; if (b) { b.fumbleRecoveries = (b.fumbleRecoveries ?? 0) + 1; counted++; } }
        catch { warnings.push(`unknown team in fumble recovery: ${m[1]}`); }
      }
    }
    // ESPN sometimes replaces the official text with a short summary ("X Fumble Y 0 Yd Fumble
    // Recovery") that has no "RECOVERED by". Fall back to fumbler vs recoverer teams, then to
    // an "(Opponent)" play type + the recoverer's team.
    const typeText = (p.type?.text ?? "").toLowerCase();
    // Only when the official description is missing (it says "recovered by" / "recovers"), and
    // only for plays ESPN labels as recoveries: its labels and roles can be wrong elsewhere (an
    // own-fumble TD labelled "Fumble Return Touchdown"; a sack safety listing the pass rusher as
    // "fumbler").
    // Official NFL wording always carries a team prefix ("recovered by HST-W.Marks") or "and recovers at".
    const officialText = /\b(?:recovered|RECOVERED) by [A-Z]{2,3}-|\band recovers at\b/.test(text);
    if (!counted && !officialText && /\(opponent\)|opp fumble|fumble return/.test(typeText)) {
      const fumbler = teamOf(part("fumbler")), rec = teamOf(part("recoverer"));
      let t: string | undefined;
      if (/\(opponent\)|opp fumble/.test(typeText)) {
        // The label itself says the opponent recovered. (Here ESPN's "fumbler" role is often the pass rusher.)
        t = rec ?? (info(p).offense ? other(info(p).offense!) : undefined);
        if (!t) warnings.push(`fumble recovery team unknown: ${text.slice(0, 80)}`);
      } else if (fumbler && rec && fumbler !== rec) t = rec;   // generic "Fumble Return": trust it only when the roles disagree on team
      if (t && teams[t]) teams[t]!.fumbleRecoveries = (teams[t]!.fumbleRecoveries ?? 0) + 1;
    }
    // Blocked field goals and punts (not PATs), credited to the team that didn't kick. On a
    // blocked kick returned for a TD, the listed "kicker" can be the scoring team's PAT kicker,
    // so the scoring team is the blocker.
    // Text first. ESPN's short summaries ("Blocked Kick Recovered by ...") need the play type,
    // but when the official text is there it wins (ESPN has labelled a missed, returned FG
    // "Blocked Field Goal").
    const officialKick = /field goal is|punts? \d+ yards?|punt is/i.test(text);
    const blocked = text.match(/(field goal|punt) is BLOCKED/i) ?? (officialKick ? null : typeText.match(/blocked (field goal|punt)/));
    if (blocked) {
      const isPunt = /punt/i.test(blocked[1]!);
      const kicking = isPunt ? teamOf(part("punter")) : teamOf(part("kicker"));
      const blocker = (p.id ? scoringTeamById.get(p.id) : undefined)
        ?? (kicking ? other(kicking) : (p.team?.$ref ? teamById.get(p.team.$ref.match(/teams\/(\d+)/)?.[1] ?? "") : undefined));
      if (blocker) {
        const k = /field goal/i.test(blocked[1]!) ? "blockedFgs" : "blockedPunts";
        teams[blocker]![k] = (teams[blocker]![k] ?? 0) + 1;
      } else warnings.push(`blocked kick team unknown: ${text.slice(0, 80)}`);
    }
  }

  // Scoring comes from the summary's scoring list (reliable team and running score);
  // the matching core play (same id) supplies participants, yardage and the PAT.
  // The core plays' own running score can lag a play behind, so it isn't used.
  const coreById = new Map(plays.filter(p => p.id).map(p => [p.id!, p]));
  let prevH = 0, prevA = 0;
  for (const sp of summary.scoringPlays ?? []) {
    const h = typeof sp.homeScore === "number" ? sp.homeScore : prevH;
    const a = typeof sp.awayScore === "number" ? sp.awayScore : prevA;
    const dH = h - prevH, dA = a - prevA;
    prevH = h; prevA = a;
    let scorer: string;
    try { scorer = sp.team?.abbreviation ? team(sp.team.abbreviation) : dH >= dA ? home : away; }
    catch { warnings.push(`unknown scoring team ${sp.team?.abbreviation}`); continue; }
    const pts = scorer === home ? dH : dA, otherD = scorer === home ? dA : dH;
    const p = sp.id ? coreById.get(sp.id) : undefined;
    if (!p) warnings.push(`scoring play ${sp.id} not in core plays: ${sp.text ?? ""}`);
    const { text, part, typeText, offense } = info(p ?? { text: sp.text ?? "", type: { text: sp.type?.text ?? "" } });

    // Field goal
    if (pts === 3) {
      const kicker = refFor(part("kicker"), scorer);
      const distance = typeof p?.statYardage === "number" && p.statYardage > 0 ? p.statYardage
        : int(text.match(/(\d+) yard field goal/i)?.[1] ?? sp.text?.match(/(\d+) Yd Field Goal/i)?.[1]);
      if (!kicker) warnings.push(`FG without kicker: ${sp.text ?? text}`);
      events.push({ kind: "fg", team: scorer, distance, ...(kicker ? { kicker } : {}) });
      continue;
    }

    // Touchdown (6, 7 or 8 points including the PAT)
    if (pts >= 6) {
      // The scorer must be on the scoring team (ESPN has listed the blocked kicker as the
      // "scorer" of a blocked-FG return). If the role is missing or wrong, take the player the
      // summary names, but only from this play's participants on the scoring team.
      let scorerRef = refFor(part("scorer"), scorer);
      if (scorerRef && scorerRef.team && scorerRef.team !== scorer) scorerRef = undefined;
      if (!scorerRef) {
        const named = normalizeName(sp.text?.match(/^(.+?) (?:\d+ Yd |Recovered |Fumble Recovery|Blocked )/)?.[1] ?? "");
        const cands = (p?.participants ?? []).map(x => refs.get(athleteId(x.athlete?.$ref) ?? "")).filter((r): r is PlayerRef => !!r && r.team === scorer && normalizeName(r.name) === named);
        if (named && cands.length >= 1 && new Set(cands.map(c => c.id)).size === 1) scorerRef = cands[0];
      }
      const length = typeof p?.statYardage === "number" ? p.statYardage : int(sp.text?.match(/ (\d+) Yd /)?.[1]);
      const returner = part("returner");
      // Participants beat the play label: ESPN has labelled a bobbled-but-caught TD pass
      // "Fumble Recovery (Own)", while listing passer, receiver = scorer.
      const sid = part("scorer");
      const passTd = /passing touchdown/.test(typeText) || (!!part("passer") && !!sid && sid === part("receiver"));
      const rushTd = /rushing touchdown/.test(typeText) || (!!sid && sid === part("rusher"));
      let td: TdKind;
      if (passTd && offense === scorer) td = "pass";
      else if (rushTd && offense === scorer) td = "rush";
      else if (/kickoff/.test(typeText)) td = part("scorer") && part("scorer") === returner ? "kickReturn" : "otherDefST";
      else if (/punt/.test(typeText) || /punt is BLOCKED/i.test(text)) {
        td = /block/.test(typeText) || /punt is BLOCKED/i.test(text) ? "blockedPuntReturn"
          : part("scorer") && part("scorer") === returner ? "puntReturn" : "defFumbleReturn";
      }
      else if (/field goal/.test(typeText)) {
        if (/field goal is BLOCKED/i.test(text) || /block/.test(typeText)) td = "blockedFgReturn";
        else { td = "otherDefST"; warnings.push(`missed field goal returned for a TD: ${text.slice(0, 80)}`); }
      }
      else if (/interception/.test(typeText)) td = offense === scorer ? "offFumbleRecovery" : "intReturn";
      else if (/fumble/.test(typeText)) td = offense === scorer ? "offFumbleRecovery" : "defFumbleReturn";
      else { td = "otherDefST"; warnings.push(`unclassified TD "${sp.type?.text}": ${(sp.text ?? text).slice(0, 80)}`); }

      const passer = td === "pass" ? refFor(part("passer"), scorer) : undefined;
      // Only warn where a fantasy player could be the scorer; defenders returning blocked kicks,
      // interceptions or fumbles score for the team defense, which is credited regardless.
      const fantasyRelevant = ["pass", "rush", "kickReturn", "puntReturn", "offFumbleRecovery", "otherDefST"].includes(td);
      if (!scorerRef && fantasyRelevant) warnings.push(`TD without scorer: ${(sp.text ?? text).slice(0, 80)}`);
      if (td === "pass" && !passer) warnings.push(`passing TD without passer: ${(sp.text ?? text).slice(0, 80)}`);
      events.push({ kind: "td", td, team: scorer, length, ...(scorerRef ? { scorer: scorerRef } : {}), ...(passer ? { passer } : {}) });

      // Two-point conversion on the same play. pointAfterAttempt.value is what the try was
      // worth, NOT whether it worked (failed tries can show value 2), so success comes from the
      // score (TD entry worth 8) or "ATTEMPT SUCCEEDS".
      const pat = p?.pointAfterAttempt;
      // Only the offense's try counts here; "DEFENSIVE TWO-POINT ATTEMPT ... ATTEMPT SUCCEEDS" is the defense's.
      const tryText = text.split(/DEFENSIVE TWO-POINT/i)[0]!;
      const twoGood = /ATTEMPT SUCCEEDS/i.test(tryText) || (pts === 8 && !/ATTEMPT FAILS/i.test(tryText));
      if (twoGood && /two point/i.test(pat?.text ?? "two point")) {
        if (/pass/i.test(pat?.text ?? "") || (!pat && / pass /i.test(text.slice(text.search(/TWO-POINT/i))))) {
          const pp = refFor(part("patPasser"), scorer), pr = refFor(part("patScorer"), scorer);
          events.push({ kind: "twoPt", team: scorer, method: "pass", ...(pp ? { passer: pp } : {}), ...(pr ? { receiver: pr } : {}) });
        } else {
          const pr = refFor(part("patScorer"), scorer);
          events.push({ kind: "twoPt", team: scorer, method: "rush", ...(pr ? { rusher: pr } : {}) });
        }
      } else if (pts === 8) warnings.push(`8-point TD but no successful two-point attempt recorded: ${(sp.text ?? text).slice(0, 80)}`);
      // Defensive two-point return on the PAT: the other team also scored 2 on this entry.
      if (otherD === 2) events.push({ kind: "defTwoPt", team: other(scorer) });
      continue;
    }

    if (pts === 2) {
      if (/safety/.test(typeText) || /safety/i.test(`${sp.type?.text} ${sp.text}`)) events.push({ kind: "safety", team: scorer });
      else events.push({ kind: "defTwoPt", team: scorer });      // standalone defensive conversion return
      continue;
    }
    warnings.push(`unhandled ${pts}-point scoring entry "${sp.type?.text}": ${(sp.text ?? "").slice(0, 100)}`);
  }

  return {
    provider: PROVIDER, gameId: comp.id,
    season: summary.header?.season?.year ?? 0, week: summary.header?.week ?? 0,
    home, away, homeScore: int(homeC.score), awayScore: int(awayC.score),
    status, players: [...boxes.values()], teams, events, warnings
  };
}

// ---- Live source ------------------------------------------------------------------

interface ScoreboardEvent { id?: string; date?: string; competitions?: { status?: { type?: { state?: string } }; competitors?: EspnCompetitor[] }[]; season?: { year?: number }; week?: { number?: number } }

export function espnLiveSource(opts: { cacheDir?: string; fetchImpl?: typeof fetch; minIntervalMs?: number; http?: Http; now?: () => number } = {}): LiveStatsSource {
  const http = opts.http ?? createHttp({
    headers: { "User-Agent": "b5-fantasy-site/0.1 (private league)" },
    minIntervalMs: opts.minIntervalMs ?? 250,
    maxRetries: 2,
    ...(opts.cacheDir ? { cacheDir: opts.cacheDir } : {}),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {})
  });
  const now = opts.now ?? Date.now;
  const lastGood = new Map<string, GameData>();     // gameId -> last successfully parsed data

  async function corePlays(id: string, cache: boolean): Promise<EspnPlay[]> {
    const out: EspnPlay[] = [];
    for (let page = 1; ; page++) {
      const r = await http.get<{ items?: EspnPlay[]; pageCount?: number }>(`${CORE}/events/${id}/competitions/${id}/plays?limit=1000&page=${page}`, { cache });
      if (!Array.isArray(r.items)) throw new ShapeError("core plays: no items array");
      out.push(...r.items);
      if (!r.pageCount || page >= r.pageCount) return out;
    }
  }

  return {
    name: PROVIDER,
    async currentWeek() {
      try {
        const sb = await http.get<{ season?: { year?: number; type?: number }; week?: { number?: number } }>(`${SITE}/scoreboard`);
        // type 2 = regular season. Preseason, playoffs and offseason aren't fantasy weeks here.
        if (sb.season?.type !== 2 || !sb.season.year || !sb.week?.number) return undefined;
        return { season: sb.season.year, week: sb.week.number };
      } catch { return undefined; }
    },
    async week(season, week): Promise<LiveWeek> {
      const errors: string[] = [];
      const fetchedAt = new Date(now()).toISOString();
      const stale = () => [...lastGood.values()].filter(g => g.season === season && g.week === week);
      let events: ScoreboardEvent[];
      try {
        const sb = await http.get<{ events?: ScoreboardEvent[] }>(`${SITE}/scoreboard?dates=${season}&seasontype=2&week=${week}`);
        if (!Array.isArray(sb.events)) throw new ShapeError("scoreboard: no events array");
        events = sb.events;
      } catch (err) {
        return { games: stale(), delayed: true, errors: [`scoreboard: ${(err as Error).message}`], fetchedAt };
      }

      const games: GameData[] = [];
      let delayed = false;
      for (const ev of events) {
        const id = ev.id;
        const state = ev.competitions?.[0]?.status?.type?.state;
        if (!id) { errors.push("scoreboard event without id"); continue; }
        if (state === "pre") {
          // Not started: no requests, just the matchup.
          const cs = ev.competitions?.[0]?.competitors ?? [];
          const h = cs.find(c => c.homeAway === "home")?.team?.abbreviation, a = cs.find(c => c.homeAway === "away")?.team?.abbreviation;
          if (h && a) games.push({ provider: PROVIDER, gameId: id, season, week, home: team(h), away: team(a), homeScore: 0, awayScore: 0, status: "scheduled", ...(ev.date ? { kickoff: new Date(ev.date).toISOString() } : {}), players: [], teams: {}, events: [], warnings: [] });
          continue;
        }
        const final = state === "post";
        try {
          // Finished games are cached on disk; live games are always re-fetched.
          const summary = await http.get<EspnSummary>(`${SITE}/summary?event=${id}`, { cache: final });
          const plays = await corePlays(id, final);
          const g = gameFromEspn(summary, plays);
          g.season ||= season; g.week ||= week;
          if (ev.date) g.kickoff = new Date(ev.date).toISOString();
          lastGood.set(id, g);
          games.push(g);
        } catch (err) {
          delayed = true;
          errors.push(`game ${id}: ${(err as Error).message}`);
          const prev = lastGood.get(id);
          if (prev) games.push(prev);
        }
      }
      return { games, delayed, errors, fetchedAt };
    }
  };
}
