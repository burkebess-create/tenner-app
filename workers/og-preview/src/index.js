// Link previews for shared list pages.
//
// l.html fetches its list with JavaScript, and the crawlers that build link
// previews — iMessage, WhatsApp, Slack, Facebook — do not run JavaScript.
// They read the HTML as served, so every shared list previewed as the generic
// "A Top 10 — Tenner". For a feature whose main channel is texting a link to
// a friend, that is most of the value gone.
//
// This Worker sits in front of l.html, asks the same public RPC the page
// asks, and rewrites the meta tags in the response stream. The page itself is
// untouched and still renders exactly as before.
//
// It FAILS OPEN on purpose: any error and the origin response is returned
// unchanged. A broken preview is a disappointment; a broken page is an
// outage.

// Same values the page carries in its own source. The publishable key is
// designed to be public and is already visible in l.html.
const SUPABASE_URL = 'https://bbjpvlmkhvggtwyvpzrq.supabase.co';
const SUPABASE_KEY = 'sb_publishable_jeeTdNoqIJXBtx_1W1TscQ_cnRAcwHx';

// Pure so it can be unit-tested off-platform; HTMLRewriter only exists in the
// Workers runtime, the string building does not have to.
export function buildMeta(data) {
  const owner = (data && data.owner) || {};
  const list = (data && data.list) || {};
  const name = (owner.display_name || '').trim()
    || (owner.handle ? '@' + owner.handle : '')
    || 'Someone';
  const category = (list.category || '').trim() || 'Top 10';
  const items = Array.isArray(list.items) ? list.items.filter(Boolean) : [];

  const possessive = name + (/s$/i.test(name) ? '’' : '’s');
  const title = `${possessive} Top 10 ${category}`;

  // Lead with their actual picks — that is the reason to tap the link. Three
  // keeps the preview to one line on most clients.
  const preview = items.slice(0, 3).join(', ');
  const description = preview
    ? `${preview}${items.length > 3 ? ', and more' : ''} — see the full list on Tenner.`
    : `${name} shared a Top 10 on Tenner.`;

  return { title, description };
}

class MetaRewriter {
  constructor(meta) { this.meta = meta; }
  element(el) {
    const prop = el.getAttribute('property') || el.getAttribute('name');
    if (prop === 'og:title' || prop === 'twitter:title') {
      el.setAttribute('content', this.meta.title);
    } else if (prop === 'og:description' || prop === 'twitter:description'
               || prop === 'description') {
      el.setAttribute('content', this.meta.description);
    }
  }
}

class TitleRewriter {
  constructor(meta) { this.meta = meta; }
  element(el) { el.setInnerContent(this.meta.title + ' — Tenner'); }
}

export default {
  async fetch(request, env, ctx) {
    const res = await fetch(request);
    try {
      const url = new URL(request.url);
      const token = url.searchParams.get('t')
        || (url.pathname.split('/l/')[1] || '').replace(/\/$/, '');
      if (!token) return res;

      const type = res.headers.get('content-type') || '';
      if (!type.includes('text/html')) return res;

      const rpc = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_public_list_data`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          apikey: SUPABASE_KEY,
          authorization: `Bearer ${SUPABASE_KEY}`,
        },
        body: JSON.stringify({ share_token: token }),
        // A revoked link should stop previewing reasonably promptly, but the
        // same link is often fetched by several crawlers at once.
        cf: { cacheTtl: 300, cacheEverything: true },
      });
      if (!rpc.ok) return res;
      const data = await rpc.json();
      // Unknown or revoked token: leave the generic tags rather than inventing
      // a preview for a page that will say "not available".
      if (!data || !data.list) return res;

      const meta = buildMeta(data);
      return new HTMLRewriter()
        .on('meta', new MetaRewriter(meta))
        .on('title', new TitleRewriter(meta))
        .transform(res);
    } catch (e) {
      return res;   // fail open
    }
  },
};
