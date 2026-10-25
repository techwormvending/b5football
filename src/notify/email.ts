/* Email content for the "notify" Edge Function: one subject + HTML + plain text per queued item
   (public.notify_claim gives each item's data). Text only: message previews never include images,
   and everything from the database is HTML-escaped. Every email ends with how to reply (on the site:
   replying to the email isn't read), why the person got it (the setting, with a link to it), a
   one-click "Turn off these emails" link (signed token, no sign-in) and the List-Unsubscribe headers. */

export type NotifyKind = "dm" | "mentions" | "trades" | "waivers" | "announcements" | "lineup"
  | "lineup_saved" | "league_lineups" | "league_trades" | "league_waivers" | "league_moves" | "scoring" | "account";
export interface Person { name?: string | null; team?: string | null }
export interface NotifyItem { id: number; user_id: string; kind: NotifyKind; email: string; token: string; data: Record<string, any> }   // eslint-disable-line @typescript-eslint/no-explicit-any
export interface Rendered { subject: string; html: string; text: string; headers: Record<string, string> }
export interface RenderOpts { site: string; functionsUrl: string }

/** The setting each email type belongs to (Account > Email notifications), as the user sees it. */
export const SETTING: Record<NotifyKind, string> = {
  dm: "Direct messages", mentions: "@mentions", trades: "My trades", league_trades: "All league trades",
  waivers: "My waiver results", league_waivers: "League-wide waiver results", league_moves: "League first-come adds/drops",
  lineup_saved: "My lineup confirmation", league_lineups: "Other teams' lineups", lineup: "Lineup reminders (bye/out starters)",
  scoring: "Daily scoring update", announcements: "Commissioner announcements and messages", account: "Account notices"
};
/** Short label for "You won't get <label> emails anymore". */
export const KIND_LABEL: Record<NotifyKind, string> = {
  dm: "direct message", mentions: "@mention", trades: "trade", league_trades: "league trade", waivers: "waiver result",
  league_waivers: "league waiver result", league_moves: "league add/drop", lineup_saved: "lineup confirmation",
  league_lineups: "other teams' lineup", lineup: "lineup reminder", scoring: "daily scoring", announcements: "commissioner", account: "account notice"
};
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const who = (p: Person | null | undefined) => !p ? "A league member" : p.team ? `${p.name || "A league member"} (${p.team})` : p.name || "A league member";
const names = (xs: string[]) => xs.length <= 1 ? xs.join("") : xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1];
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const et = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" }) + " ET";
const pts = (x: unknown) => x == null ? "–" : Number(x).toFixed(1);

/** A waiver claim's result in plain words. */
export function waiverReason(status: string, result: string | null | undefined): string {
  const r = String(result || "");
  if (status === "won") return /^Round (\d+)/.test(r) ? `won in round ${r.replace(/^Round /, "")}` : "won";
  if (/lock/i.test(r)) return "player locked (his game had started)";
  let m = /^Claimed by (.+)$/.exec(r);
  if (m) return `outbid on priority: ${m[1]} had a higher waiver priority`;
  if (/^Roster full/.test(r)) return "roster full and no player to drop";
  if (/^Not reached/.test(r)) return "not reached: the rounds ran out first";
  if (/drop is no longer/.test(r)) return "the player you'd drop was no longer on your roster";
  m = /^Already on your roster$/.exec(r);
  return m ? "already on your roster" : r || status;
}

interface Starter { slot: string; name: string; nfl?: string | null }
const lineupLines = (d: Record<string, any>): string[] => [   // eslint-disable-line @typescript-eslint/no-explicit-any
  ...((d.starters || []) as Starter[]).map(s => `${s.slot} ${s.name}${s.nfl ? ` (${s.nfl})` : ""}`),
  ...((d.empty || []).length ? [`⚠ ${(d.empty as string[]).length} empty slot${(d.empty as string[]).length > 1 ? "s" : ""} (${(d.empty as string[]).join(", ")}) — scores 0 points`] : []),
  ...((d.bench || []).length ? [`Bench: ${(d.bench as { name: string }[]).map(b => b.name).join(", ")}`] : []),
  ...((d.warnings || []) as { name: string; problem: string }[]).map(w => `⚠ ${w.name}: ${w.problem === "bye" ? "on bye" : w.problem.toUpperCase()}`)
];

