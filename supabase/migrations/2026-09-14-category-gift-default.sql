-- 2026-09-14 — Per-category default for the gift-ideas picker
--
-- Some categories are not gift ideas ("Pet peeves", "Best national parks"),
-- but the gift-guide picker pre-ticked EVERY list a user had the first time
-- they opened it, so those leaked into gift pages by default.
--
-- gift_default lets an admin mark a category as not gift-relevant, so it
-- starts unticked for everyone. It only ever affects the INITIAL state of a
-- user's picker: once someone saves their own selection, theirs wins outright
-- and this is ignored.
--
-- Column default is TRUE so the 15 existing categories keep the behaviour
-- users already have. The admin form pre-selects OFF for a NEW category, so
-- anything created from here on starts unticked unless the admin opts it in.
-- That gives "new categories default to unchecked" without retroactively
-- changing what anyone already sees.

alter table public.categories
  add column if not exists gift_default boolean not null default true;

comment on column public.categories.gift_default is
  'Suggested for gift guides by default. Only affects the initial state of a user''s picker; once a user saves their own selection, theirs wins.';
