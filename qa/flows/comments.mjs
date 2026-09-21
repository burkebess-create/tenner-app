// Comments flow — posts for real, through the UI.
//
// This used to open a list, check "some element with 'comment' in its id or
// class exists", log the answer WITHOUT asserting it, and stop. It passed
// every night for two months while comments were being saved twice: a double
// tap during the pre-submit moderation call inserted the same row twice, and
// six real duplicates reached production.
//
// Posting on the QA account's OWN list is safe — notifyListOwnerOfComment()
// is skipped when the commenter is the list owner, so no email or push is
// generated. Each comment is uniquely marked and removed again afterwards.

const MARK = () => `qa-${Date.now().toString(36)}`;

async function commentCount(page) {
  return await page.evaluate(() => {
    const el = document.getElementById('item-comments-list');
    if (!el) return -1;
    // Comment rows carry the ⋯ menu button; the empty state does not.
    return el.querySelectorAll('[onclick*="toggleCommentMenu"]').length;
  });
}

async function textCount(page, needle) {
  return await page.evaluate((n) => {
    const el = document.getElementById('item-comments-list');
    if (!el) return -1;
    return (el.innerText.match(new RegExp(n, 'g')) || []).length;
  }, needle);
}

export default {
  name: 'comments',
  async run({ page, log, shot, assert }) {
    log('nav → home');
    await page.evaluate(() => window.go && window.go('s-home'));
    await page.waitForFunction(() => document.querySelector('#s-home')?.classList.contains('active'), { timeout: 8000 });

    const listCount = await page.evaluate(() => (window.MY_LISTS || []).length);
    if (!listCount) { log('SKIP: no lists to comment on'); return; }

    // Open the first list, then open the comment thread by CLICKING an item
    // row rather than calling openItemComments() directly — the row's onclick
    // is itself string-built, so clicking it is part of what we are testing.
    await page.evaluate(() => window.showListDetail(window.MY_LISTS[0]));
    await page.waitForFunction(() => document.querySelector('#s-list-detail')?.classList.contains('active'), { timeout: 8000 });
    await page.waitForTimeout(500);

    const rows = page.locator('#list-detail-items .rank-item');
    const nRows = await rows.count();
    if (!nRows) { log('SKIP: list has no items'); return; }
    await rows.first().click();
    await page.waitForSelector('#item-comment-input', { timeout: 8000 });
    await page.waitForTimeout(400);
    await shot('01-thread-open');

    const before = await commentCount(page);
    await assert(before >= 0, `comment thread rendered (${before} existing comment(s))`);

    // ── single post ────────────────────────────────────────────────────
    const mark1 = MARK();
    await page.fill('#item-comment-input', mark1);
    await page.click('#item-comment-post');
    await page.waitForFunction((m) => (document.getElementById('item-comments-list')?.innerText || '').includes(m),
      mark1, { timeout: 15000 });
    await page.waitForTimeout(600);

    const afterOne = await commentCount(page);
    await assert(afterOne === before + 1,
      `posting once adds exactly one comment (${before} → ${afterOne})`);

    // ── double tap ─────────────────────────────────────────────────────
    // The real bug: the Post button stayed live during the moderation
    // round-trip, so a second tap sent the same text again.
    const mark2 = MARK();
    await page.fill('#item-comment-input', mark2);
    await page.click('#item-comment-post', { force: true });
    await page.waitForTimeout(120);
    await page.click('#item-comment-post', { force: true }).catch(() => {});  // disabled = good
    await page.waitForFunction((m) => (document.getElementById('item-comments-list')?.innerText || '').includes(m),
      mark2, { timeout: 15000 });
    await page.waitForTimeout(1200);

    const copies = await textCount(page, mark2);
    await shot('02-after-double-tap');
    await assert(copies === 1,
      `double-tapping Post stores the comment once (found ${copies} copies)`);

    const afterTwo = await commentCount(page);
    await assert(afterTwo === before + 2,
      `two posts produced two comments, not three (${before} → ${afterTwo})`);

    // ── cleanup ────────────────────────────────────────────────────────
    // Best-effort: leaving a QA comment behind is untidy but not a failure,
    // and the markers are unique so a leftover cannot skew the next run.
    for (const mark of [mark1, mark2]) {
      try {
        // deleteItemComment() opens the shared confirm modal rather than
        // deleting outright, so the confirm has to be clicked as well.
        const opened = await page.evaluate((m) => {
          const el = document.getElementById('item-comments-list');
          const btn = [...el.querySelectorAll('[onclick*="toggleCommentMenu"]')]
            .find(b => { const d = b.closest('div'); return d && d.innerText.includes(m); });
          if (!btn) return false;
          const id = (btn.getAttribute('onclick').match(/toggleCommentMenu\('([^']+)'\)/) || [])[1];
          if (!id || typeof window.deleteItemComment !== 'function') return false;
          window.deleteItemComment(id);
          return true;
        }, mark);
        if (opened) {
          await page.waitForSelector('#confirm-ok', { state: 'visible', timeout: 4000 });
          await page.click('#confirm-ok');
          await page.waitForFunction(
            (m) => !(document.getElementById('item-comments-list')?.innerText || '').includes(m),
            mark, { timeout: 10000 });
        }
        log(`cleanup ${mark}`, opened ? 'removed' : 'left in place');
      } catch (e) { log(`cleanup ${mark}`, 'failed: ' + String(e.message || e)); }
    }
    await page.waitForTimeout(400);
    await shot('03-cleaned-up');
  },
};
