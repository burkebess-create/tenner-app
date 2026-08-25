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

function baseTemplate(preheader: string, contentHtml: string) {
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
</style></head><body><div class="pre">${preheader}</div><div class="wrap"><div class="brand"><img src="https://mytenner.com/logo-square.png" alt="Tenner" width="90"></div><div class="card">${contentHtml}</div><div class="foot">Tenner — Top 10 lists with friends<br><a href="${APP_URL}" style="color:#888780">${APP_URL}</a></div></div></body></html>`;
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
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  return await res.json();
}

// True if birthdayStr (YYYY-MM-DD) is exactly `targetDays` days from today (ignoring the year)
function isBirthdayInDays(birthdayStr: string, targetDays: number) {
  if (!birthdayStr) return false;
  const parts = birthdayStr.split("-");
  if (parts.length < 3) return false;
  const m = parseInt(parts[1], 10);
  const d = parseInt(parts[2], 10);
  if (!m || !d) return false;
  const today = new Date();
  let target = new Date(today.getFullYear(), m - 1, d);
  const midnightToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const diffDays = Math.round((+target - +midnightToday) / (1000 * 60 * 60 * 24));
  const wrapDiff = diffDays < 0 ? diffDays + 365 : diffDays;
  return wrapDiff === targetDays;
}

async function runBirthdayReminders(supabase: any) {
  console.log("Running birthday reminders...");
  // Fetch all accepted friendships
  const { data: friendships, error: fErr } = await supabase
    .from("friendships")
    .select("requester_id, addressee_id, status")
    .eq("status", "accepted");
  if (fErr) throw fErr;

  // Fetch all profiles with a birthday set + all user emails
  const { data: profiles, error: pErr } = await supabase
    .from("profiles")
    .select("id, display_name, email, birthday");
  if (pErr) throw pErr;
  const profileById: Record<string, any> = {};
  profiles?.forEach((p: any) => { profileById[p.id] = p; });

  let sentCount = 0;
  const bdayYear = new Date().getFullYear();

  for (const f of friendships || []) {
    // For each friendship, produce two (viewer, friend) pairings so both sides get reminded
    const pairings = [
      { viewer: f.requester_id, friend: f.addressee_id },
      { viewer: f.addressee_id, friend: f.requester_id },
    ];
    for (const pair of pairings) {
      const viewerProfile = profileById[pair.viewer];
      const friendProfile = profileById[pair.friend];
      if (!viewerProfile?.email || !friendProfile?.birthday) continue;
      if (!isBirthdayInDays(friendProfile.birthday, 14)) continue;

      // Dedupe via email_log
      const refKey = `${pair.friend}_${bdayYear}`;
      const { data: existing } = await supabase
        .from("email_log")
        .select("id")
        .eq("user_id", pair.viewer)
        .eq("email_type", "birthday_reminder_14")
        .eq("ref_key", refKey)
        .maybeSingle();
      if (existing) continue;

      try {
        const friendName = friendProfile.display_name || "your friend";
        const subject = `${friendName}'s birthday in 14 days 🎂`;
        const html = baseTemplate(`${friendName}'s birthday is coming up.`,
          `<h1>🎂 ${escapeHtml(friendName)}'s birthday is in 14 days</h1>
           <p>Open Tenner to see a curated gift guide based on ${escapeHtml(friendName)}'s Top 10 lists.</p>
           <p style="text-align:center;margin-top:24px"><a href="${APP_URL}" class="cta">See gift ideas →</a></p>`);
        await sendResend(viewerProfile.email, subject, html);
        await supabase.from("email_log").insert({
          user_id: pair.viewer,
          email_type: "birthday_reminder_14",
          ref_key: refKey,
        });
        sentCount++;
      } catch (e) {
        console.error(`Birthday reminder failed for ${viewerProfile.email}:`, e);
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

Deno.serve(async (_req) => {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);
    const dayOfWeek = new Date().getUTCDay(); // 0=Sun, 5=Fri

    const birthdaySent = await runBirthdayReminders(supabase);
    const weeklySent = await runWeeklyRevealEmails(supabase);
    const feedbackDigested = await runFeedbackDigest(supabase);
    // Day-gated runs: nudge/streak only fire on reveal day (typically Friday),
    // and only when a weekly is actually revealing today. Sunday recap fires
    // only on Sundays. All are safe no-ops when their gate isn't met.
    const nudgeSent = await runWeeklyNudge(supabase);
    const streakSent = await runStreakInDanger(supabase);
    const recapSent = dayOfWeek === 0 ? await runSundayRecap(supabase) : 0;

    return new Response(JSON.stringify({
      ok: true,
      birthday_reminders_sent: birthdaySent,
      weekly_reveals_sent: weeklySent,
      feedback_digest_items: feedbackDigested,
      weekly_nudge_sent: nudgeSent,
      streak_in_danger_sent: streakSent,
      sunday_recap_sent: recapSent,
    }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ ok: false, error: String(e.message || e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
