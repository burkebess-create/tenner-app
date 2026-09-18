// Supabase Edge Function: daily-emails
// Scheduled via Supabase Cron to run daily at 8am ET (13:00 UTC).
// Sends:
//   - Birthday reminders (14 days out) to users whose friends have upcoming birthdays
//   - Weekly reveal announcements when a weekly_lists.reveal_at just passed
//   - Feedback digest to contact@mytenner.com summarizing new feedback (past 24h)
//
// Environment secrets required:
//   RESEND_API_KEY               your Resend API key
//   FROM_EMAIL                   verified sender, e.g. "Tenner <hello@mytenner.com>"
//   SUPABASE_URL                 (auto-injected by Supabase)
//   SUPABASE_SERVICE_ROLE_KEY    (auto-injected by Supabase — used to bypass RLS to query all users)

// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const APP_URL = "https://mytenner.com/";

function baseTemplate(preheader: string, contentHtml: string, unsubToken?: string) {
  const unsubBlock = unsubToken
    ? `<a href="${APP_URL}unsubscribe.html?t=${unsubToken}" style="color:#888780">Unsubscribe or manage preferences</a><br>`
    : "";
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#FAF8F5;margin:0;color:#2C2C2A}
  .wrap{max-width:560px;margin:0 auto;padding:32px 20px}
  .card{background:#fff;border-radius:16px;padding:28px 24px;border:1px solid #EAE3DC}
  h1{font-family:"DM Serif Display",Georgia,serif;font-size:28px;letter-spacing:-.02em;color:#1A0F0A;margin:0 0 12px;font-weight:400}
  p{line-height:1.55;margin:0 0 14px;font-size:15px}
  .cta{display:inline-block;background:#D85A30;color:#fff!important;padding:12px 24px;border-radius:999px;text-decoration:none;font-weight:600;font-size:15px}
  .foot{color:#888780;font-size:12px;text-align:center;padding:20px 8px}
  .brand{text-align:center;margin-bottom:18px}.brand img{width:90px;height:auto;display:inline-block}
  .pre{display:none;visibility:hidden;height:0;width:0;overflow:hidden}
</style></head><body><div class="pre">${preheader}</div><div class="wrap"><div class="brand"><img src="https://mytenner.com/logo-square.png" alt="Tenner" width="90"></div><div class="card">${contentHtml}</div><div class="foot">Tenner — Top 10 lists with friends<br>${unsubBlock}<a href="${APP_URL}" style="color:#888780">${APP_URL}</a></div></div></body></html>`;
}

function escapeHtml(str: string) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

async function sendResend(to: string, subject: string, html: string, headers?: Record<string, string>) {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("FROM_EMAIL") || "Tenner <hello@mytenner.com>";
  if (!apiKey) throw new Error("RESEND_API_KEY not configured");
  const body: any = { from, to: [to], subject, html };
  if (headers) body.headers = headers;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  return await res.json();
}

// True if birthdayStr (YYYY-MM-DD) is exactly `targetDays` days from today (ignoring the year)
function isBirthdayInDays(birthdayStr: string, targetDays: number) {
  if (!birthdayStr) return false;
  const parts = birthdayStr.split("-");
  if (parts.length < 3) return false;
  const m = parseInt(parts[1], 10);
  let d = parseInt(parts[2], 10);
  if (!m || !d) return false;
  const today = new Date();
  const year = today.getFullYear();
  const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  // Feb 29 born: observe on Feb 28 in non-leap years.
  let observeMonth = m, observeDay = d;
  if (m === 2 && d === 29 && !isLeap(year)) observeDay = 28;
  let target = new Date(year, observeMonth - 1, observeDay);
  const midnightToday = new Date(year, today.getMonth(), today.getDate());
  if (target.getTime() < midnightToday.getTime()) {
    // Roll to next year (may or may not be leap).
    const ny = year + 1;
    let od = d;
    if (m === 2 && d === 29 && !isLeap(ny)) od = 28;
    target = new Date(ny, m - 1, od);
  }
  const diffDays = Math.round((+target - +midnightToday) / (1000 * 60 * 60 * 24));
  return diffDays === targetDays;
}

// Amazon affiliate search URL built the same way the app builds it.
function amazonSearchUrl(item: string, category: string) {
  const q = `${item} ${category || ''} gift`.trim();
  return `https://www.amazon.com/s?k=${encodeURIComponent(q).replace(/%20/g, '+')}&tag=tenner09-20`;
}

async function runBirthdayReminders(supabase: any, targetDays: number) {
  console.log(`Running birthday reminders (${targetDays}-day)...`);
  const emailType = `birthday_reminder_${targetDays}`;
  const { data: friendships, error: fErr } = await supabase
    .from("friendships")
    .select("requester_id, addressee_id, status")
    .eq("status", "accepted");
  if (fErr) throw fErr;

  const { data: profiles, error: pErr } = await supabase
    .from("profiles")
    .select("id, display_name, email, birthday, gift_share_token");
  if (pErr) throw pErr;
  const profileById: Record<string, any> = {};
  profiles?.forEach((p: any) => { profileById[p.id] = p; });

  let sentCount = 0;
  const bdayYear = new Date().getFullYear();

  for (const f of friendships || []) {
    const pairings = [
      { viewer: f.requester_id, friend: f.addressee_id },
      { viewer: f.addressee_id, friend: f.requester_id },
    ];
    for (const pair of pairings) {
      const viewerProfile = profileById[pair.viewer];
      const friendProfile = profileById[pair.friend];
      if (!viewerProfile?.email || !friendProfile?.birthday) continue;
      if (!isBirthdayInDays(friendProfile.birthday, targetDays)) continue;

      const refKey = `${pair.friend}_${bdayYear}_${targetDays}`;
      const { data: existing } = await supabase
        .from("email_log")
        .select("id")
        .eq("user_id", pair.viewer)
        .eq("email_type", emailType)
        .eq("ref_key", refKey)
        .maybeSingle();
      if (existing) continue;

      // Pull the recipient's most-recently-updated public list to seed inline picks
      let picksHtml = "";
      try {
        const { data: topList } = await supabase
          .from("lists")
          .select("category, emoji, items")
          .eq("user_id", pair.friend)
          .eq("is_public", true)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (topList && Array.isArray(topList.items) && topList.items.length > 0) {
          const picks = topList.items.slice(0, 3);
          const rows = picks.map((it: string, i: number) => {
            const shopUrl = `${amazonSearchUrl(it, topList.category)}&ascsubtag=bday${targetDays}_${pair.viewer.slice(0,8)}`;
            return `<tr><td style="padding:10px 12px;border-bottom:1px solid #EAE3DC;vertical-align:middle">
              <span style="display:inline-block;width:22px;height:22px;background:#2C2C2A;color:#fff;border-radius:3px;font-size:11px;font-weight:800;text-align:center;line-height:22px;margin-right:10px">${i + 1}</span>
              <span style="font-size:14px;color:#2C2C2A;font-weight:600">${escapeHtml(it)}</span>
            </td><td style="padding:10px 12px;border-bottom:1px solid #EAE3DC;text-align:right;vertical-align:middle">
              <a href="${shopUrl}" style="color:#D85A30;font-size:12px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;text-decoration:none">Shop →</a>
            </td></tr>`;
          }).join("");
          picksHtml = `<p style="margin-top:20px;margin-bottom:8px;font-size:12px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:#888780">From their Top 10 ${escapeHtml(topList.category)}</p>
            <table style="width:100%;border-collapse:collapse;background:#FDFCF8;border:1px solid #EAE3DC;border-radius:6px">${rows}</table>`;
        }
      } catch (e) { console.error("inline picks fetch failed:", e); }

      // Deep link into their personal gift page with viewer id for click attribution.
      const giftUrl = friendProfile.gift_share_token
        ? `${APP_URL}g?t=${encodeURIComponent(friendProfile.gift_share_token)}&from=${encodeURIComponent(pair.viewer)}&utm_source=email&utm_medium=birthday&utm_campaign=bday${targetDays}`
        : `${APP_URL}?utm_source=email&utm_medium=birthday&utm_campaign=bday${targetDays}`;

      try {
        const friendName = friendProfile.display_name || "your friend";
        const daysCopy = targetDays === 3 ? "in just 3 days" : `in ${targetDays} days`;
        const urgency = targetDays === 3 ? "⏰ Last-minute reminder — " : "";
        const subject = `${urgency}${friendName}'s birthday ${daysCopy} 🎂`;
        const html = baseTemplate(`${friendName}'s birthday is ${daysCopy}.`,
          `<h1>🎂 ${escapeHtml(friendName)}'s birthday is ${daysCopy}</h1>
           <p>Here are a few ideas built from their Top 10 lists on Tenner.</p>
           ${picksHtml}
           <p style="text-align:center;margin-top:24px"><a href="${giftUrl}" class="cta">See their full gift guide →</a></p>`);
        await sendResend(viewerProfile.email, subject, html);
        await supabase.from("email_log").insert({
          user_id: pair.viewer,
          email_type: emailType,
          ref_key: refKey,
        });
        sentCount++;
      } catch (e) {
        console.error(`Birthday reminder (${targetDays}d) failed for ${viewerProfile.email}:`, e);
      }
    }
  }
  return sentCount;
}

async function runWeeklyRevealEmails(supabase: any) {
  console.log("Running weekly reveal emails...");
  // Find weekly lists that revealed in the past 24 hours
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();
  const { data: weeklyLists, error } = await supabase
    .from("weekly_lists")
    .select("id, category, emoji, reveal_at")
    .gte("reveal_at", yesterday)
    .lte("reveal_at", now);
  if (error) throw error;
  if (!weeklyLists?.length) return 0;

  // Fetch all users with an email
  const { data: profiles, error: pErr } = await supabase
    .from("profiles")
    .select("id, email");
  if (pErr) throw pErr;

  let sentCount = 0;
  for (const wk of weeklyLists) {
    for (const p of profiles || []) {
      if (!p.email) continue;
      const refKey = wk.id;
      // Dedupe
      const { data: existing } = await supabase
        .from("email_log")
        .select("id")
        .eq("user_id", p.id)
        .eq("email_type", "weekly_reveal")
        .eq("ref_key", refKey)
        .maybeSingle();
      if (existing) continue;

      try {
        const subject = `🎊 Tenner reveal: Top 10 ${wk.category}`;
        const html = baseTemplate(`The Tenner Top 10 ${wk.category} is live.`,
          `<h1>🎊 The reveal is live!</h1>
           <p>This week's Tenner list — <strong>${wk.emoji || "📋"} Top 10 ${escapeHtml(wk.category)}</strong> — is now revealed.</p>
           <p>See how your picks stack up against your friends and the entire Tenner community.</p>
           <p style="text-align:center;margin-top:24px"><a href="${APP_URL}" class="cta">See the reveal →</a></p>`);
        await sendResend(p.email, subject, html);
        await supabase.from("email_log").insert({
          user_id: p.id,
          email_type: "weekly_reveal",
          ref_key: refKey,
        });
        sentCount++;
      } catch (e) {
        console.error(`Weekly reveal email failed for ${p.email}:`, e);
      }
    }
  }
  return sentCount;
}

// Digest email to Tenner ops summarizing feedback submitted in the past 24h.
// Sent to a fixed inbox (contact@mytenner.com) — no dedupe needed since the
// window itself prevents overlap between runs. Silent no-op if nothing new.
async function runFeedbackDigest(supabase: any) {
  console.log("Running feedback digest...");
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: rows, error } = await supabase
    .from("feedback")
    .select("user_email, category, message, status, created_at")
    .gte("created_at", since)
    .order("created_at", { ascending: false });
  if (error) throw error;
  if (!rows || rows.length === 0) return 0;

  const catLabel: Record<string, string> = {
    idea: "💡 Idea",
    bug: "🐛 Bug",
    other: "📝 Other",
  };
  const itemsHtml = rows.map((f: any) => {
    const when = f.created_at ? new Date(f.created_at).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }) : '';
    const tag = catLabel[f.category] || `📝 ${f.category || 'other'}`;
    return `<div style="border:1px solid #EAE3DC;border-radius:12px;padding:14px 16px;margin-bottom:10px">
      <div style="font-size:11px;color:#888780;margin-bottom:6px;display:flex;justify-content:space-between;gap:8px">
        <span><strong style="color:#2C2C2A">${escapeHtml(f.user_email || 'anonymous')}</strong> · ${tag}</span>
        <span>${escapeHtml(when)}</span>
      </div>
      <div style="font-size:14px;color:#2C2C2A;white-space:pre-wrap;line-height:1.5">${escapeHtml(f.message || '')}</div>
    </div>`;
  }).join('');

  const subject = `📬 Tenner feedback digest — ${rows.length} new ${rows.length === 1 ? 'item' : 'items'}`;
  const html = baseTemplate(
    `${rows.length} new feedback item${rows.length === 1 ? '' : 's'} in the past 24h.`,
    `<h1>📬 Feedback digest</h1>
     <p><strong>${rows.length}</strong> new feedback submission${rows.length === 1 ? '' : 's'} in the past 24 hours.</p>
     ${itemsHtml}
     <p style="text-align:center;margin-top:24px"><a href="${APP_URL}" class="cta">Open admin panel →</a></p>`
  );

  await sendResend("contact@mytenner.com", subject, html);
  return rows.length;
}

// ─────────────────────────────────────────────────────────────────────
// Weekly-list nudge: sent when a weekly reveals TODAY and user hasn't
// filled it yet. Combines with streak-in-danger — users on streaks get
// two escalating reminders (this one + the streak version below).
// ─────────────────────────────────────────────────────────────────────
async function runWeeklyNudge(supabase: any) {
  console.log("Running weekly-list nudge...");
  const now = new Date();
  const endOfDay = new Date(now); endOfDay.setHours(23, 59, 59, 999);
  const { data: revealingToday, error } = await supabase
    .from("weekly_lists")
    .select("id, category, emoji, reveal_at")
    .gte("reveal_at", now.toISOString())
    .lte("reveal_at", endOfDay.toISOString());
  if (error) throw error;
  if (!revealingToday?.length) return 0;

  // For each weekly revealing today, find users who haven't filled it
  const { data: profiles } = await supabase.from("profiles").select("id, email, display_name");
  if (!profiles?.length) return 0;

  let sentCount = 0;
  for (const wk of revealingToday) {
    // Anyone with a matching list row (any state)
    const { data: filledList } = await supabase.from("lists").select("user_id").eq("category", wk.category);
    const filled = new Set((filledList || []).map((l: any) => l.user_id));
    for (const p of profiles) {
      if (!p.email || filled.has(p.id)) continue;
      // Check pref
      const { data: prefRow } = await supabase.from("user_email_prefs").select("prefs").eq("user_id", p.id).maybeSingle();
      if (prefRow && prefRow.prefs && prefRow.prefs.weekly === false) continue;
      const refKey = wk.id + "__nudge";
      const { data: sent } = await supabase.from("email_log").select("id").eq("user_id", p.id).eq("email_type", "weekly_nudge").eq("ref_key", refKey).maybeSingle();
      if (sent) continue;
      const revealTime = new Date(wk.reveal_at).toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });
      try {
        const subject = `⏰ ${wk.emoji || "📋"} Top 10 ${wk.category} reveals TONIGHT at ${revealTime}`;
        const html = baseTemplate(
          `Reveals tonight at ${revealTime} — have you filled yours?`,
          `<h1>⏰ Reveals tonight</h1>
           <p><strong>${wk.emoji || "📋"} Top 10 ${escapeHtml(wk.category)}</strong> reveals at <strong>${revealTime}</strong>.</p>
           <p>You haven't filled yours yet. Get in before it's live so you can compare with your friends and all of Tenner.</p>
           <p style="text-align:center;margin-top:24px"><a href="${APP_URL}" class="cta">Fill it out →</a></p>`
        );
        await sendResend(p.email, subject, html);
        await supabase.from("email_log").insert({ user_id: p.id, email_type: "weekly_nudge", ref_key: refKey });
        sentCount++;
      } catch (e) { console.error(`weekly_nudge failed for ${p.email}:`, e); }
    }
  }
  return sentCount;
}

