// Login used by the second-account helper in run.mjs.
//
// The auth flow keeps its own copy on purpose: it is the first thing that runs
// and carries a large diagnostic dump for the case where the app does not even
// render, which would be noise here. This one is the quiet version — if the
// two ever disagree about how login works, auth.mjs is the reference.
export async function login(page, baseUrl, email, password, log = () => {}) {
  const url = baseUrl.replace(/\/?$/, '/') + '?skipIntro=1';
  log('goto', url);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#auth-email', { state: 'visible', timeout: 30000 });

  await page.click('#tab-login');
  await page.fill('#auth-email', email);
  await page.fill('#auth-password', password);
  await page.click('#auth-submit');

  // Success = window.userId populated, regardless of which screen the app
  // routes to afterwards.
  await page.waitForFunction(() => !!window.userId, { timeout: 25000 })
    .catch(async () => {
      const err = await page.locator('#auth-error').textContent().catch(() => '');
      throw new Error(`login failed for ${email}. auth-error: "${(err || '').trim()}"`);
    });

  const activeId = await page.evaluate(() => document.querySelector('.screen.active')?.id);
  if (activeId === 's-onboarding') {
    await page.evaluate(() => window.go && window.go('s-home'));
    await page.waitForFunction(() => document.querySelector('#s-home')?.classList.contains('active'), { timeout: 8000 });
  }
  // Let the initial loads (profile, friends, lists) settle.
  await page.waitForTimeout(1500);
  return await page.evaluate(() => window.userId);
}
