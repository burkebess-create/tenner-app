-- Public, owner-published list pages + retailer config (2026-09-23)
--
-- Applied as:
--   public_list_pages_and_retailers
--   public_list_page_rpcs
--
-- ── Why this exists at all ────────────────────────────────────────────
-- Affiliate links needed a home that is not the signed-in app. Amazon's
-- Participation Requirements §5 bars Special Links "on or in connection with
-- ... any other application executable or installable by an end user (other
-- than Approved Mobile Applications)", and manifest.json declares
-- display:standalone, so Tenner is installable. The Mobile Application Policy
-- then requires an app-store listing, which a PWA cannot have. Rather than
-- argue the point, no Special Link ever exists inside the app: the app links
-- to a public page on our own domain, and the links live there.
--
-- That also satisfies §2(b), which allows a link to a Product LIST (a search
-- results page is one) only where "additional original content on your Site
-- that is relevant to the Special Link" accompanies it. The ranking and the
-- owner's own note are that content. A bare item name plus a Shop button —
-- the obvious in-app design — would not have qualified.
--
-- ── Why a token and not lists.is_public ───────────────────────────────
-- is_public is labelled "Visible to friends" in the UI, with the subtext
-- "Friends can see this list even if they haven't filled it out". That is a
-- promise about your circle. Deriving public pages from it would have put 183
-- existing lists, and their item notes, on the open web under wording nobody
-- read that way. A share_token is created only when the owner asks, is
-- revocable, and is deliberately independent of is_public — sharing the link
-- IS the decision. Same consent model as gift_share_token.
--
-- ── Verified as SQL, inside deliberately aborted transactions ─────────
--   owner publishes                    -> token issued
--   owner publishes again              -> SAME token (a sent link keeps working)
--   non-owner publishes                -> raises 'list not found'
--   non-owner unpublishes              -> no effect (token unchanged)
--   anon reads by token                -> succeeds; keys are list/shop/owner,
--                                         owner keys are display_name/handle/
--                                         photo only, no '@' anywhere in the
--                                         payload
--   unknown token                      -> NULL
--   after the owner revokes            -> NULL
-- Confirmed afterwards that 0 lists carry a share_token.

alter table public.lists add column if not exists share_token text;
create unique index if not exists lists_share_token_key
  on public.lists (share_token) where share_token is not null;

-- shop_query_suffix is what separates the TRY-IT intent from the GIFT intent:
-- "Catan board game", not "Catan gift ideas". It is also what stops a search
-- link being useless — "hammer" returns junk, "hammer tool" does not.
alter table public.categories add column if not exists shop_enabled boolean not null default false;
alter table public.categories add column if not exists shop_query_suffix text;

-- Retailers as config so adding Bookshop or Target is a row, not a rewrite.
-- NOTE for whoever adds the second one: §6(z) and the IP License bar using
-- Amazon's OWN content (PA API images, titles, prices) to promote anything
-- sold elsewhere. We use none of it — plain search URLs and our own copy — so
-- multi-retailer is fine. Adopting PA API content later would make richer
-- pages and multi-retailer mutually exclusive on the same page.
create table if not exists public.affiliate_retailers (
  id           uuid primary key default gen_random_uuid(),
  slug         text unique not null,
  label        text not null,
  url_template text not null,
  active       boolean not null default true,
  sort_order   int not null default 100,
  created_at   timestamptz not null default now(),
  constraint affiliate_retailers_template_has_q check (url_template like '%{q}%')
);

alter table public.affiliate_retailers enable row level security;

drop policy if exists affiliate_retailers_select_all on public.affiliate_retailers;
create policy affiliate_retailers_select_all on public.affiliate_retailers
  for select to anon, authenticated using (active);

drop policy if exists affiliate_retailers_admin_write on public.affiliate_retailers;
create policy affiliate_retailers_admin_write on public.affiliate_retailers
  for all to authenticated
  using (exists (select 1 from public.admins a where a.user_id = auth.uid()))
  with check (exists (select 1 from public.admins a where a.user_id = auth.uid()));

insert into public.affiliate_retailers (slug, label, url_template, sort_order)
values ('amazon', 'Amazon', 'https://www.amazon.com/s?k={q}&tag=tenner09-20', 10)
on conflict (slug) do nothing;

alter table public.shop_clicks add column if not exists retailer text;

-- ── RPCs ──────────────────────────────────────────────────────────────
-- (bodies as applied; see public_list_page_rpcs)
--   publish_my_list(uuid)        owner-only, idempotent, returns the token
--   unpublish_my_list(uuid)      owner-only, sets share_token = null
--   get_public_list_data(text)   anon-readable, the whole page in one call
--
-- get_public_list_data returns display_name, handle and photo and nothing
-- else about the owner: no email, no birthday, no friend graph, nothing about
-- who else can see the list. A missing categories row (a custom category)
-- yields shop.enabled = false, so nothing links out until an admin opts the
-- category in.

-- ── Categories opted in at launch ─────────────────────────────────────
-- Deliberately conservative, and deliberately excluding the Worst*/Pet peeves
-- categories: turning "Worst Smells" into an Amazon search carrying our tag is
-- exactly the brand-adjacency Operating Agreement §6(d) lets them terminate
-- over.
--   Books                          -> 'book'
--   Board, Card, & Dice Games      -> 'board game'
--   Video Games                    -> 'video game'
--   Movies                         -> 'movie'
--   TV Shows                       -> 'tv series'
--   Candy Bars                     -> 'candy'
--   Cold Cereals                   -> 'cereal'
--   Sodas                          -> 'soda'
--   Favorite travel gear           -> 'travel gear'
--   Things Everyone Should Own     -> (none)
--   Best Purchases I've Ever Made  -> (none)
--   Things I Want But Haven't Bought -> (none)

-- ── Addendum: the viewer-facing shop page (2026-09-23) ────────────────
--
-- Applied as: public_shop_page_rpc
--
-- The migration above built the PUBLISHING half — an owner shares their own
-- list. It left the actual use case unbuilt: you are looking at a FRIEND'S
-- list in the app and want the thing they picked. There was no path to the
-- shop links at all, and as built it would have depended on other people
-- publishing their lists first, which almost nobody does.
--
-- get_public_shop_page(category, items[]) serves a page about the ITEMS only
-- — no owner, no name, no notes — so it needs no token and works for any list
-- the viewer can already see.
--
-- It exists instead of get_top_items_for_category because that function's
-- min_lists default is 30 and the largest shop-enabled category has 18 public
-- lists today, so it returns items:NULL for every one of them.
--
-- The per-item count is the "additional original content" 2(b) requires
-- beside a link to a search-results page. Counts are suppressed below 3
-- public lists in the category, and the page does not render a count of 1.
--
-- VERIFIED as anon:
--   Movies + 3 items      -> enabled, suffix 'movie', 18 lists,
--                            counts 1 / 2 / 0 (unknown item)
--   Pet peeves            -> {"enabled": false} — no links, no disclosure
--   Favorite travel gear  -> count null (1 public list, below the floor)