// ─────────────────────────────────────────────────────────────────────
// Streak-in-danger: user has an active streak (filled >=2 recent weeklies)
// but hasn't filled THIS week's yet. Sent on reveal day to nudge them.
// Loss-aversion driver — telling them what they'd lose.
// ─────────────────────────────────────────────────────────────────────
async function runStreakInDanger(supabase: any) {
  console.log("Running streak-in-danger...");
  const now = new Date();
  const endOfDay = new Date(now); endOfDay.setHours(23, 59, 59, 999);
  const { data: revealingToday } = await supabase
    .from("weekly_lists")
    .select("id, category, emoji, reveal_at")
    .gte("reveal_at", now.toISOString())
    .lte("reveal_at", endOfDay.toISOString());
  if (!revealingToday?.length) return 0;

  const { data: allWeeklies } = await supabase
    .from("weekly_lists")
    .select("id, category, week_start, reveal_at")
    .order("week_start", { ascending: false })
    .limit(20);
  const pastWeeklies = (allWeeklies || []).filter((w: any) => new Date(w.reveal_at) < now);

  const { data: profiles } = await supabase.from("profiles").select("id, email, display_name");
  if (!profiles?.length) return 0;

  let sentCount = 0;
  for (const wk of revealingToday) {
    const { data: filledList } = await supabase.from("lists").select("user_id, category, updated_at").in("category", pastWeeklies.map((w: any) => w.category).concat([wk.category]));
    const listsByUser: Record<string, any[]> = {};
    (filledList || []).forEach((l: any) => { (listsByUser[l.user_id] = listsByUser[l.user_id] || []).push(l); });
    for (const p of profiles) {
      if (!p.email) continue;
      // Skip if they've already filled THIS week
      const alreadyFilledThisWeek = (listsByUser[p.id] || []).some((l: any) => l.category === wk.category);
      if (alreadyFilledThisWeek) continue;
      // Compute streak from past weeklies
      let streak = 0;
      const sortedPast = pastWeeklies.slice().sort((a: any, b: any) => (b.week_start || '').localeCompare(a.week_start || ''));
      for (let i = 0; i < sortedPast.length; i++) {
        const pw = sortedPast[i];
        const wStart = new Date(pw.week_start + "T00:00:00").getTime();
        const nextStart = sortedPast[i - 1] ? new Date(sortedPast[i - 1].week_start + "T00:00:00").getTime() : wStart + 14 * 86400000;
        const hit = (listsByUser[p.id] || []).some((l: any) => {
          if (l.category !== pw.category) return false;
          if (!l.updated_at) return false;
          const t = new Date(l.updated_at).getTime();
          return t >= wStart && t < nextStart;
        });
        if (hit) streak++; else break;
      }
      if (streak < 2) continue; // only nudge if there's a real streak at risk
      const { data: prefRow } = await supabase.from("user_email_prefs").select("prefs").eq("user_id", p.id).maybeSingle();
      if (prefRow && prefRow.prefs && prefRow.prefs.weekly === false) continue;
      const refKey = wk.id + "__streak";
      const { data: sent } = await supabase.from("email_log").select("id").eq("user_id", p.id).eq("email_type", "streak_in_danger").eq("ref_key", refKey).maybeSingle();
      if (sent) continue;
      try {
        const subject = `🔥 Your ${streak}-week streak is on the line`;
        const html = baseTemplate(
          `Your ${streak}-week streak ends if you don't fill this week's list.`,
          `<h1>🔥 Your ${streak}-week streak is at risk</h1>
           <p>You've filled every weekly list for <strong>${streak} weeks in a row</strong>. Don't break the chain.</p>
           <p>This week: <strong>Top 10 ${escapeHtml(wk.category)}</strong> — reveals tonight.</p>
           <p style="text-align:center;margin-top:24px"><a href="${APP_URL}" class="cta">Keep the streak alive →</a></p>`
        );
        await sendResend(p.email, subject, html);
        await supabase.from("email_log").insert({ user_id: p.id, email_type: "streak_in_danger", ref_key: refKey });
        sentCount++;
      } catch (e) { console.error(`streak_in_danger failed for ${p.email}:`, e); }
    }
  }
  return sentCount;
}

