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

function baseTemplate(preheader: string, contentHtml: string) {
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
  return { subject: "Welcome to Tenner 🎉", html: baseTemplate(preheader, body) };
}

function templateBirthdayReminder(data: any) {
  const friendName = data.friend_name || "your friend";
  const days = data.days_until;
  const preheader = `${friendName}'s birthday is coming up.`;
  const body = `
    <h1>🎂 ${escapeHtml(friendName)}'s birthday is in ${days} days</h1>
    <p>Open Tenner to see a curated gift guide based on ${escapeHtml(friendName)}'s Top 10 lists — books, movies, songs, and things they've told you they love.</p>
    <p style="text-align:center;margin-top:24px"><a href="${APP_URL}" class="cta">See gift ideas →</a></p>`;
  return { subject: `${friendName}'s birthday in ${days} days 🎂`, html: baseTemplate(preheader, body) };
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
  return { subject: `🎊 Tenner reveal: Top 10 ${cat}`, html: baseTemplate(preheader, body) };
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
  return { subject: `Tenner feedback update: ${statusLabel}`, html: baseTemplate(preheader, body) };
}

function templateFriendUpdate(data: any) {
  const friendName = data.friend_name || "A friend";
  const cat = data.category || "list";
  const preheader = `${friendName} updated their ${cat} list.`;
  const body = `
    <h1>${escapeHtml(friendName)} updated their Top 10 ${escapeHtml(cat)}</h1>
    <p>Their picks changed — your match score with them might have shifted too. See what's new.</p>
    <p style="text-align:center;margin-top:24px"><a href="${APP_URL}" class="cta">See the update →</a></p>`;
  return { subject: `${friendName} updated their Top 10 ${cat}`, html: baseTemplate(preheader, body) };
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
  return { subject, html: baseTemplate(preheader, body) };
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
  return { subject: `${requesterName} wants to add you on Tenner`, html: baseTemplate(preheader, body) };
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
  return { subject: `${senderName} shared a Top 10 ${cat} list with you`, html: baseTemplate(preheader, body) };
}

function escapeHtml(str: string) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

async function sendResend(to: string, subject: string, html: string) {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("FROM_EMAIL") || "Tenner <hello@mytenner.com>";
  if (!apiKey) throw new Error("RESEND_API_KEY not configured");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ from, to: [to], subject, html }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Resend error ${res.status}: ${errText}`);
  }
  return await res.json();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });

  try {
    const { type, to, data } = await req.json();
    if (!type || !to) throw new Error("type and to are required");

    let tpl;
    switch (type) {
      case "welcome":            tpl = templateWelcome(data || {}); break;
      case "birthday_reminder":  tpl = templateBirthdayReminder(data || {}); break;
      case "weekly_reveal":      tpl = templateWeeklyReveal(data || {}); break;
      case "feedback_update":    tpl = templateFeedbackUpdate(data || {}); break;
      case "friend_update":      tpl = templateFriendUpdate(data || {}); break;
      case "new_comment":        tpl = templateNewComment(data || {}); break;
      case "friend_request":     tpl = templateFriendRequest(data || {}); break;
      case "list_share":         tpl = templateListShare(data || {}); break;
      default: throw new Error(`Unknown email type: ${type}`);
    }

    const result = await sendResend(to, tpl.subject, tpl.html);
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
