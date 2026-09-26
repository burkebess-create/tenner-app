// Create-list flow — driven through the UI.
//
// This used to set window.selCat directly and call goToCreateStep2(), which
// skipped every line of code a real user touches: the category input, the
// redundant-prefix hint, the Continue handler, and the add-item button. A user
// saved a list called "Top 10 Top 10 Engines" while this flow was green,
// because the hint it would have exercised was never run.
//
// The flow now SAVES, because not saving was its blind spot. @teresa's list
// reported "couldn't save" while the row sat complete in the database, and
// nothing here would have caught it: every check passed against a list that
// was abandoned before the save button.
//
// It saves via the real "Add more later" path, which calls saveListDataOnly()
// — the exact function that failed for her. That path does NOT call
// notifyFriendsOfUpdate (only saveList does, and only on an update), so no
// friend is notified. The list is created private and deleted afterwards.

const TYPED_CATEGORY = 'QA Smoke Category';
const ITEMS = ['QA Test Item 1', 'QA Test Item 2', 'QA Test Item 3'];

export default {
  name: 'lists',
  async run({ page, log, shot, assert }) {
    // Clear any leftover from a run that died mid-flight. Without this, a
    // stale list turns the create path into an EDIT and the flow would be
    // exercising a different code path than the one it claims to test.
    const preCleaned = await page.evaluate(async (cat) => {
      const r = await window.sbClient.from('lists')
        .delete().eq('user_id', window.userId).eq('category', cat).select('category');
      if (r.error) return { error: r.error.message };
      if ((r.data || []).length && Array.isArray(window.MY_LISTS)) {
        window.MY_LISTS = window.MY_LISTS.filter(l => (l.category || '') !== cat);
      }
      return { removed: (r.data || []).length };
    }, TYPED_CATEGORY);
    log('pre-clean', JSON.stringify(preCleaned));

    // Real tab tap, not go().
    log('tap Create in the nav');
    await page.click('#nav-create');
    await page.waitForFunction(() => document.querySelector('#s-create1')?.classList.contains('active'), { timeout: 8000 });
    await page.waitForTimeout(600);
    await shot('01-create1');

    // ── redundant "Top 10" prefix guard ─────────────────────────────────
    // The app prints "Top 10" itself, immediately left of this field, so a
    // category starting with "Top 10" renders twice. Typing it must produce a
    // hint with a working one-tap fix, and Continue must not accept it raw.
    await page.fill('#cat-inp', 'Top 10 ' + TYPED_CATEGORY);
    await page.waitForTimeout(250);
    const hint = await page.evaluate(() => {
      const el = document.getElementById('cat-inp-hint');
      return { visible: el && el.style.display !== 'none', text: (el?.innerText || '').trim(), hasButton: !!el?.querySelector('button') };
    });
    await assert(hint.visible, `typing a doubled "Top 10" shows the hint (${JSON.stringify(hint.text.slice(0, 60))})`);
    await assert(hint.hasButton, 'the hint offers a one-tap fix rather than advice only');

    await page.click('#cat-inp-hint button');
    await page.waitForTimeout(250);
    const fixed = await page.inputValue('#cat-inp');
    await assert(fixed === TYPED_CATEGORY,
      `tapping the fix strips the prefix in one go (got ${JSON.stringify(fixed)})`);

    // Also prove Continue itself refuses the raw form, since the hint is
    // skippable and that is how the bad list got saved.
    await page.fill('#cat-inp', 'Top 10 ' + TYPED_CATEGORY);
    await page.waitForTimeout(200);
    await page.click('#create1-continue-btn');
    await page.waitForTimeout(700);
    const selCat = await page.evaluate(() => window.selCat);
    await assert(selCat === TYPED_CATEGORY,
      `Continue strips the redundant prefix even when the hint is ignored (selCat=${JSON.stringify(selCat)})`);

    await page.waitForFunction(() => document.querySelector('#s-create2')?.classList.contains('active'), { timeout: 8000 });
    await shot('02-create2');

    // ── add items through the real controls ─────────────────────────────
    log('add items via the + button');
    for (const item of ITEMS) {
      await page.fill('#item-inp', item);
      // The "+" button is the textarea's next sibling; click that exact node
      // rather than a positional selector.
      const clicked = await page.evaluate(() => {
        const inp = document.getElementById('item-inp');
        const btn = inp && inp.parentElement && inp.parentElement.querySelector('button');
        if (!btn) return false;
        btn.click();
        return true;
      });
      if (!clicked) await page.press('#item-inp', 'Enter');   // the textarea binds Enter too
      await page.waitForTimeout(220);
    }
    await shot('03-items-added');

    const count = await page.evaluate(() => (window.items || []).length);
    await assert(count >= ITEMS.length, `items array has >= ${ITEMS.length} entries (got ${count})`);

    const rendered = await page.locator('#items-list .rank-item').count();
    await assert(rendered >= ITEMS.length,
      `items are actually rendered on screen, not just in state (${rendered} rows)`);

    // ── save it for real, and prove the row landed ──────────────────────
    // Private, so a QA list never appears in a friend's Circle feed.
    await page.evaluate(() => {
      const t = document.getElementById('create-public-toggle');
      if (t && t.checked) t.click();
    });

    try {
      log('Continue → "Add more later" (this is the saveListDataOnly path)');
      await page.click('#create2-continue-new');
      await page.waitForSelector('#confirm-modal', { state: 'visible', timeout: 8000 });
      await page.click('#confirm-modal .btn-secondary');
      await page.waitForFunction(() => document.querySelector('#s-create3')?.classList.contains('active'), { timeout: 8000 });
      await page.waitForTimeout(1500);   // let the background save settle
      await shot('04-saved');

      // The only assertion that would have caught the original bug.
      const row = await page.evaluate(async (cat) => {
        const r = await window.sbClient.from('lists')
          .select('category, items, is_public').eq('user_id', window.userId).eq('category', cat).maybeSingle();
        return r.error ? { error: r.error.message } : r.data;
      }, TYPED_CATEGORY);

      await assert(row && !row.error, `read the list back from the database (${(row && row.error) || 'ok'})`);
      await assert(!!row, 'the saved list EXISTS in the database');
      await assert(Array.isArray(row.items) && row.items.length >= ITEMS.length,
        `it carries the items that were typed (${JSON.stringify(row.items)})`);
      await assert(row.is_public === false,
        `the QA list is private, so it cannot reach a friend's feed (is_public=${row.is_public})`);

      // The other half of @teresa's report: the row landed but the list had
      // vanished from her own app, because the throw skipped the line that
      // adds it to MY_LISTS.
      const inMemory = await page.evaluate((cat) =>
        (window.MY_LISTS || []).some(l => (l.category || '') === cat), TYPED_CATEGORY);
      await assert(inMemory, 'and it is in MY_LISTS, so it shows in the app too');
    } finally {
      const cleaned = await page.evaluate(async (cat) => {
        const r = await window.sbClient.from('lists')
          .delete().eq('user_id', window.userId).eq('category', cat);
        return r.error ? r.error.message : null;
      }, TYPED_CATEGORY);
      log('cleanup', cleaned ? 'FAILED: ' + cleaned : 'QA list removed');
    }

    // Confirm the cleanup actually deleted, rather than reporting success.
    const leftover = await page.evaluate(async (cat) => {
      const r = await window.sbClient.from('lists')
        .select('category').eq('user_id', window.userId).eq('category', cat);
      return (r.data || []).length;
    }, TYPED_CATEGORY);
    await assert(leftover === 0, `no QA list left behind (${leftover} remaining)`);

    log('back home');
    await page.click('#nav-home');
    await page.waitForFunction(() => document.querySelector('#s-home')?.classList.contains('active'), { timeout: 8000 });
    await shot('05-back-home');
  },
};