// ─────────────────────────────────────────────────────────────────────
// Sunday weekly recap: for each user, sum their past-7-days activity
// (reactions received, comments received, new friends, lists updated).
// Skip anyone with zero activity — no empty recaps.
// ─────────────────────────────────────────────────────────────────────
async function runSundayRecap(supabase: any) {
  console.log("Running Sunday recap...");
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data: profiles } = await supabase.from("profiles").select("id, email, display_name");
  if (!profiles?.length) return 0;

  const [reactionsRes, commentsRes, friendshipsRes, listsRes] = await Promise.all([
    supabase.from("list_reactions").select("list_owner_id, from_user_id, created_at").gte("created_at", sevenDaysAgo),
    supabase.from("list_item_comments").select("list_owner_id, from_user_id, created_at").gte("created_at", sevenDaysAgo),
    supabase.from("friendships").select("requester_id, addressee_id, status").eq("status", "accepted"),
    supabase.from("lists").select("user_id, updated_at").gte("updated_at", sevenDaysAgo),
  ]);
  const reactionsByOwner: Record<string, number> = {};
  (reactionsRes.data || []).forEach((r: any) => { if (r.from_user_id !== r.list_owner_id) reactionsByOwner[r.list_owner_id] = (reactionsByOwner[r.list_owner_id] || 0) + 1; });
  const commentsByOwner: Record<string, number> = {};
  (commentsRes.data || []).forEach((c: any) => { if (c.from_user_id !== c.list_owner_id) commentsByOwner[c.list_owner_id] = (commentsByOwner[c.list_owner_id] || 0) + 1; });
  const friendCountByUser: Record<string, number> = {};
  (friendshipsRes.data || []).forEach((f: any) => {
    friendCountByUser[f.requester_id] = (friendCountByUser[f.requester_id] || 0) + 1;
    friendCountByUser[f.addressee_id] = (friendCountByUser[f.addressee_id] || 0) + 1;
  });
  const listsUpdatedByUser: Record<string, number> = {};
  (listsRes.data || []).forEach((l: any) => { listsUpdatedByUser[l.user_id] = (listsUpdatedByUser[l.user_id] || 0) + 1; });

  let sentCount = 0;
  for (const p of profiles) {
    if (!p.email) continue;
    const reactions = reactionsByOwner[p.id] || 0;
    const comments = commentsByOwner[p.id] || 0;
    const listsUpdated = listsUpdatedByUser[p.id] || 0;
    if (reactions + comments + listsUpdated === 0) continue; // nothing worth recapping
    const { data: prefRow } = await supabase.from("user_email_prefs").select("prefs").eq("user_id", p.id).maybeSingle();
    if (prefRow && prefRow.prefs && prefRow.prefs.weekly === false) continue;
    const refKey = new Date().toISOString().slice(0, 10) + "__recap";
    const { data: sent } = await supabase.from("email_log").select("id").eq("user_id", p.id).eq("email_type", "sunday_recap").eq("ref_key", refKey).maybeSingle();
    if (sent) continue;
    const stats: string[] = [];
    if (reactions > 0) stats.push(`<strong>${reactions}</strong> reaction${reactions === 1 ? '' : 's'} on your lists`);
    if (comments > 0) stats.push(`<strong>${comments}</strong> comment${comments === 1 ? '' : 's'} on your lists`);
    if (listsUpdated > 0) stats.push(`You updated <strong>${listsUpdated}</strong> list${listsUpdated === 1 ? '' : 's'}`);
    try {
      const subject = `📊 Your Tenner week`;
      const html = baseTemplate(
        `Your Tenner week in review.`,
        `<h1>📊 Your Tenner week</h1>
         <p>Here's what happened this week:</p>
         <ul>${stats.map((s) => `<li>${s}</li>`).join('')}</ul>
         <p style="text-align:center;margin-top:24px"><a href="${APP_URL}" class="cta">Open Tenner →</a></p>`
      );
      await sendResend(p.email, subject, html);
      await supabase.from("email_log").insert({ user_id: p.id, email_type: "sunday_recap", ref_key: refKey });
      sentCount++;
    } catch (e) { console.error(`sunday_recap failed for ${p.email}:`, e); }
  }
  return sentCount;
}

