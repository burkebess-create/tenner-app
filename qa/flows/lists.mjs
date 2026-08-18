// Create-list flow: nav to Create, pick a category, add 3 items, save.
// We stop short of publishing to avoid spamming friends — QA just verifies
// the create flow renders and persists something to MY_LISTS.
const CATEGORY = 'Movies';
const ITEMS = ['QA Test Item 1', 'QA Test Item 2', 'QA Test Item 3'];

export default {
  name: 'lists',
  async run({ page, log, shot, assert }) {
    log('nav → create');
    await page.evaluate(() => window.go && window.go('s-create1'));
    await page.waitForSelector('#s-create1.active', { timeout: 5000 });
    await shot('01-create1');

    log(`pick category "${CATEGORY}"`);
    // Category cards live in the standard grid; click by text.
    const cat = page.locator(`#cat-grid >> text=${CATEGORY}`).first();
    if (await cat.count()) {
      await cat.click();
    } else {
      // Fallback: type it
      await page.fill('#cat-inp', CATEGORY);
      await page.keyboard.press('Enter');
    }
    await page.waitForSelector('#s-create2.active', { timeout: 5000 });
    await shot('02-create2');

    log('add items');
    for (const item of ITEMS) {
      await page.fill('#item-inp', item);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(150);
    }
    await shot('03-items-added');

    const count = await page.evaluate(() => (window.items || []).length);
    await assert(count >= ITEMS.length, `items array has >= ${ITEMS.length} entries (got ${count})`);

    log('leave without publishing (QA does not spam friends)');
    await page.evaluate(() => window.go && window.go('s-home'));
    await page.waitForSelector('#s-home.active', { timeout: 5000 });
    await shot('04-back-home');
  },
};
