-- 2026-09-16 — Autofill-item count per category, for the admin Categories list
--
-- Shows at a glance whether a category has autofill suggestions. Six
-- categories currently have none, which means anyone creating one of those
-- lists types into a blank field with no help.
--
-- Needs to be an RPC: PostgREST cannot GROUP BY, and counting client-side is
-- not viable because a plain select caps at 1000 rows while Movies alone has
-- ~2800 items — the counts would be silently wrong for exactly the categories
-- where they matter most.
--
-- LEFT JOIN so categories with zero items are returned too; the admin list
-- needs to tell "no autofill yet" (amber badge) apart from "lookup failed"
-- (no badge at all).

create or replace function public.category_item_counts()
returns table (category_id uuid, item_count bigint)
language sql
stable
security definer
set search_path = public
as $$
  select c.id, count(ci.id)::bigint
  from public.categories c
  left join public.category_items ci on ci.category_id = c.id
  group by c.id;
$$;

revoke all on function public.category_item_counts() from public, anon;
grant execute on function public.category_item_counts() to authenticated;
