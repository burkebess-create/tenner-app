-- 2026-09-15 — Promote a user-invented category to a standard one
--
-- Ice Cream was promoted by hand: find it with a query, create the category,
-- then rename it across every table that stores a category BY NAME. Miss one
-- and comments detach from their list, share invites stop resolving, or match
-- scores silently go stale. That is too error-prone to repeat manually, and
-- the whole "let categories earn their place" strategy depends on doing it
-- often.
--
-- admin_custom_categories() lists what users have invented, ranked by how
-- many people made one — the signal for whether a category deserves promoting.
--
-- admin_promote_category() does the promotion atomically: creates the
-- category, moves every reference across all 11 category-keyed tables,
-- updates default list titles (leaving custom ones alone), and seeds autofill
-- from picks people already made — deduped on the same expression as the
-- unique index so nothing is silently dropped.
--
-- SECURITY DEFINER because promoting rewrites OTHER USERS' lists, which no
-- client-side policy can or should allow. Both functions check admins first.
-- Renaming onto an existing category name is refused rather than merging,
-- since merging two categories is a different operation with different
-- consequences.
--
-- Verified under `set local role authenticated`: non-admin promote blocked
-- (admin_only) and sees zero custom categories; admin sees the probe category
-- with the right people count; promoting onto "Movies" refused
-- (target_name_taken); a real promotion moved 2 lists and 1 comment, updated
-- both list titles, seeded 4 unique autofill items from 5 picks, and left no
-- rows under the old name.

create or replace function public.admin_custom_categories()
returns table (
  category text,
  people bigint,
  total_items bigint,
  last_updated timestamptz,
  sample_items text[]
)
language sql stable security definer set search_path = public
as $$
  select l.category,
         count(distinct l.user_id)::bigint as people,
         sum(jsonb_array_length(l.items))::bigint as total_items,
         max(l.updated_at) as last_updated,
         (array_agg(distinct it.item))[1:6] as sample_items
  from public.lists l
  left join lateral jsonb_array_elements_text(l.items) as it(item) on true
  where exists (select 1 from public.admins a where a.user_id = auth.uid())
    and not exists (select 1 from public.categories c where c.name = l.category)
  group by l.category
  order by count(distinct l.user_id) desc, l.category;
$$;

create or replace function public.admin_promote_category(
  p_old text,
  p_new text,
  p_emoji text default '📋',
  p_gift_default boolean default true,
  p_seed_items boolean default true
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_new text := btrim(coalesce(p_new, ''));
  v_cat_id uuid;
  v_lists int := 0; v_refs int := 0; v_seeded int := 0; n int;
begin
  if not exists (select 1 from admins where user_id = auth.uid()) then
    raise exception 'admin_only';
  end if;
  if p_old is null or btrim(p_old) = '' or v_new = '' then
    raise exception 'name_required';
  end if;
  if lower(v_new) <> lower(p_old)
     and exists (select 1 from categories where lower(name) = lower(v_new)) then
    raise exception 'target_name_taken';
  end if;

  insert into categories (name, emoji, gift_default)
  values (v_new, coalesce(nullif(btrim(coalesce(p_emoji,'')), ''), '📋'), coalesce(p_gift_default, true))
  on conflict (name) do nothing;
  select id into v_cat_id from categories where name = v_new;

  update lists set name = 'Top 10 ' || v_new
   where category = p_old and name = 'Top 10 ' || p_old;

  update lists set category = v_new where category = p_old;
  get diagnostics v_lists = row_count;

  update list_item_comments   set category = v_new where category = p_old; get diagnostics n = row_count; v_refs := v_refs + n;
  update comment_thread_reads set category = v_new where category = p_old; get diagnostics n = row_count; v_refs := v_refs + n;
  update list_reactions       set category = v_new where category = p_old; get diagnostics n = row_count; v_refs := v_refs + n;
  update match_reveals        set category = v_new where category = p_old; get diagnostics n = row_count; v_refs := v_refs + n;
  update group_lists          set category = v_new where category = p_old; get diagnostics n = row_count; v_refs := v_refs + n;
  update list_share_invites   set category = v_new where category = p_old; get diagnostics n = row_count; v_refs := v_refs + n;
  update list_change_events   set category = v_new where category = p_old; get diagnostics n = row_count; v_refs := v_refs + n;
  update shop_clicks          set category = v_new where category = p_old; get diagnostics n = row_count; v_refs := v_refs + n;
  update weekly_lists         set category = v_new where category = p_old; get diagnostics n = row_count; v_refs := v_refs + n;
  update feedback             set category = v_new where category = p_old; get diagnostics n = row_count; v_refs := v_refs + n;

  if coalesce(p_seed_items, true) and v_cat_id is not null then
    insert into category_items (category_id, item_text, sort_order)
    select v_cat_id, x.item, row_number() over (order by x.n desc, x.item)
    from (
      select btrim(it.item) as item, count(*) as n
      from lists l, jsonb_array_elements_text(l.items) as it(item)
      where l.category = v_new and btrim(it.item) <> ''
      group by lower(btrim(it.item)), btrim(it.item)
    ) x
    where not exists (
      select 1 from category_items ci
      where ci.category_id = v_cat_id
        and lower(btrim(ci.item_text)) = lower(btrim(x.item))
    );
    get diagnostics v_seeded = row_count;
  end if;

  return jsonb_build_object(
    'ok', true, 'category', v_new, 'lists_moved', v_lists,
    'references_moved', v_refs, 'items_seeded', v_seeded
  );
end $$;

revoke all on function public.admin_custom_categories() from public, anon;
revoke all on function public.admin_promote_category(text, text, text, boolean, boolean) from public, anon;
grant execute on function public.admin_custom_categories() to authenticated;
grant execute on function public.admin_promote_category(text, text, text, boolean, boolean) to authenticated;
