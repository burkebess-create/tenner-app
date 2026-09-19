// Supabase Edge Function: send-email
// Handles user-triggered emails (welcome, feedback status update, one-off notifications)
// Called from the client via supabase.functions.invoke('send-email', { body: {...} })
//
// Environment secrets required (set via Supabase dashboard → Edge Functions → Secrets):
//   RESEND_API_KEY   your Resend API key
//   FROM_EMAIL       verified sender, e.g. "Tenner <hello@mytenner.com>"

// deno-lint-ignore-file no-explicit-any
// Finding 7: a wildcard let any website invoke this from a visitor's
// browser. Impact was limited (no cookie credentials, and each type is
// authorized server-side) but there is no reason to accept any origin.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://mytenner.com",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const APP_URL = "https://mytenner.com/";

// Every email type maps to a preference category. 'essential' emails always
// send regardless of prefs — welcome, feedback status changes, security.
const EMAIL_TYPE_TO_CATEGORY: Record<string, string> = {
  new_comment:     "social",
  friend_request:  "social",
  list_share:      "social",
  friend_update:   "social",
  weekly_reveal:   "weekly",
  streak_in_danger:"weekly",
  birthday_reminder:    "reminders",
  birthday_reminder_14: "reminders",
  welcome:            "essential",
  feedback_update:    "essential",
  feedback_reply:     "essential",
  account_suspended:  "essential",
};

