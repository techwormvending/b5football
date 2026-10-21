/* TEMPORARY (2026 shadow season; MFL is official). Remove with the other MFL code.
   MFL's public live-scoring export (TYPE=liveScoring, no login) gives every franchise's
   starters for the week and MFL's own live points. Used two ways:
   - Starters -> lineup_slots, refreshed until each player's kickoff: a starter whose game
     has kicked off keeps his slot (MFL locks him too); everyone else follows MFL. Runs from
     the pre-game job (pg_cron "b5-mfl-lineups") and from every live pass.
   - Our live points vs MFL's, per team and per starter -> live_compare (Commish page): the
     shadow-mode check during games. MFL's live numbers can trail ours by a few minutes. */

import { sbBase, sbHeaders, type SbConfig } from "../league/supabaseRest.ts";

const MFL = "https://www45.myfantasyleague.com";
const ORDER = ["QB", "RB", "RB", "WR", "WR", "WR", "TE", "K", "DEF"];
const IN_CHUNK = 120;

export interface MflFranchise { id: string; score: number; starters: { mflId: string; score: number }[] }
type Slot = { season: number; week: number; team_id: string; slot: number; player_id: string };

/** MFL starters (comma lists per franchise) -> lineup_slots rows, slotted QB RB RB WR WR WR TE K DEF by our positions. */
export function mirrorSlots(season: number, week: number, starters: { team: string; mflIds: string[] }[],
  map: Map<string, string>, position: Map<string, string>): { rows: { season: number; week: number; team_id: string; slot: number; player_id: string }[]; missing: string[] } {
  const rows: { season: number; week: number; team_id: string; slot: number; player_id: string }[] = [], missing: string[] = [];
  for (const s of starters) {
    const used = ORDER.map(() => false);
    for (const m of s.mflIds) {
      const pid = map.get(m);
      if (!pid) { missing.push(`${s.team}:${m}`); continue; }
      const pos = pid.startsWith("DEF:") ? "DEF" : position.get(pid);
      const i = ORDER.findIndex((p, k) => p === pos && !used[k]);
      if (i < 0) { missing.push(`${s.team}:${m}`); continue; }
      used[i] = true;
      rows.push({ season, week, team_id: s.team, slot: i, player_id: pid });
    }
  }
  return { rows, missing };
}

const arr = <T>(x: T | T[] | undefined | null): T[] => (x == null ? [] : Array.isArray(x) ? x : [x]);

/** liveScoring export -> each franchise's score and starters (MFL IDs with MFL's points). */
export function parseLiveScoring(j: unknown): MflFranchise[] {
  const ls = (j as { liveScoring?: { matchup?: unknown; franchise?: unknown } }).liveScoring ?? {};
  type F = { id?: string; score?: string; players?: { player?: unknown } };
  const fr = [...arr(ls.matchup as { franchise?: unknown } | { franchise?: unknown }[]).flatMap(m => arr(m.franchise as F | F[])), ...arr(ls.franchise as F | F[])];
  return fr.filter(f => f.id).map(f => ({
    id: f.id!, score: Number(f.score ?? 0),
    starters: arr(f.players?.player as { id?: string; score?: string; status?: string } | { id?: string; score?: string; status?: string }[])
      .filter(p => p.status === "starter" && p.id).map(p => ({ mflId: p.id!, score: Number(p.score ?? 0) }))
  }));
}

/** One team's mirrored lineup: starters whose game has kicked off stay where they are; the
    other slots follow MFL. A team with no lineup yet takes MFL's as is. `ignored` = MFL
    starters already kicked off that weren't ours (a change after kickoff; shows up in the
    comparison). */
