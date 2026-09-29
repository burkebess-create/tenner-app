// The Block control on a friend's page: it must be there, beside Remove
// friend, carry the friend's USER id (not the friendship id), and survive a
// name containing a quote — the onclick is string-built.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright/index.js');
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-proxy-server', '--no-sandbox'] });
const fails = [];
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails.push(m); };
const page = await browser.newPage({ viewport: { width: 430, height: 950 } });
await page.goto('http://localhost:8899/?skipIntro=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window.renderFriendDetail === 'function', { timeout: 20000 });

const r = await page.evaluate(async () => {
  window.userId = 'me';
  window.MY_LISTS = [];
  window.myFriends = [{ id: 'friendship-1', friendId: 'user-9', status: 'accepted',
    name: "Riley O'Brien", display_name: "Riley O'Brien", handle: 'riley' }];
  window.selFriendId = 'user-9';
  window.sbClient = null;   // stop the async half; the markup is what we check
  window.go('s-fdetail');
  await window.renderFriendDetail();
  await new Promise(r => setTimeout(r, 300));
  const btns = [...document.querySelectorAll('#s-fdetail button')];
  const block = btns.find(b => b.textContent.trim() === 'Block');
  const unfriend = btns.find(b => /Remove friend/.test(b.textContent));
  const rect = block ? block.getBoundingClientRect() : { height: 0, width: 0 };
  return { hasBlock: !!block, hasUnfriend: !!unfriend,
    onclick: block ? block.getAttribute('onclick') : null,
    h: rect.height, w: rect.width,
    adjacent: !!(block && unfriend && unfriend.nextElementSibling === block) };
});
ok(r.hasUnfriend, 'Remove friend is still there');
ok(r.hasBlock, 'and Block sits next to it');
ok(r.adjacent, 'they are adjacent, so blocking is found where removing is');
ok(r.h >= 30 && r.w > 0, `Block is a real tap target (${r.h.toFixed(0)}×${r.w.toFixed(0)})`);
ok(/'user-9'/.test(r.onclick || ''), `it passes the friend's USER id, not the friendship id (${r.onclick})`);
ok(!/'friendship-1'/.test(r.onclick || ''), 'the friendship id is not what gets blocked');
let parses = true; try { new Function(r.onclick); } catch (e) { parses = false; }
ok(parses, "a name with an apostrophe does not break the handler");

await browser.close();
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nall checks passed');
process.exit(fails.length ? 1 : 0);
