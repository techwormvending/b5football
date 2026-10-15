/* Player-name normalization for matching players across providers
   ("D.J. Moore" = "DJ Moore", "Michael Penix Jr." = "Michael Penix"). */

const SUFFIX = /\b(jr|sr|ii|iii|iv|v)\b\.?$/;

export function normalizeName(name: string): string {
  return name
    .normalize("NFD").replace(/[̀-ͯ]/g, "")   // strip accents
    .toLowerCase()
    .replace(/[.'’`]/g, "")
    .replace(/[^a-z0-9 -]/g, " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(SUFFIX, "")
    .trim();
}
