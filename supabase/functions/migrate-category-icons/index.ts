// Admin-only: move inline base64 category icons out of the `emoji` column and
// into Storage, behind the img.mytenner.com CDN.
//
// WHY: the Restaurants icon is a 44,790-character data: URL sitting in
// categories.emoji, and copied again into lists.emoji for every list in that
// category. It rode along in every payload carrying that category, and any
// render path that printed the emoji as text dumped the whole string on
// screen. Hosting it leaves a ~90-character URL in its place.
//
// Idempotent: rows already holding an https URL are skipped, so re-running is
// safe. Identical images are uploaded once and shared by content hash, so the
// three lists using the Restaurants icon all point at one file.
// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

const SUPABASE_HOST = 'bbjpvlmkhvggtwyvpzrq.supabase.co';
const CDN_HOST      = 'img.mytenner.com';
const BUCKET        = 'photos';

function toCdn(url: string): string {
  return url.replace(
    `https://${SUPABASE_HOST}/storage/v1/object/public/`,
    `https://${CDN_HOST}/storage/v1/object/public/`
  );
}

function dataUrlToBytes(dataUrl: string): { bytes: Uint8Array; mime: string } | null {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!m) return null;
  try {
    const bin = atob(m[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes, mime: m[1] };
  } catch { return null; }
}

function extFor(mime: string): string {
  const t = (mime.split('/')[1] || 'png').toLowerCase();
  return t === 'jpeg' ? 'jpg' : (t === 'svg+xml' ? 'svg' : t);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
  if (req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);

  const url        = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const anonKey    = Deno.env.get('SUPABASE_ANON_KEY')!;
  const admin      = createClient(url, serviceKey);

  const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!jwt) return json({ ok: false, error: 'missing_jwt' }, 401);
  const asUser = createClient(url, anonKey, { global: { headers: { Authorization: `Bearer ${jwt}` } } });
  const callerId = (await asUser.auth.getUser()).data?.user?.id;
  if (!callerId) return json({ ok: false, error: 'not_authenticated' }, 401);
  const isAdmin = await admin.from('admins').select('user_id').eq('user_id', callerId).maybeSingle();
  if (!isAdmin.data) return json({ ok: false, error: 'not_admin' }, 403);

  const dryRun = !!(await req.json().catch(() => ({})))?.dry_run;

  const stats = {
    dry_run: dryRun,
    categories_found: 0, categories_migrated: 0,
    lists_found: 0, lists_migrated: 0,
    uploaded: 0, reused: 0, bytes_removed: 0,
    errors: [] as string[]
  };

  // content hash -> public URL, so the same image is stored once
  const uploaded = new Map<string, string>();

  async function hostImage(dataUrl: string): Promise<string | null> {
    const parsed = dataUrlToBytes(dataUrl);
    if (!parsed) { stats.errors.push('parse_fail'); return null; }
    const hash = await sha256Hex(parsed.bytes);
    const cached = uploaded.get(hash);
    if (cached) { stats.reused++; return cached; }

    const path = `category-icons/${hash}.${extFor(parsed.mime)}`;
    // upsert:true so a re-run after a partial failure doesn't error on an
    // already-present object.
    const up = await admin.storage.from(BUCKET)
      .upload(path, parsed.bytes, { contentType: parsed.mime, cacheControl: '31536000', upsert: true });
    if (up.error) { stats.errors.push('upload_fail ' + up.error.message); return null; }
    const publicUrl = admin.storage.from(BUCKET).getPublicUrl(path)?.data?.publicUrl;
    if (!publicUrl) { stats.errors.push('url_fail ' + path); return null; }
    const cdn = toCdn(publicUrl);
    uploaded.set(hash, cdn);
    stats.uploaded++;
    return cdn;
  }

  // ── Categories ───────────────────────────────────────────────
  const cats = await admin.from('categories').select('id, name, emoji').like('emoji', 'data:image/%');
  for (const c of cats.data || []) {
    stats.categories_found++;
    const before = (c.emoji || '').length;
    if (dryRun) { stats.bytes_removed += before; continue; }
    const hosted = await hostImage(c.emoji);
    if (!hosted) continue;
    const upd = await admin.from('categories').update({ emoji: hosted }).eq('id', c.id);
    if (upd.error) { stats.errors.push('cat_update_fail ' + c.name + ' ' + upd.error.message); continue; }
    stats.categories_migrated++;
    stats.bytes_removed += before - hosted.length;
  }

  // ── Lists (each carries its own copy of the icon) ────────────
  const lists = await admin.from('lists').select('id, category, emoji').like('emoji', 'data:image/%');
  for (const l of lists.data || []) {
    stats.lists_found++;
    const before = (l.emoji || '').length;
    if (dryRun) { stats.bytes_removed += before; continue; }
    const hosted = await hostImage(l.emoji);
    if (!hosted) continue;
    const upd = await admin.from('lists').update({ emoji: hosted }).eq('id', l.id);
    if (upd.error) { stats.errors.push('list_update_fail ' + l.id + ' ' + upd.error.message); continue; }
    stats.lists_migrated++;
    stats.bytes_removed += before - hosted.length;
  }

  return json({ ok: true, stats });
});