interface Body { subject: string; heading: string; lines: string[]; quote?: string; button: string }

/** Subject and body lines (plain text; escaped when turned into HTML). */
export function content(item: NotifyItem): Body {
  const d = item.data || {};
  switch (item.kind) {
    case "dm": {
      const senders: Person[] = d.senders || [], n = Number(d.count || 1);
      const from = senders.length === 1 ? who(senders[0]) : names(senders.map(s => s.name || "A league member"));
      return { subject: n === 1 ? `New message from ${from}` : `${n} new messages from ${from}`, heading: n === 1 ? `New message from ${from}` : `${n} new messages from ${from}`,
        lines: n > 1 ? ["Latest:"] : [], quote: d.preview, button: "Reply on B5" };
    }
    case "mentions":
      return { subject: `${who(d.from)} mentioned you in ${d.where}`, heading: `${who(d.from)} mentioned you in ${d.where}`, lines: d.title ? [`Thread: ${d.title}`] : [], quote: d.preview, button: "Open on B5" };
    case "trades":
    case "league_trades": {
      const tag = d.test ? "[TEST] " : "";
      const s: Record<string, string> = {
        proposed: `Trade proposal from ${d.from_team}`, accepted: "Trade accepted: waiting for the commissioner", approved: "Trade approved",
        rejected: "Trade rejected by the commissioner", declined: `${d.to_team} declined the trade`, withdrawn: `${d.from_team} withdrew the trade`, expired: "Trade proposal expired" };
      const lines = [`${d.summary}.`];
      if (d.note && d.status === "proposed") lines.push(`Note: "${d.note}"`);
      if (d.status === "proposed" && d.expires_at) lines.push(`Answer by ${et(d.expires_at)}.`);
      if (d.decision_note && (d.status === "approved" || d.status === "rejected")) lines.push(`Commissioner: "${d.decision_note}"`);
      if (d.status === "accepted" && d.commissioner_party) lines.push("The commissioner owns one of these teams: the decision is flagged and audited.");
      if (d.test) lines.push("Test trade: MFL is official for 2026, so rosters don't change.");
      const subject = tag + (item.kind === "league_trades" ? `League trade completed: ${d.from_team} and ${d.to_team}` : s[d.status] || "Trade update");
      return { subject, heading: subject, lines, button: "See the trade on B5" };
    }
    case "waivers": {
      const claims: { player: string; drop?: string | null; status: string; result?: string | null }[] = d.claims || [];
      const won = claims.filter(c => c.status === "won").length;
      return { subject: `Waiver results: ${won} of ${plural(claims.length, "claim")} won`, heading: "Your waiver results",
        lines: claims.map(c => `${c.status === "won" ? "✅" : c.status === "lost" ? "❌" : "⏭"} ${c.player}${c.drop ? ` (drop ${c.drop})` : ""}: ${waiverReason(c.status, c.result)}`),
        button: "See the results on B5" };
    }
    case "league_waivers": {
      const won: { team: string; player: string; drop?: string | null }[] = d.won || [];
      return { subject: `League waivers: ${plural(won.length, "claim")} won`, heading: "Waiver results around the league",
        lines: won.map(w => `${w.team}: + ${w.player}${w.drop ? `, − ${w.drop}` : ""}`).concat(d.claims ? [`${d.claims} claims in this run.`] : []), button: "See all results" };
    }
    case "league_moves": {
      const mv: { team: string; added?: string | null; dropped?: string | null }[] = d.moves || [];
      return { subject: `League adds/drops: ${plural(mv.length, "move")}`, heading: "First-come-first-served moves (the last hour)",
        lines: mv.map(m => `${m.team}: ${[m.added ? `+ ${m.added}` : "", m.dropped ? `− ${m.dropped}` : ""].filter(Boolean).join(", ")}`), button: "See the transactions" };
    }
    case "announcements": {
      if (d.commissioner === "lineup") return { subject: `From the commissioner: your week ${d.week} lineup`, heading: `${d.team}: week ${d.week} lineup`,
        lines: [d.saved_by ? `Last saved by ${d.saved_by}${d.saved_at ? `, ${et(d.saved_at)}` : ""}.` : "Not submitted on the site yet.", ...lineupLines(d)], button: "Open My Team" };
      if (d.commissioner === "reminder") return { subject: `Reminder: set your week ${d.week} lineup`, heading: `${d.team}: your week ${d.week} lineup isn't submitted yet`,
        lines: [d.first_kickoff ? `The week's next kickoff: ${et(d.first_kickoff)}. Each player locks at his own kickoff.` : "Each player locks at his own kickoff."], button: "Set your lineup" };
      return { subject: `B5: ${d.title}`, heading: d.title || "League announcement", lines: [], quote: d.preview, button: "Read it on B5" };
    }
    case "lineup": {
      const ps: { name: string; pos: string; problem: string; deadline: string }[] = d.players || [];
      return { subject: `Lineup check: ${plural(ps.length, "starter")} on bye or out (week ${d.week})`, heading: `Lineup check for ${d.team}, week ${d.week}`,
        lines: ps.map(p => `${p.pos} ${p.name}: ${p.problem === "bye" ? "on bye" : p.problem.toUpperCase()} (swap by ${et(p.deadline)})`), button: "Set your lineup" };
    }
    case "lineup_saved":
      return { subject: `${d.test ? "TEST lineup" : "Lineup"} saved: ${d.team}, week ${d.week}`, heading: `${d.team}: week ${d.week} ${d.test ? "TEST lineup" : "lineup"} saved`,
        lines: [...(d.test ? ["TEST lineup: MFL is official for 2026."] : []), `Saved by ${d.saved_by || "an owner"}${d.saved_at ? `, ${et(d.saved_at)}` : ""}.`, ...lineupLines(d)], button: "Open My Team" };
    case "league_lineups": {
      const teams: (Record<string, any> & { team: string; by?: string; at?: string })[] = d.teams || [];   // eslint-disable-line @typescript-eslint/no-explicit-any
      const lines = teams.flatMap(t => [`${t.team} (week ${t.week}, by ${t.by || "an owner"}${t.at ? `, ${et(t.at)}` : ""}):`,
        ((t.starters || []) as Starter[]).map(s => `${s.slot} ${s.name}`).join(" · ")]);
      return d.mode === "instant"
        ? { subject: `${teams[0]?.team ?? "A team"} changed their lineup`, heading: `${teams[0]?.team ?? "A team"} changed their lineup`, lines, button: "See the team" }
        : { subject: `Lineup changes: ${plural(teams.length, "team")}`, heading: "Lineup changes since the last digest", lines, button: "See the teams" };
    }
    case "account": {
      if (d.type === "test") return { subject: "B5 test email", heading: "Your B5 email works", lines: ["This is the test email an administrator asked for. Nothing else to do."], button: "Open B5" };
      const role = d.role === "admin" ? "administrator" : "commissioner";
      return d.action === "grant"
        ? { subject: `You're now a B5 ${role}`, heading: `You're now a B5 ${role}`, lines: [`${d.by} gave you the ${role} role.`, d.role === "admin" ? "Your tools are on the Admin page." : "Your tools are on the Commish page."], button: "Open B5" }
        : { subject: `Your B5 ${role} role was removed`, heading: `Your B5 ${role} role was removed`, lines: [`${d.by} removed your ${role} role.`], button: "Open B5" };
    }
    case "scoring": {
      const tag = d.unofficial ? " (unofficial)" : "";
      const day = new Date(String(d.day) + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
      const lines: string[] = [];
      if (d.mine) lines.push(`Your matchup: ${d.mine.team} ${pts(d.mine.us)}, ${d.mine.opp} ${pts(d.mine.them)}`);
      lines.push(...((d.matchups || []) as { away: string; away_score: number; home: string; home_score: number }[]).map(m => `${m.away} ${pts(m.away_score)} @ ${m.home} ${pts(m.home_score)}`));
      if (d.high) lines.push(`Weekly high ($35 race): ${d.high.team}, ${pts(d.high.points)}`);
      if (d.danger) lines.push(`Guillotine danger (lowest so far): ${d.danger.team}, ${pts(d.danger.points)}`);
      for (const c of (d.corrections || []) as { was: string; now: string }[]) lines.push(`Stat correction changed a result: ${c.was} → ${c.now} now wins.`);
      if (d.unofficial) lines.push("Scores are unofficial until the week is finalized.");
      return { subject: `Week ${d.week} scores after ${day}${tag}`, heading: `Week ${d.week} scores after ${day}${tag}`, lines, button: "Open Live scoring" };
    }
  }
}

export function renderEmail(item: NotifyItem, o: RenderOpts): Rendered {
  const b = content(item);
  const site = o.site.replace(/\/+$/, "");
  const link = site + "/" + String(item.data?.link || "#home").replace(/^\/?/, "");
  const off = `${site}/#unsubscribe/${item.token}`, settings = `${site}/#account/email`;
  const replyNote = "Replying to this email isn't supported: use the button above to answer on B5.";
  const notice = item.kind === "account";   // role changes and test emails: always sent, no unsubscribe
  const why = notice ? "Why you got this: it's a notice about your B5 account (these always go out)." : `Why you got this: "${SETTING[item.kind]}" is on in your B5 email settings.`;
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f4f1;font-family:Arial,Helvetica,sans-serif;color:#151515">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:10px;overflow:hidden">
<tr><td style="background:#0b0b0b;padding:14px 20px;color:#FFB612;font-weight:bold;font-size:18px;letter-spacing:1px">B5 FANTASY</td></tr>
<tr><td style="padding:22px 20px">
<h1 style="font-size:20px;margin:0 0 12px">${esc(b.heading)}</h1>
${b.lines.map(l => `<p style="margin:0 0 8px;font-size:15px;line-height:1.45">${esc(l)}</p>`).join("\n")}
${b.quote ? `<blockquote style="margin:12px 0;padding:10px 14px;border-left:4px solid #FFB612;background:#f7f7f4;font-size:15px;line-height:1.45">${esc(b.quote)}</blockquote>` : ""}
<p style="margin:20px 0 4px"><a href="${esc(link)}" style="display:inline-block;background:#FFB612;color:#0b0b0b;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:6px">${esc(b.button)}</a></p>
</td></tr>
<tr><td style="padding:14px 20px;border-top:1px solid #e6e6e1;font-size:12px;color:#666;line-height:1.5">
${esc(replyNote)}<br>
${esc(why)}${notice ? "" : ` <a href="${esc(settings)}" style="color:#666">Change this setting</a><br>
<a href="${esc(off)}" style="color:#666">Turn off these emails</a>`}
</td></tr></table></td></tr></table></body></html>`;
  const text = [b.heading, "", ...b.lines, ...(b.quote ? ["", `"${b.quote}"`] : []), "", `${b.button}: ${link}`, "", "--", replyNote,
    why, ...(notice ? [] : [`Change this setting: ${settings}`, `Turn off these emails: ${off}`])].join("\n");
  return { subject: b.subject.slice(0, 180), html, text,
    headers: notice ? {} : { "List-Unsubscribe": `<${o.functionsUrl.replace(/\/+$/, "")}/notify?u=${encodeURIComponent(item.token)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } };
}
