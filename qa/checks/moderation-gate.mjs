// Every user-visible free-text write goes through screenUserText().
//
// This exists because moderation was bolted onto individual save paths and
// four fields were never wired in — display name, bio, list item names,
// custom category names and group names all went straight to the database —
// while the one gate that did exist had a second door: saveList() screened
// notes and saveListDataOnly() screened nothing, same notes, same button row.
//
// The moderation endpoint is stubbed so a chosen word is "flagged". What is
// NOT stubbed is the save path: each case drives the app's real function and
// then asks whether a write reached the database layer. A test that only
// checked "screenUserText was called" would pass against code that ignored
// the answer.
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
await page.waitForFunction(() => typeof window.screenUserText === 'function', { timeout: 20000 });

const BAD = 'zzbadword';

// Stub only the network edge: the moderation function, and a recording
// Supabase client. `outage` makes every moderation call fail, to prove the
// gate falls open rather than costing someone their list.
async function reset({ outage = false } = {}) {
  await page.evaluate(({ bad, outage }) => {
    window.userId = 'u1';
    window.writes = [];       // every table write that got through
    window.modCalls = [];     // every text sent for screening
    window.toasts = [];
    window.shownErrors = [];
    window.screenedReset && window.screenedReset();
    window.showToast = (t) => window.toasts.push(t);
    window.showProfileError = (t) => window.shownErrors.push(t);
    window.trackEvent = () => {};
    window.saveState = () => {};
    window.markListDirty = () => {};

    const rec = (table) => ({
      insert: (p) => { window.writes.push({ table, op: 'insert', p });
        const r = { data: { id: 'new-id' }, error: null };
        return Object.assign(Promise.resolve(r), { select: () => ({ maybeSingle: async () => r }) }); },
      update: (p) => { window.writes.push({ table, op: 'update', p });
        return { eq: () => ({ eq: async () => ({ error: null }), then: undefined,
                              error: null, data: null }) }; },
      upsert: (p) => { window.writes.push({ table, op: 'upsert', p }); return Promise.resolve({ error: null }); },
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
                                    maybeSingle: async () => ({ data: null, error: null }) }) }),
    });
    window.sbClient = {
      from: rec,
      rpc: async () => ({ data: null, error: null }),
      functions: {
        invoke: async (name, opts) => {
          const text = (opts && opts.body && opts.body.text) || '';
          window.modCalls.push(text);
          if (outage) return { error: new Error('moderation is down'), data: null };
          return { data: { flagged: text.toLowerCase().includes(bad),
                           primary: 'hate', primary_label: 'hate speech' }, error: null };
        },
      },
    };
  }, { bad: BAD, outage });
  // A pass is cached per session by design; clear it between cases.
  await page.evaluate(() => { for (const k in window._screenedOk) delete window._screenedOk[k]; });
}

// ── the gate itself ─────────────────────────────────────────────────────
await reset();
let r = await page.evaluate(async (bad) => {
  const clean = await window.screenUserText([{ label: 'name', text: 'Riley Brooks' }], 't');
  const calls1 = window.modCalls.length;
  const dirty = await window.screenUserText([
    { label: 'name', text: 'Riley Brooks' },
    { label: 'bio', text: 'hello ' + bad + ' there' },
  ], 't');
  return { clean, dirty, calls1, all: window.modCalls.length };
}, BAD);
ok(r.clean.blocked === false, 'clean text passes');
ok(r.dirty.blocked === true, 'flagged text is refused');
ok(r.dirty.label === 'bio', `and the offending field is named (${r.dirty.label})`);
ok(/hate speech/.test(r.dirty.reason), `with a reason (${r.dirty.reason})`);

await reset();
r = await page.evaluate(async () => {
  await window.screenUserText([
    { label: 'a', text: 'one' }, { label: 'b', text: 'two' }, { label: 'c', text: 'three' },
  ], 't');
  return { calls: window.modCalls.length, first: window.modCalls[0] };
});
ok(r.calls === 1, `a clean batch of three costs one call, not three (${r.calls})`);
ok(/one[\s\S]*two[\s\S]*three/.test(r.first), 'because they are screened together');

