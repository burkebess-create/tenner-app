// Profile flow: open profile screen, verify it renders and myProfile is loaded,
// verify gift-share token exists (or gets auto-generated).
export default {
  name: 'profile',
  async run({ page, log, shot, assert }) {
    log('nav → profile');
    await page.evaluate(() => window.go && window.go('s-profile'));
    await page.waitForFunction(() => document.querySelector('#s-profile')?.classList.contains('active'), { timeout: 8000 });
    await page.waitForTimeout(600); // let async loadProfile settle
    await shot('01-profile');

    const profile = await page.evaluate(() => window.myProfile || null);
    await assert(!!profile, 'myProfile is loaded');
    await assert(!!profile.gift_share_token, 'gift_share_token exists');
    log('token', profile.gift_share_token?.slice(0, 8) + '…');
  },
};
