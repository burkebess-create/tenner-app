// Things a store reviewer checks, that a browser-only test would never notice.
//
// The native-shell half of this exists because the obvious test is wrong.
// navigator.standalone and display-mode:standalone are TRUE of an installed
// PWA and FALSE inside a WKWebView, so every check written to suppress the
// "install this as an app" prompts for a home-screen install lets them
// straight through in the App Store build — where they are a 4.2 / 2.3.1
// rejection and the first thing a reviewer sees.
//
// So each prompt is asserted twice: it must still work in a plain browser
// (otherwise "fixed" just means "deleted"), and it must be silent in a shell.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright/index.js');

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-proxy-server', '--no-sandbox'],
});
const fails = [];
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails.push(m); };

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) '
  + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

// ── the marketing redirect ──────────────────────────────────────────────
// A first run with no session bounces to /welcome.html. In the native build
// that means the app replaces itself with the marketing website on launch.
async function firstRunLandsOn({ ua, url }) {
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, userAgent: ua });
  const p = await ctx.newPage();
  await p.goto(url, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(900);
  const landed = p.url();
  await ctx.close();
  return landed;
}
const webFirstRun = await firstRunLandsOn({ ua: IPHONE_UA, url: 'http://localhost:8899/' });
ok(/welcome\.html/.test(webFirstRun),
  `on the web, a first visit still reaches the marketing page (${webFirstRun})`);

for (const [how, url, ua] of [
  ['?native=1',        'http://localhost:8899/?native=1', IPHONE_UA],
  ['a TennerApp agent', 'http://localhost:8899/',          IPHONE_UA + ' TennerApp/1.0'],
]) {
  const landed = await firstRunLandsOn({ ua, url });
  ok(!/welcome\.html/.test(landed),
    `in a shell (${how}) the app does not replace itself with the website (${landed})`);
}

// ── the two install prompts ─────────────────────────────────────────────
async function installPrompts({ native }) {
  const ctx = await browser.newContext({
    viewport: { width: 393, height: 852 },
    userAgent: IPHONE_UA + (native === 'ua' ? ' TennerApp/1.0' : ''),
  });
  const p = await ctx.newPage();
  await p.goto('http://localhost:8899/?skipIntro=1' + (native === 'qs' ? '&native=1' : ''),
    { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => typeof window.maybeShowIosInstallPrompt === 'function', { timeout: 20000 });
  const r = await p.evaluate(async () => {
    // Everything the banner asks for before it will show: a prior visit more
    // than an hour ago, and at least one saved list.
    localStorage.removeItem('tenner_ios_install_dismissed');
    localStorage.setItem('tenner_first_visit_at', String(Date.now() - 2 * 60 * 60 * 1000));
    window.userId = 'u1';
    window.MY_LISTS = [{ n: 'Top 10 Candy bars', category: 'Candy bars', items: ['a'] }];
    window.maybeShowIosInstallPrompt();
    await new Promise(r => setTimeout(r, 300));
    const banner = document.getElementById('ios-install-banner');
    // And the Android/Chrome path: the deferred prompt is what the button needs.
    window.dispatchEvent(Object.assign(new Event('beforeinstallprompt'), { prompt: () => {} }));
    await new Promise(r => setTimeout(r, 100));
    const btn = document.getElementById('pwa-install-btn');
    return {
      banner: !!banner,
      bannerH: banner ? banner.getBoundingClientRect().height : 0,
      bannerText: banner ? banner.innerText : '',
      btnShown: !!btn && btn.style.display !== 'none',
      deferred: !!window.__deferredInstallPrompt,
      shellDetected: window.isNativeShell(),
    };
  });
  await ctx.close();
  return r;
}

const web = await installPrompts({ native: false });
ok(web.shellDetected === false, 'a plain browser is not mistaken for a shell');
ok(web.banner && web.bannerH > 0,
  `on the web the Add-to-Home-Screen banner still appears (${web.bannerH.toFixed(0)}px tall)`);
ok(/Home Screen/i.test(web.bannerText), 'and still says what it is for');
ok(web.deferred, 'and the Chrome install prompt is still captured');
ok(web.btnShown, 'and the Install button still becomes visible');

for (const how of ['qs', 'ua']) {
  const shell = await installPrompts({ native: how });
  const label = how === 'qs' ? '?native=1' : 'a TennerApp agent';
  ok(shell.shellDetected === true, `${label} is recognised as a shell`);
  ok(shell.banner === false,
    `${label}: the app never tells a reviewer to install the website`);
  ok(shell.deferred === false, `${label}: the Chrome install prompt is not captured`);
  ok(shell.btnShown === false, `${label}: the Install button stays hidden`);
}

// The flag has to survive a navigation — a WebView can drop an injected
// global or lose the query string partway through a session.
const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, userAgent: IPHONE_UA });
const p2 = await ctx.newPage();
await p2.goto('http://localhost:8899/?skipIntro=1&native=1', { waitUntil: 'domcontentloaded' });
await p2.waitForFunction(() => typeof window.isNativeShell === 'function', { timeout: 20000 });
ok(await p2.evaluate(() => window.isNativeShell()), 'the shell flag is set on arrival');
await p2.goto('http://localhost:8899/?skipIntro=1', { waitUntil: 'domcontentloaded' });
await p2.waitForFunction(() => typeof window.isNativeShell === 'function', { timeout: 20000 });
ok(await p2.evaluate(() => window.isNativeShell()),
  'and is remembered after a navigation that drops the parameter');

