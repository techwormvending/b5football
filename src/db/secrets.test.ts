/* The repo is public: fail the build if a Supabase secret key, a service_role
   JWT or a private key ever lands in a tracked file. The publishable key in
   supabase-config.js is public by design and allowed. */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SKIP = new Set(["package-lock.json"]);

function trackedFiles(): string[] {
  try {
    // Tracked plus new not-yet-ignored files, so a secret is caught before its first commit.
    const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" });
    return out.split("\n").filter(Boolean);
  } catch {
    return [];   // not a git checkout: nothing to check
  }
}

const jwtPayload = (jwt: string) => {
  try { return JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>; }
  catch { return {}; }
};

test("no secret keys in the repo", () => {
  const hits: string[] = [];
  for (const f of trackedFiles()) {
    if (SKIP.has(path.basename(f)) || f.endsWith(".test.ts")) continue;
    const full = path.join(ROOT, f);
    if (!fs.existsSync(full) || fs.statSync(full).size > 2_000_000) continue;
    const text = fs.readFileSync(full, "utf8");
    if (/sb_secret_[A-Za-z0-9_-]{10,}/.test(text)) hits.push(`${f}: Supabase secret key (sb_secret_)`);
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) hits.push(`${f}: private key`);
    for (const m of text.matchAll(/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g)) {
      if (jwtPayload(m[0]).role === "service_role") hits.push(`${f}: service_role JWT`);
    }
  }
  assert.deepEqual(hits, [], "Secrets must live in GitHub Actions secrets / backend env vars, never in the repo");
});

test("the browser config holds only the public URL and publishable key", () => {
  const cfg = fs.readFileSync(path.join(ROOT, "supabase-config.js"), "utf8");
  assert.match(cfg, /publishableKey: "sb_publishable_[A-Za-z0-9_-]+"/);
  assert.doesNotMatch(cfg, /sb_secret_|service_role"?\s*:/);
});
