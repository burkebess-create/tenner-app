// process-notifications — cron every 15 min.
// Reads pending notification_queue rows, verifies referenced content still
// exists, groups by recipient, applies cadence preference, sends digest emails.
//
// Cadence rules:
//   immediate  → send as soon as row is >= 1 hour old (safety window against
//                created-then-deleted lists / posted-then-deleted comments)
//   daily      → send once per UTC day at ≥13:00 UTC, batching everything since last send
//   weekly     → send once per week on Sunday at ≥13:00 UTC
//
// Uses email_log to dedupe daily/weekly runs so a cron running every 15 min
// doesn't send multiple digests per day.

// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const APP_URL = "https://mytenner.com/";
const SAFETY_WINDOW_MS = 60 * 60 * 1000; // 1 hour

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function escapeHtml(str: string) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function baseTemplate(preheader: string, contentHtml: string, unsubToken?: string) {
  const unsubBlock = unsubToken
    ? `<a href="${APP_URL}unsubscribe.html?t=${unsubToken}" style="color:#888780">Unsubscribe or manage preferences</a><br>`
    : ``;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#FAF8F5;margin:0;color:#2C2C2A}
    .wrap{max-width:560px;margin:0 auto;padding:32px 20px}
    .card{background:#fff;border-radius:16px;padding:28px 24px;border:1px solid #EAE3DC}
    h1{font-family:"DM Serif Display",Georgia,serif;font-size:26px;letter-spacing:-.02em;color:#1A0F0A;margin:0 0 12px;font-weight:400}
    h2{font-family:"DM Serif Display",Georgia,serif;font-size:18px;color:#1A0F0A;margin:22px 0 6px;font-weight:400}
    p{line-height:1.55;margin:0 0 14px;font-size:14px}
    .item{background:#F7F6F2;border-radius:12px;padding:12px 14px;margin-bottom:8px;font-size:13.5px;line-height:1.5}
    .cta{display:inline-block;background:#D85A30;color:#fff!important;padding:12px 24px;border-radius:999px;text-decoration:none;font-weight:600;font-size:15px}
    .foot{color:#888780;font-size:12px;text-align:center;padding:20px 8px;line-height:1.6}
    .brand{text-align:center;margin-bottom:18px}.brand img{width:90px;height:auto}
    .pre{display:none;visibility:hidden;height:0;width:0;overflow:hidden}
  </style></head><body><div class="pre">${preheader}</div><div class="wrap"><div class="brand"><img src="https://mytenner.com/logo-square.png" alt="Tenner" width="90"></div><div class="card">${contentHtml}</div><div class="foot">Tenner — Top 10 lists with friends<br><a href="${APP_URL}" style="color:#888780">${APP_URL}</a><br>${unsubBlock}</div></div></body></html>`;
}

async function sendResend(to: string, subject: string, html: string, headers?: Record<string, string>) {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("FROM_EMAIL") || "Tenner <hello@mytenner.com>";
  if (!apiKey) throw new Error("RESEND_API_KEY not configured");
  const body: any = { from, to: [to], subject, html };
  if (headers && Object.keys(headers).length) body.headers = headers;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  return await res.json();
}

// Verify the underlying content referenced by an event still exists. Returns
// true if the notification should proceed, false if the reference is gone
// (list deleted, comment deleted, etc.). Also handles friend_update: verify
// the list still exists AND the friendship is still accepted.
async function isEventStillValid(supabase: any, row: any): Promise<{ valid: boolean; reason?: string }> {
  const t = row.event_type;
  const d = row.event_data || {};
  try {
    if (t === "friend_update") {
      // List must still exist, be public, and the friendship still accepted
      if (d.category && row.from_user_id) {
        const { data: list } = await supabase.from("lists")
          .select("id, is_public")
          .eq("user_id", row.from_user_id)
          .eq("category", d.category)
          .maybeSingle();
        if (!list || !list.is_public) return { valid: false, reason: "list_gone_or_private" };
      }
      // Friendship check
      const { data: fr } = await supabase.from("friendships")
        .select("id, status")
        .or(`and(requester_id.eq.${row.from_user_id},addressee_id.eq.${row.recipient_user_id}),and(requester_id.eq.${row.recipient_user_id},addressee_id.eq.${row.from_user_id})`)
        .maybeSingle();
      if (!fr || fr.status !== "accepted") return { valid: false, reason: "friendship_gone" };
      return { valid: true };
    }
    if (t === "new_comment") {
      if (d.comment_id) {
        const { data: c } = await supabase.from("list_item_comments")
          .select("id")
          .eq("id", d.comment_id)
          .maybeSingle();
        if (!c) return { valid: false, reason: "comment_deleted" };
      }
      return { valid: true };
    }
    if (t === "list_share") {
      if (d.share_id) {
        const { data: s } = await supabase.from("list_share_invites")
          .select("id")
          .eq("id", d.share_id)
          .maybeSingle();
        if (!s) return { valid: false, reason: "share_deleted" };
      }
      return { valid: true };
    }
    return { valid: true };
  } catch (e) {
    console.warn("isEventStillValid check failed", e);
    return { valid: true }; // fail open — better to over-send than lose
  }
}

// Render one event as an HTML block for the digest email.
function renderEventBlock(row: any, fromProfile: any): string {
  const t = row.event_type;
  const d = row.event_data || {};
  const name = (fromProfile && (fromProfile.display_name || (fromProfile.handle ? "@" + fromProfile.handle : ""))) || "A friend";
  if (t === "friend_update") {
    return `<div class="item">🔀 <strong>${escapeHtml(name)}</strong> updated their <strong>Top 10 ${escapeHtml(d.category || "list")}</strong></div>`;
  }
  if (t === "new_comment") {
    const isWhole = d.is_whole_list === true || d.item_name === "__list__";
    const on = isWhole
      ? `your <strong>Top 10 ${escapeHtml(d.category || "list")}</strong>`
      : `<strong>${escapeHtml(d.item_name || "one of your picks")}</strong> from your <strong>Top 10 ${escapeHtml(d.category || "list")}</strong>`;
    const preview = d.comment_text ? `<div style="margin-top:6px;font-style:italic;color:#5F5E5A">"${escapeHtml(String(d.comment_text).slice(0, 200))}${String(d.comment_text).length > 200 ? "…" : ""}"</div>` : "";
    return `<div class="item">💬 <strong>${escapeHtml(name)}</strong> commented on ${on}${preview}</div>`;
  }
  if (t === "list_share") {
    return `<div class="item">🎯 <strong>${escapeHtml(name)}</strong> shared a <strong>Top 10 ${escapeHtml(d.category || "list")}</strong> with you</div>`;
  }
  return `<div class="item">${escapeHtml(name)} did something on Tenner</div>`;
}

// Group events by from_user_id + event_type + category. Returns a single
// merged summary line per group so 5 updates on the same category by the
// same person show as one line.
function collapseEvents(rows: any[]): any[] {
  const byKey: Record<string, any[]> = {};
  rows.forEach((r) => {
    const d = r.event_data || {};
    const key = [r.event_type, r.from_user_id || "sys", d.category || "", d.item_name || "", d.comment_id || d.share_id || ""].join("|");
    if (!byKey[key]) byKey[key] = [];
    byKey[key].push(r);
  });
  // Keep the most recent row per key (later events override earlier ones on the same object)
  return Object.values(byKey).map((group) => group.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""))[0]);
}

// Main entry: process the queue.
async function processQueue(supabase: any, options: { forceMode?: string } = {}) {
  const now = new Date();
  const safeCutoff = new Date(now.getTime() - SAFETY_WINDOW_MS).toISOString();
  const dayOfWeek = now.getUTCDay(); // 0 = Sunday
  const hourUtc = now.getUTCHours();

  // Load all pending rows created before the safety cutoff
  const { data: pendingRows, error } = await supabase
    .from("notification_queue")
    .select("*")
    .is("sent_at", null)
    .is("dropped_at", null)
    .lt("created_at", safeCutoff)
    .order("created_at", { ascending: true })
    .limit(2000);
  if (error) throw error;
  if (!pendingRows || pendingRows.length === 0) return { processed: 0, sent: 0 };

  // Group by recipient
  const byRecipient: Record<string, any[]> = {};
  pendingRows.forEach((r: any) => {
    if (!byRecipient[r.recipient_user_id]) byRecipient[r.recipient_user_id] = [];
    byRecipient[r.recipient_user_id].push(r);
  });

  // Fetch prefs + emails for all recipients in one query
  const recipientIds = Object.keys(byRecipient);
  const { data: profileRows } = await supabase.from("profiles").select("id, email").in("id", recipientIds);
  const emailByUser: Record<string, string> = {};
  (profileRows || []).forEach((p: any) => { if (p.email) emailByUser[p.id] = p.email; });
  const { data: prefRows } = await supabase.from("user_email_prefs").select("user_id, prefs, unsubscribe_token, notification_cadence").in("user_id", recipientIds);
  const prefByUser: Record<string, any> = {};
  (prefRows || []).forEach((p: any) => { prefByUser[p.user_id] = p; });

  let sent = 0;
  let dropped = 0;

  for (const recipientId of recipientIds) {
    const email = emailByUser[recipientId];
    if (!email) {
      // Drop notifications for users with no email on file
      const ids = byRecipient[recipientId].map((r: any) => r.id);
      await supabase.from("notification_queue").update({ dropped_at: now.toISOString(), drop_reason: "no_email" }).in("id", ids);
      dropped += ids.length;
      continue;
    }
    const prefRow = prefByUser[recipientId] || {};
    const cadence = options.forceMode || (prefRow.notification_cadence || "daily");
    const prefs = prefRow.prefs || {};
    // If social pref is explicitly off, drop everything for this recipient.
    if (prefs.social === false) {
      const ids = byRecipient[recipientId].map((r: any) => r.id);
      await supabase.from("notification_queue").update({ dropped_at: now.toISOString(), drop_reason: "opted_out_social" }).in("id", ids);
      dropped += ids.length;
      continue;
    }

    // Cadence gate
    if (cadence === "daily") {
      // Only run at/after 13:00 UTC. If we're earlier in the day, leave rows for later cycle.
      if (hourUtc < 13) continue;
      // One digest per user per day: check email_log for today's digest_daily
      const today = now.toISOString().slice(0, 10);
      const { data: sentToday } = await supabase.from("email_log")
        .select("id").eq("user_id", recipientId).eq("email_type", "digest_daily").eq("ref_key", today).maybeSingle();
      if (sentToday) continue;
    } else if (cadence === "weekly") {
      // Sunday only, 13:00 UTC+
      if (dayOfWeek !== 0 || hourUtc < 13) continue;
      const weekKey = "week_of_" + now.toISOString().slice(0, 10);
      const { data: sentWeek } = await supabase.from("email_log")
        .select("id").eq("user_id", recipientId).eq("email_type", "digest_weekly").eq("ref_key", weekKey).maybeSingle();
      if (sentWeek) continue;
    }
    // immediate: no gate — every 15-min cron cycle can send

    // Validate + collapse events
    const validRows: any[] = [];
    const invalidIds: string[] = [];
    const dropReasons: Record<string, string> = {};
    for (const row of byRecipient[recipientId]) {
      const { valid, reason } = await isEventStillValid(supabase, row);
      if (valid) validRows.push(row); else { invalidIds.push(row.id); dropReasons[row.id] = reason || "unknown"; }
    }
    if (invalidIds.length) {
      // Batch drop — one query per reason
      const byReason: Record<string, string[]> = {};
      invalidIds.forEach((id) => { const r = dropReasons[id]; if (!byReason[r]) byReason[r] = []; byReason[r].push(id); });
      for (const r of Object.keys(byReason)) {
        await supabase.from("notification_queue").update({ dropped_at: now.toISOString(), drop_reason: r }).in("id", byReason[r]);
      }
      dropped += invalidIds.length;
    }
    if (validRows.length === 0) continue;

    const collapsed = collapseEvents(validRows);

    // Fetch from_user profiles for names
    const fromIds = Array.from(new Set(collapsed.map((r: any) => r.from_user_id).filter(Boolean)));
    const { data: fromProfiles } = await supabase.from("profiles").select("id, display_name, handle").in("id", fromIds);
    const fromById: Record<string, any> = {};
    (fromProfiles || []).forEach((p: any) => { fromById[p.id] = p; });

    // Sort: comments first (most engaging), then updates, then shares
    const rank: Record<string, number> = { new_comment: 0, list_share: 1, friend_update: 2 };
    collapsed.sort((a: any, b: any) => (rank[a.event_type] ?? 9) - (rank[b.event_type] ?? 9));

    // Build email
    const itemsHtml = collapsed.map((r: any) => renderEventBlock(r, fromById[r.from_user_id])).join("");
    const count = collapsed.length;
    let subject: string, headline: string, intro: string;
    if (cadence === "weekly") {
      subject = `Your Tenner week — ${count} update${count === 1 ? "" : "s"}`;
      headline = "Your Tenner week";
      intro = `Here's what your friends did on Tenner this week.`;
    } else if (cadence === "daily") {
      subject = `Your Tenner update — ${count} thing${count === 1 ? "" : "s"}`;
      headline = "Your Tenner update";
      intro = `Here's what happened on Tenner since your last digest.`;
    } else {
      // immediate
      if (count === 1) {
        const r = collapsed[0];
        const fp = fromById[r.from_user_id];
        const name = (fp && (fp.display_name || (fp.handle ? "@" + fp.handle : ""))) || "A friend";
        const d = r.event_data || {};
        if (r.event_type === "friend_update") subject = `${name} updated their Top 10 ${d.category || "list"}`;
        else if (r.event_type === "new_comment") subject = `${name} commented on your list`;
        else if (r.event_type === "list_share") subject = `${name} shared a Top 10 ${d.category || "list"} with you`;
        else subject = `${name} did something on Tenner`;
      } else {
        subject = `${count} new updates on Tenner`;
      }
      headline = count === 1 ? "New on Tenner" : `${count} new updates`;
      intro = "";
    }

    const bodyHtml = `<h1>${escapeHtml(headline)}</h1>${intro ? `<p>${escapeHtml(intro)}</p>` : ""}${itemsHtml}<p style="text-align:center;margin-top:22px"><a href="${APP_URL}" class="cta">Open Tenner →</a></p>`;
    const preheader = intro || `${count} new update${count === 1 ? "" : "s"} on Tenner`;
    const html = baseTemplate(preheader, bodyHtml, prefRow.unsubscribe_token);

    try {
      const headers: Record<string, string> = {};
      if (prefRow.unsubscribe_token) {
        headers["List-Unsubscribe"] = `<${APP_URL}unsubscribe.html?t=${prefRow.unsubscribe_token}&c=social>`;
        headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
      }
      await sendResend(email, subject, html, headers);
      sent++;
      // Stamp all validRows as sent
      const validIds = validRows.map((r: any) => r.id);
      await supabase.from("notification_queue").update({ sent_at: now.toISOString() }).in("id", validIds);
      // Log the digest for cadence dedup
      if (cadence === "daily") {
        await supabase.from("email_log").insert({ user_id: recipientId, email_type: "digest_daily", ref_key: now.toISOString().slice(0, 10) });
      } else if (cadence === "weekly") {
        await supabase.from("email_log").insert({ user_id: recipientId, email_type: "digest_weekly", ref_key: "week_of_" + now.toISOString().slice(0, 10) });
      }
    } catch (e) {
      console.error(`digest send failed for ${email}`, e);
    }
  }

  return { processed: pendingRows.length, sent, dropped };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);
    const result = await processQueue(supabase);
    return new Response(JSON.stringify({ ok: true, ...result }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  } catch (e: any) {
    console.error(e);
    return new Response(JSON.stringify({ ok: false, error: String(e.message || e) }), { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  }
});
