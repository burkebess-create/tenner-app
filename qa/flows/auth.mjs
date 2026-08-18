// Auth flow: land on s-auth, log in with password, confirm we reach s-home.
export default {
  name: 'auth',
  async run({ page, cfg, log, shot, assert }) {
    log('goto', cfg.url);
    await page.goto(cfg.url, { waitUntil: 'domcontentloaded' });
    // Wait for the auth screen's inputs to actually be visible — more robust
    // than watching for the .active class (which briefly toggles during boot).
    await page.waitForSelector('#auth-email', { state: 'visible', timeout: 30000 });
    await shot('01-landing');

    log('select login tab');
    await page.click('#tab-login');

    log('fill credentials');
    await page.fill('#auth-email', cfg.email);
    await page.fill('#auth-password', cfg.password);
    await shot('02-filled');

    log('submit');
    await page.click('#auth-submit');

    // Success = window.userId gets populated (works regardless of which
    // post-login screen the app routes to)
    await page.waitForFunction(() => !!window.userId, { timeout: 25000 })
      .catch(async () => {
        // Capture whatever the auth-error banner says for debugging
        const err = await page.locator('#auth-error').textContent().catch(() => '');
        throw new Error(`login did not complete. auth-error text: "${(err || '').trim()}"`);
      });

    const activeId = await page.evaluate(() => document.querySelector('.screen.active')?.id);
    log('post-login screen', activeId);
    await shot('03-post-login');

    if (activeId === 's-onboarding') {
      log('WARN: onboarding shown — QA account is fresh, skipping to home via go()');
      // Push through to home so downstream flows work
      await page.evaluate(() => window.go && window.go('s-home'));
      await page.waitForFunction(() => document.querySelector('#s-home')?.classList.contains('active'), { timeout: 8000 });
    }

    await assert(
      await page.evaluate(() => !!window.userId),
      'window.userId is populated after login'
    );
  },
};