// ─────────────────────────────────────────────────────────────────────
// Lifecycle emails: the onboarding leak.
//
// Every other email in this file (and in process-notifications) is gated on
// the user ALREADY being past the step it would nudge them toward: the
// digests need an active friend, sunday_recap skips zero-activity users
// outright, streak_in_danger needs streak >= 2. So a user who signs up and
// stalls gets the welcome email and then total silence — permanently
// unreachable if they never made a list or added a friend.
//
// These four fill that gap. They fire once each, in priority order, at most
// one per user per run and at most LIFECYCLE_MAX across a user's lifetime.
// Eligibility is recomputed from live state every run, so the moment someone
// completes a step its email stops being sendable — there is no queue to
// drain and no way to nag someone who already did the thing.
//
//   first_list       day 2+, no list at all
//   first_friend     day 3+, has a list, no accepted friend
//   no_match         day 5+, has a list and a friend, but no SHARED category
//                    (the in-app "You're first!" moment, by email)
//   profile_birthday day 7+, no birthday set — deliberately the only profile
//                    field chased, because it's the one that powers the gift
//                    reminders OTHER people get about them. Chasing a bio or
//                    a photo would be nagging for our benefit, not theirs.
// ─────────────────────────────────────────────────────────────────────
const LIFECYCLE_MAX = 3;         // hard lifetime cap per user, across all stages
const LIFECYCLE_TYPES = ["lifecycle_first_list", "lifecycle_first_friend", "lifecycle_no_match", "lifecycle_profile_birthday"];

