// Profile flow: nav to profile, verify myProfile loads, verify gift-share token
// exists (or generate one if missing — the app's regen RPC is public and safe),
// and then actually SAVE a profile edit end to end.
//
// The save half exists because of a bug that ran for six days and nobody
// reported: lock_down_profile_contact_columns revoked SELECT on
// profiles.phone, and saveProfile() used .upsert(), which PostgREST compiles
// to INSERT ... ON CONFLICT DO UPDATE SET phone = excluded.phone. Reading
// excluded.phone needs SELECT on that column, so Postgres refused the whole
// statement with 42501 and profile editing was impossible. Every existing
// check passed throughout: the screen rendered, myProfile loaded, the token
// was there. Nothing exercised the WRITE.
//
// So this drives the real saveProfile() against the real database and reads
// the row back. It writes to the QA account's own profile and restores the
// original value afterwards, in a finally.
export default {
  name: 'profile',
  async run({ page, log, shot, assert }) {
    log('nav → profile');
    await page.evaluate(() => window.go && window.go('s-profile'));
    await page.waitForFunction(() => document.querySelector('#s-profile')?.classList.contains('active'), { timeout: 8000 });

    // Wait up to 5s for loadProfile to populate window.myProfile
    await page.waitForFunction(() => !!window.myProfile, { timeout: 5000 });
    await shot('01-profile');

    let profile = await page.evaluate(() => window.myProfile);
    await assert(!!profile, 'myProfile is loaded');

    if (!profile.gift_share_token) {
      log('no token — calling regenerate_my_gift_share_token RPC');
      const gen = await page.evaluate(async () => {
        try {
          const r = await window.sbClient.rpc('regenerate_my_gift_share_token');
          if (r.error) return { ok: false, err: r.error.message };
          window.myProfile.gift_share_token = r.data;
          return { ok: true, token: r.data };
        } catch (e) { return { ok: false, err: String(e) }; }
      });
      log('regen result', JSON.stringify(gen));
      profile = await page.evaluate(() => window.myProfile);
    }

    await assert(!!profile.gift_share_token, 'gift_share_token exists');
    log('token', profile.gift_share_token.slice(0, 8) + '…');

    // ── the write path ──────────────────────────────────────────────────
    const marker = `qa-bio-${Date.now().toString(36)}`;
    const original = await page.evaluate(async () => {
      const r = await window.sbClient.from('profiles')
        .select('bio, display_name, handle').eq('id', window.userId).maybeSingle();
      return r.error ? { error: r.error.message } : r.data;
    });
    await assert(!original.error, `read own profile back (${original.error || 'ok'})`);
    log('current bio', JSON.stringify(original.bio));

    let restored = false;
    try {
      // Drive the REAL saveProfile(), through the form, not a hand-rolled
      // query — the bug was in how the client composed its write, so a
      // hand-rolled query would have passed while the app stayed broken.
      const saved = await page.evaluate(async (bio) => {
        window.go('s-profile-edit');
        await new Promise(r => setTimeout(r, 400));
        const set = (id, v) => { const e = document.getElementById(id); if (e) e.value = v; };
        // Keep name and handle exactly as they are; only the bio changes.
        set('profile-name-input', window.myProfile.display_name || '');
        set('profile-handle-input', window.myProfile.handle || '');
        set('profile-bio-input', bio);
        let shownError = null;
        const realErr = window.showProfileError;
        window.showProfileError = (t) => { shownError = t; if (realErr) realErr(t); };
        try { await window.saveProfile(); } catch (e) { shownError = String(e && e.message || e); }
        window.showProfileError = realErr;
        await new Promise(r => setTimeout(r, 600));
        return { shownError };
      }, marker);

      await assert(!saved.shownError,
        `saveProfile reported no error (${saved.shownError || 'clean'})`);

      // The only proof that counts: read it back from the database.
      const after = await page.evaluate(async () => {
        const r = await window.sbClient.from('profiles')
          .select('bio, display_name, handle').eq('id', window.userId).maybeSingle();
        return r.error ? { error: r.error.message } : r.data;
      });
      await assert(!after.error, `re-read the row (${after.error || 'ok'})`);
      await assert(after.bio === marker,
        `the edit is IN THE DATABASE (wanted ${marker}, got ${JSON.stringify(after.bio)})`);
      await assert(after.display_name === original.display_name && after.handle === original.handle,
        'name and handle were not clobbered by the save');
      await shot('02-after-save');
    } finally {
      // Put the bio back whatever happened above, so a failing run does not
      // leave a QA marker sitting on the account.
      const undo = await page.evaluate(async (bio) => {
        const r = await window.sbClient.from('profiles')
          .update({ bio: bio }).eq('id', window.userId);
        return r.error ? r.error.message : null;
      }, original.bio ?? null);
      restored = !undo;
      log('restore bio', restored ? 'ok' : 'FAILED: ' + undo);
    }

    await assert(restored, 'the original bio was restored');
  },
};
