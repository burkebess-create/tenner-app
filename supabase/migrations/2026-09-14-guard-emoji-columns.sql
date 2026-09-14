-- 2026-09-14 — An emoji must be a short glyph or a genuine data:image URL
--
-- THE BUG
-- The Restaurants icon is a 44,790-character base64 PNG stored in the emoji
-- column (a 128x128 image uploaded through the admin picker). renderCatEmoji
-- handles that shape, but five render paths interpolated the emoji as raw
-- text instead of calling it — the circle/activity feeds, the group and
-- weekly rows, and the share sheet. On any of those, the entire base64 string
-- was printed on screen, destroying the layout. Reported on a friend's Top 10
-- Restaurants.
--
-- THE FIX (three layers)
--   1. renderCatEmoji now only treats a WELL-FORMED data:image URL as an
--      image, drops any other value over 24 characters rather than printing
--      it, and gives the <img> an onerror fallback. It can no longer emit
--      more than a few characters of text whatever it is handed.
--   2. All five raw interpolation sites now go through it.
--   3. This trigger stops the bad shape reaching storage at all.
--
-- It sanitises rather than rejects: an over-long NON-image value silently
-- becomes the fallback glyph, so no user action fails because of an icon.
-- Genuine uploaded images pass through untouched — which is why the existing
-- Restaurants icon still renders.
--
-- Verified: over-long text -> 📋; a real data:image URL of 22,022 chars
-- unchanged; a normal emoji and a multi-codepoint ZWJ sequence both unchanged.
--
-- NOTE: this does not address the SIZE of legitimate inline icons. The
-- Restaurants image adds ~44KB to every payload that carries it (the category
-- list, and each of the 3 lists using it). Moving custom icons to Storage
-- behind img.mytenner.com, as profile photos already are, would be the proper
-- fix and is not done here.

create or replace function public.guard_emoji_value()
returns trigger language plpgsql set search_path = public
as $$
begin
  if new.emoji is not null
     and new.emoji !~* '^data:image/(png|jpe?g|gif|webp|svg\+xml);base64,'
     and length(new.emoji) > 24
  then
    new.emoji := '📋';
  end if;
  return new;
end $$;

drop trigger if exists trg_guard_emoji on public.categories;
create trigger trg_guard_emoji
  before insert or update on public.categories
  for each row execute function public.guard_emoji_value();

drop trigger if exists trg_guard_emoji on public.lists;
create trigger trg_guard_emoji
  before insert or update on public.lists
  for each row execute function public.guard_emoji_value();

-- ─────────────────────────────────────────────────────────────────────
-- Amended the same day: allow a hosted icon URL.
--
-- The first version exempted only data:image URLs. Once category icons move
-- to Storage the replacement value is an https://img.mytenner.com/... URL —
-- longer than 24 chars and not a data URL — so this guard would have silently
-- rewritten every migrated icon to 📋, undoing the migration as it ran.
-- Caught before running it.
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.guard_emoji_value()
returns trigger language plpgsql set search_path = public
as $$
begin
  if new.emoji is not null
     and new.emoji !~* '^data:image/(png|jpe?g|gif|webp|svg\+xml);base64,'
     and new.emoji !~* '^https://[^[:space:]]+$'
     and length(new.emoji) > 24
  then
    new.emoji := '📋';
  end if;
  -- A hosted URL has no business being enormous either.
  if new.emoji is not null
     and new.emoji ~* '^https://'
     and length(new.emoji) > 512
  then
    new.emoji := '📋';
  end if;
  return new;
end $$;
