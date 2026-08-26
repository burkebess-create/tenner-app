// send-push — deliver a Web Push notification to all of a user's subscriptions.
// Uses Deno's native Web Crypto API — no external web-push package needed.
//
// Implements: VAPID JWT signing (RFC 8292) + payload encryption (RFC 8291, aes128gcm).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY')!;
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') || 'mailto:contact@mytenner.com';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// ── base64url helpers ──────────────────────────────────────────────────
function b64urlEncode(bytes: Uint8Array): string {
  let s = btoa(String.fromCharCode(...bytes));
  return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice(0, (4 - str.length % 4) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
function concatBytes(...arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

// ── VAPID keypair import ───────────────────────────────────────────────
// Public key is uncompressed EC point: 0x04 || X (32B) || Y (32B) → 65 bytes.
// Private key is 32-byte scalar (d).
async function importVapidPrivateKey(): Promise<CryptoKey> {
  const pub = b64urlDecode(VAPID_PUBLIC_KEY);
  const priv = b64urlDecode(VAPID_PRIVATE_KEY);
  if (pub.length !== 65 || pub[0] !== 0x04) throw new Error('bad VAPID public key');
  if (priv.length !== 32) throw new Error('bad VAPID private key');
  const x = b64urlEncode(pub.slice(1, 33));
  const y = b64urlEncode(pub.slice(33, 65));
  const d = b64urlEncode(priv);
  return await crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x, y, d, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
}

// ── Build VAPID JWT (ES256) for a given push endpoint ──────────────────
async function buildVapidJwt(endpoint: string, privKey: CryptoKey): Promise<string> {
  const aud = new URL(endpoint).origin;
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = { aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: VAPID_SUBJECT };
  const enc = (o: any) => b64urlEncode(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = `${enc(header)}.${enc(payload)}`;
  const sigBuf = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privKey,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${b64urlEncode(new Uint8Array(sigBuf))}`;
}

// ── Payload encryption per RFC 8291 (aes128gcm content encoding) ───────
// Steps: generate ephemeral ECDH keypair → ECDH with UA public key → HKDF
// with (salt, ikm=shared_secret) → derive CEK (16B) and nonce (12B) → wrap
// plaintext with padding delimiter (0x02 + padding bytes) → AES-128-GCM →
// prepend record header (salt || rs || idlen || pubkey).
async function encryptPayload(plaintext: Uint8Array, uaPubB64u: string, uaAuthB64u: string): Promise<Uint8Array> {
  const uaPub = b64urlDecode(uaPubB64u); // 65 bytes uncompressed
  const uaAuth = b64urlDecode(uaAuthB64u); // 16 bytes

  // Ephemeral ECDH keypair (application server keys per notification)
  const asKeypair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );
  const asPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', asKeypair.publicKey)); // 65 bytes

  // Import UA public key for deriveBits
  const uaPubKey = await crypto.subtle.importKey(
    'raw',
    uaPub,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const ecdhBits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: uaPubKey },
    asKeypair.privateKey,
    256,
  ));

  // Salt: 16 random bytes
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // HKDF helper
  async function hkdf(ikm: Uint8Array, saltBytes: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey('raw', ikm, { name: 'HKDF' }, false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: saltBytes, info },
      key,
      len * 8,
    );
    return new Uint8Array(bits);
  }

  // PRK_key = HKDF(auth, ecdhBits, info="WebPush: info\0" || uaPub || asPub, 32)
  const wpInfo = concatBytes(
    new TextEncoder().encode('WebPush: info\0'),
    uaPub,
    asPubRaw,
  );
  const ikm = await hkdf(ecdhBits, uaAuth, wpInfo, 32);

  // CEK = HKDF(salt, ikm, info="Content-Encoding: aes128gcm\0", 16)
  const cek = await hkdf(ikm, salt, new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 16);
  // NONCE = HKDF(salt, ikm, info="Content-Encoding: nonce\0", 12)
  const nonce = await hkdf(ikm, salt, new TextEncoder().encode('Content-Encoding: nonce\0'), 12);

  // Wrap plaintext with delimiter (0x02) — the "record" is last so use 0x02.
  const record = concatBytes(plaintext, new Uint8Array([0x02]));

  // AES-128-GCM encrypt
  const cekKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    cekKey,
    record,
  ));

  // Record header: salt (16) || rs (4 BE) || idlen (1) || keyid (asPubRaw)
  const rs = 4096;
  const header = new Uint8Array(16 + 4 + 1 + asPubRaw.length);
  header.set(salt, 0);
  header[16] = (rs >>> 24) & 0xff;
  header[17] = (rs >>> 16) & 0xff;
  header[18] = (rs >>> 8) & 0xff;
  header[19] = rs & 0xff;
  header[20] = asPubRaw.length;
  header.set(asPubRaw, 21);

  return concatBytes(header, ciphertext);
}

// ── Deliver one push ───────────────────────────────────────────────────
async function sendOnePush(sub: any, payload: string, privKey: CryptoKey): Promise<{ ok: boolean; status: number; body?: string }> {
  const jwt = await buildVapidJwt(sub.endpoint, privKey);
  const encrypted = await encryptPayload(
    new TextEncoder().encode(payload),
    sub.p256dh,
    sub.auth,
  );
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `vapid t=${jwt}, k=${VAPID_PUBLIC_KEY}`,
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL': '60',
    },
    body: encrypted,
  });
  const body = res.ok ? undefined : await res.text().catch(() => undefined);
  return { ok: res.ok, status: res.status, body };
}

// ── HTTP handler ───────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const { to_email, to_user_id, title, body, url } = await req.json();
    if (!title || !body) throw new Error('title and body required');
    if (!to_email && !to_user_id) throw new Error('to_email or to_user_id required');
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    let userId = to_user_id;
    if (!userId && to_email) {
      const { data: authUser } = await supabase.auth.admin.listUsers();
      const found = authUser?.users?.find((u: any) => (u.email || '').toLowerCase() === to_email.toLowerCase());
      if (!found) return new Response(JSON.stringify({ sent: 0, reason: 'no_user' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      userId = found.id;
    }

    const { data: prefRow } = await supabase.from('user_email_prefs').select('prefs').eq('user_id', userId).maybeSingle();
    if (prefRow?.prefs?.push === false) {
      return new Response(JSON.stringify({ sent: 0, reason: 'opted_out' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const { data: subs, error: subsErr } = await supabase.from('push_subscriptions').select('*').eq('user_id', userId);
    if (subsErr) throw subsErr;
    if (!subs || subs.length === 0) {
      return new Response(JSON.stringify({ sent: 0, reason: 'no_subscriptions' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const privKey = await importVapidPrivateKey();
    const payload = JSON.stringify({ title, body, url: url || '/' });
    let sent = 0;
    const deadIds: string[] = [];

    await Promise.all(subs.map(async (s: any) => {
      try {
        const r = await sendOnePush(s, payload, privKey);
        if (r.ok) {
          sent++;
          supabase.from('push_subscriptions').update({ last_used_at: new Date().toISOString() }).eq('id', s.id).then(() => {});
        } else if (r.status === 404 || r.status === 410) {
          deadIds.push(s.id);
        } else {
          console.warn('push send non-ok', s.id, r.status, r.body);
        }
      } catch (err: any) {
        console.warn('push send threw', s.id, err?.message);
      }
    }));

    if (deadIds.length) {
      await supabase.from('push_subscriptions').delete().in('id', deadIds);
    }

    return new Response(JSON.stringify({ sent, cleaned: deadIds.length, total: subs.length }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err: any) {
    console.error('send-push error', err?.message, err?.stack);
    return new Response(JSON.stringify({ error: String(err?.message || err) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
