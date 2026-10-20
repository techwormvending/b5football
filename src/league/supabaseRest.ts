/* Minimal Data API (PostgREST) client for server jobs, as service_role. No dependencies.
   The key comes from the environment (GitHub Actions secret); never from the repo. */

export interface SbConfig { url: string; serviceKey: string }

export function sbHeaders(cfg: SbConfig, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { apikey: cfg.serviceKey, "Content-Type": "application/json", ...extra };
  // Legacy service_role keys are JWTs and also go in Authorization; sb_secret_ keys go in apikey only.
  if (cfg.serviceKey.startsWith("eyJ")) h.Authorization = `Bearer ${cfg.serviceKey}`;
  return h;
}
export const sbBase = (cfg: SbConfig) => cfg.url.replace(/\/+$/, "").replace(/\/rest\/v1$/, "") + "/rest/v1/";

async function check(res: Response, what: string) {
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
}

/** Every row of a query, paged (the Data API caps a response at 1,000 rows). */
export async function selectAll<T>(cfg: SbConfig, table: string, query: string, fetchImpl: typeof fetch = fetch, page = 1000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += page) {
    const res = await fetchImpl(`${sbBase(cfg)}${table}?${query}`, { headers: sbHeaders(cfg, { Range: `${from}-${from + page - 1}`, "Range-Unit": "items" }) });
    await check(res, table);
    const rows = await res.json() as T[];
    out.push(...rows);
    if (rows.length < page) return out;
  }
}

/** Delete rows matching a PostgREST filter; returns how many went. */
export async function deleteWhere(cfg: SbConfig, table: string, filter: string, fetchImpl: typeof fetch = fetch): Promise<number> {
  const res = await fetchImpl(`${sbBase(cfg)}${table}?${filter}`, { method: "DELETE", headers: sbHeaders(cfg, { Prefer: "return=representation" }) });
  await check(res, `${table} delete`);
  return (await res.json() as unknown[]).length;
}

/** PATCH rows matching a filter. */
export async function updateWhere(cfg: SbConfig, table: string, filter: string, body: object, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(`${sbBase(cfg)}${table}?${filter}`, { method: "PATCH", headers: sbHeaders(cfg, { Prefer: "return=minimal" }), body: JSON.stringify(body) });
  await check(res, `${table} update`);
}