await reset();
r = await page.evaluate(async () => {
  const a = await window.screenUserText([{ label: 'x', text: 'same text' }], 't');
  const n1 = window.modCalls.length;
  const b = await window.screenUserText([{ label: 'x', text: 'same text' }], 't');
  const c = await window.screenUserText([{ label: 'x', text: 'same text', was: 'same text' }], 't');
  return { a, b, c, n1, n2: window.modCalls.length };
});
ok(r.n1 === 1 && r.n2 === 1, `text that already passed is not re-screened (${r.n1} → ${r.n2})`);
ok(r.b.blocked === false && r.c.blocked === false, 'and is still allowed through');

// Falling open matters more than it looks: a missed post can be reported and
// removed, a lost list cannot be recovered.
await reset({ outage: true });
r = await page.evaluate(async (bad) => await window.screenUserText([{ label: 'bio', text: bad }], 't'), BAD);
ok(r.blocked === false, 'with moderation down the gate falls open rather than blocking saves');

// ── profile: display name and bio ───────────────────────────────────────
async function saveProfileWith(name, bio) {
  await reset();
  return await page.evaluate(async ({ n, b }) => {
    window.myProfile = { id: 'u1', display_name: 'Riley Brooks', handle: 'riley', bio: 'old bio' };
    window.go('s-profile-edit');
    await new Promise(r => setTimeout(r, 300));
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.value = v; };
    set('profile-name-input', n);
    set('profile-handle-input', 'riley');
    set('profile-bio-input', b);
    try { await window.saveProfile(); } catch (e) {}
    await new Promise(r => setTimeout(r, 300));
    return { writes: window.writes.map(w => w.table + ':' + w.op),
             errors: window.shownErrors, name: window.myProfile.display_name };
  }, { n: name, b: bio });
}
let p = await saveProfileWith('Riley Brooks', 'a normal bio');
ok(p.writes.some(w => w.startsWith('profiles')), `a clean profile still saves (${JSON.stringify(p.writes)})`);

p = await saveProfileWith(BAD + ' Brooks', 'a normal bio');
ok(!p.writes.some(w => w.startsWith('profiles')), `a flagged display name never reaches profiles (${JSON.stringify(p.writes)})`);
ok(p.errors.some(e => /name/.test(e) && /hate speech/.test(e)), `and is explained inline (${JSON.stringify(p.errors)})`);
ok(p.name === 'Riley Brooks', `and myProfile keeps the old name (${p.name})`);

p = await saveProfileWith('Riley Brooks', 'I love ' + BAD);
ok(!p.writes.some(w => w.startsWith('profiles')), 'a flagged bio never reaches profiles');
ok(p.errors.some(e => /bio/.test(e)), `and the bio is named, not the name (${JSON.stringify(p.errors)})`);

// ── onboarding writes display_name through its own path ─────────────────
await reset();
r = await page.evaluate(async (bad) => {
  window.myProfile = { id: 'u1', display_name: bad, handle: null };
  const okd = await window.saveOnboardingProfile();
  return { okd, writes: window.writes.map(w => w.table) };
}, BAD);
ok(r.okd === false, 'onboarding refuses a flagged name');
ok(!r.writes.includes('profiles'), `and writes nothing (${JSON.stringify(r.writes)})`);

await reset();
r = await page.evaluate(async () => {
  window.myProfile = { id: 'u1', display_name: 'Lisa Mercer', handle: null };
  const a = await window.saveOnboardingProfile();
  const n1 = window.modCalls.length;
  const b = await window.saveOnboardingProfile();   // onboarding saves each step
  return { a, b, n1, n2: window.modCalls.length };
});
ok(r.a === true && r.b === true, 'a clean name saves');
ok(r.n1 === 1 && r.n2 === 1,
  `and stepping through onboarding does not re-screen it each time (${r.n1} → ${r.n2})`);

// ── lists: items, the custom category, and BOTH save buttons ────────────
async function saveList(fn, { cat, items, notes }) {
  await reset();
  return await page.evaluate(async ({ fn, cat, items, notes }) => {
    window.MY_LISTS = [];
    window.selCat = cat; window.selCatEmoji = '🍫';
    window.items = items; window.itemNotes = notes || {};
    window.isRanked = true;
    window.pruneItemNotes = () => window.itemNotes;
    window.saveListToDb = async (o) => { window.writes.push({ table: 'lists', op: 'save', p: o }); };
    window.renderItems = () => {}; window.updateProg = () => {};
    window.doAddItem = () => {}; window.commitItemNote = () => {};
    window._openNoteIdx = -1; window.editingListIdx = -1;
    let threw = false;
    try { await window[fn](); } catch (e) { threw = true; }
    await new Promise(r => setTimeout(r, 300));
    const dlg = document.getElementById('confirm-modal');
    return { threw, saved: window.writes.some(w => w.table === 'lists'),
             stored: window.MY_LISTS.length,
             dialog: (dlg && dlg.style.display !== 'none') ? document.body.innerText : '' };
  }, { fn, cat, items, notes });
}

