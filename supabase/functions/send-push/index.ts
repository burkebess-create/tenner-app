// send-push — deliver a Web Push notification to all of a user's subscriptions.
//
// Invoked from the client (or other edge functions) with:
//   { to_email?: string, to_user_id?: string, title: string, body: string, url?: string }
//
// One of to_email / to_user_id is required. If to_email, we look up the user_id
// via profiles. Then we fetch all rows from push_subscriptions and POST to each
// endpoint using the Web Push protocol (VAPID-signed).
//
// Respects user_email_prefs.prefs.push === false as opt-out (opt-out model,
// same as email). Dead subscriptions (410/404 from endpoint) are auto-deleted.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import webpush from 'https://esm.sh/web-push@3.6.7';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY')!;
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') || 'mailto:hello@mytenner.com';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { to_email, to_user_id, title, body, url } = await req.json();
    if (!title || !body) throw new Error('title and body required');
    if (!to_email && !to_user_id) throw new Error('to_email or to_user_id required');

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // Resolve to user_id
    let userId = to_user_id;
    if (!userId && to_email) {
      const { data: authUser } = await supabase.auth.admin.listUsers();
      const found = authUser?.users?.find((u: any) => (u.email || '').toLowerCase() === to_email.toLowerCase());
      if (!found) return new Response(JSON.stringify({ sent: 0, reason: 'no_user' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      userId = found.id;
    }

    // Check opt-out
    const { data: prefRow } = await supabase.from('user_email_prefs').select('prefs').eq('user_id', userId).maybeSingle();
    if (prefRow?.prefs?.push === false) {
      return new Response(JSON.stringify({ sent: 0, reason: 'opted_out' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Fetch subscriptions
    const { data: subs, error: subsErr } = await supabase.from('push_subscriptions').select('*').eq('user_id', userId);
    if (subsErr) throw subsErr;
    if (!subs || subs.length === 0) {
      return new Response(JSON.stringify({ sent: 0, reason: 'no_subscriptions' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const payload = JSON.stringify({ title, body, url: url || '/' });
    let sent = 0;
    const deadIds: string[] = [];

    await Promise.all(subs.map(async (s: any) => {
      const subscription = {
        endpoint: s.endpoint,
        keys: { p256dh: s.p256dh, auth: s.auth },
      };
      try {
        await webpush.sendNotification(subscription, payload);
        sent++;
        // Bump last_used_at (best-effort)
        supabase.from('push_subscriptions').update({ last_used_at: new Date().toISOString() }).eq('id', s.id).then(() => {});
      } catch (err: any) {
        const status = err?.statusCode;
        if (status === 404 || status === 410) {
          deadIds.push(s.id);
        } else {
          console.warn('push send failed', s.id, status, err?.body);
        }
      }
    }));

    if (deadIds.length) {
      await supabase.from('push_subscriptions').delete().in('id', deadIds);
    }

    return new Response(JSON.stringify({ sent, cleaned: deadIds.length }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err: any) {
    console.error('send-push error', err);
    return new Response(JSON.stringify({ error: String(err?.message || err) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
