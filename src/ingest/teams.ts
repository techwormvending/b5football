/* Canonical NFL team codes and the aliases providers use for them. */

export const TEAMS = [
  "ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN", "DET", "GB",
  "HOU", "IND", "JAX", "KC", "LAC", "LAR", "LV", "MIA", "MIN", "NE", "NO", "NYG",
  "NYJ", "PHI", "PIT", "SEA", "SF", "TB", "TEN", "WAS"
] as const;

const ALIASES: Record<string, string> = {
  // nflverse
  LA: "LAR",
  // MFL
  GBP: "GB", JAC: "JAX", KCC: "KC", LVR: "LV", NEP: "NE", NOS: "NO", SFO: "SF", TBB: "TB",
  // ESPN and others
  WSH: "WAS", BLT: "BAL", CLV: "CLE", HST: "HOU", ARZ: "ARI", OAK: "LV", SD: "LAC", STL: "LAR"
};

const KNOWN = new Set<string>(TEAMS);

/** Canonical team code, or throws so a bad mapping is caught instead of silently mis-scoring. */
export function team(code: string): string {
  const c = code.trim().toUpperCase();
  const t = ALIASES[c] ?? c;
  if (!KNOWN.has(t)) throw new Error(`Unknown NFL team code "${code}"`);
  return t;
}