for (const fn of ['saveList', 'saveListDataOnly']) {
  let L = await saveList(fn, { cat: 'Candy bars', items: ['Twix', 'Snickers'] });
  ok(L.saved, `${fn}: a clean list still saves (saved=${L.saved})`);

  L = await saveList(fn, { cat: 'Candy bars', items: ['Twix', BAD + ' bar'] });
  ok(!L.saved, `${fn}: a flagged ITEM NAME blocks the save`);
  ok(L.stored === 0, `${fn}: and nothing lands in MY_LISTS either (${L.stored})`);
  ok(/list item/i.test(L.dialog) && /hate speech/i.test(L.dialog),
    `${fn}: and the user is told which item`);

  L = await saveList(fn, { cat: BAD + ' things', items: ['Twix'] });
  ok(!L.saved, `${fn}: a flagged CUSTOM CATEGORY name blocks the save`);
  ok(/category name/i.test(L.dialog), `${fn}: and is named as the category`);

  L = await saveList(fn, { cat: 'Candy bars', items: ['Twix'], notes: { Twix: 'so ' + BAD } });
  ok(!L.saved, `${fn}: a flagged NOTE blocks the save — the one case that already worked`);
}

// A standard category is our own text and must not cost a call.
await reset();
r = await page.evaluate(async () => {
  window.MY_LISTS = []; window.selCat = (window.CATS && window.CATS[0] && window.CATS[0].n) || 'Candy bars';
  window.items = []; window.itemNotes = {};
  const res = await window.screenListBeforeSave(null);
  return { res, calls: window.modCalls.length, cat: window.selCat };
});
ok(r.calls === 0, `a standard category with no items is screened without a call (${r.cat}, ${r.calls} calls)`);

// Reordering an existing list is not new content.
await reset();
r = await page.evaluate(async () => {
  window.selCat = 'Candy bars'; window.itemNotes = {};
  window.items = ['Snickers', 'Twix'];
  const res = await window.screenListBeforeSave({ category: 'Candy bars', items: ['Twix', 'Snickers'], item_notes: {} });
  return { res, calls: window.modCalls.length };
});
ok(r.calls === 0, `reordering a saved list costs no moderation call (${r.calls})`);
ok(r.res.blocked === false, 'and is allowed');

// ── groups: create and rename ───────────────────────────────────────────
await reset();
r = await page.evaluate(async (bad) => {
  window.creatingNewGroup = true;
  window.addedFriends = new Set(); window.addedNonFriends = {};
  window.selEmojiChar = '🎉'; window.groupPhotoData = null;
  window.MY_GROUPS = [];
  const el = document.getElementById('group-name');
  if (el) el.value = bad + ' crew';
  try { await window.finishGroup(false); } catch (e) {}
  await new Promise(r => setTimeout(r, 300));
  return { writes: window.writes.map(w => w.table), body: document.body.innerText };
}, BAD);
ok(!r.writes.includes('groups'), `a flagged group name is never inserted (${JSON.stringify(r.writes)})`);
ok(/group name/i.test(r.body), 'and the user is told it was the group name');

await reset();
r = await page.evaluate(async (bad) => {
  window.MY_GROUPS = [{ id: 'g1', n: 'Book club', emoji: '📚', photo: null }];
  window.selGroupIdx = 0;
  window.go('s-gsettings');
  await new Promise(r => setTimeout(r, 250));
  const el = document.getElementById('gsettings-name');
  if (el) el.value = bad + ' club';
  try { await window.saveGroupSettings(); } catch (e) {}
  await new Promise(r => setTimeout(r, 300));
  return { writes: window.writes.map(w => w.table), name: window.MY_GROUPS[0].n };
}, BAD);
ok(!r.writes.includes('groups'), 'renaming a group to flagged text is refused too');
ok(r.name === 'Book club', `and the group keeps its old name in memory (${r.name})`);

await browser.close();
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nall checks passed');
process.exit(fails.length ? 1 : 0);
