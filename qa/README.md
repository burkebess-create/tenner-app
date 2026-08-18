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

Create `qa/.env` (gitignored) or export inline:

```
TENNER_URL=https://mytenner.com
QA_EMAIL=qa+tenner@example.com
QA_PASSWORD=super-secret
QA_FRIEND_EMAIL=qa+friend@example.com   # optional, enables friend-flow tests
QA_FRIEND_PASSWORD=super-secret
```

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
