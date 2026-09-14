-- 2026-09-14 — Weekly-list emoji must be a plain glyph (no images)
--
-- Found while sweeping every surface that renders a category icon, after the
-- 44,790-character Restaurants icon turned up on the public gift page.
--
-- The weekly reveal emails interpolate weekly_lists.emoji into the HTML *and
-- into the subject line*:
--   `⏰ ${wk.emoji} Top 10 ${wk.category} reveals TONIGHT at ...`
-- A subject line cannot render an image, so an uploaded icon would paste a
-- URL — or, before the emoji guard existed, 44,790 characters of base64 —
-- into every recipient's inbox. Nothing sanitised it on the way out.
--
-- categories and lists may hold a hosted image URL because they are only ever
-- rendered as HTML. weekly_lists is deliberately stricter: its value reaches a
-- text-only context, so it is held to a short glyph.
--
-- There are zero weekly lists today, so nothing is rewritten retroactively —
-- this closes the hole before the first one is created.
--
-- Verified: a plain glyph is kept; a hosted URL and a 40KB data URL are both
-- replaced with the fallback.

create or replace function public.guard_weekly_emoji_glyph_only()
returns trigger language plpgsql set search_path = public
as $$
begin
  if new.emoji is not null
     and (length(new.emoji) > 24 or new.emoji ~* '^(data:|https?:)')
  then
    new.emoji := '📋';
  end if;
  return new;
end $$;

drop trigger if exists trg_guard_weekly_emoji on public.weekly_lists;
create trigger trg_guard_weekly_emoji
  before insert or update on public.weekly_lists
  for each row execute function public.guard_weekly_emoji_glyph_only();
