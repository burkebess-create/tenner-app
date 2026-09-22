# Tenner QA Agent

Browser-driven smoke tests for mytenner.com. Uses Playwright + Chromium to
log in as a dedicated test user, walk the golden paths (auth, create list,
comments, friends, gift page), screenshot every step, and write a Markdown
report.

## Prereqs

- Node 18+
- A dedicated Supabase test account (do NOT use your real account — the
  agent creates and mutates data).

```
cd qa
npm install
```

Chromium is expected at `/opt/pw-browsers/chromium` in the managed
environment; on a local machine run `npx playwright install chromium` once.

## Env

Easiest: copy the example and fill in your test account.

```
cp qa/.env.example qa/.env
# then edit qa/.env
```

`qa/.env` is gitignored — safe for credentials. Shell env vars still win
if you'd rather pass them inline:

```
QA_EMAIL=you@example.com QA_PASSWORD=... npm run qa
```

### Second account (optional but recommended)

`QA_EMAIL_2` / `QA_PASSWORD_2` enable the `social` flow, which is the only
one that can reach anything *between* two users. Three production bugs lived
there and were invisible to a single login:

- the Circle feed emptying when `are_friends()` lost its EXECUTE grant — a
  user reading their own lists never evaluates that policy branch;
- a comment showing "A friend" in the thread and the real name in Alerts;
- `notifyFriendsOfUpdate()` notifying nobody, which is skipped entirely when
  the commenter is the list owner.

The two accounts must be **accepted friends** and both need at least one
public list, ideally sharing a category so match scores are non-trivial. The
flow skips itself with a log line when the secrets are absent, so the suite
still runs for anyone without them.

In CI these are repository secrets of the same names.

## Run

```
npm run qa              # headless
npm run qa:headed       # visible browser (local only)
FLOWS=auth,lists npm run qa   # subset
```

Artifacts land in `qa/screenshots/<run-id>/` and `qa/reports/<run-id>.md`.

## Adding flows

Each flow is a file in `qa/flows/` exporting `{ name, run(ctx) }`. `ctx`
provides `{ page, log, shot, assert, expectText }`. Register it in
`run.mjs`'s `FLOWS` map.
