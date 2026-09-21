// Create-list flow — driven through the UI.
//
// This used to set window.selCat directly and call goToCreateStep2(), which
// skipped every line of code a real user touches: the category input, the
// redundant-prefix hint, the Continue handler, and the add-item button. A user
// saved a list called "Top 10 Top 10 Engines" while this flow was green,
// because the hint it would have exercised was never run.
//
// Nothing is published: the flow leaves before saving, so no friend is
// notified and no list is created.

const TYPED_CATEGORY = 'QA Smoke Category';
const ITEMS = ['QA Test Item 1', 'QA Test Item 2', 'QA Test Item 3'];

export default {
  name: 'lists',
  async run({ page, log, shot, assert }) {
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

    log('leave without publishing');
    await page.click('#nav-home');
    await page.waitForFunction(() => document.querySelector('#s-home')?.classList.contains('active'), { timeout: 8000 });
    await shot('04-back-home');
  },
};
