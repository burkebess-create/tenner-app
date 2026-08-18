// Profile flow: nav to profile, verify myProfile loads, verify gift-share token
// exists (or generate one if missing — the app's regen RPC is public and safe).
export default {
  name: 'profile',
  async run({ page, log, shot, assert }) {
    log('nav → profile');
    await page.evaluate(() => window.go && window.go('s-profile'));
    await page.waitForFunction(() => document.querySelector('#s-profile')?.classList.contains('active'), { timeout: 8000 });

    // Wait up to 5s for loadProfile to populate window.myProfile
    await page.waitForFunction(() => !!window.myProfile, { timeout: 5000 });
    await shot('01-profile');

    let profile = await page.evaluate(() => window.myProfile);
    await assert(!!profile, 'myProfile is loaded');

    if (!profile.gift_share_token) {
      log('no token — calling regenerate_my_gift_share_token RPC');
      const gen = await page.evaluate(async () => {
        try {
          const r = await window.sbClient.rpc('regenerate_my_gift_share_token');
          if (r.error) return { ok: false, err: r.error.message };
          window.myProfile.gift_share_token = r.data;
          return { ok: true, token: r.data };
        } catch (e) { return { ok: false, err: String(e) }; }
      });
      log('regen result', JSON.stringify(gen));
      profile = await page.evaluate(() => window.myProfile);
    }

    await assert(!!profile.gift_share_token, 'gift_share_token exists');
    log('token', profile.gift_share_token.slice(0, 8) + '…');
  },
};
