/* Email content for the "notify" Edge Function: one subject + HTML + plain text per queued item
   (public.notify_claim gives each item's data). Text only: message previews never include images,
   and everything from the database is HTML-escaped. Every email ends with how to reply (on the site:
   replying to the email isn't read), a one-click "Turn off these emails" link (signed token, no
   sign-in) and the email settings link; the List-Unsubscribe headers point at the function. */

export type NotifyKind = "dm" | "mentions" | "trades" | "waivers" | "announcements" | "lineup";
export interface Person { name?: string | null; team?: string | null }
export interface NotifyItem { id: number; user_id: string; kind: NotifyKind; email: string; token: string; data: Record<string, any> }   // eslint-disable-line @typescript-eslint/no-explicit-any
export interface Rendered { subject: string; html: string; text: string; headers: Record<string, string> }
export interface RenderOpts { site: string; functionsUrl: string }

export const KIND_LABEL: Record<NotifyKind, string> = {
  dm: "direct message", mentions: "@mention", trades: "trade", waivers: "waiver result", announcements: "announcement", lineup: "lineup reminder"
};
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const who = (p: Person | null | undefined) => !p ? "A league member" : p.team ? `${p.name || "A league member"} (${p.team})` : p.name || "A league member";
const names = (xs: string[]) => xs.length <= 1 ? xs.join("") : xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1];
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const et = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" }) + " ET";

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
    case "trades": {
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
      const subject = tag + (s[d.status] || "Trade update");
      return { subject, heading: subject, lines, button: "See the trade on B5" };
    }
    case "waivers": {
      const claims: { player: string; drop?: string | null; status: string; result?: string | null }[] = d.claims || [];
      const won = claims.filter(c => c.status === "won").length;
      return { subject: `Waiver results: ${won} of ${plural(claims.length, "claim")} won`, heading: "Waiver results",
        lines: claims.map(c => `${c.status === "won" ? "✅ Won" : c.status === "lost" ? "❌ Lost" : "⏭ Skipped"}: ${c.player}${c.drop ? ` (drop ${c.drop})` : ""}${c.result ? ` — ${c.result}` : ""}`),
        button: "See the results on B5" };
    }
    case "announcements":
      return { subject: `B5: ${d.title}`, heading: d.title || "League announcement", lines: [], quote: d.preview, button: "Read it on B5" };
    case "lineup": {
      const ps: { name: string; pos: string; problem: string; deadline: string }[] = d.players || [];
      return { subject: `Lineup check: ${plural(ps.length, "starter")} on bye or out (week ${d.week})`, heading: `Lineup check for ${d.team}, week ${d.week}`,
        lines: ps.map(p => `${p.pos} ${p.name}: ${p.problem === "bye" ? "on bye" : p.problem.toUpperCase()} (swap by ${et(p.deadline)})`), button: "Set your lineup" };
    }
  }
}

export function renderEmail(item: NotifyItem, o: RenderOpts): Rendered {
  const b = content(item);
  const site = o.site.replace(/\/+$/, "");
  const link = site + "/" + String(item.data?.link || "#home").replace(/^\/?/, "");
  const off = `${site}/#unsubscribe/${item.token}`, settings = `${site}/#account`;
  const replyNote = "Replying to this email isn't supported: use the button above to answer on B5.";
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
You get these because ${esc(KIND_LABEL[item.kind])} emails are on for your B5 account.
<a href="${esc(off)}" style="color:#666">Turn off these emails</a> · <a href="${esc(settings)}" style="color:#666">Email settings</a>
</td></tr></table></td></tr></table></body></html>`;
  const text = [b.heading, "", ...b.lines, ...(b.quote ? ["", `"${b.quote}"`] : []), "", `${b.button}: ${link}`, "", "--", replyNote,
    `Turn off these emails: ${off}`, `Email settings: ${settings}`].join("\n");
  return { subject: b.subject.slice(0, 180), html, text,
    headers: { "List-Unsubscribe": `<${o.functionsUrl.replace(/\/+$/, "")}/notify?u=${encodeURIComponent(item.token)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } };
}