export function mergeMirror(existing: Slot[], mfl: Slot[], locked: (playerId: string) => boolean): { rows: Slot[]; ignored: string[] } {
  if (!existing.length) return { rows: mfl, ignored: [] };
  const rows = existing.filter(r => locked(r.player_id));
  const taken = new Set(rows.map(r => r.slot)), have = new Set(rows.map(r => r.player_id)), ignored: string[] = [];
  for (const m of mfl) {
    if (have.has(m.player_id)) continue;
    if (locked(m.player_id)) { ignored.push(m.player_id); continue; }
    const slot = !taken.has(m.slot) ? m.slot : ORDER.findIndex((p, i) => p === ORDER[m.slot] && !taken.has(i));
    if (slot < 0) { ignored.push(m.player_id); continue; }
    taken.add(slot); have.add(m.player_id);
    rows.push({ ...m, slot });
  }
  return { rows: rows.sort((a, b) => a.slot - b.slot), ignored };
}

const sameLineup = (a: Slot[], b: Slot[]) => {
  const k = (x: Slot[]) => x.map(r => `${r.slot}:${r.player_id}`).sort().join(",");
  return k(a) === k(b);
};

export interface CompareRow {
  season: number; week: number; team_id: string; our_points: number; mfl_points: number;
  players: { player_id?: string; mfl_id?: string; name?: string; ours: number | null; mfl: number | null }[];
  diff_since: string | null; checked_at: string;
}

/** Our totals (our lineup x our points) vs MFL's, with every starter whose points differ. */
export function compareTeams(o: {
  season: number; week: number; at: string; franchises: MflFranchise[]; slots: Map<string, Slot[]>;
  map: Map<string, string>; ours: Map<string, number>; names: Map<string, string>; prevSince: Map<string, string | null>;
}): CompareRow[] {
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return o.franchises.map(f => {
    const mine = o.slots.get(f.id) ?? [];
    const our = r2(mine.reduce((s, x) => s + (o.ours.get(x.player_id) ?? 0), 0));
    const players: CompareRow["players"] = [];
    const mflPids = new Set<string>();
    for (const s of f.starters) {
      const pid = o.map.get(s.mflId);
      if (!pid) { players.push({ mfl_id: s.mflId, ours: null, mfl: s.score }); continue; }
      mflPids.add(pid);
      const ours = o.ours.get(pid) ?? 0;
      if (Math.abs(ours - s.score) >= 0.005) players.push({ player_id: pid, mfl_id: s.mflId, name: o.names.get(pid) ?? pid, ours, mfl: s.score });
    }
    for (const x of mine) if (!mflPids.has(x.player_id)) players.push({ player_id: x.player_id, name: o.names.get(x.player_id) ?? x.player_id, ours: o.ours.get(x.player_id) ?? 0, mfl: null });
    const differs = Math.abs(our - f.score) >= 0.005 || players.length > 0;
    return { season: o.season, week: o.week, team_id: f.id, our_points: our, mfl_points: r2(f.score), players,
      diff_since: differs ? (o.prevSince.get(f.id) ?? o.at) : null, checked_at: o.at };
  });
}

export interface MflLiveResult { teams: number; changedLineups: number; compared: number; missing: string[]; ignored: string[] }

/** Fetch MFL's live scoring, mirror starters (until kickoff), write the comparison. Throws on failure
    (callers keep the last mirrored lineups). */