function daysSince(iso: string) {
  if (!iso) return 0;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

// PostgREST caps a plain select at 1000 rows and returns them without error,
// so an un-paged read silently goes wrong the moment a table crosses that
// line. `lists` is the one here that will get there first, and a truncated
// read would mean emailing people who DO have a list telling them they don't.
async function fetchAll(query: () => any, pageSize = 1000) {
  const out: any[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await query().range(from, from + pageSize - 1);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < pageSize) return out;
  }
}

// Pure so the ordering can be tested without a database. Returns the single
// highest-priority stage the user is eligible for, or null.
export function pickLifecycleStage(
  age: number, nLists: number, nFriends: number, hasMatch: boolean, hasBirthday: boolean
): string | null {
  if (age >= 2 && nLists === 0) return "first_list";
  if (age >= 3 && nLists > 0 && nFriends === 0) return "first_friend";
  if (age >= 5 && nLists > 0 && nFriends > 0 && !hasMatch) return "no_match";
  if (age >= 7 && !hasBirthday) return "profile_birthday";
  return null;
}

function lifecycleContent(stage: string, ctx: any) {
  const name = (ctx.name || "").split(" ")[0];
  const hi = name ? `${escapeHtml(name)}, ` : "";
  if (stage === "first_list") {
    // Suggest what's actually popular right now — those are the categories
    // most likely to produce a match, which is the whole payoff.
    const pills = (ctx.topCategories || []).slice(0, 3).map((c: string) =>
      `<a href="${APP_URL}?fill=${encodeURIComponent(c)}" style="display:inline-block;border:1px solid #EAE3DC;border-radius:999px;padding:8px 16px;margin:4px 4px 4px 0;text-decoration:none;color:#2C2C2A;font-size:14px">Top 10 ${escapeHtml(c)}</a>`
    ).join("");
    return {
      subject: "Your first Top 10 takes about 90 seconds",
      preheader: "Pick a category, list ten things you love. That's it.",
      body: `<h1>Ready when you are</h1>
        <p>${hi}you signed up for Tenner but haven't made a list yet. It's genuinely quick — pick something you have opinions about and rank ten of them.</p>
        <p>Popular right now:</p>
        <p>${pills}</p>
        <p style="text-align:center;margin-top:24px"><a href="${APP_URL}" class="cta">Make my first list →</a></p>`,
    };
  }
  if (stage === "first_friend") {
    const cat = ctx.sampleCategory || "list";
    return {
      subject: `Your Top 10 ${cat} is waiting for someone to beat it`,
      preheader: "Tenner works when you can compare. Add someone.",
      body: `<h1>Nobody's seen your list yet</h1>
        <p>${hi}you made a <strong>Top 10 ${escapeHtml(cat)}</strong> — nice. But Tenner's whole point is seeing how your picks stack up against people you know, and you haven't added anyone yet.</p>
        <p>Anyone who signs up from your invite link becomes a friend automatically. No app to install.</p>
        <p style="text-align:center;margin-top:24px"><a href="${APP_URL}?invite=1" class="cta">Invite someone →</a></p>`,
    };
  }
  if (stage === "no_match") {
    const cat = ctx.sampleCategory || "list";
    return {
      subject: `You're the only one with a Top 10 ${cat}`,
      preheader: "Get one friend to fill theirs out and you've got a match.",
      body: `<h1>You're first</h1>
        <p>${hi}none of your friends on Tenner have a <strong>Top 10 ${escapeHtml(cat)}</strong> yet, so there's nothing to compare against.</p>
        <p>Ask one of them to fill theirs out — the match opens up the moment they do.</p>
        <p style="text-align:center;margin-top:24px"><a href="${APP_URL}?share=${encodeURIComponent(cat)}" class="cta">Ask a friend →</a></p>`,
    };
  }
  return {
    subject: "One field away from better gifts",
    preheader: "Add your birthday so friends get a heads-up.",
    body: `<h1>Add your birthday</h1>
      <p>${hi}your profile is missing a birthday. That's the one field that works <em>for</em> you: friends get a reminder two weeks before, pointed at your lists, so they actually know what to get you.</p>
      <p>Takes five seconds.</p>
      <p style="text-align:center;margin-top:24px"><a href="${APP_URL}?profile=1" class="cta">Add my birthday →</a></p>`,
  };
}

