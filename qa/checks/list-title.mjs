// A retitled list must show its new title everywhere it is named.
//
// An admin can retitle a list; the category stays put because it is the join
// key. Most screens predate that and rebuilt the title as 'Top 10 ' +
// category, so a retitled list kept showing its OLD name in the Circle feed,
// on the friend's page and on the gift tiles — while the new emoji, which
// those same screens read off the row, came through. Reported as "still
// showing under the old title but new emoji in lots of places".
//
// The stub honours the SELECT projection: it returns only the columns the
// query actually asked for. That matters more than it sounds. The helper
// falls back to the category when `name` is absent, so a screen that renders
// listTitleFor() but forgets to select `name` looks fixed and does nothing —
// the exact shape of the original bug. Against a stub that returns whole
// rows regardless, such a screen passes. Here it fails.
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
await page.waitForFunction(() => typeof window.listTitleFor === 'function', { timeout: 20000 });

// Teresa's real case: retitled to the plural, category left alone.
const CUSTOM = 'Top 10 Best Fruits';
const CATEGORY = 'Best Fruit';
const DERIVED = 'Top 10 Best Fruit';

// ── the helpers ─────────────────────────────────────────────────────────
let h = await page.evaluate(({ c, cat }) => ({
  custom:   window.listTitleFor({ name: c, category: cat }, cat),
  clientRow: window.listTitleFor({ n: c, category: cat }, cat),
  none:     window.listTitleFor({ category: cat }, cat),
  blank:    window.listTitleFor({ name: '   ', category: cat }, cat),
  nullRow:  window.listTitleFor(null, cat),
  short:    window.listShortTitleFor({ name: c, category: cat }, cat),
  shortNone: window.listShortTitleFor({ category: cat }, cat),
}), { c: CUSTOM, cat: CATEGORY });
ok(h.custom === CUSTOM, `a stored title wins (${h.custom})`);
ok(h.clientRow === CUSTOM, `and the in-memory shape (.n) works too (${h.clientRow})`);
ok(h.none === DERIVED, `no stored title falls back to the category (${h.none})`);
ok(h.blank === DERIVED, `a whitespace title is not a title (${h.blank})`);
ok(h.nullRow === DERIVED, `and a missing row does not throw (${h.nullRow})`);
ok(h.short === 'Best Fruits', `the short form drops the prefix (${h.short})`);
ok(h.shortNone === CATEGORY, `and falls back to the bare category (${h.shortNone})`);

// ── the screens ─────────────────────────────────────────────────────────
// A Supabase stub that respects `select(...)`: a screen that renders the
// title but forgets to select `name` gets a row without one, and fails.
async function stub() {
  await page.evaluate(({ c, cat }) => {
    window.userId = 'me';
    window.selectedColumns = [];
    const LIST = {
      id: 'l1', user_id: 'u9', name: c, category: cat, emoji: '🍇',
      items: ['Mango', 'Strawberry', 'Pineapple'], is_ranked: true,
      is_public: true, blind_fill: false, item_notes: {},
      updated_at: new Date(Date.now() - 9 * 60 * 1000).toISOString(),
    };
    const project = (row, cols) => {
      if (!cols || cols.trim() === '*') return Object.assign({}, row);
      const keep = cols.split(',').map(s => s.trim()).filter(Boolean);
      const out = {};
      keep.forEach(k => { if (k in row) out[k] = row[k]; });
      return out;
    };
    const build = (table, cols) => {
      const rows = table === 'lists' ? [project(LIST, cols)] : [];
      const res = { data: rows, error: null, count: rows.length };
      const chain = {
        eq: () => chain, in: () => chain, order: () => chain, limit: () => chain,
        gte: () => chain, lte: () => chain, not: () => chain, is: () => chain,
        or: () => chain, neq: () => chain, filter: () => chain, range: () => chain,
        contains: () => chain, select: () => chain, ilike: () => chain,
        maybeSingle: async () => ({ data: rows[0] || null, error: null }),
        single: async () => ({ data: rows[0] || null, error: null }),
        then: (r, j) => Promise.resolve(res).then(r, j),
      };
      return chain;
    };
    window.sbClient = {
      from: (table) => ({
        select: (cols) => { if (table === 'lists') window.selectedColumns.push(cols || '*');
          return build(table, cols); },
        insert: () => Promise.resolve({ error: null }),
        upsert: () => Promise.resolve({ error: null }),
        delete: () => ({ eq: async () => ({ error: null }) }),
        update: () => ({ eq: async () => ({ error: null }) }),
      }),
      rpc: async () => ({ data: [], error: null }),
    };
    window.myFriends = [{ friendId: 'u9', status: 'accepted',
      profile: { id: 'u9', display_name: 'Teresa Bess', handle: 'teresa' } }];
    window.MY_LISTS = [];
    window.trackEvent = () => {};
  }, { c: CUSTOM, cat: CATEGORY });
}

