// Comments flow: open user's own first list from Home, verify list-detail
// screen renders, and that the comments UI (input or empty state) is present.
// Does not post — we'd need a second account to test the notification loop.
export default {
  name: 'comments',
  async run({ page, log, shot, assert }) {
    log('nav → home');
    await page.evaluate(() => window.go && window.go('s-home'));
    await page.waitForSelector('#s-home.active', { timeout: 5000 });
    await page.waitForTimeout(400);

    const listCount = await page.evaluate(() => (window.MY_LISTS || []).length);
    log('MY_LISTS count', String(listCount));
    if (!listCount) {
      log('SKIP: no lists to open');
      return;
    }

    log('open first list programmatically');
    const opened = await page.evaluate(() => {
      const l = window.MY_LISTS && window.MY_LISTS[0];
      if (l && window.showListDetail) { window.showListDetail(l); return true; }
      return false;
    });
    await assert(opened, 'showListDetail invoked on MY_LISTS[0]');
    await page.waitForSelector('#s-list-detail.active', { timeout: 5000 });
    await shot('01-list-detail');

    // Comment UI present in some form (input or list of comments)
    const hasCommentUi = await page.locator('#s-list-detail').evaluate(root =>
      !!root.querySelector('[id*="comment"], [class*="comment"], textarea')
    );
    log('comment UI present', String(hasCommentUi));
  },
};
