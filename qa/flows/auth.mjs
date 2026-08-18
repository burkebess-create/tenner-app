// Auth flow: land on s-auth, log in with password, confirm we reach s-home.
export default {
  name: 'auth',
  async run({ page, cfg, log, shot, assert }) {
    log('goto', cfg.url);
    await page.goto(cfg.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#s-auth.active', { timeout: 15000 });
    await shot('01-landing');

    log('select login tab');
    await page.click('#tab-login');

    log('fill credentials');
    await page.fill('#auth-email', cfg.email);
    await page.fill('#auth-password', cfg.password);
    await shot('02-filled');

    log('submit');
    await page.click('#auth-submit');

    // Success = s-home becomes active (or onboarding if fresh account)
    await page.waitForFunction(() => {
      const a = document.querySelector('.screen.active');
      return a && a.id !== 's-auth';
    }, { timeout: 20000 });

    const activeId = await page.evaluate(() => document.querySelector('.screen.active')?.id);
    log('post-login screen', activeId);
    await shot('03-post-login');

    if (activeId === 's-onboarding') {
      log('WARN: onboarding shown — QA account is fresh, skipping to home via go()');
      // Push through to home so downstream flows work
      await page.evaluate(() => window.go && window.go('s-home'));
      await page.waitForSelector('#s-home.active', { timeout: 5000 });
    }

    await assert(
      await page.evaluate(() => !!window.userId),
      'window.userId is populated after login'
    );
  },
};