export async function syncMflLive(o: { sb: SbConfig; fetch: typeof fetch; league: string; season: number; week: number; now: number }): Promise<MflLiveResult> {
  const { sb, season, week } = o;
  const at = new Date(o.now).toISOString();
  const UA = { "User-Agent": "b5-fantasy-site/0.1 (private league)" };
  const get = async <T>(u: string, headers: Record<string, string>): Promise<T> => {
    const r = await o.fetch(u, { headers });
    if (!r.ok) throw new Error(`${u.replace(/\?.*$/, "")}: HTTP ${r.status}`);
    return r.json() as Promise<T>;
  };
  const rest = <T>(p: string) => get<T>(sbBase(sb) + p, sbHeaders(sb));
  const write = async (p: string, method: string, body: unknown, prefer: string) => {
    const r = await o.fetch(sbBase(sb) + p, { method, headers: sbHeaders(sb, { Prefer: prefer }), body: body == null ? null : JSON.stringify(body) });
    if (!r.ok) throw new Error(`${p.replace(/\?.*$/, "")} ${method}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  };
  const inList = (ids: string[]) => encodeURIComponent(ids.map(i => `"${i.replace(/"/g, "")}"`).join(","));
  const chunks = <T>(a: T[]): T[][] => { const out: T[][] = []; for (let i = 0; i < a.length; i += IN_CHUNK) out.push(a.slice(i, i + IN_CHUNK)); return out; };

  const franchises = parseLiveScoring(await get(`${MFL}/${season}/export?TYPE=liveScoring&L=${o.league}&W=${week}&DETAILS=1&JSON=1`, UA))
    .filter(f => f.starters.length);
  const res: MflLiveResult = { teams: franchises.length, changedLineups: 0, compared: 0, missing: [], ignored: [] };
  if (!franchises.length) return res;

  const map = new Map<string, string>();
  for (const c of chunks([...new Set(franchises.flatMap(f => f.starters.map(s => s.mflId)))]))
    for (const r of await rest<{ mfl_id: string; player_id: string }[]>(`mfl_player_map?mfl_id=in.(${inList(c)})&select=mfl_id,player_id`)) map.set(r.mfl_id, r.player_id);
  const existing = await rest<Slot[]>(`lineup_slots?season=eq.${season}&week=eq.${week}&select=season,week,team_id,slot,player_id`);
  const pids = [...new Set([...map.values(), ...existing.map(e => e.player_id)])];
  const info = new Map<string, { name: string; position: string; nfl_team: string | null }>();
  for (const c of chunks(pids)) for (const r of await rest<{ id: string; name: string; position: string; nfl_team: string | null }[]>(`nfl_players?id=in.(${inList(c)})&select=id,name,position,nfl_team`)) info.set(r.id, r);
  const games = await rest<{ home: string; away: string; kickoff: string | null }[]>(`nfl_games?season=eq.${season}&week=eq.${week}&select=home,away,kickoff`);
  const kickoff = new Map<string, number>();
  for (const g of games) if (g.kickoff) for (const t of [g.home, g.away]) kickoff.set(t, Math.min(kickoff.get(t) ?? Infinity, Date.parse(g.kickoff)));
  const teamOf = (pid: string) => (pid.startsWith("DEF:") ? pid.slice(4) : info.get(pid)?.nfl_team ?? "");
  const locked = (pid: string) => (kickoff.get(teamOf(pid)) ?? Infinity) <= o.now;
  const position = new Map([...info].map(([id, p]) => [id, p.position]));

  const slots = new Map<string, Slot[]>();
  for (const f of franchises) {
    const mine = existing.filter(e => e.team_id === f.id);
    const { rows: mfl, missing } = mirrorSlots(season, week, [{ team: f.id, mflIds: f.starters.map(s => s.mflId) }], map, position);
    res.missing.push(...missing);
    const { rows, ignored } = mergeMirror(mine, mfl, locked);
    res.ignored.push(...ignored.map(p => `${f.id}:${p}`));
    slots.set(f.id, rows);
    if (sameLineup(mine, rows)) continue;
    await write(`lineup_slots?season=eq.${season}&week=eq.${week}&team_id=eq.${f.id}`, "DELETE", null, "return=minimal");
    if (rows.length) await write("lineup_slots", "POST", rows, "return=minimal");
    res.changedLineups++;
  }

  const ours = new Map<string, number>();
  const scored = [...new Set([...map.values(), ...[...slots.values()].flat().map(s => s.player_id)])];
  for (const c of chunks(scored)) for (const r of await rest<{ player_id: string; points: number }[]>(`player_scores?season=eq.${season}&week=eq.${week}&player_id=in.(${inList(c)})&select=player_id,points`)) ours.set(r.player_id, Number(r.points));
  const prev = await rest<{ team_id: string; diff_since: string | null }[]>(`live_compare?season=eq.${season}&week=eq.${week}&select=team_id,diff_since`);
  const names = new Map([...info].map(([id, p]) => [id, p.name]));
  const rows = compareTeams({ season, week, at, franchises, slots, map, ours, names, prevSince: new Map(prev.map(p => [p.team_id, p.diff_since])) });
  await write("live_compare?on_conflict=season,week,team_id", "POST", rows, "resolution=merge-duplicates,return=minimal");
  res.compared = rows.length;
  return res;
}
