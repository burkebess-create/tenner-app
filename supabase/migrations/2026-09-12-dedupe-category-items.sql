-- 2026-09-12 — De-duplicate category_items and prevent future duplicates
--
-- Applied to the live database on 2026-09-12. Removed 1806 duplicate rows
-- (1804 in Movies, 2 in TV Shows), keeping the earliest row of each
-- (category, case-insensitive trimmed text) pair. Deleted rows are preserved
-- in category_items_dupe_backup_20260912 — drop that table once you are
-- confident the cleanup was correct.
--
-- The unique index is the real guard. The admin UI checks for duplicates
-- before inserting so it can show a friendly warning, but that check can race
-- or read a stale cache; the index is what actually makes duplicates
-- impossible. Client code must therefore handle SQLSTATE 23505 on insert and
-- on rename.

create table if not exists public.category_items_dupe_backup_20260912 (
  like public.category_items including all
);

with ranked as (
  select id, row_number() over (
           partition by category_id, lower(btrim(item_text))
           order by sort_order nulls last, id
         ) rn
  from public.category_items
)
insert into public.category_items_dupe_backup_20260912
select ci.* from public.category_items ci
join ranked r on r.id = ci.id and r.rn > 1;

with ranked as (
  select id, row_number() over (
           partition by category_id, lower(btrim(item_text))
           order by sort_order nulls last, id
         ) rn
  from public.category_items
)
delete from public.category_items ci
using ranked r
where r.id = ci.id and r.rn > 1;

create unique index if not exists uq_category_items_cat_text
  on public.category_items (category_id, lower(btrim(item_text)));
