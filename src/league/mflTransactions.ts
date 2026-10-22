/* TEMPORARY (2026: MFL is official for add/drops). MFL's public transactions export
   (TYPE=transactions, no login) -> rows for public.transactions (via 'mfl', status processed), so the
   site's transactions log and its 24-hour drop lock follow what happens on MFL. Rosters themselves
   are mirrored by the nightly roster sync. Remove with the other MFL code.
   MFL shapes (2026): FREE_AGENT {transaction: "ADDED,|DROPPED,"}, WAIVER {added: "ID,", dropped: "ID,"},
   TRADE {franchise, franchise2, franchise1_gave_up, franchise2_gave_up}; others (AUTO_PROCESS_WAIVERS,
   LOCK_ALL_PLAYERS, IR, TAXI...) aren't roster moves and are skipped. MFL player IDs map to ours
   through mfl_player_map; an unmapped player is kept as "mfl:<id>" (never guessed). */

export interface MflTxn { type?: string; timestamp?: string; franchise?: string; transaction?: string; added?: string; dropped?: string;
  franchise2?: string; franchise1_gave_up?: string; franchise2_gave_up?: string }
export interface TxnRow {
  season: number; team_id: string; type: "add" | "drop" | "add_drop" | "trade"; status: "processed"; via: "mfl";
  players_in: string[]; players_out: string[]; partner_team_id: string | null; created_at: string; decided_at: string; mfl_key: string; note: string | null;
}

const ids = (s: string | undefined) => String(s ?? "").split(",").map(x => x.trim()).filter(x => x && !x.startsWith("BB_") && /^\d+$/.test(x));

export function txnRows(season: number, list: MflTxn[], map: Map<string, string>): { rows: TxnRow[]; unmapped: string[] } {
  const rows: TxnRow[] = [], unmapped = new Set<string>();
  const ours = (id: string) => { const p = map.get(id); if (!p) unmapped.add(id); return p ?? `mfl:${id}`; };
  for (const t of list) {
    const at = t.timestamp ? new Date(Number(t.timestamp) * 1000).toISOString() : null;
    if (!at || !t.franchise) continue;
    const key = `${t.type}:${t.timestamp}:${t.franchise}:${t.transaction ?? `${t.added ?? ""}|${t.dropped ?? ""}|${t.franchise2 ?? ""}`}`;
    let inn: string[] = [], out: string[] = [], partner: string | null = null, type: TxnRow["type"];
    if (t.type === "FREE_AGENT") { const [a, d] = String(t.transaction ?? "").split("|"); inn = ids(a); out = ids(d); }
    else if (t.type === "WAIVER") { inn = ids(t.added); out = ids(t.dropped); }
    else if (t.type === "TRADE") { inn = ids(t.franchise2_gave_up); out = ids(t.franchise1_gave_up); partner = t.franchise2 ?? null; }
    else continue;
    if (!inn.length && !out.length) continue;
    type = t.type === "TRADE" ? "trade" : inn.length && out.length ? "add_drop" : inn.length ? "add" : "drop";
    rows.push({ season, team_id: t.franchise, type, status: "processed", via: "mfl", players_in: inn.map(ours), players_out: out.map(ours),
      partner_team_id: partner, created_at: at, decided_at: at, mfl_key: key, note: t.type === "WAIVER" ? "MFL waiver claim" : t.type === "TRADE" ? "MFL trade" : null });
  }
  return { rows, unmapped: [...unmapped] };
}