// Test mode lives in app_settings, not in this file, so switching from a test
// send to the real one is one UPDATE instead of a redeploy. While the list is
// non-empty we send ONLY to those addresses, send all four stages to each (an
// admin account usually qualifies for none of them, so stage-based selection
// would send nothing to review), and write no email_log rows — a test must
// never burn a real user's once-ever send.
async function lifecycleTestEmails(supabase: any): Promise<string[]> {
  try {
    const { data } = await supabase.from("app_settings").select("value").eq("key", "lifecycle_test_emails").maybeSingle();
    const v = data?.value;
    if (!Array.isArray(v)) return [];
    return v.map((s: any) => String(s).trim().toLowerCase()).filter(Boolean);
  } catch (e) { console.error("lifecycle test-mode lookup failed:", e); return []; }
}

async function runLifecycleEmails(supabase: any) {
  console.log("Running lifecycle emails...");
  const testEmails = await lifecycleTestEmails(supabase);
  const testMode = testEmails.length > 0;
  if (testMode) console.log("LIFECYCLE TEST MODE — only:", testEmails.join(", "));
  const profiles = await fetchAll(() =>
    supabase.from("profiles").select("id, email, display_name, birthday, created_at, is_system, is_banned"));
  if (!profiles.length) return 0;
  const candidates = testMode
    ? profiles.filter((p: any) => p.email && testEmails.includes(String(p.email).toLowerCase()))
    : profiles.filter((p: any) =>
        p.email && !p.is_system && !p.is_banned && daysSince(p.created_at) >= 2
      );
  if (!candidates.length) return 0;

  const [allLists, allFriends, allPrefs, allLog] = await Promise.all([
    fetchAll(() => supabase.from("lists").select("user_id, category, updated_at")),
    fetchAll(() => supabase.from("friendships").select("requester_id, addressee_id").eq("status", "accepted")),
    fetchAll(() => supabase.from("user_email_prefs").select("user_id, prefs, unsubscribe_token")),
    fetchAll(() => supabase.from("email_log").select("user_id, email_type").in("email_type", LIFECYCLE_TYPES)),
  ]);

  // Newest list per user doubles as the category we name in the copy.
  const listsByUser: Record<string, any[]> = {};
  allLists.forEach((l: any) => { (listsByUser[l.user_id] = listsByUser[l.user_id] || []).push(l); });
  const friendsByUser: Record<string, string[]> = {};
  allFriends.forEach((f: any) => {
    (friendsByUser[f.requester_id] = friendsByUser[f.requester_id] || []).push(f.addressee_id);
    (friendsByUser[f.addressee_id] = friendsByUser[f.addressee_id] || []).push(f.requester_id);
  });
  const prefByUser: Record<string, any> = {};
  allPrefs.forEach((r: any) => { prefByUser[r.user_id] = r; });
  const sentByUser: Record<string, Set<string>> = {};
  allLog.forEach((r: any) => {
    (sentByUser[r.user_id] = sentByUser[r.user_id] || new Set()).add(r.email_type);
  });

  const catCounts: Record<string, number> = {};
  allLists.forEach((l: any) => { if (l.category) catCounts[l.category] = (catCounts[l.category] || 0) + 1; });
  const topCategories = Object.keys(catCounts).sort((a, b) => catCounts[b] - catCounts[a]).slice(0, 3);

  let sentCount = 0;
  for (const p of candidates) {
    const already = sentByUser[p.id] || new Set();
    const pref = prefByUser[p.id];
    if (!testMode) {
      if (already.size >= LIFECYCLE_MAX) continue;
      if (pref?.prefs && pref.prefs.getting_started === false) continue;
    }

    const age = daysSince(p.created_at);
    const myLists = listsByUser[p.id] || [];
    const myFriends = friendsByUser[p.id] || [];
    const newest = myLists.slice().sort((a: any, b: any) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")))[0];

    const mine = new Set(myLists.map((l: any) => l.category));
    const hasMatch = myFriends.some((fid: string) =>
      (listsByUser[fid] || []).some((l: any) => mine.has(l.category))
    );
    // Normally: first eligible stage wins, sendable once ever. In test mode:
    // every stage, so all four templates can be reviewed at once.
    const stages = testMode
      ? ["first_list", "first_friend", "no_match", "profile_birthday"]
      : (() => {
          const s = pickLifecycleStage(age, myLists.length, myFriends.length, hasMatch, !!p.birthday);
          return s && !already.has("lifecycle_" + s) ? [s] : [];
        })();

    for (const stage of stages) {
      const emailType = "lifecycle_" + stage;
      const tpl = lifecycleContent(stage, {
        name: p.display_name,
        sampleCategory: newest?.category,
        topCategories,
      });
      const token = pref?.unsubscribe_token || "";
      try {
        await sendResend(
          p.email,
          (testMode ? "[TEST] " : "") + tpl.subject,
          baseTemplate(tpl.preheader, tpl.body, token),
          token ? { "List-Unsubscribe": `<${APP_URL}unsubscribe.html?t=${token}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : undefined
        );
        // Deliberately not logged in test mode: an email_log row here would
        // permanently suppress this stage for a real user later.
        if (!testMode) {
          await supabase.from("email_log").insert({ user_id: p.id, email_type: emailType, ref_key: stage });
        }
        sentCount++;
      } catch (e) { console.error(`${emailType} failed for ${p.email}:`, e); }
    }
  }
  return sentCount;
}

Deno.serve(async (_req) => {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);
    const dayOfWeek = new Date().getUTCDay(); // 0=Sun, 5=Fri

    const birthdaySent14 = await runBirthdayReminders(supabase, 14);
    const birthdaySent3 = await runBirthdayReminders(supabase, 3);
    const birthdaySent = birthdaySent14 + birthdaySent3;
    const weeklySent = await runWeeklyRevealEmails(supabase);
    const feedbackDigested = await runFeedbackDigest(supabase);
    // Day-gated runs: nudge/streak only fire on reveal day (typically Friday),
    // and only when a weekly is actually revealing today. Sunday recap fires
    // only on Sundays. All are safe no-ops when their gate isn't met.
    const nudgeSent = await runWeeklyNudge(supabase);
    const streakSent = await runStreakInDanger(supabase);
    const recapSent = dayOfWeek === 0 ? await runSundayRecap(supabase) : 0;
    const lifecycleSent = await runLifecycleEmails(supabase);

    return new Response(JSON.stringify({
      ok: true,
      birthday_reminders_sent: birthdaySent,
      weekly_reveals_sent: weeklySent,
      feedback_digest_items: feedbackDigested,
      weekly_nudge_sent: nudgeSent,
      streak_in_danger_sent: streakSent,
      sunday_recap_sent: recapSent,
      lifecycle_sent: lifecycleSent,
    }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ ok: false, error: String(e.message || e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
