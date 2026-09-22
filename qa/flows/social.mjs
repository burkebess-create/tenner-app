// Two-account flow — the surface no single-login test can reach.
//
// Everything a single account can see of itself was already covered. What was
// not, and what broke in production, lives strictly between two users:
//
//   * The Circle feed went empty for days because are_friends() — called
//     inside the lists RLS policy — lost its EXECUTE grant. A logged-in
//     account reading its OWN lists never touches that policy branch.
//   * Comment authorship showed "A friend" in the thread and the real name in
//     Alerts, because the thread only resolved names from the viewer's own
//     friend list. You need someone else's comment to see it.
//   * notifyFriendsOfUpdate() silently notified nobody for a day. It is
//     skipped entirely when the commenter is the list owner.
//
// Skips cleanly when QA_EMAIL_2 / QA_PASSWORD_2 are not configured, so the
// suite still runs with one account.

export default {
  name: 'social',
  async run({ page, log, shot, assert, openSecondAccount }) {
    const page2 = await openSecondAccount(log);
    if (!page2) {
      log('SKIP', 'QA_EMAIL_2 / QA_PASSWORD_2 not set — two-account checks skipped');
      return;
    }

    const me = await page.evaluate(() => window.userId);
    const them = await page2.evaluate(() => window.userId);
    await assert(me && them && me !== them, `two distinct sessions (${me?.slice(0, 8)} / ${them?.slice(0, 8)})`);

    // ── they are actually friends ───────────────────────────────────────
    const friendship = await page.evaluate((otherId) => {
      const f = (window.myFriends || []).find(x => x.friendId === otherId);
      return f ? f.status : null;
    }, them);
    await assert(friendship === 'accepted',
      `account 1 sees account 2 as an accepted friend (got ${friendship})`);

    // ── the Circle feed: the exact shape of the are_friends outage ──────
    // A friend's public list must be readable. When the policy helper lost its
    // grant this returned zero rows with no error, and the feed rendered
    // "No new activity from your circle yet".
    const visible = await page.evaluate(async (otherId) => {
      const res = await window.sbClient.from('lists')
        .select('user_id, category, is_public')
        .eq('user_id', otherId).eq('is_public', true);
      return { error: res.error ? res.error.message : null, rows: (res.data || []).length };
    }, them);
    await assert(!visible.error, `reading a friend's lists succeeds (${visible.error || 'ok'})`);
    await assert(visible.rows > 0,
      `a friend's public lists are visible (${visible.rows} rows) — zero is what the outage looked like`);

    await page.evaluate(() => window.go && window.go('s-circle'));
    await page.waitForTimeout(1800);
    await shot('01-circle');
    const feedText = await page.evaluate(() =>
      (document.getElementById('home-feed-section')?.innerText || '').trim());
    await assert(!/No new activity from your circle/i.test(feedText),
      `the Circle feed is not showing its empty state (${JSON.stringify(feedText.slice(0, 70))})`);

    // ── a comment from someone else ─────────────────────────────────────
    // Account 2 comments on account 1's list, then account 1 opens the thread.
    // This is the only way to exercise cross-account authorship, and it is the
    // path that produced "A friend".
    const mark = `qa2-${Date.now().toString(36)}`;
    const posted = await page2.evaluate(async ({ ownerId, text }) => {
      const owner = window.MY_FRIEND_LIST_SUMMARIES && window.MY_FRIEND_LIST_SUMMARIES[ownerId];
      const cat = (owner && owner[0] && owner[0].category) || 'Movies';
      const res = await window.sbClient.from('lists')
        .select('category, items').eq('user_id', ownerId).eq('category', cat).maybeSingle();
      if (res.error || !res.data) return { error: res.error ? res.error.message : 'no list found' };
      const item = (res.data.items || [])[0];
      if (!item) return { error: 'friend list has no items' };
      const ins = await window.sbClient.from('list_item_comments')
        .insert({ from_user_id: window.userId, list_owner_id: ownerId,
                  category: cat, item_name: item, comment: text })
        .select('id').maybeSingle();
      return { error: ins.error ? ins.error.message : null,
               id: ins.data && ins.data.id, category: cat, item };
    }, { ownerId: me, text: mark });

    await assert(!posted.error, `account 2 can comment on account 1's list (${posted.error || 'ok'})`);
    await assert(!!posted.id, 'the cross-account comment was stored');
    log('posted on', `${posted.category} / ${posted.item}`);

    // Account 1 opens that thread and must see a real name, not "A friend".
    const seen = await page.evaluate(async ({ cat, item, text }) => {
      await window.openItemComments(window.userId, cat, item);
      await new Promise(r => setTimeout(r, 1800));
      const el = document.getElementById('item-comments-list');
      const body = el ? el.innerText : '';
      const row = body.split('\n').findIndex(l => l.includes(text));
      return { body: body.slice(0, 400), hasMark: body.includes(text), rowIdx: row };
    }, { cat: posted.category, item: posted.item, text: mark });
    await shot('02-thread-cross-account');

    await assert(seen.hasMark, 'account 1 sees the comment account 2 just posted');
    await assert(!/\bA friend\b/.test(seen.body),
      `the commenter is named, not rendered as "A friend" (${JSON.stringify(seen.body.slice(0, 120))})`);

    // ── clean up ────────────────────────────────────────────────────────
    const removed = await page2.evaluate(async (id) => {
      const res = await window.sbClient.from('list_item_comments')
        .delete().eq('id', id).eq('from_user_id', window.userId);
      return !res.error;
    }, posted.id);
    log('cleanup', removed ? 'cross-account comment removed' : 'left in place');
  },
};
