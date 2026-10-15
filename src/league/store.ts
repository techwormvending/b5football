/* Score storage. `ScoreStore` is the interface the poller, finalizer and
   commissioner tools use; `jsonFileStore` implements it with JSON files until
   the Postgres layer exists (swap the implementation, keep the interface).

   Files (under the data dir):
     live/<season>-w<week>.json    latest live snapshot      (written only by the live poller)
     weeks/<season>-w<week>.json   week record: status, final snapshot, diff log
                                   (written by the finalizer and commissioner tools)
     overrides/<season>-w<week>.json  commissioner overrides     (written only by commissioner tools)
     review.json                   players flagged for commissioner review
     audit.jsonl                   append-only audit log
   Live and final live in separate files so the two processes never write the same file. */

import fs from "node:fs";
import path from "node:path";
import type { UnmatchedPlayer } from "../ingest/crosswalk.ts";
import type { DiffEntry, WeekSnapshot } from "./scores.ts";
import type { Override } from "./overrides.ts";

/** live: no final numbers yet. pending_review: nflverse numbers in, awaiting the commissioner. final: locked. */
export type WeekStatus = "live" | "pending_review" | "final";

export interface DiffLogEntry {
  at: string;
  /** live_vs_final: first nflverse numbers vs the last live numbers. correction: later nflverse update vs earlier final. */
  kind: "live_vs_final" | "correction";
  entries: DiffEntry[];
  note?: string;
}

export interface WeekRecord {
  season: number;
  week: number;
  status: WeekStatus;
  final?: WeekSnapshot;
  /** Games in the schedule that nflverse doesn't have yet (AWAY@HOME). Can't finalize until empty. */
  missingGames: string[];
  /** When the week auto-finalizes if the commissioner hasn't confirmed (ISO), if known. */
  autoFinalizeAt?: string;
  diffLog: DiffLogEntry[];
  finalizedAt?: string;
  finalizedBy?: string;
  updatedAt: string;
}

export interface ReviewItem extends UnmatchedPlayer { firstSeen: string; lastSeen: string; status: "open" | "resolved"; note?: string }

export interface AuditEntry { at: string; actor: string; action: string; season?: number; week?: number; details?: Record<string, unknown> }

export interface ScoreStore {
  getLive(season: number, week: number): Promise<WeekSnapshot | undefined>;
  putLive(snap: WeekSnapshot): Promise<void>;
  getWeek(season: number, week: number): Promise<WeekRecord | undefined>;
  putWeek(rec: WeekRecord): Promise<void>;
  listWeeks(season: number): Promise<WeekRecord[]>;
  /** Adds new unmatched players (deduped by provider + ID); returns how many were new. */
  addReviewItems(items: UnmatchedPlayer[], at: string): Promise<number>;
  listReview(): Promise<ReviewItem[]>;
  audit(e: AuditEntry): Promise<void>;
  listAudit(): Promise<AuditEntry[]>;
  /** All overrides for a week, active and removed. */
  listOverrides(season: number, week: number): Promise<Override[]>;
  saveOverrides(season: number, week: number, list: Override[]): Promise<void>;
}

export function jsonFileStore(dir: string): ScoreStore {
  const p = (...parts: string[]) => path.join(dir, ...parts);
  const read = <T,>(file: string): T | undefined => {
    try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; }
    catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw err; }
  };
  const write = (file: string, data: unknown) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
    fs.renameSync(tmp, file);           // atomic replace: readers never see half a file
  };
  const wk = (season: number, week: number) => `${season}-w${week}.json`;

  return {
    async getLive(s, w) { return read<WeekSnapshot>(p("live", wk(s, w))); },
    async putLive(snap) { write(p("live", wk(snap.season, snap.week)), snap); },
    async getWeek(s, w) { return read<WeekRecord>(p("weeks", wk(s, w))); },
    async putWeek(rec) { write(p("weeks", wk(rec.season, rec.week)), rec); },
    async listWeeks(season) {
      const d = p("weeks");
      if (!fs.existsSync(d)) return [];
      return fs.readdirSync(d).filter(f => f.startsWith(`${season}-w`) && f.endsWith(".json"))
        .map(f => read<WeekRecord>(path.join(d, f))!).filter(Boolean).sort((a, b) => a.week - b.week);
    },
    async addReviewItems(items, at) {
      if (!items.length) return 0;
      const list = read<ReviewItem[]>(p("review.json")) ?? [];
      let added = 0;
      for (const u of items) {
        const existing = list.find(r => r.provider === u.provider && r.providerId === u.providerId);
        if (existing) existing.lastSeen = at;
        else { list.push({ ...u, firstSeen: at, lastSeen: at, status: "open" }); added++; }
      }
      write(p("review.json"), list);
      return added;
    },
    async listReview() { return read<ReviewItem[]>(p("review.json")) ?? []; },
    async audit(e) {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(p("audit.jsonl"), JSON.stringify(e) + "\n");
    },
    async listOverrides(s, w) { return read<Override[]>(p("overrides", wk(s, w))) ?? []; },
    async saveOverrides(s, w, list) { write(p("overrides", wk(s, w)), list); },
    async listAudit() {
      if (!fs.existsSync(p("audit.jsonl"))) return [];
      return fs.readFileSync(p("audit.jsonl"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l) as AuditEntry);
    }
  };
}