// Circle → Recent updates
await stub();
let out = await page.evaluate(async () => {
  window.go('s-circle');
  await window.renderHomeFeed();
  await new Promise(r => setTimeout(r, 300));
  const el = document.getElementById('home-feed-section');
  return { text: el ? el.innerText : '', html: el ? el.innerHTML : '',
           cols: window.selectedColumns };
});
ok(out.text.includes(CUSTOM), `Circle feed shows the new title (${JSON.stringify(out.text.slice(0, 80))})`);
ok(!out.text.includes(DERIVED + '\n') && !/updated Top 10 Best Fruit$/m.test(out.text),
  'and not the old one');
ok(/🍇/.test(out.html), 'with the new emoji, as it already did');

// Friend page → tiles and activity rows
await stub();
out = await page.evaluate(async () => {
  window.selFriendId = 'u9';
  window.MY_LISTS = [];
  window.go('s-fdetail');
  await window.renderFriendDetail();
  await new Promise(r => setTimeout(r, 700));
  const tiles = document.getElementById('fdetail-lists');
  const act = document.getElementById('fdetail-activity');
  return { tiles: tiles ? tiles.innerText : '', act: act ? act.innerText : '',
           cols: window.selectedColumns };
});
ok(out.tiles.includes('Best Fruits'), `their list tile shows the new title (${JSON.stringify(out.tiles.slice(0, 60))})`);
ok(out.act.includes(CUSTOM), `the activity row shows it too (${JSON.stringify(out.act.slice(0, 80))})`);

// Alerts → a comment on one of MY lists, where only the category is known.
out = await page.evaluate(({ c, cat }) => {
  window.MY_LISTS = [{ n: c, category: cat, items: [] }];
  return { mine: window.myListTitleFor(cat), unknown: window.myListTitleFor('Pies') };
}, { c: CUSTOM, cat: CATEGORY });
ok(out.mine === CUSTOM, `a category-only reference resolves through MY_LISTS (${out.mine})`);
ok(out.unknown === 'Top 10 Pies', `and a list I do not have still reads sensibly (${out.unknown})`);

// ── the whole point: nothing regresses for untitled lists ───────────────
await page.evaluate(() => {
  window.MY_LISTS = [];
  const el = document.getElementById('home-feed-section');
  if (el) el.innerHTML = '';
});
out = await page.evaluate(async (cat) => {
  // Same stub, but the row has no custom title — the normal case.
  const prev = window.sbClient.from;
  window.sbClient.from = (t) => {
    const chain = { eq: () => chain, in: () => chain, order: () => chain, limit: () => chain,
      then: (r, j) => Promise.resolve({ data: t === 'lists' ? [{
        user_id: 'u9', name: 'Top 10 ' + cat, category: cat, emoji: '🍇',
        is_public: true, updated_at: new Date().toISOString(), items: [] }] : [], error: null }).then(r, j),
      maybeSingle: async () => ({ data: null, error: null }) };
    return { select: () => chain };
  };
  window.go('s-circle');
  await window.renderHomeFeed();
  await new Promise(r => setTimeout(r, 300));
  window.sbClient.from = prev;
  const el = document.getElementById('home-feed-section');
  return el ? el.innerText : '';
}, CATEGORY);
ok(out.includes(DERIVED), `an ordinary list still reads "${DERIVED}"`);

await browser.close();
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nall checks passed');
process.exit(fails.length ? 1 : 0);