function baseTemplate(preheader: string, contentHtml: string, unsubToken?: string, category?: string) {
  const unsubBlock = unsubToken
    ? `<a href="${APP_URL}unsubscribe.html?t=${unsubToken}">Unsubscribe or manage preferences</a><br>`
    : ``;
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Tenner</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #FAF8F5; margin: 0; padding: 0; color: #2C2C2A; }
  .wrap { max-width: 560px; margin: 0 auto; padding: 32px 20px; }
  .card { background: #fff; border-radius: 16px; padding: 28px 24px; border: 1px solid #EAE3DC; }
  h1 { font-family: "DM Serif Display", Georgia, serif; font-size: 28px; letter-spacing: -0.02em; color: #1A0F0A; margin: 0 0 12px; font-weight: 400; }
  h2 { font-family: "DM Serif Display", Georgia, serif; font-size: 20px; color: #1A0F0A; margin: 20px 0 8px; font-weight: 400; }
  p  { line-height: 1.55; margin: 0 0 14px; font-size: 15px; }
  .cta { display: inline-block; background: #D85A30; color: #ffffff !important; padding: 12px 24px; border-radius: 999px; text-decoration: none; font-weight: 600; font-size: 15px; }
  .cta:hover { background: #993C1D; }
  .foot { color: #888780; font-size: 12px; text-align: center; padding: 20px 8px; line-height: 1.6; }
  .foot a { color: #888780; }
  .brand { text-align: center; margin-bottom: 18px; }
  .brand img { width: 90px; height: auto; display: inline-block; }
  .preheader { display: none; visibility: hidden; opacity: 0; color: transparent; height: 0; width: 0; overflow: hidden; }
</style>
</head>
<body>
  <div class="preheader">${preheader}</div>
  <div class="wrap">
    <div class="brand"><img src="https://mytenner.com/logo-square.png" alt="Tenner" width="90"></div>
    <div class="card">
      ${contentHtml}
    </div>
    <div class="foot">
      Tenner — Top 10 lists with friends<br>
      <a href="${APP_URL}">${APP_URL}</a><br>
      ${unsubBlock}
      You're getting this because you have a Tenner account.
    </div>
  </div>
</body>
</html>`;
}

function templateWelcome(data: any) {
  const name = data.name || "there";
  const preheader = "Welcome to Tenner — let's make your first Top 10.";
  const body = `
    <h1>Welcome to Tenner, ${escapeHtml(name)}!</h1>
    <p>You're in. Tenner is a fun way to rank what you love — movies, restaurants, songs, books, or anything you want — and compare with friends.</p>
    <h2>Here's how to get started</h2>
    <p>1. <strong>Make your first Top 10 list</strong> in any category.<br>
       2. <strong>Add friends</strong> to your Circle.<br>
       3. <strong>Compare</strong> — see how your picks stack up.</p>
    <p style="text-align:center;margin-top:24px"><a href="${APP_URL}" class="cta">Make my first list →</a></p>`;
  return { subject: "Welcome to Tenner 🎉", html: baseTemplate(preheader, body, data.__unsub_token, data.__category) };
}

function templateBirthdayReminder(data: any) {
  const friendName = data.friend_name || "your friend";
  const days = data.days_until;
  const preheader = `${friendName}'s birthday is coming up.`;
  const body = `
    <h1>🎂 ${escapeHtml(friendName)}'s birthday is in ${days} days</h1>
    <p>Open Tenner to see a curated gift guide based on ${escapeHtml(friendName)}'s Top 10 lists — books, movies, songs, and things they've told you they love.</p>
    <p style="text-align:center;margin-top:24px"><a href="${APP_URL}" class="cta">See gift ideas →</a></p>`;
  return { subject: `${friendName}'s birthday in ${days} days 🎂`, html: baseTemplate(preheader, body, data.__unsub_token, data.__category) };
}

function templateWeeklyReveal(data: any) {
  const cat = data.category || "the weekly list";
  const emoji = data.emoji || "📋";
  const preheader = `The Tenner Top 10 ${cat} is live — see how you compared.`;
  const body = `
    <h1>🎊 The reveal is live!</h1>
    <p>This week's Tenner list — <strong>${emoji} Top 10 ${escapeHtml(cat)}</strong> — is now revealed.</p>
    <p>See how your picks stack up against your friends, and check out what the entire Tenner community picked.</p>
    <p style="text-align:center;margin-top:24px"><a href="${APP_URL}" class="cta">See the reveal →</a></p>`;
  return { subject: `🎊 Tenner reveal: Top 10 ${cat}`, html: baseTemplate(preheader, body, data.__unsub_token, data.__category) };
}

function templateAccountSuspended(data: any) {
  const name   = data.name || 'there';
  const reason = data.reason ? String(data.reason) : '';
  const reasonBlock = reason
    ? `<p style="background:#FBE6DE;border:1px solid #F0997B;border-left:4px solid #D85A30;padding:12px 14px;border-radius:6px;color:#2C2C2A;margin:16px 0"><strong style="display:block;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#A32D2D;margin-bottom:6px">Reason given</strong>${escapeHtml(reason)}</p>`
    : `<p style="color:#5F5E5A;font-style:italic">No specific reason was provided.</p>`;
  const body = `
    <h1>Your Tenner account has been suspended</h1>
    <p>Hi ${escapeHtml(name)},</p>
    <p>Your Tenner account was suspended by our moderation team. When you next open the app, you'll be signed out and see a suspension notice.</p>
    ${reasonBlock}
    <p>If you believe this was a mistake, reply to this email or reach us at <a href="mailto:contact@mytenner.com" style="color:#D85A30">contact@mytenner.com</a> and we'll review it.</p>`;
  return {
    subject: 'Your Tenner account has been suspended',
    html: baseTemplate('Your Tenner account has been suspended.', body, data.__unsub_token, data.__category)
  };
}
// A personal note from whoever replied, shown above the canned line. This is
// the part that actually reads like a human answered, so it leads.
function noteBlock(note: string, fromName: string) {
  const t = String(note || "").trim();
  if (!t) return "";
  return `<div style="border-left:3px solid #D85A30;padding:2px 0 2px 14px;margin:0 0 16px">
      <p style="white-space:pre-wrap;margin:0 0 6px">${escapeHtml(t)}</p>
      <p style="margin:0;font-size:12px;color:#888780">— ${escapeHtml(fromName || "The Tenner team")}</p>
    </div>`;
}

function statusLabelFor(status: string) {
  return status === "resolved"      ? "Resolved ✓"
       : status === "in_progress"   ? "Working on it 🔧"
       : status === "awaiting_user" ? "Question for you"
       : "Reopened";
}

function templateFeedbackUpdate(data: any) {
  const status = data.status || "updated";
  const message = data.message || "";
  const statusLabel = statusLabelFor(status);
  const note = noteBlock(data.note, data.from_name);
  // With a personal note present the generic line is noise, so it is dropped —
  // except on 'resolved', where the thanks still earns its place.
  const canned = status === "awaiting_user"
      ? "<p>Reply in the app and we'll pick it straight back up.</p>"
    : status === "resolved"
      ? "<p>Thanks for helping make Tenner better. Keep the ideas coming!</p>"
    : data.note
      ? ""
      : "<p>We're on it — we'll let you know when it's resolved.</p>";
  const cta = status === "awaiting_user" ? "Reply to this →" : "Open Tenner →";
  const preheader = data.note ? String(data.note).trim().slice(0, 120) : `We updated your feedback: ${statusLabel}`;
  const body = `
    <h1>${status === "awaiting_user" ? "A quick question" : `Feedback update: ${statusLabel}`}</h1>
    ${note}
    <p style="font-size:12px;color:#888780;margin-bottom:6px">Your original feedback:</p>
    <p style="background:#F1EFE8;padding:12px 14px;border-radius:10px;font-style:italic;color:#5F5E5A">${escapeHtml(message)}</p>
    ${canned}
    <p style="text-align:center;margin-top:24px"><a href="${APP_URL}?feedback=1" class="cta">${cta}</a></p>`;
  return { subject: `Tenner feedback update: ${statusLabel}`, html: baseTemplate(preheader, body, data.__unsub_token, data.__category) };
}

// A message with no status change — following up, or checking a fix landed.
function templateFeedbackReply(data: any) {
  const message = data.message || "";
  const note = noteBlock(data.note, data.from_name);
  const preheader = data.note ? String(data.note).trim().slice(0, 120) : "A reply to your Tenner feedback";
  const body = `
    <h1>A reply to your feedback</h1>
    ${note}
    <p style="font-size:12px;color:#888780;margin-bottom:6px">Your original feedback:</p>
    <p style="background:#F1EFE8;padding:12px 14px;border-radius:10px;font-style:italic;color:#5F5E5A">${escapeHtml(message)}</p>
    <p style="text-align:center;margin-top:24px"><a href="${APP_URL}?feedback=1" class="cta">Reply in Tenner →</a></p>`;
  return { subject: "Re: your Tenner feedback", html: baseTemplate(preheader, body, data.__unsub_token, data.__category) };
}

function templateFriendUpdate(data: any) {
  const friendName = data.friend_name || "A friend";
  const cat = data.category || "list";
  const preheader = `${friendName} updated their ${cat} list.`;
  const body = `
    <h1>${escapeHtml(friendName)} updated their Top 10 ${escapeHtml(cat)}</h1>
    <p>Their picks changed — your match score with them might have shifted too. See what's new.</p>
    <p style="text-align:center;margin-top:24px"><a href="${APP_URL}" class="cta">See the update →</a></p>`;
  return { subject: `${friendName} updated their Top 10 ${cat}`, html: baseTemplate(preheader, body, data.__unsub_token, data.__category) };
}

function templateNewComment(data: any) {
  const commenterName = data.commenter_name || "A friend";
  const cat = data.category || "list";
  const itemName = data.item_name || "one of your picks";
  const commentText = data.comment_text || "";
  const isWholeList = data.is_whole_list === true || itemName === "__list__";

  const subject = isWholeList
    ? `${commenterName} commented on your Top 10 ${cat} list`
    : `${commenterName} commented on one of your Top 10 ${cat}`;

  const preheader = isWholeList
    ? `${commenterName} commented on your Top 10 ${cat} list.`
    : `${commenterName} commented on "${itemName}".`;

  const bodyIntro = isWholeList
    ? `${escapeHtml(commenterName)} left a comment on your <strong>Top 10 ${escapeHtml(cat)}</strong> list:`
    : `${escapeHtml(commenterName)} commented on <strong>${escapeHtml(itemName)}</strong> from your <strong>Top 10 ${escapeHtml(cat)}</strong>:`;

  const body = `
    <h1>💬 ${escapeHtml(commenterName)} commented</h1>
    <p>${bodyIntro}</p>
    <p style="background:#F1EFE8;padding:12px 14px;border-radius:10px;font-style:italic;color:#5F5E5A">"${escapeHtml(commentText)}"</p>
    <p style="text-align:center;margin-top:24px"><a href="${APP_URL}" class="cta">Reply on Tenner →</a></p>`;
  return { subject, html: baseTemplate(preheader, body, data.__unsub_token, data.__category) };
}

function templateFriendRequest(data: any) {
  const requesterName = data.requester_name || "Someone";
  const requesterHandle = data.requester_handle ? ` (@${data.requester_handle})` : "";
  const message = data.message || "";
  const preheader = `${requesterName} wants to add you as a friend on Tenner.`;
  const body = `
    <h1>👋 ${escapeHtml(requesterName)}${escapeHtml(requesterHandle)} wants to connect</h1>
    <p>They'd like to add you as a friend on Tenner so you can compare Top 10 lists.</p>
    ${message ? `<p style="background:#F1EFE8;padding:12px 14px;border-radius:10px;font-style:italic;color:#5F5E5A">"${escapeHtml(message)}"</p>` : ""}
    <p style="text-align:center;margin-top:24px"><a href="${APP_URL}" class="cta">Respond on Tenner →</a></p>`;
  return { subject: `${requesterName} wants to add you on Tenner`, html: baseTemplate(preheader, body, data.__unsub_token, data.__category) };
}

function templateListShare(data: any) {
  const senderName = data.sender_name || "A friend";
  const senderHandle = data.sender_handle ? ` (@${data.sender_handle})` : "";
  const cat = data.category || "list";
  const preheader = `${senderName} shared a Top 10 ${cat} list with you.`;
  const body = `
    <h1>🎯 ${escapeHtml(senderName)}${escapeHtml(senderHandle)} shared a list with you</h1>
    <p>${escapeHtml(senderName)} wants you to fill out your own <strong>Top 10 ${escapeHtml(cat)}</strong> so you can compare with theirs on Tenner.</p>
    <p style="text-align:center;margin-top:24px"><a href="${APP_URL}" class="cta">Fill out my Top 10 →</a></p>`;
  return { subject: `${senderName} shared a Top 10 ${cat} list with you`, html: baseTemplate(preheader, body, data.__unsub_token, data.__category) };
}

function escapeHtml(str: string) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
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
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Resend error ${res.status}: ${errText}`);
  }
  return await res.json();
}

// Look up recipient's preference row (opt-out check + unsubscribe token for
// email footer links). Uses the service role key so it can read across users.
async function fetchRecipientPrefs(toEmail: string): Promise<{ userId: string; token: string; prefs: Record<string, boolean> } | null> {
  const url = Deno.env.get("SUPABASE_URL");
  const srk = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !srk) return null;
  try {
    // 1. Look up user_id by email (profiles table has one row per user)
    const pRes = await fetch(`${url}/rest/v1/profiles?select=id&email=eq.${encodeURIComponent(toEmail)}&limit=1`, {
      headers: { apikey: srk, Authorization: `Bearer ${srk}` },
    });
    const profs = await pRes.json();
    const userId = profs?.[0]?.id;
    if (!userId) return null;
    // 2. Look up prefs row
    const uRes = await fetch(`${url}/rest/v1/user_email_prefs?select=prefs,unsubscribe_token&user_id=eq.${encodeURIComponent(userId)}&limit=1`, {
      headers: { apikey: srk, Authorization: `Bearer ${srk}` },
    });
    const prefsRows = await uRes.json();
    const row = prefsRows?.[0];
    return {
      userId,
      token: row?.unsubscribe_token || "",
      prefs: row?.prefs || {},
    };
  } catch (e) {
    console.warn("fetchRecipientPrefs failed:", e);
    return null;
  }
}

function sbHeaders() {
  const srk = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  return { apikey: srk, Authorization: `Bearer ${srk}`, "Content-Type": "application/json" };
}

// The caller's user id, read from the JWT the gateway already validated.
// Only the payload is inspected — the signature was checked upstream.
function callerId(req: Request): string | null {
  try {
    const h = req.headers.get("Authorization") || "";
    const tok = h.replace(/^Bearer\s+/i, "");
    const part = tok.split(".")[1];
    if (!part) return null;
    const json = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
    return json.sub || null;   // anon/service keys carry no sub
  } catch (e) { return null; }
}

async function isAdmin(userId: string) {
  const url = Deno.env.get("SUPABASE_URL");
  if (!url || !userId) return false;
  try {
    const r = await fetch(`${url}/rest/v1/admins?select=user_id&user_id=eq.${encodeURIComponent(userId)}&limit=1`, { headers: sbHeaders() });
    const rows = await r.json();
    return Array.isArray(rows) && rows.length > 0;
  } catch (e) { return false; }
}

async function emailOf(userId: string): Promise<string | null> {
  const url = Deno.env.get("SUPABASE_URL");
  if (!url || !userId) return null;
  try {
    const r = await fetch(`${url}/rest/v1/profiles?select=email&id=eq.${encodeURIComponent(userId)}&limit=1`, { headers: sbHeaders() });
    const rows = await r.json();
    return rows?.[0]?.email || null;
  } catch (e) { return null; }
}

// Does the caller have a friendship with the person at this address? Gates the
// one type that is legitimately user-to-user.
async function hasFriendshipWith(callerUserId: string, toEmail: string) {
  const url = Deno.env.get("SUPABASE_URL");
  if (!url) return false;
  try {
    const pRes = await fetch(`${url}/rest/v1/profiles?select=id&email=eq.${encodeURIComponent(toEmail)}&limit=1`, { headers: sbHeaders() });
    const other = (await pRes.json())?.[0]?.id;
    if (!other) return false;
    const q = `or=(and(requester_id.eq.${callerUserId},addressee_id.eq.${other}),and(requester_id.eq.${other},addressee_id.eq.${callerUserId}))`;
    const fRes = await fetch(`${url}/rest/v1/friendships?select=id&${q}&limit=1`, { headers: sbHeaders() });
    const rows = await fRes.json();
    return Array.isArray(rows) && rows.length > 0;
  } catch (e) { return false; }
}

// This function could previously be invoked by ANY signed-in user with an
// arbitrary `to` and `type` — i.e. send Tenner-branded mail from the verified
// domain to any address on earth. The gateway's verify_jwt only proves the
// caller is *someone*. Each type now states who may send it and to whom.
async function authorize(req: Request, type: string, to: string): Promise<string | null> {
  const uid = callerId(req);
  if (!uid) return "sign-in required";
  if (type === "welcome") {
    const own = await emailOf(uid);
    return (own && own.toLowerCase() === String(to).toLowerCase()) ? null : "welcome may only be sent to yourself";
  }
  if (type === "friend_request") {
    return (await hasFriendshipWith(uid, to)) ? null : "no friendship with that recipient";
  }
  // feedback_update, feedback_reply, account_suspended, and anything added
  // later: admin only. Default deny, so a new type cannot arrive unguarded.
  return (await isAdmin(uid)) ? null : "admin only";
}

// Records the send so the admin UI can show what actually went out. Silent on
// failure: a logging problem must never look like a delivery problem.
async function logEmail(type: string, toEmail: string, refKey: string | null) {
  const url = Deno.env.get("SUPABASE_URL");
  if (!url) return;
  try {
    const pRes = await fetch(`${url}/rest/v1/profiles?select=id&email=eq.${encodeURIComponent(toEmail)}&limit=1`, { headers: sbHeaders() });
    const uid = (await pRes.json())?.[0]?.id;
    if (!uid) return;
    await fetch(`${url}/rest/v1/email_log`, {
      method: "POST",
      headers: sbHeaders(),
      body: JSON.stringify({ user_id: uid, email_type: type, ref_key: refKey || null }),
    });
  } catch (e) { console.warn("logEmail failed:", e); }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });

  try {
    const body = await req.json();
    const { type, data } = body;
    // to_user_id is preferred: it means the CLIENT never has to read another
    // user's email address, which is what forced profiles.email to be readable
    // by every signed-in user. `to` stays supported for existing callers.
    let to = body.to as string | undefined;
    if (!to && body.to_user_id) to = (await emailOf(String(body.to_user_id))) || undefined;
    if (!type || !to) throw new Error("type and a recipient (to or to_user_id) are required");

    const denied = await authorize(req, type, to);
    if (denied) {
      return new Response(JSON.stringify({ ok: false, error: "Not allowed: " + denied }), {
        status: 403, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // Preference check — skip if the recipient opted out of this category.
    // 'essential' emails always go through (welcome / feedback_update / security).
    const category = EMAIL_TYPE_TO_CATEGORY[type] || "essential";
    const recipient = await fetchRecipientPrefs(to);
    if (category !== "essential" && recipient) {
      const allowed = recipient.prefs?.[category];
      // Default = opted in (true) if the key is missing. Only skip when explicitly false.
      if (allowed === false) {
        return new Response(JSON.stringify({ ok: true, skipped: "user opted out of " + category }), {
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }
    }

    const unsubToken = recipient?.token || "";
    const enrichedData = { ...(data || {}), __unsub_token: unsubToken, __category: category };

    let tpl;
    switch (type) {
      case "welcome":            tpl = templateWelcome(enrichedData); break;
      case "birthday_reminder":  tpl = templateBirthdayReminder(enrichedData); break;
      case "weekly_reveal":      tpl = templateWeeklyReveal(enrichedData); break;
      case "feedback_update":    tpl = templateFeedbackUpdate(enrichedData); break;
      case "feedback_reply":     tpl = templateFeedbackReply(enrichedData); break;
      case "friend_update":      tpl = templateFriendUpdate(enrichedData); break;
      case "new_comment":        tpl = templateNewComment(enrichedData); break;
      case "friend_request":     tpl = templateFriendRequest(enrichedData); break;
      case "list_share":         tpl = templateListShare(enrichedData); break;
      case "account_suspended":  tpl = templateAccountSuspended(enrichedData); break;
      default: throw new Error(`Unknown email type: ${type}`);
    }

    // List-Unsubscribe headers for Gmail/Apple Mail one-click unsubscribe.
    // Required for good deliverability; recipients see a native "Unsubscribe"
    // button next to the sender name.
    const extraHeaders: Record<string, string> = {};
    if (unsubToken) {
      extraHeaders["List-Unsubscribe"] = `<${APP_URL}unsubscribe.html?t=${unsubToken}&c=${category}>`;
      extraHeaders["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
    }
    const result = await sendResend(to, tpl.subject, tpl.html, extraHeaders);
    await logEmail(type, to, (data && data.ref_key) || null);
    return new Response(JSON.stringify({ ok: true, id: result.id }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e.message || e) }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
