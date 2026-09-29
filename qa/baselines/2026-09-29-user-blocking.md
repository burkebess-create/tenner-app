# Blocking — verification record, 2026-09-29

Every check below ran inside a transaction that ended in `RAISE EXCEPTION`,
so the result text came back and the rows rolled back. Roles were set with
`set local role authenticated` plus `set_config('request.jwt.claims', …)` —
blocking that only works for the `postgres` role proves nothing, since the
app reads with the user's own token.

Subjects: a non-admin user A with 25 public lists and an accepted friendship
to B; a second non-admin friend C, uninvolved. An earlier run of this test
picked an admin as the blocker and a non-friend as the "uninvolved" party —
the admin branch bypasses the block entirely and a non-friend already sees 0
lists, so both halves proved nothing. Re-run with neither.

| Check | Before | After |
|---|---|---|
| B reads A's lists | 25 | 0 |
| B reads A's profile | 1 | 0 |
| B reads A's comments | 0 | 0 |
| B reads the block row itself | — | 0 (not detectable) |
| A reads B's profile (symmetry) | 1 | 0 |
| A reads B's lists (symmetry) | — | 0 |
| A's own blocked list | — | 1 |
| C reads A's lists (uninvolved) | 32 | 32 |
| C reads A's profile (uninvolved) | 1 | 1 |
| after `unblock_user`: A reads B's profile | 0 | 1 |
| after `unblock_user`: friendship restored? | — | 0 — deliberately not |
| admin reads both profiles | — | 2 |
| admin reads A's lists / comments | — | 32 / 66 |
| a user who blocked an admin, read as that admin | — | 1 (moderation unaffected) |
