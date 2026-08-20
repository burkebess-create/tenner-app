// Supabase Edge Function: send-email
// Handles user-triggered emails (welcome, feedback status update, one-off notifications)
// Called from the client via supabase.functions.invoke('send-email', { body: {...} })
//
// Environment secrets required (set via Supabase dashboard → Edge Functions → Secrets):
//   RESEND_API_KEY   your Resend API key
//   FROM_EMAIL       verified sender, e.g. "Tenner <hello@mytenner.com>"

// deno-lint-ignore-file no-explicit-any
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
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
  welcome:         "essential",
  feedback_update: "essential",
};

function baseTemplate(preheader: string, contentHtml: string, unsubToken?: string, category?: string) {
  const unsubBlock = unsubToken
    ? `<a href="${APP_URL}unsubscribe.html?t=${unsubToken}${category ? `&c=${category}` : ""}">Unsubscribe from these</a>
       · <a href="${APP_URL}unsubscribe.html?t=${unsubToken}&c=all">Unsubscribe from all</a>
       · <a href="${APP_URL}?openPrefs=1">Manage email preferences</a><br>`
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

function templateFeedbackUpdate(data: any) {
  const status = data.status || "updated";
  const message = data.message || "";
  const statusLabel = status === "resolved"
    ? "Resolved ✓"
    : status === "in_progress"
    ? "Working on it 🔧"
    : "Reopened";
  const preheader = `We updated your feedback: ${statusLabel}`;
  const body = `
    <h1>Feedback update: ${statusLabel}</h1>
    <p>You submitted this feedback:</p>
    <p style="background:#F1EFE8;padding:12px 14px;border-radius:10px;font-style:italic;color:#5F5E5A">${escapeHtml(message)}</p>
    ${status === "resolved" ? "<p>Thanks for helping make Tenner better. Keep the ideas coming!</p>" : "<p>We're on it — we'll let you know when it's resolved.</p>"}
    <p style="text-align:center;margin-top:24px"><a href="${APP_URL}" class="cta">Open Tenner →</a></p>`;
  return { subject: `Tenner feedback update: ${statusLabel}`, html: baseTemplate(preheader, body, data.__unsub_token, data.__category) };
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });

  try {
    const { type, to, data } = await req.json();
    if (!type || !to) throw new Error("type and to are required");

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
      case "friend_update":      tpl = templateFriendUpdate(enrichedData); break;
      case "new_comment":        tpl = templateNewComment(enrichedData); break;
      case "friend_request":     tpl = templateFriendRequest(enrichedData); break;
      case "list_share":         tpl = templateListShare(enrichedData); break;
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
