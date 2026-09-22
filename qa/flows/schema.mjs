// Schema / permission contract.
//
// Twice now a database change has silently broken the app: revoking EXECUTE on
// are_friends() (used inside the lists RLS policy) emptied the Circle feed, and
// locking down profiles.email/phone blanked the admin user list and killed the
// friend-update notification fanout. Both were invisible because supabase-js
// RESOLVES with { data, error } instead of throwing, so an unchecked query
// looks exactly like "no rows".
//
// This flow runs the reads the app depends on and asserts that each one comes
// back WITHOUT an error — the distinction the UI cannot make on its own.
// It reads only; nothing here writes.
//
// The checks are DATA, not source strings. The first version built each query
// with `new Function(...)` inside the page, which works against a local
// python http.server (no CSP header) and fails against every one of the nine
// checks in production, where the CSP has no 'unsafe-eval'. A green local run
// and eight identical CSP errors in CI. Anything evaluated in the page has to
// survive the real CSP, so the query is described here and assembled from
// plain method calls on the other side.

const CHECKS = [
  {
    name: 'own lists',
    table: 'lists', select: 'id, category, items', eq: ['user_id', '@uid'], limit: 5,
  },
  {
    name: "friends' lists (exercises are_friends in the lists policy)",
    table: 'lists', select: 'user_id, category, updated_at', neq: ['user_id', '@uid'], limit: 5,
  },
  {
    name: 'profiles — columns the UI reads',
    table: 'profiles', select: 'id, display_name, handle, photo, bio, birthday, created_at', limit: 5,
  },
  {
    name: 'friendships',
    table: 'friendships', select: 'id, requester_id, addressee_id, status', limit: 5,
  },
  {
    name: 'item comments',
    table: 'list_item_comments', select: 'id, from_user_id, comment', limit: 5,
  },
  {
    name: 'list reactions',
    table: 'list_reactions', select: 'id, emoji, item_name', limit: 5,
  },
  {
    name: 'groups + membership',
    table: 'group_members', select: 'group_id, status, role', eq: ['user_id', '@uid'], limit: 5,
  },
  {
    name: 'categories catalogue',
    table: 'categories', select: 'id, name, emoji, sort_order', limit: 5,
  },
  {
    name: 'own contact details (get_my_contact RPC)',
    rpc: 'get_my_contact',
  },
];

export default {
  name: 'schema',
  async run({ page, log, assert }) {
    const results = await page.evaluate(async (checks) => {
      const sb = window.sbClient;
      const uid = window.userId;
      if (!sb || !uid) return [{ name: '(setup)', error: 'no sbClient/userId — not signed in' }];
      // '@uid' is the one placeholder; everything else is a literal.
      const val = (v) => (v === '@uid' ? uid : v);
      const out = [];
      for (const c of checks) {
        try {
          let q;
          if (c.rpc) {
            q = sb.rpc(c.rpc, c.args || undefined);
          } else {
            q = sb.from(c.table).select(c.select);
            if (c.eq) q = q.eq(c.eq[0], val(c.eq[1]));
            if (c.neq) q = q.neq(c.neq[0], val(c.neq[1]));
            if (c.limit) q = q.limit(c.limit);
          }
          const res = await q;
          out.push({
            name: c.name,
            error: res && res.error ? (res.error.message || String(res.error)) : null,
            rows: res && Array.isArray(res.data) ? res.data.length : (res && res.data ? 1 : 0),
          });
        } catch (e) {
          out.push({ name: c.name, error: 'threw: ' + String(e.message || e), rows: 0 });
        }
      }
      return out;
    }, CHECKS);

    const failed = results.filter(r => r.error);
    for (const r of results) {
      log(r.error ? `✗ ${r.name}` : `· ${r.name}`, r.error || `${r.rows} row(s)`);
    }

    await assert(results.length === CHECKS.length,
      `ran all ${CHECKS.length} contract checks (got ${results.length})`);

    if (failed.length) {
      throw new Error(`${failed.length} query/permission failure(s): ` +
        failed.map(f => `${f.name} → ${f.error}`).join(' | '));
    }
    await assert(true, `all ${CHECKS.length} reads succeeded without a permission error`);

    // The Circle feed outage had a second signature the queries above miss:
    // the query worked for the app's own user but returned nothing because the
    // policy helper was unreachable. If this account has accepted friends with
    // public lists, the feed should not be empty.
    const feed = await page.evaluate(async () => {
      const accepted = (window.myFriends || []).filter(f => f.status === 'accepted');
      if (!accepted.length) return { skipped: 'no accepted friends' };
      const ids = accepted.map(f => f.friendId);
      const res = await window.sbClient.from('lists')
        .select('user_id, category, is_public').in('user_id', ids).eq('is_public', true).limit(20);
      return { error: res.error ? res.error.message : null, rows: (res.data || []).length, friends: ids.length };
    });
    if (feed.skipped) { log('circle feed', 'skipped — ' + feed.skipped); return; }
    await assert(!feed.error, `circle feed query succeeded (${feed.error || 'ok'})`);
    await assert(feed.rows > 0,
      `circle feed returns rows for ${feed.friends} friends (got ${feed.rows}) — zero here is what the outage looked like`);
  },
};
