/* HTTP handler for the "notify" Supabase Edge Function (supabase/functions/notify).

   1. Sending (POST {nonce}): pg_cron's private.notify_tick() calls it only when something is due,
      with a one-time nonce (same scheme as b5-live: public.live_nonces, service_role only). It
      claims due items (public.notify_claim applies every rule: toggles, unread, presence, throttle,
      free-tier cap), sends each through Resend from "B5 Fantasy <noreply@b5football.win>", and
      reports each result (public.notify_done: a failure is retried once, then given up quietly).
   2. Unsubscribe (GET or POST ?u=<token>, no sign-in): the email footer's page and the
      List-Unsubscribe one-click POST both end in public.notify_unsubscribe(token).
   Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (provided by Supabase), RESEND_API_KEY (a Supabase
   secret set by the deploy workflow from the GitHub secret), SITE_URL (default https://b5football.win).
   No addresses or message contents are logged. */

import { consumeNonce } from "../live/edgeHandler.ts";
import { sbBase, sbHeaders, type SbConfig } from "../league/supabaseRest.ts";
import { KIND_LABEL, renderEmail, type NotifyItem, type NotifyKind } from "./email.ts";

export interface NotifyEnv { SUPABASE_URL?: string; SUPABASE_SERVICE_ROLE_KEY?: string; RESEND_API_KEY?: string; SITE_URL?: string }
export const FROM = "B5 Fantasy <noreply@b5football.win>";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const page = (title: string, body: string, status = 200) => new Response(
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>` +
  `<body style="font-family:Arial,sans-serif;max-width:480px;margin:40px auto;padding:0 16px;color:#151515"><h1 style="font-size:20px">${title}</h1><p>${body}</p></body></html>`,
  { status, headers: { "Content-Type": "text/html; charset=utf-8" } });

async function rpc(sb: SbConfig, fetchImpl: typeof fetch, name: string, body: object): Promise<Response> {
  return fetchImpl(`${sbBase(sb)}rpc/${name}`, { method: "POST", headers: sbHeaders(sb, { "Content-Type": "application/json" }), body: JSON.stringify(body) });
}

/** One email through Resend. Returns the provider id, or throws with a short reason. */
export async function sendResend(fetchImpl: typeof fetch, key: string, to: string, m: { subject: string; html: string; text: string; headers: Record<string, string> }): Promise<string> {
  const r = await fetchImpl("https://api.resend.com/emails", {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [to], subject: m.subject, html: m.html, text: m.text, headers: m.headers })
  });
  if (!r.ok) throw new Error(`Resend HTTP ${r.status}`);
  const j = (await r.json().catch(() => ({}))) as { id?: string };
  return j.id || "";
}

export async function handle(req: Request, env: NotifyEnv, fetchImpl: typeof fetch = fetch, now: () => number = Date.now): Promise<Response> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: "not configured" }, 500);
  const sb: SbConfig = { url: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY };
  const url = new URL(req.url), token = url.searchParams.get("u");
  if (token) {
    const r = await rpc(sb, fetchImpl, "notify_unsubscribe", { p_token: token });
    const kind = r.ok ? (await r.json()) as NotifyKind : null;
    if (req.method === "POST") return json(kind ? { ok: true } : { error: "invalid link" }, kind ? 200 : 400);
    return kind ? page("You're unsubscribed", `You won't get ${KIND_LABEL[kind]} emails from B5 anymore. You can turn them back on under Account &gt; Email notifications.`)
      : page("That link didn't work", "It may be old or incomplete. Sign in to B5 and use Account &gt; Email notifications instead.", 400);
  }
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let nonce = "";
  try { nonce = String(((await req.json()) as { nonce?: unknown }).nonce ?? ""); } catch { /* no body */ }
  if (!nonce || !(await consumeNonce(sb, nonce, fetchImpl, now()))) return json({ error: "unauthorized" }, 401);
  if (!env.RESEND_API_KEY) return json({ skipped: "RESEND_API_KEY is not set" });

  const c = await rpc(sb, fetchImpl, "notify_claim", { p_limit: 25 });
  if (!c.ok) return json({ error: `claim failed: HTTP ${c.status}` }, 500);
  const items = (await c.json()) as NotifyItem[];
  const site = env.SITE_URL || "https://b5football.win", functionsUrl = sb.url.replace(/\/+$/, "").replace(/\/rest\/v1$/, "") + "/functions/v1";
  let sent = 0, failed = 0;
  for (const item of items) {
    let ok = false, id: string | null = null, err: string | null = null;
    try { id = await sendResend(fetchImpl, env.RESEND_API_KEY, item.email, renderEmail(item, { site, functionsUrl })); ok = true; }
    catch (e) { err = (e as Error).message.slice(0, 200); }
    if (ok) sent++; else failed++;
    await rpc(sb, fetchImpl, "notify_done", { p_id: item.id, p_ok: ok, p_provider_id: id, p_error: err }).catch(() => null);
  }
  return json({ claimed: items.length, sent, failed });
}
