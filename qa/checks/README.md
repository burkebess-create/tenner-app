# Standalone UI checks

These run against a locally served copy of the app with a stubbed Supabase
client. Unlike `qa/flows/`, they sign nobody in and touch no real data, so
they are safe to run any time — but for the same reason they prove only that
the UI calls the right things, never that the database honours them. The
server-side half of blocking is proved in SQL (see
`supabase/migrations/2026-09-29-user-blocking.sql` and the verification
transactions recorded in `qa/baselines/`).

    cd /path/to/tenner-app && python3 -m http.server 8899 &
    node qa/checks/blocking.mjs
    node qa/checks/blocking-entry-point.mjs
    node qa/checks/store-readiness.mjs
    node qa/checks/moderation-gate.mjs
