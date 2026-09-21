// Handler-compile sweep.
//
// Every row template in the app builds its click handler as a STRING inside an
// HTML attribute: onclick="fn('<interpolated value>')". If a value contains a
// quote, the attribute stops being valid JavaScript and the control silently
// dies — no page error, no console message, nothing. A real category called
// "Best Purchases I've Ever Made" killed every reaction button on that list,
// and separately the Mark-resolved button in the admin Errors screen could not
// be clicked because the error message it carried contained an apostrophe.
//
// Neither was caught by the other flows, because they drive the app through
// window globals and never click a rendered element. This flow does the one
// thing that catches the whole class: walk every on* attribute the browser
// actually produced and try to compile it.
//
// It is data-dependent by design — it tests the strings your real content
// generates, which is exactly where the bugs came from.

const SKIP_SCREENS = new Set([
  // Nothing destructive, and nothing that fires outbound mail/pushes.
  's-auth',
]);

export default {
  name: 'handlers',
  async run({ page, log, shot, assert }) {
    // Collect every screen id the app defines, then visit each one.
    const screenIds = await page.evaluate(() =>
      [...document.querySelectorAll('.screen')].map(s => s.id).filter(Boolean));
    log('screens found', String(screenIds.length));

    const broken = [];
    const visited = [];

    for (const id of screenIds) {
      if (SKIP_SCREENS.has(id)) continue;

      const ok = await page.evaluate((sid) => {
        try {
          // Some detail screens need a subject before they render anything.
          if (sid === 's-fdetail' || sid === 's-friend-list') {
            const f = (window.myFriends || []).find(x => x.status === 'accepted');
            if (!f) return false;
            window.selFriendId = f.friendId;
          }
          if (sid === 's-list-detail') {
            const l = (window.MY_LISTS || [])[0];
            if (!l) return false;
            window.selListDetail = l;
          }
          if (typeof window.go !== 'function') return false;
          window.go(sid);
          return true;
        } catch (e) { return false; }
      }, id);
      if (!ok) continue;

      await page.waitForTimeout(350);   // let async renderers fill in
      visited.push(id);

      const bad = await page.evaluate((sid) => {
        const out = [];
        document.querySelectorAll('*').forEach(el => {
          for (const a of el.attributes) {
            if (!/^on[a-z]+$/i.test(a.name)) continue;
            try {
              // Same compile the browser does when the event fires.
              new Function(a.value);
            } catch (err) {
              out.push({
                screen: sid,
                attr: a.name,
                tag: el.tagName.toLowerCase(),
                text: (el.textContent || '').trim().slice(0, 40),
                value: a.value.slice(0, 160),
                err: String(err.message || err),
              });
            }
          }
        });
        return out;
      }, id);

      if (bad.length) {
        broken.push(...bad);
        log(`✗ ${id}`, `${bad.length} broken handler(s)`);
        await shot(`broken-${id}`);
      }
    }

    log('screens visited', visited.join(', '));

    // Count what we actually checked, so a silently-empty sweep can't pass.
    const total = await page.evaluate(() => {
      let n = 0;
      document.querySelectorAll('*').forEach(el => {
        for (const a of el.attributes) if (/^on[a-z]+$/i.test(a.name)) n++;
      });
      return n;
    });
    log('handlers on final screen', String(total));

    await assert(visited.length >= 5,
      `visited at least 5 screens (got ${visited.length}) — a sweep that visits nothing cannot fail`);

    if (broken.length) {
      const detail = broken.slice(0, 6)
        .map(b => `${b.screen} <${b.tag}> ${b.attr}: ${b.err} :: ${b.value}`)
        .join(' | ');
      throw new Error(`${broken.length} uncompilable inline handler(s): ${detail}`);
    }
    await assert(true, `every inline handler compiles across ${visited.length} screens`);

    // ── escaping contract ───────────────────────────────────────────────
    // The sweep above only inspects what the QA account's data happens to
    // render. If nobody's list contains an apostrophe that night, it proves
    // nothing. This half is data-independent: it feeds the app's own escaping
    // helper the characters that have actually broken production and checks
    // the result still compiles inside an attribute.
    //
    // The values are real: a category called "Best Purchases I've Ever Made"
    // killed the reaction buttons, and a SyntaxError message containing 've
    // made the admin Mark-resolved button unclickable.
    const HOSTILE = [
      "Best Purchases I've Ever Made",
      "You've Got Mail",
      'He said "hi" loudly',
      "SyntaxError: Unexpected identifier 've'. Expected ')'.",
      'back\\slash',
      'a<b> & c',
      "mixed \"both\" and 'single'",
    ];

    const esc = await page.evaluate((vals) => {
      if (typeof window.jsStrAttr !== 'function') {
        return { missing: true };
      }
      const out = [];
      for (const v of vals) {
        // Exactly how the app builds a row handler, then how the browser
        // parses it back out of the attribute.
        const host = document.createElement('div');
        host.innerHTML = '<button onclick="fn(\'' + window.jsStrAttr(v) + '\')">x</button>';
        const attr = host.firstChild && host.firstChild.getAttribute('onclick');
        let err = null;
        try { new Function(attr || 'throw new Error("attribute destroyed")'); }
        catch (e) { err = String(e.message || e); }
        out.push({ value: v, attr: (attr || '').slice(0, 120), err });
      }
      return { results: out };
    }, HOSTILE);

    if (esc.missing) {
      throw new Error('jsStrAttr() is missing — inline handler values are not being escaped for JS');
    }
    const escBad = esc.results.filter(r => r.err);
    for (const r of escBad) log('✗ escaping', `${JSON.stringify(r.value)} → ${r.err}`);
    if (escBad.length) {
      throw new Error(`${escBad.length}/${HOSTILE.length} hostile value(s) produce an uncompilable handler: ` +
        escBad.map(r => JSON.stringify(r.value)).join(', '));
    }
    await assert(true,
      `all ${HOSTILE.length} hostile values survive jsStrAttr() and compile inside an attribute`);
  },
};
