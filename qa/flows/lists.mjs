// Create-list flow: navigate to create1, set category via app state (avoids
// racing renderCatGrid), press Continue, add 3 items, return home without
// publishing (QA does not spam real friends).
const CATEGORY = 'Movies';
const ITEMS = ['QA Test Item 1', 'QA Test Item 2', 'QA Test Item 3'];

export default {
  name: 'lists',
  async run({ page, log, shot, assert }) {
    log('nav → create');
    await page.evaluate(() => window.go && window.go('s-create1'));
    await page.waitForFunction(() => document.querySelector('#s-create1')?.classList.contains('active'), { timeout: 8000 });
    // Give renderCatGrid() a beat
    await page.waitForFunction(() => document.querySelectorAll('#cat-grid .cat-card, #cat-grid > div').length > 0, { timeout: 5000 }).catch(() => {});
    await shot('01-create1');

    log(`set category "${CATEGORY}" via app state`);
    await page.evaluate((cat) => {
      window.selCat = cat;
      window.selCatEmoji = window.getCatEmoji ? window.getCatEmoji(cat) : '🎬';
    }, CATEGORY);

    log('click Continue → (goToCreateStep2)');
    await page.evaluate(() => window.goToCreateStep2 && window.goToCreateStep2());
    await page.waitForFunction(() => document.querySelector('#s-create2')?.classList.contains('active'), { timeout: 8000 });
    await shot('02-create2');

    log('add items');
    for (const item of ITEMS) {
      await page.fill('#item-inp', item);
      await page.evaluate(() => window.doAddItem && window.doAddItem());
      await page.waitForTimeout(120);
    }
    await shot('03-items-added');

    const count = await page.evaluate(() => (window.items || []).length);
    await assert(count >= ITEMS.length, `items array has >= ${ITEMS.length} entries (got ${count})`);

    log('leave without publishing');
    await page.evaluate(() => window.go && window.go('s-home'));
    await page.waitForFunction(() => document.querySelector('#s-home')?.classList.contains('active'), { timeout: 8000 });
    await shot('04-back-home');
  },
};
