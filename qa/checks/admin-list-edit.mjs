// Admin → Lists → Edit: retitle a list and set its emoji.
//
// The write goes through admin_update_list_meta() rather than a table update
// because lists_update is USING (user_id = auth.uid()): an admin PATCH of
// someone else's list matches zero rows and returns NO ERROR, which
// supabase-js hands back as success. A test that stubbed .update() and
// checked it was called would therefore pass against code that silently
// changed nothing in production. So this asserts the RPC is what gets called.
//
// The category is deliberately not editable here — it is the join key eight
// tables store as bare text — so there is a check that nothing in this path
// tries to write one.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright/index.js');

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-proxy-server', '--no-sandbox'],
});
const fails = [];
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails.push(m); };

const page = await browser.newPage({ viewport: { width: 430, height: 950 } });
await page.goto('http://localhost:8899/?skipIntro=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window.editAdminListMeta === 'function', { timeout: 20000 });

const ROW = { id: 'list-1', name: 'Top 10 Best Fruit', emoji: '🍎',
              category: 'Best Fruit', user_id: 'u9', items: ['Mango', 'Strawberry'] };

async function open(row, rpcResult) {
  await page.evaluate(({ r, rr }) => {
    window.rpcs = []; window.tableWrites = []; window.toasts = [];
    window.showToast = (t) => window.toasts.push(t);
    window.trackEvent = () => {};
    window.renderAdmin = () => { window.rerendered = true; };
    window.rerendered = false;
    window.sbClient = {
      from: (t) => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: r, error: null }) }) }),
        update: (p) => { window.tableWrites.push({ t, p }); return { eq: async () => ({ error: null }) }; },
      }),
      rpc: async (n, a) => { window.rpcs.push({ n, a });
        return rr || { data: { id: r.id, name: a.p_name, emoji: a.p_emoji,
                               category: r.category,
                               differs_from_category: a.p_name !== ('Top 10 ' + r.category) },
                       error: null }; },
    };
    const m = document.getElementById('admin-list-meta-modal'); if (m) m.remove();
  }, { r: row, rr: rpcResult });
  await page.evaluate((id) => window.editAdminListMeta(id), row.id);
  await page.waitForSelector('#admin-list-meta-modal', { timeout: 5000 });
  await page.waitForTimeout(200);
}

// ── the modal ───────────────────────────────────────────────────────────
await open(ROW);
let m = await page.evaluate(() => {
  const el = document.getElementById('admin-list-meta-modal');
  const r = el.getBoundingClientRect();
  return { h: r.height, w: r.width, text: el.innerText,
           name: document.getElementById('alm-name').value,
           emoji: document.getElementById('alm-emoji').value,
           inFrame: !!el.closest('.frame') };
});
ok(m.h > 0 && m.w > 0, `the editor is laid out (${m.h.toFixed(0)}×${m.w.toFixed(0)})`);
ok(m.inFrame, 'and sits inside .frame, not on document.body');
ok(m.name === ROW.name, `the title is prefilled (${m.name})`);
ok(m.emoji === ROW.emoji, `and the emoji is prefilled (${m.emoji})`);
ok(/Best Fruit/.test(m.text), 'the category is shown');
ok(/not changed here/i.test(m.text), 'and the modal says the category is not being changed');
ok(/Custom categories/i.test(m.text), 'and points at the tool that does change it');
await page.screenshot({ path: '/tmp/admin-list-edit.png' });

// The hint has to react as they type — an admin fixing a typo wants the two
// to agree; one giving a list a nicer name is choosing to let them differ.
let hint = await page.evaluate(() => document.getElementById('alm-name-hint').innerText);
ok(/Matches the category/i.test(hint), `an unchanged title reads as matching (${JSON.stringify(hint)})`);
await page.fill('#alm-name', 'Top 10 Fruit, Ranked');
await page.waitForTimeout(150);
hint = await page.evaluate(() => document.getElementById('alm-name-hint').innerText);
ok(/Differs from the category/i.test(hint) && /Best Fruit/.test(hint),
  `a changed title says what it still matches under (${JSON.stringify(hint)})`);