// ── the legal links ─────────────────────────────────────────────────────
// "Accessible in the app" means reachable after signup too, not just once on
// the auth screen. Both are measured laid out, on an active screen.
const legal = await p2.evaluate(() => {
  const out = {};
  const measure = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { h: r.height, w: r.width, text: el.innerText };
  };
  window.go('s-auth');
  out.auth = measure('#auth-legal');
  out.authTerms = !!document.querySelector('#auth-legal a[href="terms.html"]');
  out.authPrivacy = !!document.querySelector('#auth-legal a[href="privacy.html"]');
  window.go('s-profile-account');
  const acct = [...document.querySelectorAll('#s-profile-account a')].map(a => a.getAttribute('href'));
  out.acctHrefs = acct;
  const t = document.querySelector('#s-profile-account a[href="terms.html"]');
  out.acctRect = t ? t.getBoundingClientRect() : { height: 0, width: 0 };
  return out;
});
ok(legal.auth && legal.auth.h > 0, `the signup agreement is laid out (${legal.auth && legal.auth.h.toFixed(0)}px)`);
ok(/agree to/i.test(legal.auth.text), 'it says the user agrees');
ok(legal.authTerms && legal.authPrivacy, 'and links both documents');
ok(/13/.test(legal.auth.text), 'and states the minimum age');
ok(legal.acctHrefs.includes('terms.html') && legal.acctHrefs.includes('privacy.html'),
  `both are reachable again from Account (${JSON.stringify(legal.acctHrefs)})`);
ok(legal.acctRect.height > 0 && legal.acctRect.width > 0,
  `and rendered there, not hidden (${legal.acctRect.height.toFixed(0)}×${legal.acctRect.width.toFixed(0)})`);
ok(legal.acctHrefs.some(h => /^mailto:/.test(h)), 'with a way to contact us — App Store 1.2');

// ── the policy pages themselves ─────────────────────────────────────────
for (const [file, musts] of [
  ['privacy.html', [
    [/Profile\s*(&rarr;|→)\s*Account/i, 'the privacy policy names the in-app deletion route'],
    [/immediately/i, 'and says deletion is immediate'],
    [/de-identified/i, 'and admits which records are kept de-identified'],
    [/handed to another member/i, 'and explains what happens to groups you created'],
  ]],
  ['terms.html', [
    [/no tolerance for objectionable content/i, 'the terms state zero tolerance — App Store 1.2'],
    [/within 24 hours/i, 'and commit to a review window'],
    [/Block/, 'and name blocking as a tool the user has'],
    [/Profile\s*(&rarr;|→)\s*Account\s*(&rarr;|→)\s*Delete my account/i,
      'and point at the in-app deletion route'],
  ]],
]) {
  const res = await p2.goto('http://localhost:8899/' + file, { waitUntil: 'domcontentloaded' });
  ok(res.ok(), `${file} loads (${res.status()})`);
  const body = await p2.content();
  for (const [re, msg] of musts) ok(re.test(body), msg);
  ok(!/emailing <a href="mailto:contact@mytenner\.com">contact@mytenner\.com<\/a>\. We will delete your data within 30 days of the request\./.test(body),
    `${file} no longer says email is the only way to delete an account`);
  ok(!/currently in beta/i.test(body), `${file} does not call the product a beta — App Store 2.2`);
}

await ctx.close();
await browser.close();
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nall checks passed');
process.exit(fails.length ? 1 : 0);
