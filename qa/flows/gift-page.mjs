// Gift page flow: open the user's own public /g?t=TOKEN in a fresh tab
// and verify it renders (hero + at least the "Browse categories" callout).
// Also spot-checks that budget pills render and toggling one updates a shop
// link to include the rh=p_36:... filter.
export default {
  name: 'gift-page',
  async run({ page, cfg, log, shot, assert }) {
    const token = await page.evaluate(() => window.myProfile?.gift_share_token);
    await assert(!!token, 'have gift-share token to open /g');

    const giftUrl = `${cfg.url.replace(/\/$/, '')}/g.html?t=${token}`;
    log('open', giftUrl);
    const ctx = page.context();
    const p2 = await ctx.newPage();
    await p2.goto(giftUrl, { waitUntil: 'domcontentloaded' });
    await p2.waitForSelector('.hero, .empty', { timeout: 15000 });
    await p2.screenshot({ path: page.url() ? undefined : undefined }).catch(() => {});
    await p2.waitForTimeout(500);

    const hasHero = await p2.locator('.hero').count();
    log('hero rendered', String(hasHero > 0));

    // If user has any lists, budget pills should mount
    const pillsCount = await p2.locator('#budget-pills-host button').count();
    log('budget pills', String(pillsCount));

    if (pillsCount > 0) {
      // Grab a shop-link href, click "Under $25", verify href changed
      const shopBefore = await p2.locator('a.shop').first().getAttribute('href').catch(() => null);
      await p2.locator('#budget-pills-host button', { hasText: 'Under $25' }).first().click();
      await p2.waitForTimeout(200);
      const shopAfter = await p2.locator('a.shop').first().getAttribute('href').catch(() => null);
      if (shopBefore && shopAfter) {
        await assert(
          shopAfter.includes('rh=') && shopAfter !== shopBefore,
          'budget filter appended rh= param to shop link'
        );
      } else {
        log('no shop links to spot-check (user has no lists yet)');
      }
    }

    // Cross-link should live at the BOTTOM now (after bento). Verify it exists.
    const bottomCross = await p2.locator('text=Browse Tenner\'s gift categories').count();
    await assert(bottomCross > 0, 'cross-link to /gifts/ is present on /g page');

    await p2.close();
  },
};
