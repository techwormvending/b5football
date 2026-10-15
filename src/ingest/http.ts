/* Shared HTTP helper for paid stats APIs: spacing between requests (rate
   limits), retry with backoff on 429/5xx, and an optional on-disk cache for
   responses that won't change (finished games). */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface HttpOptions {
  headers: Record<string, string>;
  /** Minimum milliseconds between requests (e.g. 12000 for a 5/min trial key). */
  minIntervalMs?: number;
  cacheDir?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

export interface Http {
  /** GET JSON. `cache: true` stores the response on disk and reuses it. */
  get<T = unknown>(url: string, opts?: { cache?: boolean }): Promise<T>;
}

export function createHttp(o: HttpOptions): Http {
  const doFetch = o.fetchImpl ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const maxRetries = o.maxRetries ?? 5;
  let last = 0;

  const cacheFile = (url: string) => o.cacheDir && path.join(o.cacheDir, crypto.createHash("sha1").update(url).digest("hex") + ".json");

  return {
    async get<T>(url: string, opts: { cache?: boolean } = {}): Promise<T> {
      const file = opts.cache ? cacheFile(url) : undefined;
      if (file && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8")).body as T;

      for (let attempt = 0; ; attempt++) {
        const wait = (o.minIntervalMs ?? 0) - (Date.now() - last);
        if (wait > 0) await sleep(wait);
        last = Date.now();
        const res = await doFetch(url, { headers: o.headers });
        if (res.ok) {
          const body = (await res.json()) as T;
          if (file) {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, JSON.stringify({ url, fetchedAt: new Date().toISOString(), body }));
          }
          return body;
        }
        const retryable = res.status === 429 || res.status >= 500;
        if (!retryable || attempt >= maxRetries) {
          const text = await res.text().catch(() => "");
          throw new Error(`GET ${url.replace(/\?.*/, "")}: HTTP ${res.status} ${text.slice(0, 200)}`);
        }
        const after = Number(res.headers.get("retry-after"));
        await sleep(after > 0 ? after * 1000 : Math.min(60000, 1000 * 2 ** attempt));
      }
    }
  };
}
