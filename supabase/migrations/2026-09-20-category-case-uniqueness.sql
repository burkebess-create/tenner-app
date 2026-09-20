-- Case-insensitive category uniqueness (2026-09-20)
-- (migration case_insensitive_category_uniqueness)
--
-- WHY: a category's identity IS its text name. There is no id on the
-- user-facing tables — lists, group_lists, list_share_invites,
-- list_item_comments, list_reactions, comment_thread_reads,
-- list_change_events, match_reveals, weekly_lists and shop_clicks all key on
-- the name, with no foreign key anywhere. (categories has real UUIDs, and
-- category_items references them properly, so the app is half-migrated.)
--
-- Every comparison against a category is case-SENSITIVE: the catalogue
-- lookup, the autofill pool, and every .eq('category', x) in the client. So
-- 'Movies' and 'movies' would be two unrelated categories that never match
-- between friends and never share an item pool. That is the same class of
-- bug that made "top podcasts" show band suggestions.
--
-- Verified safe before applying: 0 case-duplicate lists per user,
-- 0 case-duplicate catalogue rows, 0 categories spelled two ways.
--
-- The existing case-sensitive indexes are deliberately KEPT: the client
-- upserts lists with onConflict: 'user_id,category', which needs
-- lists_user_id_category_key to exist by that exact shape. These are
-- additional constraints, not replacements.

create unique index if not exists categories_name_lower_key
  on public.categories (lower(name));

create unique index if not exists lists_user_id_category_lower_key
  on public.lists (user_id, lower(category));

-- VERIFIED (inside deliberately aborted transactions, zero residue):
--   insert 'Zzztest' then 'zzztest'      -> second BLOCKED
--   insert 'Zzztest' then 'Zzzother'     -> both OK
--   two catalogue rows differing by case -> second BLOCKED
--   upsert on conflict (user_id, category), same case -> OK, 1 row
--     (this is the client's own save path; confirmed unaffected)
--
-- Client-side, saveListToDb() now routes the category through
-- canonicalCategoryName(), which adopts the spelling already in use — the
-- user's own list first, then the catalogue — so the constraint is a safety
-- net rather than an error the user ever sees.
--
-- STILL OPEN (recommended, not done): nothing enforces that
-- rename_category_everywhere() covers every table with a category column.
-- Coverage is complete today (feedback.category holds a feedback type, not a
-- list category, and is correctly excluded), but an eleventh table added
-- later would be silently orphaned by every rename. A test that enumerates
-- category columns and fails on an uncovered one would close that.
