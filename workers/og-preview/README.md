# tenner-og-preview

Link previews for `/l.html`, the shared-list page.

## Why

`l.html` loads its list with JavaScript. The crawlers that build link
previews — iMessage, WhatsApp, Slack, Facebook — do not run JavaScript, so
every shared list previewed as the generic "A Top 10 — Tenner". For a feature
whose main channel is texting a link to a friend, that is most of the value
gone.

This Worker calls the same public RPC the page calls, then rewrites the meta
tags in the response stream with HTMLRewriter. The page is not modified and
still renders exactly as before.

    Pyper's Top 10 Board, Card, & Dice Games
    Toy Battle, Monopoly Deal, Cover your assets, and more — see the full
    list on Tenner.

## Deploy

    cd workers/og-preview
    npx wrangler deploy

The route in `wrangler.toml` is `mytenner.com/l.html*` and nothing else, so a
mistake here cannot affect the app.

Requires mytenner.com to be proxied through Cloudflare (orange cloud). If the
zone is DNS-only the route never fires and nothing breaks — previews just stay
generic.

## Behaviour

* Fails open. Any error — RPC down, bad JSON, unexpected shape — returns the
  origin response untouched. A broken preview is a disappointment; a broken
  page is an outage.
* An unknown or revoked token leaves the generic tags rather than inventing a
  preview for a page that will say "not available".
* The RPC response is cached at the edge for 5 minutes, so the several
  crawlers that hit a freshly-sent link do not each trigger a round trip.
* No secrets. It uses the same publishable key already present in l.html.

## Tests

    node test-buildmeta.mjs

Covers the metadata builder: possessive for names ending in s, the handle
fallback, an empty list, missing data, and null input. The HTMLRewriter half
only exists in the Workers runtime and is not covered here — verify it after
deploying with:

    curl -s 'https://mytenner.com/l.html?t=<token>' | grep -i 'og:title'