// ── saving ──────────────────────────────────────────────────────────────
await page.fill('#alm-emoji', '🍍');
await page.click('#alm-save');
await page.waitForTimeout(400);
let r = await page.evaluate(() => ({ rpcs: window.rpcs, writes: window.tableWrites,
  toasts: window.toasts, open: !!document.getElementById('admin-list-meta-modal'),
  rerendered: window.rerendered }));
ok(r.rpcs.length === 1 && r.rpcs[0].n === 'admin_update_list_meta',
  `saving calls the RPC (${JSON.stringify(r.rpcs.map(x => x.n))})`);
ok(r.rpcs[0].a.p_name === 'Top 10 Fruit, Ranked' && r.rpcs[0].a.p_emoji === '🍍',
  `with the typed title and emoji (${JSON.stringify(r.rpcs[0].a)})`);
ok(r.writes.length === 0,
  `and NOT a table update, which an admin's PATCH would silently no-op (${JSON.stringify(r.writes)})`);
ok(!('p_category' in r.rpcs[0].a), 'the category is not sent at all');
ok(!r.open, 'the editor closes');
ok(r.toasts.some(t => /updated/i.test(t)), `and says so (${JSON.stringify(r.toasts)})`);
ok(r.rerendered, 'and the list refreshes');

// ── refusals ────────────────────────────────────────────────────────────
await open(ROW);
await page.fill('#alm-name', '   ');
await page.click('#alm-save');
await page.waitForTimeout(250);
r = await page.evaluate(() => ({ rpcs: window.rpcs.length,
  err: document.getElementById('alm-error').innerText,
  open: !!document.getElementById('admin-list-meta-modal'),
  disabled: document.getElementById('alm-save').disabled }));
ok(r.rpcs === 0, 'a blank title never reaches the server');
ok(/needs a title/i.test(r.err), `and is explained (${JSON.stringify(r.err)})`);
ok(r.open && !r.disabled, 'the editor stays open and usable');

await open(ROW, { data: null, error: { message: 'Not authorized' } });
await page.fill('#alm-name', 'Something else');
await page.click('#alm-save');
await page.waitForTimeout(300);
r = await page.evaluate(() => ({ err: document.getElementById('alm-error').innerText,
  open: !!document.getElementById('admin-list-meta-modal'),
  disabled: document.getElementById('alm-save').disabled,
  toasts: window.toasts }));
ok(/Not authorized/.test(r.err), `a server refusal is shown verbatim (${JSON.stringify(r.err)})`);
ok(r.open, 'the editor stays open on failure');
ok(!r.disabled, 'and the Save button works again');
ok(!r.toasts.some(t => /updated/i.test(t)), 'a failed save is not reported as success');

// ── the owner's next save must not undo it ──────────────────────────────
// Both save paths rebuilt the title from the category every time, so an
// admin's retitle survived only until the owner touched that list.
r = await page.evaluate(() => {
  const t = (cat, list) => window.listTitleForSave(cat, list);
  return {
    fresh:    t('Best Fruit', null),
    untouched: t('Best Fruit', { n: 'Top 10 Best Fruit', category: 'Best Fruit' }),
    custom:   t('Best Fruit', { n: 'Top 10 Fruit, Ranked', category: 'Best Fruit' }),
    recategorised: t('Best Snacks', { n: 'Top 10 Fruit, Ranked', category: 'Best Fruit' }),
    nameless: t('Best Fruit', { n: '', category: 'Best Fruit' }),
    fromDbShape: t('Best Fruit', { name: 'Top 10 Fruit, Ranked', category: 'Best Fruit' }),
  };
});
ok(r.fresh === 'Top 10 Best Fruit', `a new list derives its title (${r.fresh})`);
ok(r.untouched === 'Top 10 Best Fruit', `an uncustomised title is still derived (${r.untouched})`);
ok(r.custom === 'Top 10 Fruit, Ranked',
  `an admin's retitle SURVIVES the owner's next save (${r.custom})`);
ok(r.recategorised === 'Top 10 Best Snacks',
  `but changing the category drops a title that no longer describes it (${r.recategorised})`);
ok(r.nameless === 'Top 10 Best Fruit', `a nameless row falls back to the derived title (${r.nameless})`);
ok(r.fromDbShape === 'Top 10 Fruit, Ranked', 'and it reads a raw database row too');

await browser.close();
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nall checks passed');
process.exit(fails.length ? 1 : 0);
