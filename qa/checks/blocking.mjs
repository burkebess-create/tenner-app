// Blocking UI (App Store 1.2): it must be reachable, say what it does,
// be undoable, and every string-built onclick it draws must actually parse.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright/index.js');
const SP = '/tmp';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-proxy-server', '--no-sandbox'],
});
const fails = [];
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails.push(m); };

const page = await browser.newPage({ viewport: { width: 430, height: 950 } });
await page.goto('http://localhost:8899/?skipIntro=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window.confirmBlockUser === 'function', { timeout: 20000 });

// A fake client that records rpc calls and answers my_blocked_accounts.
async function stub(blocked, failWith) {
  await page.evaluate(({ b, f }) => {
    window.userId = 'me';
    window.rpcs = [];
    window.toasts = [];
    window.showToast = (t) => window.toasts.push(t);
    window.loadFriends = async () => {};
    window.sbClient = {
      rpc: async (n, a) => {
        window.rpcs.push({ n, a });
        if (n === 'my_blocked_accounts') return { data: b, error: null };
        return f ? { data: null, error: f } : { data: true, error: null };
      },
    };
  }, { b: blocked, f: failWith });
}

// ── the blocked-accounts screen ─────────────────────────────────────────
await stub([]);
await page.evaluate(() => window.go('s-profile-account'));
await page.waitForTimeout(400);
const empty = await page.evaluate(() => {
  const card = document.getElementById('blocked-accounts-card');
  const list = document.getElementById('blocked-accounts-list');
  const screen = card && card.closest('.screen');
  const r = card ? card.getBoundingClientRect() : { height: 0, width: 0 };
  return { screen: screen && screen.id, h: r.height, w: r.width,
           text: list ? list.innerText.trim() : null,
           blurb: card ? card.innerText : '' };
});
ok(empty.screen === 's-profile-account',
  `the blocked list lives with the other account actions (${empty.screen})`);
ok(empty.h > 0 && empty.w > 0, `it is laid out, not a zero-height stub (${empty.h}×${empty.w})`);
ok(/have not blocked anyone/i.test(empty.text || ''), `empty state reads plainly (${JSON.stringify(empty.text)})`);
ok(/not be told|not told/i.test(empty.blurb), 'and it says the blocked person is not notified');

await stub([{ user_id: 'u2', display_name: 'Lisa <b>Mercer</b>', handle: 'lisam' },
            { user_id: 'u3', display_name: null, handle: 'ghost' }]);
await page.evaluate(() => window.renderBlockedAccounts());
await page.waitForTimeout(300);
const listed = await page.evaluate(() => {
  const el = document.getElementById('blocked-accounts-list');
  return { html: el.innerHTML, text: el.innerText,
           unblocks: el.querySelectorAll('[onclick*="confirmUnblockUser"]').length };
});
ok(listed.unblocks === 2, `every blocked account gets an Unblock button (${listed.unblocks})`);
ok(!/<b>Mercer<\/b>/.test(listed.html) && /Lisa <b>Mercer<\/b>/.test(listed.text),
  'a name with markup in it is escaped, not rendered');
ok(/@ghost/.test(listed.text), 'a nameless account still shows as its handle');
await page.screenshot({ path: SP + '/blocked-accounts.png' });

// Every onclick this screen just built must parse — these are string-built
// attributes with user names interpolated into them.
const parsed = await page.evaluate(() => [...document.querySelectorAll('#blocked-accounts-list [onclick]')]
  .map(e => e.getAttribute('onclick')));
let bad = 0;
for (const src of parsed) { try { new Function(src); } catch (e) { bad++; console.log('   unparsable:', src); } }
ok(bad === 0, `the generated Unblock handlers parse (${parsed.length} checked)`);

// ── unblock: confirmed, and honest about what it does not restore ────────
await page.evaluate(() => window.confirmUnblockUser('u2', 'Lisa Mercer'));
await page.waitForSelector('#confirm-ok', { state: 'visible', timeout: 5000 });
let dlg = await page.evaluate(() => document.querySelector('#confirm-modal, #confirm-ok').closest('div[id]').parentElement.innerText);
ok(/Unblock Lisa Mercer/i.test(dlg), 'unblocking asks first, by name');
ok(/does not add them back|new request/i.test(dlg),
  'and says the friendship is not restored');
await page.click('#confirm-ok');
await page.waitForTimeout(400);
let rpcs = await page.evaluate(() => window.rpcs.map(r => r.n + ':' + JSON.stringify(r.a)));
ok(rpcs.some(r => r.startsWith('unblock_user:') && r.includes('u2')),
  `confirming calls unblock_user for that person (${JSON.stringify(rpcs)})`);

// Cancel must not unblock.
await stub([{ user_id: 'u2', display_name: 'Lisa', handle: 'lisam' }]);
await page.evaluate(() => window.renderBlockedAccounts());
await page.waitForTimeout(250);
await page.evaluate(() => window.confirmUnblockUser('u2', 'Lisa'));
await page.waitForSelector('#confirm-ok', { state: 'visible', timeout: 5000 });
await page.evaluate(() => {
  const btns = [...document.querySelectorAll('button')].filter(b => /cancel|never mind/i.test(b.textContent));
  (btns[btns.length - 1] || {}).click?.();
});
await page.waitForTimeout(300);
rpcs = await page.evaluate(() => window.rpcs.map(r => r.n));
ok(!rpcs.includes('unblock_user'), `cancelling unblocks nobody (${JSON.stringify(rpcs)})`);

// ── block: confirmed, names the consequences ────────────────────────────
await stub([]);
await page.evaluate(() => window.confirmBlockUser('u9', 'Riley'));
await page.waitForSelector('#confirm-ok', { state: 'visible', timeout: 5000 });
dlg = await page.evaluate(() => document.body.innerText);
ok(/Block Riley\?/.test(dlg), 'blocking asks first, by name');
ok(/not be able to see your lists/i.test(dlg), 'it says they lose sight of your lists');
ok(/removes them from your circle/i.test(dlg), 'it says the friendship goes');
ok(/not told/i.test(dlg), 'it says they are not notified');
ok(/undo this any time/i.test(dlg), 'and that it is reversible');
await page.click('#confirm-ok');
await page.waitForTimeout(500);
const after = await page.evaluate(() => ({ rpcs: window.rpcs.map(r => r.n + ':' + JSON.stringify(r.a)),
  toasts: window.toasts, screen: document.querySelector('.screen.active')?.id }));
ok(after.rpcs.some(r => r.startsWith('block_user:') && r.includes('u9')),
  `confirming calls block_user (${JSON.stringify(after.rpcs)})`);
ok(after.toasts.some(t => /Riley is blocked/.test(t)), `and confirms it (${JSON.stringify(after.toasts)})`);
ok(after.screen === 's-circle',
  `it leaves their now-invisible page rather than showing stale rows (${after.screen})`);

// ── a refused block is surfaced, not swallowed ──────────────────────────
await stub([], { message: 'you cannot block yourself' });
await page.evaluate(() => window.confirmBlockUser('me', 'Me'));
await page.waitForSelector('#confirm-ok', { state: 'visible', timeout: 5000 });
await page.click('#confirm-ok');
await page.waitForTimeout(400);
const refused = await page.evaluate(() => window.toasts);
ok(refused.some(t => /cannot block yourself/i.test(t)),
  `a refusal reaches the user (${JSON.stringify(refused)})`);
ok(!refused.some(t => /is blocked/.test(t)), 'and is not reported as success');

// ── no-op guard ─────────────────────────────────────────────────────────
await stub([]);
await page.evaluate(() => window.confirmBlockUser('', 'Nobody'));
await page.waitForTimeout(250);
// The confirm modal is a persistent, hidden element — count() is 1 whether or
// not it was opened, so ask whether it is VISIBLE.
ok(!(await page.locator('#confirm-ok').isVisible().catch(() => false)),
  'an empty user id opens nothing');

await browser.close();
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nall checks passed');
process.exit(fails.length ? 1 : 0);
