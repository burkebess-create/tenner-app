// Supabase Edge Function: daily-emails
// Scheduled via Supabase Cron to run daily at 8am ET (13:00 UTC).
// Sends:
//   - Birthday reminders (14 days out) to users whose friends have upcoming birthdays
//   - Weekly reveal announcements when a weekly_lists.reveal_at just passed
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
  .brand{font-family:"DM Serif Display",Georgia,serif;font-size:22px;color:#D85A30;text-align:center;margin-bottom:18px;letter-spacing:-.02em}
  .pre{display:none;visibility:hidden;height:0;width:0;overflow:hidden}
</style></head><body><div class="pre">${preheader}</div><div class="wrap"><div class="brand">Tenner</div><div class="card">${contentHtml}</div><div class="foot">Tenner — Top 10 lists with friends<br><a href="${APP_URL}" style="color:#888780">${APP_URL}</a></div></div></body></html>`;
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

Deno.serve(async (_req) => {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const birthdaySent = await runBirthdayReminders(supabase);
    const weeklySent = await runWeeklyRevealEmails(supabase);

    return new Response(JSON.stringify({
      ok: true,
      birthday_reminders_sent: birthdaySent,
      weekly_reveals_sent: weeklySent,
    }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ ok: false, error: String(e.message || e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
