// Exercises the REAL renderAdminCustomCats / toggleCustomCatOwners from
// index.html, with sbClient.rpc stubbed. The sandbox cannot reach supabase, so
// this is the only way to see the markup these two actually produce.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright/index.js');

const PORT = process.argv[2] || '8899';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-proxy-server', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 430, height: 930 } });
const fails = [];
const ok = (cond, msg) => { console.log((cond ? '  ok   ' : '  FAIL ') + msg); if (!cond) fails.push(msg); };

await page.goto(`http://localhost:${PORT}/?skipIntro=1`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window.renderAdminCustomCats === 'function', { timeout: 20000 });

// Stub the two RPCs with shapes matching what the real ones return.
await page.evaluate(() => {
  window.__calls = [];
  window.sbClient = {
    rpc: async function (name, args) {
      window.__calls.push({ name, args });
      if (name === 'admin_custom_categories') {
        return { data: [
          { category: 'Rides at Lagoon', people: 4, total_items: 381,
            sample_items: ['Bombora', 'Bumper cars', 'Cannibal', "Colossus: The Fire Dragon"] },
          { category: "Best Purchases I've Ever Made", people: 2, total_items: 20,
            sample_items: ["a <b>hammer</b>", "quotes ' and \""] },
        ], error: null };
      }
      if (name === 'admin_custom_category_owners') {
        if (args.p_category === 'Rides at Lagoon') {
          return { data: [
            { user_id: 'u1', display_name: 'Pyper', handle: 'pyper', email: 'p@x.com',
              list_id: '11111111-1111-4111-8111-111111111111', item_count: 10, is_public: true,
              updated_at: new Date(Date.now() - 3600e3).toISOString() },
            { user_id: 'u2', display_name: null, handle: null, email: 'anna.wiser@icloud.com',
              list_id: '22222222-2222-4222-8222-222222222222', item_count: 7, is_public: false,
              updated_at: new Date(Date.now() - 7200e3).toISOString() },
          ], error: null };
        }
        return { data: [], error: null };
      }
      return { data: [], error: null };
    },
  };
});

const host = await page.evaluateHandle(() => {
  const d = document.createElement('div');
  d.id = 'cc-test-host';
  document.body.appendChild(d);
  return d;
});
await page.evaluate(async (el) => { await window.renderAdminCustomCats(el); }, host);

ok(await page.locator('#cc-test-host .card').count() === 2, 'two category tiles render');
ok(await page.locator('#cc-owners-0').count() === 1, 'tile 0 has an owners container');
ok(!(await page.locator('#cc-owners-0').isVisible()), 'owners start collapsed');
ok((await page.locator('#cc-caret-0').textContent()) === '▸', 'caret starts collapsed');

// Expand.
await page.locator('#cc-test-host .card').first().locator('div[onclick^="toggleCustomCatOwners"]').click();
await page.waitForFunction(() => {
  const b = document.getElementById('cc-owners-0');
  return b && b.style.display !== 'none' && !/Loading/.test(b.innerText);
}, { timeout: 8000 });

const body = await page.locator('#cc-owners-0').innerText();
ok(/Pyper/.test(body), 'a named owner is listed');
ok(/anna\.wiser@icloud\.com/.test(body), 'a nameless owner falls back to email, not "unknown"');
ok(/10 items/.test(body) && /public/.test(body), 'item count and visibility render');
ok((await page.locator('#cc-caret-0').textContent()) === '▾', 'caret flips when open');

// The Promote button must not toggle the row.
const calls0 = await page.evaluate(() => window.__calls.length);
await page.evaluate(() => {
  const b = document.querySelector('#cc-test-host .card button.btn-primary');
  b.setAttribute('onclick', b.getAttribute('onclick').replace('promoteCustomCat(0)', 'void 0'));
  b.click();
});
ok(await page.locator('#cc-owners-0').isVisible(), 'Promote does not collapse the row (stopPropagation)');
ok(await page.evaluate(() => window.__calls.length) === calls0, 'Promote fired no extra RPC');

// Collapse again.
await page.locator('#cc-test-host .card').first().locator('div[onclick^="toggleCustomCatOwners"]').click();
await page.waitForTimeout(200);
ok(!(await page.locator('#cc-owners-0').isVisible()), 'tapping again collapses');

// Re-expand must be served from cache, not a second round trip.
const before = await page.evaluate(() => window.__calls.filter(c => c.name === 'admin_custom_category_owners').length);
await page.locator('#cc-test-host .card').first().locator('div[onclick^="toggleCustomCatOwners"]').click();
await page.waitForTimeout(300);
const after = await page.evaluate(() => window.__calls.filter(c => c.name === 'admin_custom_category_owners').length);
ok(before === after, `re-expanding reuses the cache (${before} → ${after} calls)`);

// The empty case.
await page.locator('#cc-test-host .card').nth(1).locator('div[onclick^="toggleCustomCatOwners"]').click();
await page.waitForFunction(() => {
  const b = document.getElementById('cc-owners-1');
  return b && b.style.display !== 'none' && !/Loading/.test(b.innerText);
}, { timeout: 8000 });
ok(/No lists found/.test(await page.locator('#cc-owners-1').innerText()), 'empty result shows a message');

// Every handler this screen generated must actually compile. Collected in the
// page, compiled here: the production CSP has no 'unsafe-eval'.
const attrs = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll('#cc-test-host *').forEach(el => {
    for (const a of el.attributes) if (/^on[a-z]+$/i.test(a.name)) out.push(a.value);
  });
  return out;
});
let broken = 0;
for (const a of attrs) { try { new Function(a); } catch (e) { broken++; console.log('  broken handler:', a.slice(0, 120), e.message); } }
ok(broken === 0, `all ${attrs.length} inline handlers compile (including the apostrophe category)`);

await page.screenshot({ path: '/tmp/claude-0/-home-user-tenner-app/18e12a9a-11f9-5c8b-9cd0-bc42074913db/scratchpad/cc-expanded.png' });
await browser.close();
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nall checks passed');
process.exit(fails.length ? 1 : 0);
